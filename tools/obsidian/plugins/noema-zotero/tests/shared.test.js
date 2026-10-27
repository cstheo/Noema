"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient } = require("../shared");

const SERVER = "LocalServer2";
const AUTH = "a".repeat(32);
const PAPER = "PAPERKEY";
const PDF = "PDF2KEYX";
const NOTE = "NTEKEY22";
const ANNOTATION = "ANTNKEY2";
const ALPHABET = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";

function row(key, data, version = 1) { return { key, version, data: { key, version, ...data } }; }
function response(status, value, headers = {}) {
  return { status, headers: { "Zotero-Server-ID": SERVER, ...headers }, json: value };
}
function note(key = NOTE, parentItem = PAPER, version = 1) {
  return row(key, { itemType: "note", parentItem, note: "<p>Original</p>", tags: [] }, version);
}
function annotation(overrides = {}) {
  return row(ANNOTATION, { itemType: "annotation", parentItem: PDF, annotationType: "highlight",
    annotationText: "Marked text", annotationComment: "Original comment", annotationColor: "#ffd400",
    annotationPageLabel: "1", annotationSortIndex: "00000|000000|00000",
    annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[1, 2, 3, 4]] }),
    annotationIsExternal: false, ...overrides });
}
function highlight(overrides = {}) {
  return { text: "Selected text", comment: "My comment", color: "#FFD400", pageLabel: "1",
    sortIndex: "00000|000000|00000", position: { pageIndex: 0, rects: [[1, 2, 3, 4]] }, ...overrides };
}
function fixture(intercept) {
  const records = new Map([
    [PAPER, row(PAPER, { itemType: "journalArticle", title: "Paper" })],
    [PDF, row(PDF, { itemType: "attachment", parentItem: PAPER, contentType: "application/pdf" })],
    [NOTE, note()], [ANNOTATION, annotation()]
  ]);
  const calls = [];
  const request = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url, ...options });
    assert.equal(parsed.origin, "http://127.0.0.1:23119");
    assert.equal(options.headers["Zotero-Server-ID"], SERVER);
    assert.equal(options.headers["Zotero-API-Version"], "3");
    if (intercept) {
      const result = await intercept({ url: parsed, options, records, calls });
      if (result !== undefined) return result;
    }
    if (parsed.pathname === "/api/local/authorize") return response(200, { key: AUTH, remember: true });
    if (options.method === "POST") {
      const [data] = JSON.parse(options.body);
      // Native local API selects keyed creation before fromJSON. New
      // notes/annotations with keys trigger the unloaded primaryData path.
      if (["note", "annotation"].includes(data.itemType) && data.key !== undefined) {
        return response(200, { successful: {}, unchanged: {}, failed: { 0: { code: 400,
          message: `'primaryData' not loaded for item (null/1/${data.key})` } } });
      }
      if (data.key !== undefined) assert.equal(data.version, 0);
      const savedKey = data.key ?? "SRVRKEY2";
      const saved = row(savedKey, data, 2);
      saved.data.version = 2;
      records.set(savedKey, saved);
      return response(200, { successful: { 0: saved }, unchanged: {}, failed: {} });
    }
    const key = parsed.pathname.split("/")[5];
    if (options.method === "PATCH") {
      const previous = records.get(key);
      if (Number(options.headers["If-Unmodified-Since-Version"]) !== previous.version) return response(412);
      const saved = row(key, { ...previous.data, ...JSON.parse(options.body) }, previous.version + 1);
      saved.data.version = saved.version;
      records.set(key, saved);
      return response(204);
    }
    if (parsed.pathname.endsWith("/children")) {
      const type = parsed.searchParams.get("itemType");
      const items = [...records.values()].filter(value => value.data.parentItem === key && value.data.itemType === type);
      const start = Number(parsed.searchParams.get("start"));
      return response(200, items.slice(start, start + 100), { "Total-Results": String(items.length), "Last-Modified-Version": "7" });
    }
    return records.has(key) ? response(200, records.get(key)) : response(404);
  };
  return { records, calls, client: createClient({ request, serverId: SERVER }) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test("shared-note state reads active and trashed native records without version or write authorization", async () => {
  for (const [deleted, status] of [[undefined, "active"], [false, "active"], [0, "active"], [true, "deleted"], [1, "deleted"]]) {
    const f = fixture();
    const native = note(NOTE, PAPER, 7);
    if (deleted !== undefined) native.data.deleted = deleted;
    native.data.note = "<p>Current native content</p>";
    f.records.set(NOTE, native);
    const entry = { serverId: SERVER, key: NOTE, parentKey: PAPER, version: 1 };
    const before = structuredClone(entry);
    const state = await f.client.getNoteState(entry);
    assert.equal(state.status, status);
    assert.equal(state.record.key, NOTE);
    assert.equal(state.record.parentItem, PAPER);
    assert.equal(state.record.version, 7);
    assert.equal(state.record.serverId, SERVER);
    assert.equal(state.record.note, native.data.note);
    assert.equal(state.record.noteHTML, native.data.note);
    assert.equal(state.record.deleted, deleted);
    assert.deepEqual(entry, before);
    assert.equal(f.calls.length, 1);
    const call = f.calls[0], url = new URL(call.url);
    assert.equal(call.method, "GET");
    assert.equal(url.pathname, `/api/users/0/items/${NOTE}`);
    assert.equal(url.searchParams.get("format"), "json");
    assert.equal(url.searchParams.get("include"), "data");
    assert.equal(call.body, undefined);
    assert.equal(call.headers["Zotero-API-Key"], undefined);
    assert.equal(call.headers["If-Unmodified-Since-Version"], undefined);
  }
});

test("a server-confirmed keyed 404 reports a missing shared note", async () => {
  const f = fixture();
  f.records.delete(NOTE);
  assert.deepEqual(await f.client.getNoteState({ serverId: SERVER, key: NOTE, parentKey: PAPER }),
    { status: "missing", record: null });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "GET");
});

test("child absence distinguishes moved and standalone notes from deletion", async () => {
  for (const [parentItem, deleted] of [["THRKEY22", undefined], [undefined, undefined], ["THRKEY22", true]]) {
    const f = fixture();
    const native = note();
    if (parentItem === undefined) delete native.data.parentItem;
    else native.data.parentItem = parentItem;
    if (deleted !== undefined) native.data.deleted = deleted;
    f.records.set(NOTE, native);
    assert.deepEqual((await f.client.loadPaper(PAPER)).notes, []);
    const state = await f.client.getNoteState({ serverId: SERVER, key: NOTE, parentKey: PAPER });
    assert.equal(state.status, "moved");
    assert.equal(state.record.key, NOTE);
    assert.equal(state.record.parentItem, parentItem);
    assert.equal(state.record.deleted, deleted);
    assert.ok(f.calls.every(call => call.method === "GET"));
  }
});

test("invalid shared-note state identities are rejected before any request", async () => {
  const f = fixture();
  const entry = { serverId: SERVER, key: NOTE, parentKey: PAPER };
  for (const invalid of [null, [], "note", { ...entry, serverId: "AnotherServer" }, { ...entry, key: "../bad" },
    { ...entry, parentKey: "../bad" }, { ...entry, itemType: "annotation" }, { key: NOTE, serverId: SERVER }]) {
    await rejectsCode(f.client.getNoteState(invalid), "INVALID_INPUT");
  }
  assert.equal(f.calls.length, 0);
});

test("failed or untrusted keyed reads never report shared-note deletion or absence", async () => {
  const scenarios = [
    { result: () => ({ status: 404, headers: {}, json: undefined }), code: "INVALID_RESPONSE" },
    { result: () => response(404, undefined, { "Zotero-Server-ID": "OtherServer" }), code: "SERVER_CHANGED" },
    { result: () => ({ status: 200, headers: {}, json: note() }), code: "INVALID_RESPONSE" },
    { result: () => response(200, note(), { "Zotero-Server-ID": "OtherServer" }), code: "SERVER_CHANGED" },
    { result: () => response(401), code: "AUTHORIZATION_REQUIRED" },
    { result: () => response(403), code: "FORBIDDEN" },
    { result: () => response(503), code: "REMOTE_ERROR" },
    { result: () => response(302), code: "HTTP_ERROR" },
    { result: () => response(204), code: "HTTP_ERROR" },
    { result: () => { throw new Error("Local transport failed"); }, code: "NETWORK" },
    { result: () => ({ status: "unknown", headers: { "Zotero-Server-ID": SERVER } }), code: "INVALID_RESPONSE" },
    { result: () => response(200, null), code: "INVALID_RESPONSE" }
  ];
  for (const { result, code } of scenarios) {
    const f = fixture(result);
    await rejectsCode(f.client.getNoteState({ serverId: SERVER, key: NOTE, parentKey: PAPER }), code);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, "GET");
  }
});

test("unexpected item identities, types and trash flags cannot confirm note removal", async () => {
  const invalid = [
    note("THRKEY22"),
    row(NOTE, { itemType: "attachment", parentItem: PAPER, contentType: "application/pdf" }),
    row(NOTE, { ...annotation().data, key: NOTE }),
    note(NOTE, "../bad")
  ];
  for (const deleted of [null, "1", "true", 2, {}, []]) {
    const value = note(); value.data.deleted = deleted; invalid.push(value);
  }
  for (const value of invalid) {
    const f = fixture(() => response(200, value));
    await rejectsCode(f.client.getNoteState({ serverId: SERVER, key: NOTE, parentKey: PAPER }), "INVALID_RESPONSE");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, "GET");
  }
});

function persistTrashFlag({ options, records }, returnedFlag) {
  if (options.method !== "PATCH") return;
  const previous = records.get(ANNOTATION);
  const data = { ...previous.data, ...JSON.parse(options.body) };
  if (returnedFlag === undefined) delete data.deleted;
  else data.deleted = returnedFlag;
  const saved = row(ANNOTATION, data, previous.version + 1);
  saved.data.version = saved.version;
  records.set(ANNOTATION, saved);
  return response(204);
}

function persistNoteTrashFlag({ options, records }, returnedFlag) {
  if (options.method !== "PATCH") return;
  const previous = records.get(NOTE);
  const data = { ...previous.data, ...JSON.parse(options.body) };
  if (returnedFlag === undefined) delete data.deleted;
  else data.deleted = returnedFlag;
  const saved = row(NOTE, data, previous.version + 1);
  saved.data.version = saved.version;
  records.set(NOTE, saved);
  return response(204);
}

test("paper note trash patches only deleted with a version guard and preserves the native note", async () => {
  for (const returnedFlag of [true, 1]) {
    const f = fixture(context => persistNoteTrashFlag(context, returnedFlag));
    const original = (await f.client.loadPaper(PAPER)).notes[0];
    const before = structuredClone(original);
    const paperBefore = structuredClone(f.records.get(PAPER));
    const pdfBefore = structuredClone(f.records.get(PDF));
    const annotationBefore = structuredClone(f.records.get(ANNOTATION));
    const saved = await f.client.trashNote(original, AUTH);
    const writes = f.calls.filter(call => call.method !== "GET");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PATCH");
    assert.equal(new URL(writes[0].url).pathname, `/api/users/0/items/${NOTE}`);
    assert.deepEqual(JSON.parse(writes[0].body), { deleted: 1 });
    assert.equal(writes[0].headers["If-Unmodified-Since-Version"], String(original.version));
    assert.equal(writes[0].headers["Zotero-API-Key"], AUTH);
    assert.equal(saved.deleted, returnedFlag);
    assert.equal(saved.version, original.version + 1);
    assert.equal(saved.note, original.note);
    assert.equal(saved.noteHTML, original.noteHTML);
    assert.equal(saved.parentItem, PAPER);
    assert.equal(saved.key, NOTE);
    assert.equal(saved.serverId, SERVER);
    assert.deepEqual(original, before);
    assert.deepEqual(f.records.get(PAPER), paperBefore);
    assert.deepEqual(f.records.get(PDF), pdfBefore);
    assert.deepEqual(f.records.get(ANNOTATION), annotationBefore);
    assert.ok(f.calls.every(call => ["GET", "PATCH"].includes(call.method)
      && !new URL(call.url).pathname.includes("/file")));
  }
});

test("note trash rejects invalid identities, authorizations and cached trash states before reading", async () => {
  const f = fixture();
  const original = { ...note().data, serverId: SERVER };
  const invalid = [null, [], "note", { ...original, serverId: "AnotherServer" },
    { ...original, itemType: "annotation" }, { ...original, key: "../bad" },
    { ...original, parentItem: "../bad" }, { ...original, parentItem: undefined },
    { ...original, version: NaN }, { ...original, version: -1 }];
  for (const deleted of [true, 1, null, "1", {}, []]) invalid.push({ ...original, deleted });
  for (const value of invalid) await rejectsCode(f.client.trashNote(value, AUTH), "INVALID_INPUT");
  await rejectsCode(f.client.trashNote(original, "bad-key"), "INVALID_INPUT");
  assert.equal(f.calls.length, 0);
});

test("note trash rechecks native identity, version, active state and paper ancestry before writing", async () => {
  const scenarios = [
    { change: value => { value.version++; value.data.version++; }, code: "CONFLICT" },
    { change: value => { value.data.deleted = true; }, code: "CONFLICT" },
    { change: value => { value.data.deleted = null; }, code: "INVALID_RESPONSE" },
    { change: value => { value.data.parentItem = "THRKEY22"; }, code: "CONFLICT" },
    { change: value => { delete value.data.parentItem; }, code: "CONFLICT" },
    { change: value => { value.data.itemType = "attachment"; }, code: "CONFLICT" },
    { change: (_, records) => { records.get(PAPER).data.deleted = true; }, code: "INVALID_RESPONSE" },
    { change: (_, records) => { records.get(PAPER).data.itemType = "note"; records.get(PAPER).data.note = "<p>Other note</p>"; }, code: "INVALID_RESPONSE" },
    { change: (_, records) => { records.delete(PAPER); }, code: "NOT_FOUND" }
  ];
  for (const { change, code } of scenarios) {
    const f = fixture();
    const original = (await f.client.loadPaper(PAPER)).notes[0];
    change(f.records.get(NOTE), f.records);
    await rejectsCode(f.client.trashNote(original, AUTH), code);
    assert.ok(f.calls.every(call => call.method === "GET"));
  }
});

test("note trash failures retain their native status and never repeat an uncertain write", async () => {
  for (const [outcome, code] of [["timeout", "WRITE_UNCERTAIN"], [503, "WRITE_UNCERTAIN"],
    [401, "AUTHORIZATION_REQUIRED"], [403, "FORBIDDEN"], [412, "CONFLICT"], ["server", "WRITE_UNCERTAIN"]]) {
    const f = fixture(({ options }) => {
      if (options.method !== "PATCH") return;
      if (outcome === "timeout") throw new Error("timeout");
      if (outcome === "server") return response(204, undefined, { "Zotero-Server-ID": "AnotherServer" });
      return response(outcome);
    });
    const original = (await f.client.loadPaper(PAPER)).notes[0];
    await rejectsCode(f.client.trashNote(original, AUTH), code);
    assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
    assert.ok(f.calls.every(call => ["GET", "PATCH"].includes(call.method)));
  }
});

test("note trash does not claim success without a verified native trash flag and advanced version", async () => {
  for (const failure of ["omitted", "invalid-flag", "missing", "network", "version", "server"]) {
    let wrote = false;
    const f = fixture(context => {
      if (context.options.method === "PATCH") {
        wrote = true;
        const result = persistNoteTrashFlag(context, failure === "omitted" ? undefined : failure === "invalid-flag" ? "1" : true);
        if (failure === "version") context.records.get(NOTE).version = context.records.get(NOTE).data.version = 1;
        return result;
      }
      if (wrote && context.url.pathname.endsWith(`/${NOTE}`)) {
        if (failure === "missing") return response(404);
        if (failure === "network") throw new Error("timeout");
        if (failure === "server") return response(200, context.records.get(NOTE), { "Zotero-Server-ID": "AnotherServer" });
      }
    });
    const original = (await f.client.loadPaper(PAPER)).notes[0];
    await rejectsCode(f.client.trashNote(original, AUTH), "WRITE_UNCERTAIN");
    assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
  }
});

test("note trash verification detects concurrent content, ancestry, type and trash-state changes", async () => {
  for (const altered of [{ note: "<p>Changed by Zotero</p>" }, { parentItem: "THRKEY22" },
    { itemType: "attachment" }, { deleted: false }]) {
    const f = fixture(context => {
      if (context.options.method !== "PATCH") return;
      const result = persistNoteTrashFlag(context, true);
      Object.assign(context.records.get(NOTE).data, altered);
      return result;
    });
    const original = (await f.client.loadPaper(PAPER)).notes[0];
    await rejectsCode(f.client.trashNote(original, AUTH), "CONFLICT");
    assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
  }
});

test("trashing an annotation patches only deleted and verifies native boolean normalization", async () => {
  for (const returnedFlag of [true, 1]) {
    const f = fixture(context => persistTrashFlag(context, returnedFlag));
    const original = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
    const pdfBefore = JSON.parse(JSON.stringify(f.records.get(PDF)));
    const saved = await f.client.trashAnnotation(original, AUTH);
    const writes = f.calls.filter(call => call.method !== "GET");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PATCH");
    assert.equal(new URL(writes[0].url).pathname, `/api/users/0/items/${ANNOTATION}`);
    assert.deepEqual(JSON.parse(writes[0].body), { deleted: 1 });
    assert.equal(writes[0].headers["If-Unmodified-Since-Version"], String(original.version));
    assert.equal(writes[0].headers["Zotero-API-Key"], AUTH);
    assert.equal(saved.deleted, returnedFlag);
    assert.equal(saved.version, original.version + 1);
    for (const name of Object.keys(original).filter(name => name.startsWith("annotation"))) {
      assert.equal(saved[name], original[name]);
    }
    assert.deepEqual(saved.position, original.position);
    assert.equal(original.deleted, undefined);
    assert.deepEqual(f.records.get(PDF), pdfBefore);
    assert.ok(f.calls.every(call => !new URL(call.url).pathname.includes("/file")));
  }
});

test("restoration patches deleted zero and accepts native omitted or false active flags", async () => {
  for (const returnedFlag of [undefined, false, 0]) {
    const f = fixture(context => persistTrashFlag(context, returnedFlag));
    f.records.set(ANNOTATION, annotation({ deleted: true }));
    const recovery = { ...f.records.get(ANNOTATION).data, serverId: SERVER };
    const saved = await f.client.restoreAnnotation(recovery, AUTH);
    const writes = f.calls.filter(call => call.method !== "GET");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PATCH");
    assert.deepEqual(JSON.parse(writes[0].body), { deleted: 0 });
    assert.equal(writes[0].headers["If-Unmodified-Since-Version"], "1");
    assert.equal(saved.deleted, returnedFlag);
    assert.equal(saved.version, 2);
    assert.equal(saved.annotationText, recovery.annotationText);
    assert.equal(saved.annotationComment, recovery.annotationComment);
    assert.equal(saved.annotationPosition, recovery.annotationPosition);
    assert.equal(recovery.deleted, true);
  }
});

test("annotation recovery reads current active or trashed state without a version precondition or write", async () => {
  for (const deleted of [undefined, true]) {
    const f = fixture();
    const old = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
    const current = annotation(deleted === undefined ? {} : { deleted });
    current.version = current.data.version = 4;
    f.records.set(ANNOTATION, current);
    const fresh = await f.client.getAnnotation(old);
    assert.equal(fresh.version, 4);
    assert.equal(fresh.deleted, deleted);
    assert.equal(fresh.parentItem, PDF);
    assert.ok(f.calls.every(call => call.method === "GET" && !call.headers["Zotero-API-Key"]
      && !call.headers["If-Unmodified-Since-Version"]));
  }
});

test("trash and restore reject invalid server identities, nonannotations and wrong cached recovery states", async () => {
  const f = fixture();
  const record = { ...annotation().data, serverId: SERVER };
  for (const invalid of [{ ...record, serverId: "OtherServer" }, { ...record, itemType: "note" },
    { ...record, key: "../bad" }, { ...record, parentItem: "../bad" }, { ...record, version: NaN }]) {
    await rejectsCode(f.client.trashAnnotation(invalid, AUTH), "INVALID_INPUT");
    await rejectsCode(f.client.restoreAnnotation({ ...invalid, deleted: true }, AUTH), "INVALID_INPUT");
  }
  await rejectsCode(f.client.trashAnnotation({ ...record, deleted: true }, AUTH), "INVALID_INPUT");
  await rejectsCode(f.client.restoreAnnotation(record, AUTH), "INVALID_INPUT");
  await rejectsCode(f.client.trashAnnotation(record, "bad-key"), "INVALID_INPUT");
  assert.equal(f.calls.length, 0);
});

test("fresh recovery guards reject concurrent changes, unavailable parents and explicit external annotations", async () => {
  const scenarios = [
    { change: value => { value.version++; value.data.version++; }, code: "CONFLICT" },
    { change: value => { value.data.deleted = true; }, code: "CONFLICT" },
    { change: value => { value.data.parentItem = "THRKEY22"; }, code: "CONFLICT" },
    { change: value => { value.data.annotationIsExternal = true; }, code: "FORBIDDEN" },
    { change: (_, records) => { records.get(PDF).data.deleted = true; }, code: "INVALID_RESPONSE" },
    { change: (_, records) => { records.get(PAPER).data.deleted = true; }, code: "INVALID_RESPONSE" }
  ];
  for (const { change, code } of scenarios) {
    const f = fixture();
    const record = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
    change(f.records.get(ANNOTATION), f.records);
    await rejectsCode(f.client.trashAnnotation(record, AUTH), code);
    assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
  }
  const f = fixture();
  const record = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
  await rejectsCode(f.client.trashAnnotation({ ...record, annotationIsExternal: true }, AUTH), "FORBIDDEN");
  f.records.set(ANNOTATION, annotation({ deleted: true }));
  const recovery = { ...f.records.get(ANNOTATION).data, serverId: SERVER };
  f.records.get(ANNOTATION).version = f.records.get(ANNOTATION).data.version = 2;
  await rejectsCode(f.client.restoreAnnotation(recovery, AUTH), "CONFLICT");
  f.records.get(ANNOTATION).version = f.records.get(ANNOTATION).data.version = 1;
  delete f.records.get(ANNOTATION).data.deleted;
  await rejectsCode(f.client.restoreAnnotation(recovery, AUTH), "CONFLICT");
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});

test("getAnnotation revalidates identity, PDF ancestry and external flags without mutation", async () => {
  for (const scenario of ["server", "parent", "external", "cached-external", "pdf", "paper"]) {
    const f = fixture();
    const record = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
    if (scenario === "server") record.serverId = "OtherServer";
    if (scenario === "parent") f.records.get(ANNOTATION).data.parentItem = "THRKEY22";
    if (scenario === "external") f.records.get(ANNOTATION).data.annotationIsExternal = true;
    if (scenario === "cached-external") record.annotationIsExternal = true;
    if (scenario === "pdf") f.records.get(PDF).data.contentType = "text/html";
    if (scenario === "paper") f.records.get(PAPER).data.deleted = true;
    await assert.rejects(f.client.getAnnotation(record), error => ["INVALID_INPUT", "CONFLICT", "FORBIDDEN", "INVALID_RESPONSE"].includes(error.code));
    assert.ok(f.calls.every(call => call.method === "GET"));
  }
});

test("recovery writes never retry after transport failures, changed servers or version conflicts", async () => {
  for (const [outcome, code] of [["timeout", "WRITE_UNCERTAIN"], [503, "WRITE_UNCERTAIN"],
    [412, "CONFLICT"], [403, "FORBIDDEN"], ["server", "WRITE_UNCERTAIN"]]) {
    const f = fixture(({ options }) => {
      if (options.method !== "PATCH") return;
      if (outcome === "timeout") throw new Error("timeout");
      if (outcome === "server") return response(204, undefined, { "Zotero-Server-ID": "OtherServer" });
      return response(outcome);
    });
    const original = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
    await rejectsCode(f.client.trashAnnotation(original, AUTH), code);
    assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
    assert.ok(f.calls.every(call => ["GET", "PATCH"].includes(call.method)));
  }
});

test("missing or unreadable postwrite verification never claims that an annotation is recoverably trashed", async () => {
  for (const failure of ["omitted", "missing", "network", "version"]) {
    let wrote = false;
    const f = fixture(context => {
      if (context.options.method === "PATCH") {
        wrote = true;
        const result = persistTrashFlag(context, failure === "omitted" ? undefined : true);
        if (failure === "version") {
          context.records.get(ANNOTATION).version = context.records.get(ANNOTATION).data.version = 1;
        }
        return result;
      }
      if (wrote && context.url.pathname.endsWith(`/${ANNOTATION}`)) {
        if (failure === "missing") return response(404);
        if (failure === "network") throw new Error("timeout");
      }
    });
    const original = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
    await rejectsCode(f.client.trashAnnotation(original, AUTH), "WRITE_UNCERTAIN");
    assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
  }
});

test("recovery verification reports conflicts if annotation content or recovery state changes", async () => {
  for (const altered of [{ annotationText: "Other text" }, { annotationComment: "Other comment" },
    { annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[2, 3, 4, 5]] }) }, { deleted: false }]) {
    const f = fixture(context => {
      if (context.options.method !== "PATCH") return;
      const result = persistTrashFlag(context, true);
      Object.assign(context.records.get(ANNOTATION).data, altered);
      return result;
    });
    const original = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
    await rejectsCode(f.client.trashAnnotation(original, AUTH), "CONFLICT");
    assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
  }
});

test("loads notes and all annotation fields with server identity and parsed position", async () => {
  const f = fixture();
  const loaded = await f.client.loadPaper(PAPER, [PDF, PDF]);
  assert.equal(loaded.serverId, SERVER);
  assert.equal(loaded.parentKey, PAPER);
  assert.equal(loaded.notes[0].noteHTML, "<p>Original</p>");
  assert.equal(loaded.notes[0].version, 1);
  assert.equal(loaded.annotations.length, 1);
  assert.equal(loaded.annotations[0].annotationSortIndex, "00000|000000|00000");
  assert.deepEqual(loaded.annotations[0].position.rects, [[1, 2, 3, 4]]);
  assert.ok(f.calls.every(call => call.method === "GET" && !call.headers["Zotero-API-Key"]));
});

test("authorization is explicit, identifies the app, and returns the runtime key", async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.client.authorize(), { key: AUTH, remember: true });
  assert.deepEqual(JSON.parse(f.calls[0].body), { appName: "Noema Obsidian" });
  assert.equal(f.calls[0].method, "POST");
  assert.equal(f.calls[0].headers["Zotero-API-Key"], undefined);
});

test("notes are created once with a verified server-allocated key and no client key or version", async () => {
  const f = fixture();
  const saved = await f.client.createNote(PAPER, "<p>New note</p>", AUTH);
  const writes = f.calls.filter(call => call.method === "POST");
  assert.equal(writes.length, 1);
  const [body] = JSON.parse(writes[0].body);
  assert.equal(body.key, undefined);
  assert.equal(body.version, undefined);
  assert.equal(body.parentItem, PAPER);
  assert.equal(writes[0].headers["Zotero-API-Key"], AUTH);
  assert.equal(saved.noteHTML, "<p>New note</p>");
  assert.equal(saved.key, "SRVRKEY2");
  assert.equal(saved.itemType, "note");
  assert.equal(saved.serverId, SERVER);
  assert.equal(saved.version, 2);
  assert.equal(f.calls.length, 2); // Parent read, then one POST; no guessed-key lookups.
});

test("note updates patch only note with the version precondition", async () => {
  const f = fixture();
  const loaded = await f.client.loadPaper(PAPER, []);
  const saved = await f.client.saveNote(loaded.notes[0], "<p>Edited</p>", AUTH);
  const [write] = f.calls.filter(call => call.method === "PATCH");
  assert.deepEqual(JSON.parse(write.body), { note: "<p>Edited</p>" });
  assert.equal(write.headers["If-Unmodified-Since-Version"], "1");
  assert.equal(saved.noteHTML, "<p>Edited</p>");
  assert.equal(saved.version, 2);
});

test("highlight creation stores only a native PDF annotation, without file writes", async () => {
  const f = fixture();
  const saved = await f.client.createHighlight(PDF, highlight(), AUTH);
  const [body] = JSON.parse(f.calls.find(call => call.method === "POST").body);
  assert.equal(body.annotationType, "highlight");
  assert.equal(body.key, undefined);
  assert.equal(body.version, undefined);
  assert.equal(body.annotationColor, "#ffd400");
  assert.equal(body.annotationIsExternal, undefined); // Not part of native Web API item JSON.
  assert.deepEqual(JSON.parse(body.annotationPosition), { pageIndex: 0, rects: [[1, 2, 3, 4]] });
  assert.equal(saved.parentItem, PDF);
  assert.equal(saved.key, "SRVRKEY2");
  assert.ok(f.calls.every(call => !new URL(call.url).pathname.includes("/file")));
});

test("comment updates patch only annotationComment and preserve geometry", async () => {
  const f = fixture();
  const loaded = await f.client.loadPaper(PAPER, [PDF]);
  const saved = await f.client.saveComment(loaded.annotations[0], "New comment", AUTH);
  assert.deepEqual(JSON.parse(f.calls.find(call => call.method === "PATCH").body), { annotationComment: "New comment" });
  assert.deepEqual(saved.position, { pageIndex: 0, rects: [[1, 2, 3, 4]] });
});

test("native palette colors and underline selections round-trip without changing text or geometry", async () => {
  const palette = ["#ffd400", "#ff6666", "#5fb236", "#2ea8e5", "#a28ae5", "#e56eee", "#f19837", "#aaaaaa"];
  for (const color of palette) {
    for (const type of ["highlight", "underline"]) {
      const f = fixture();
      const selection = highlight({ color: color.toUpperCase(), type });
      const original = JSON.parse(JSON.stringify(selection));
      const saved = await f.client.createHighlight(PDF, selection, AUTH);
      const [payload] = JSON.parse(f.calls.find(call => call.method === "POST").body);
      assert.equal(payload.annotationType, type);
      assert.equal(saved.annotationType, type);
      assert.equal(saved.annotationColor, color);
      assert.equal(saved.annotationText, original.text);
      assert.equal(saved.annotationComment, original.comment);
      assert.deepEqual(saved.position, original.position);
      assert.equal(payload.annotationAuthorName, undefined);
      assert.equal(payload.annotationIsExternal, undefined);
      assert.deepEqual(selection, original);
    }
  }
});

test("style updates patch only chosen fields and preserve native annotation content", async () => {
  const f = fixture();
  f.records.get(ANNOTATION).data.annotationAuthorName = "Original author";
  const original = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
  const saved = await f.client.saveAnnotationStyle(original, { color: "#A28AE5", type: "underline" }, AUTH);
  const writes = f.calls.filter(call => call.method === "PATCH");
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].body), { annotationColor: "#a28ae5", annotationType: "underline" });
  assert.equal(writes[0].headers["If-Unmodified-Since-Version"], String(original.version));
  assert.equal(saved.annotationType, "underline");
  assert.equal(saved.annotationColor, "#a28ae5");
  for (const field of ["key", "parentItem", "annotationText", "annotationComment", "annotationAuthorName", "annotationPageLabel", "annotationSortIndex", "annotationPosition"]) {
    assert.equal(saved[field], original[field]);
  }
  assert.deepEqual(saved.position, original.position);
  assert.equal(saved.version, original.version + 1);
  assert.equal(original.annotationType, "highlight");
});

test("single-field style changes keep the other style and repeated choices need no PATCH", async () => {
  const f = fixture();
  const original = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
  const colored = await f.client.saveAnnotationStyle(original, { color: "#2ea8e5" }, AUTH);
  assert.equal(colored.annotationType, "highlight");
  const underlined = await f.client.saveAnnotationStyle(colored, { type: "underline" }, AUTH);
  assert.equal(underlined.annotationColor, "#2ea8e5");
  const repeated = await f.client.saveAnnotationStyle(underlined, { color: "#2EA8E5", type: "underline" }, AUTH);
  assert.equal(repeated.version, underlined.version);
  assert.deepEqual(f.calls.filter(call => call.method === "PATCH").map(call => JSON.parse(call.body)), [
    { annotationColor: "#2ea8e5" }, { annotationType: "underline" }
  ]);
});

test("invalid styles and unsupported creation types are rejected before requests", async () => {
  const f = fixture();
  const record = { ...annotation().data, serverId: SERVER };
  const invalid = [null, [], {}, { color: null }, { color: "#1234" }, { color: "red" }, { type: null },
    { type: "image" }, { type: "Underline" }, { annotationPosition: "{}" }, { color: "#ffd400", parentItem: PAPER }];
  for (const style of invalid) await rejectsCode(f.client.saveAnnotationStyle(record, style, AUTH), "INVALID_INPUT");
  for (const type of [null, "note", "image", "ink", "Underline"]) {
    await rejectsCode(f.client.createHighlight(PDF, highlight({ type }), AUTH), "INVALID_INPUT");
  }
  assert.equal(f.calls.length, 0);
});

test("style changes reject unsupported, external, stale and moved annotation records", async () => {
  for (const type of ["note", "text", "image", "ink"]) {
    const f = fixture();
    f.records.set(ANNOTATION, annotation({ annotationType: type }));
    const record = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
    await rejectsCode(f.client.saveAnnotationStyle(record, { color: "#ff6666" }, AUTH), "UNSUPPORTED_ANNOTATION");
    assert.equal(f.calls.filter(call => call.method === "PATCH").length, 0);
  }
  for (const change of [value => { value.version++; value.data.version++; }, value => { value.data.parentItem = "THRKEY22"; },
    value => { value.data.annotationIsExternal = true; }]) {
    const f = fixture();
    const record = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
    change(f.records.get(ANNOTATION));
    await assert.rejects(f.client.saveAnnotationStyle(record, { type: "underline" }, AUTH), error => ["CONFLICT", "FORBIDDEN"].includes(error.code));
    assert.equal(f.calls.filter(call => call.method === "PATCH").length, 0);
  }
  const f = fixture();
  delete f.records.get(ANNOTATION).data.annotationIsExternal;
  const record = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
  await rejectsCode(f.client.saveAnnotationStyle({ ...record, annotationIsExternal: true }, { color: "#ff6666" }, AUTH), "FORBIDDEN");
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 0);
});

test("style verification detects text or geometry changed after saving", async () => {
  for (const altered of [{ annotationText: "Concurrent text" }, { annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[2, 3, 4, 5]] }) }]) {
    const f = fixture(({ options, records }) => {
      if (options.method !== "PATCH") return;
      const previous = records.get(ANNOTATION);
      records.set(ANNOTATION, row(ANNOTATION, { ...previous.data, ...JSON.parse(options.body), ...altered, version: 2 }, 2));
      return response(204);
    });
    const record = (await f.client.loadPaper(PAPER, [PDF])).annotations[0];
    await assert.rejects(f.client.saveAnnotationStyle(record, { color: "#ff6666", type: "underline" }, AUTH), error => {
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.itemKey, ANNOTATION);
      return true;
    });
    assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
  }
});

test("stale records and changed parents are rejected before mutation", async () => {
  for (const change of [value => { value.version++; value.data.version++; }, value => { value.data.parentItem = "THRKEY22"; }]) {
    const f = fixture();
    const loaded = await f.client.loadPaper(PAPER, []);
    change(f.records.get(NOTE));
    await rejectsCode(f.client.saveNote(loaded.notes[0], "edit", AUTH), "CONFLICT");
    assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
  }
});

test("a concurrent version change between read and patch returns CONFLICT", async () => {
  const f = fixture(({ options }) => options.method === "PATCH" ? response(412) : undefined);
  const loaded = await f.client.loadPaper(PAPER, []);
  await rejectsCode(f.client.saveNote(loaded.notes[0], "edit", AUTH), "CONFLICT");
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
});

test("wrong server records and changed server responses cannot be written", async () => {
  const f = fixture();
  await rejectsCode(f.client.saveNote({ ...note().data, serverId: "Another" }, "edit", AUTH), "INVALID_INPUT");
  assert.equal(f.calls.length, 0);
  const g = fixture(() => response(200, row(PAPER, { itemType: "journalArticle" }), { "Zotero-Server-ID": "Another" }));
  await rejectsCode(g.client.createNote(PAPER, "note", AUTH), "SERVER_CHANGED");
  assert.equal(g.calls.length, 1);
});

test("missing response identity and malformed child data are rejected", async () => {
  const f = fixture(() => response(200, row(PAPER, { itemType: "journalArticle" }), { "Zotero-Server-ID": "" }));
  await rejectsCode(f.client.loadPaper(PAPER, []), "INVALID_RESPONSE");
  const g = fixture();
  g.records.get(ANNOTATION).data.annotationPosition = "not-json";
  await rejectsCode(g.client.loadPaper(PAPER, [PDF]), "INVALID_RESPONSE");
});

test("an explicitly identified external annotation cannot have its comment mutated", async () => {
  const f = fixture();
  f.records.set(ANNOTATION, annotation({ annotationIsExternal: true }));
  const loaded = await f.client.loadPaper(PAPER, [PDF]);
  await rejectsCode(f.client.saveComment(loaded.annotations[0], "edit", AUTH), "FORBIDDEN");
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 0);
});

test("invalid keys, secrets, oversized text and invalid highlights cause no requests", async () => {
  const f = fixture();
  const invalid = [
    f.client.loadPaper("../PAPER", []), f.client.loadPaper(PAPER, ["P0F2KEYX"]),
    f.client.createNote(PAPER, "note", "invalid"), f.client.createNote(PAPER, "x".repeat(512 * 1024 + 1), AUTH),
    f.client.createHighlight(PDF, highlight({ sortIndex: "00001|000000|00000" }), AUTH),
    f.client.createHighlight(PDF, highlight({ position: { pageIndex: 0, rects: [[1, 2, Infinity, 4]] } }), AUTH),
    f.client.createHighlight(PDF, highlight({ position: { pageIndex: 0, rects: [[3, 2, 1, 4]] } }), AUTH),
    f.client.createHighlight(PDF, highlight({ position: { pageIndex: -1, rects: [[1, 2, 3, 4]] } }), AUTH),
    f.client.createHighlight(PDF, highlight({ color: "javascript:bad" }), AUTH)
  ];
  await Promise.all(invalid.map(promise => rejectsCode(promise, "INVALID_INPUT")));
  assert.equal(f.calls.length, 0);
});

test("authorization failures are structured and never trigger another authorization", async () => {
  const f = fixture(({ url, options }) => {
    if (url.pathname === "/api/local/authorize") return response(403, { denied: true });
    if (options.method === "POST") return response(401);
  });
  await rejectsCode(f.client.authorize(), "AUTHORIZATION_DENIED");
  await rejectsCode(f.client.createNote(PAPER, "note", AUTH), "AUTHORIZATION_REQUIRED");
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === "/api/local/authorize").length, 1);
});

test("a committed note POST timeout stays uncertain without guessing its key or retrying", async () => {
  const f = fixture(({ options, records }) => {
    if (options.method !== "POST") return;
    const [body] = JSON.parse(options.body);
    const saved = row("SRVRKEY2", body, 2);
    saved.data.version = 2;
    records.set(saved.key, saved);
    throw new Error("timeout with sensitive details");
  });
  await assert.rejects(f.client.createNote(PAPER, "note", AUTH), error => {
    assert.equal(error.code, "WRITE_UNCERTAIN");
    assert.equal(error.itemKey, undefined);
    assert.match(error.message, /Check Zotero and refresh/);
    assert.ok(!error.message.includes(AUTH));
    return true;
  });
  const writes = f.calls.filter(call => call.method === "POST");
  assert.equal(writes.length, 1);
  assert.equal(f.records.get("SRVRKEY2").data.note, "note");
  assert.equal(JSON.parse(writes[0].body)[0].key, undefined);
  assert.equal(f.calls.length, 2);
});

test("a highlight POST timeout reports uncertainty without inventing a key or retrying", async () => {
  const f = fixture(({ options }) => { if (options.method === "POST") throw new Error("timeout"); });
  await assert.rejects(f.client.createHighlight(PDF, highlight(), AUTH), error => {
    assert.equal(error.code, "WRITE_UNCERTAIN");
    assert.equal(error.itemKey, undefined);
    assert.match(error.message, /Check Zotero and refresh/);
    assert.ok(!error.message.includes(AUTH));
    return true;
  });
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("a PATCH timeout reports uncertainty and never retries", async () => {
  const f = fixture(({ options }) => { if (options.method === "PATCH") throw new Error("timeout"); });
  const loaded = await f.client.loadPaper(PAPER, []);
  await rejectsCode(f.client.saveNote(loaded.notes[0], "edit", AUTH), "WRITE_UNCERTAIN");
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
});

test("pagination loads all child notes without duplicates", async () => {
  const f = fixture();
  for (let i = 0; i < 101; i++) {
    const key = "ZZZZZZ" + ALPHABET[(i >> 5) & 31] + ALPHABET[i & 31];
    f.records.set(key, note(key));
  }
  const loaded = await f.client.loadPaper(PAPER, []);
  assert.equal(loaded.notes.length, 102);
  assert.equal(f.calls.filter(call => call.url.includes("/children")).length, 2);
});

test("changed pagination metadata is rejected instead of mixing snapshots", async () => {
  const f = fixture(({ url }) => {
    if (!url.pathname.endsWith("/children")) return;
    const start = Number(url.searchParams.get("start"));
    const items = Array.from({ length: start ? 1 : 100 }, (_, i) => {
      const index = start + i;
      return note("YYYYYY" + ALPHABET[(index >> 5) & 31] + ALPHABET[index & 31]);
    });
    return response(200, items, { "Total-Results": "101", "Last-Modified-Version": start ? "8" : "7" });
  });
  await rejectsCode(f.client.loadPaper(PAPER, []), "CONFLICT");
});

test("an attachment from a different paper is rejected", async () => {
  const f = fixture();
  f.records.get(PDF).data.parentItem = "THRKEY22";
  await rejectsCode(f.client.loadPaper(PAPER, [PDF]), "INVALID_RESPONSE");
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});

test("new notes reject client-supplied keys before any request", async () => {
  const f = fixture();
  for (const itemKey of ["DRAFTKEY", "../invalid-key", null]) {
    await rejectsCode(f.client.createNote(PAPER, "<p>Draft</p>", AUTH, { itemKey }), "UNSUPPORTED_OPTION");
  }
  assert.equal(f.calls.length, 0);
});

test("client-supplied existing note and annotation keys are rejected without creation", async () => {
  const f = fixture();
  await rejectsCode(f.client.createNote(PAPER, "Different HTML", AUTH, { itemKey: NOTE }), "UNSUPPORTED_OPTION");
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  await rejectsCode(f.client.createHighlight(PDF, highlight({ comment: "Other" }), AUTH, { itemKey: ANNOTATION }), "UNSUPPORTED_OPTION");
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
});

test("a valid server-allocated note with different HTML is a conflict carrying its actual key", async () => {
  const f = fixture(({ options, records }) => {
    if (options.method !== "POST") return;
    const [body] = JSON.parse(options.body);
    const saved = row("SRVRKEY2", { ...body, note: "Remote edit" }, 3);
    saved.data.version = 3;
    records.set(saved.key, saved);
    return response(200, { successful: { 0: saved }, unchanged: {}, failed: {} });
  });
  await assert.rejects(f.client.createNote(PAPER, "My draft", AUTH), error => {
    assert.equal(error.code, "CONFLICT");
    assert.equal(error.itemKey, "SRVRKEY2");
    assert.equal(error.record.noteHTML, "Remote edit");
    return true;
  });
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("server-allocated notes verify available type, parent and exact normalized HTML", async () => {
  for (const altered of [{ itemType: "attachment" }, { parentItem: "THRKEY22" }, { note: "Other HTML" }, { deleted: true }]) {
    const f = fixture(({ options }) => {
      if (options.method !== "POST") return;
      const [payload] = JSON.parse(options.body);
      return response(200, { successful: { 0: row("SRVRKEY2", { ...payload, ...altered }, 2) }, unchanged: {}, failed: {} });
    });
    await assert.rejects(f.client.createNote(PAPER, "<p>Draft</p>", AUTH), error => {
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.itemKey, "SRVRKEY2");
      assert.equal(error.record.key, "SRVRKEY2");
      return true;
    });
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  }
});

test("ambiguous note creation responses never invent a key, look up candidates or retry", async () => {
  const saved = row("SRVRKEY2", { itemType: "note", parentItem: PAPER, note: "Draft" }, 2);
  const outcomes = [response(500), { ...response(200), json: undefined, text: "broken{" },
    response(200, { successful: {}, unchanged: {}, failed: {} }),
    response(200, { successful: { 0: { data: { itemType: "note", parentItem: PAPER } } }, unchanged: {}, failed: {} }),
    response(200, { successful: { 0: row("INVALID0", { itemType: "note", parentItem: PAPER, note: "Draft" }, 2) }, unchanged: {}, failed: {} }),
    response(200, { successful: { 0: saved }, unchanged: { 0: "SRVRKEY2" }, failed: {} }),
    response(200, { successful: { 1: saved }, unchanged: {}, failed: {} }),
    response(200, { successful: {}, unchanged: { 0: "SRVRKEY2" }, failed: {} }),
    response(200, { successful: { 0: saved }, unchanged: {}, failed: {} }, { "Zotero-Server-ID": "AnotherServer" }),
    response(200, { successful: { 0: row("SRVRKEY2", { itemType: "note", parentItem: PAPER, note: null }, 2) }, unchanged: {}, failed: {} })];
  for (const outcome of outcomes) {
    const f = fixture(({ options }) => options.method === "POST" ? outcome : undefined);
    await assert.rejects(f.client.createNote(PAPER, "Draft", AUTH), error => {
      assert.equal(error.code, "WRITE_UNCERTAIN");
      assert.equal(error.itemKey, undefined);
      assert.equal(error.record, undefined);
      return true;
    });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  }
});

test("explicit note creation rejection remains a structured failure without retries", async () => {
  const f = fixture(({ options }) => options.method === "POST" ? response(200, {
    successful: {}, unchanged: {}, failed: { 0: { code: 400, message: "Invalid note HTML" } }
  }) : undefined);
  await assert.rejects(f.client.createNote(PAPER, "Draft", AUTH), error => {
    assert.equal(error.code, "HTTP_ERROR");
    assert.equal(error.status, 400);
    assert.equal(error.reason, "Invalid note HTML");
    assert.equal(error.itemKey, undefined);
    return true;
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("post-save reads reject later remote edits instead of rebasing the draft", async () => {
  const f = fixture(({ options, records }) => {
    if (options.method !== "PATCH") return;
    records.set(NOTE, note(NOTE, PAPER, 3));
    records.get(NOTE).data.note = "<p>Other editor</p>";
    return response(204);
  });
  const loaded = await f.client.loadPaper(PAPER, []);
  await assert.rejects(f.client.saveNote(loaded.notes[0], "<p>My edit</p>", AUTH), error => {
    assert.equal(error.code, "CONFLICT");
    assert.equal(error.record.noteHTML, "<p>Other editor</p>");
    return true;
  });
});

test("native setter normalization is applied before saving", async () => {
  const f = fixture();
  const noteSaved = await f.client.createNote(PAPER, "  <p>Hi\u0001</p>  ", AUTH);
  assert.equal(noteSaved.noteHTML, "<p>Hi</p>");
  const annotationSaved = await f.client.createHighlight(PDF, highlight({ text: " e\u0301 ", comment: "  comment  " }), AUTH);
  assert.equal(annotationSaved.annotationText, "é");
  assert.equal(annotationSaved.annotationComment, "comment");
});

test("per-item write failure retains a bounded reason and redacts authorization keys", async () => {
  const f = fixture(({ options }) => options.method === "POST" ? response(200, {
    successful: {}, unchanged: {}, failed: { 0: { code: 400,
      message: `Annotation parent must be a PDF\nToken ${AUTH}\u0000 ${"x ".repeat(300)}` } }
  }) : undefined);
  await assert.rejects(f.client.createHighlight(PDF, highlight(), AUTH), error => {
    assert.equal(error.code, "HTTP_ERROR");
    assert.equal(error.status, 400);
    assert.match(error.reason, /^Annotation parent must be a PDF Token \[redacted\]/);
    assert.ok(error.reason.length <= 300);
    assert.ok(!error.message.includes(AUTH));
    assert.ok(!/[\u0000-\u001F\u007F-\u009F]/.test(error.reason));
    return true;
  });
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("plain HTTP errors expose a short reason without headers or request payload", async () => {
  const f = fixture(({ options }) => options.method === "POST" ? {
    ...response(400), text: `Invalid annotation color\r\n${AUTH}`
  } : undefined);
  await assert.rejects(f.client.createHighlight(PDF, highlight(), AUTH), error => {
    assert.equal(error.reason, "Invalid annotation color [redacted]");
    assert.ok(!error.message.includes("Selected text"));
    return true;
  });
});

test("new highlights reject client-supplied item keys before requests", async () => {
  const f = fixture();
  await rejectsCode(f.client.createHighlight(PDF, highlight(), AUTH, { itemKey: "DRAFTKEY" }), "UNSUPPORTED_OPTION");
  assert.equal(f.calls.length, 0);
});

test("server-keyed highlight success rejects missing or malformed returned records", async () => {
  for (const successful of [{}, { 0: { data: { itemType: "annotation", parentItem: PDF } } }]) {
    const f = fixture(({ options }) => options.method === "POST"
      ? response(200, { successful, unchanged: {}, failed: {} }) : undefined);
    await rejectsCode(f.client.createHighlight(PDF, highlight(), AUTH), "WRITE_UNCERTAIN");
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  }
});

test("server-keyed highlight success validates parent and all submitted content", async () => {
  const changed = [
    { parentItem: "THRKEY22" }, { annotationType: "underline" }, { annotationText: "Other text" },
    { annotationComment: "Other comment" }, { annotationColor: "#ff6666" }, { annotationPageLabel: "2" },
    { annotationSortIndex: "00000|000001|00000" },
    { annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[2, 3, 4, 5]] }) }
  ];
  for (const fields of changed) {
    const f = fixture(({ options }) => {
      if (options.method !== "POST") return;
      const [data] = JSON.parse(options.body);
      return response(200, { successful: { 0: row("SRVRKEY2", { ...data, ...fields }, 2) }, unchanged: {}, failed: {} });
    });
    await rejectsCode(f.client.createHighlight(PDF, highlight(), AUTH), "CONFLICT");
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  }
});

test("highlight creation does not retry or invent a key after remote/unreadable responses", async () => {
  for (const result of [response(500), { ...response(200), json: undefined, text: "incomplete{" }]) {
    const f = fixture(({ options }) => options.method === "POST" ? result : undefined);
    await assert.rejects(f.client.createHighlight(PDF, highlight(), AUTH), error => {
      assert.equal(error.code, "WRITE_UNCERTAIN");
      assert.equal(error.itemKey, undefined);
      return true;
    });
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
    assert.equal(f.calls.filter(call => call.url.includes("/children")).length, 0);
  }
});

test("note discovery pages through native notes with a stable library version and cursor", async () => {
  const keys = Array.from({ length: 101 }, (_, i) => `N${Array.from({ length: 7 }, (_, p) => ALPHABET[Math.floor(i / 32 ** p) % 32]).join("")}`);
  const f = fixture(({ url, options }) => {
    assert.equal(options.method, "GET");
    assert.equal(url.searchParams.get("itemType"), "note");
    assert.equal(url.searchParams.get("includeTrashed"), "0");
    assert.equal(url.searchParams.get("since"), "4");
    const start = Number(url.searchParams.get("start"));
    return response(200, keys.slice(start, start + 100).map(key => note(key, PAPER, 5)), { "Total-Results": "101", "Last-Modified-Version": "7" });
  });
  const found = await f.client.discoverNotes(4);
  assert.equal(found.notes.length, 101); assert.equal(found.libraryVersion, 7);
  assert.equal(f.calls.length, 2);
  assert(f.calls.every(call => !call.headers["Zotero-API-Key"]));
});

test("discovery refuses incomplete pages, duplicate notes, invalid cursors and changing versions", async () => {
  for (const scenario of [
    () => response(200, [], { "Total-Results": "1", "Last-Modified-Version": "7" }),
    () => response(200, [note(), note()], { "Total-Results": "2", "Last-Modified-Version": "7" }),
    () => response(200, [], { "Total-Results": "0", "Last-Modified-Version": "1" }),
    () => response(200, [], { "Total-Results": "many", "Last-Modified-Version": "7" })
  ]) {
    const f = fixture(scenario);
    await assert.rejects(f.client.discoverNotes(4));
  }
  const f = fixture(({ url }) => {
    const start = Number(url.searchParams.get("start"));
    return response(200, start ? [note("LAST2222")] : Array.from({ length: 100 }, (_, i) => note(`N${Array.from({ length: 7 }, (_, p) => ALPHABET[Math.floor(i / 32 ** p) % 32]).join("")}`)),
      { "Total-Results": "101", "Last-Modified-Version": start ? "8" : "7" });
  });
  await rejectsCode(f.client.discoverNotes(), "CONFLICT");
  await rejectsCode(f.client.discoverNotes(-1), "INVALID_INPUT");
});
