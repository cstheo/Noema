"use strict";

const { BASE_URL: BASE, PAGE_SIZE } = require("./bridge.js");
const ITEM_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
const API_KEY = /^[A-Za-z0-9]{32}$/;
const MAX_TEXT = 512 * 1024;
const MAX_POSITION = 65000; // Zotero 10 annotations.js: ANNOTATION_POSITION_MAX_SIZE.
const MAX_RECORD = 1024 * 1024;
const MAX_CHILDREN = 10000;

class SharedError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SharedError";
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) { throw new SharedError(code, message, details); }
function input(condition, message) { if (!condition) fail("INVALID_INPUT", message); }
function validKey(key) { return typeof key === "string" && ITEM_KEY.test(key); }
function itemKey(key) { input(validKey(key), "A valid Zotero item key is required."); return key; }
function apiKey(key) { input(typeof key === "string" && API_KEY.test(key), "A valid local authorization key is required."); return key; }
function version(value) { return Number.isSafeInteger(value) && value >= 0; }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value, name, max = MAX_TEXT) {
  input(typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= max,
    `${name} must be text within the supported size limit.`);
  return value;
}
// Match the native item setters before sending or verifying persisted content.
function noteHTML(value) { return text(value, "Note HTML").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim(); }
function annotationText(value, name, max) { return text(value, name, max).trim().normalize(); }
function annotationColor(value) {
  input(typeof value === "string" && /^#[a-fA-F0-9]{6}$/.test(value), "A six-digit annotation color is required.");
  return value.toLowerCase();
}
function annotationType(value) {
  input(value === "highlight" || value === "underline", "Only highlight and underline annotations are supported.");
  return value;
}
function header(response, name) {
  if (typeof response.headers?.get === "function") return response.headers.get(name);
  const entry = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1]) : null;
}
async function json(response) {
  try {
    if (typeof response.json === "function") return await response.json();
    if (response.json !== undefined) return response.json;
    const value = typeof response.text === "function" ? await response.text() : response.text;
    if (typeof value !== "string" || Buffer.byteLength(value) > 16 * MAX_RECORD) throw new Error();
    return JSON.parse(value);
  } catch (_) { fail("INVALID_RESPONSE", "Zotero returned an unreadable response."); }
}
function boundedReason(value, secret) {
  if (typeof value !== "string") return "";
  let result = value.slice(0, 4096).replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();
  if (secret) result = result.split(secret).join("[redacted]");
  // Runtime authorization keys are 32 alphanumeric characters. Never expose a
  // token-like value even if an unexpected server error includes one.
  return result.replace(/[A-Za-z0-9]{32,}/g, "[redacted]").slice(0, 300);
}
async function responseReason(response, secret) {
  try {
    const value = typeof response.text === "function" ? await response.text() : response.text;
    if (typeof value !== "string") return "";
    // JSON responses are handled by their explicit error field, not dumped.
    if (/^[\s]*[\[{]/.test(value)) return "";
    return boundedReason(value, secret);
  } catch (_) { return ""; }
}
function httpError(status, response, authorization = false, reason = "") {
  const details = { status, ...(reason ? { reason } : {}) };
  if (status === 401) return new SharedError("AUTHORIZATION_REQUIRED", "Authorize this write in Zotero, then try again.", details);
  if (status === 403) return new SharedError(authorization ? "AUTHORIZATION_DENIED" : "FORBIDDEN",
    authorization ? "Zotero authorization was declined." : "Zotero did not permit this write.", details);
  if (status === 409 || status === 412) return new SharedError("CONFLICT", "Zotero changed. Reload this paper before saving.", details);
  if (status === 429) return new SharedError("RATE_LIMITED", "Zotero is limiting requests. Try again later.",
    { ...details, retryAfter: header(response, "Retry-After") });
  if (status === 404) return new SharedError("NOT_FOUND", "The Zotero item is no longer available.", details);
  return new SharedError(status >= 500 ? "REMOTE_ERROR" : "HTTP_ERROR", `Zotero returned HTTP ${status}.${reason ? ` ${reason}` : ""}`, details);
}

function highlightPosition(value) {
  input(plain(value) && Object.keys(value).every(key => ["pageIndex", "rects"].includes(key)), "A single-page highlight position is required.");
  input(Number.isInteger(value.pageIndex) && value.pageIndex >= 0 && value.pageIndex <= 99999, "The PDF page index is invalid.");
  input(Array.isArray(value.rects) && value.rects.length > 0 && value.rects.length <= 1000, "Highlight rectangles are required.");
  for (const rect of value.rects) {
    input(Array.isArray(rect) && rect.length === 4 && rect.every(number => Number.isFinite(number) && Math.abs(number) <= 1e6)
      && rect[0] < rect[2] && rect[1] < rect[3], "Highlight rectangles must have finite, ordered PDF coordinates.");
  }
  const result = { pageIndex: value.pageIndex, rects: value.rects.map(rect => [...rect]) };
  input(JSON.stringify(result).length <= MAX_POSITION, "The highlight position is too large for Zotero.");
  return result;
}

// The transport must not follow redirects. Keys are held by the caller, never
// persisted here. All reads and writes are pinned to this exact loopback server.
function createClient({ request, serverId } = {}) {
  input(typeof request === "function", "A local Zotero request function is required.");
  input(typeof serverId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(serverId), "The current Zotero server identity is required.");

  async function call(path, { method = "GET", body, key, expected = [200], authorization = false, precondition } = {}) {
    const headers = { "Zotero-API-Version": "3", "Zotero-Server-ID": serverId };
    if (key !== undefined) headers["Zotero-API-Key"] = apiKey(key);
    if (precondition !== undefined) headers["If-Unmodified-Since-Version"] = String(precondition);
    let serialized;
    if (body !== undefined) {
      serialized = JSON.stringify(body);
      input(Buffer.byteLength(serialized) <= MAX_RECORD, "The write payload is too large.");
      headers["Content-Type"] = "application/json";
    }
    let response;
    try { response = await request(`${BASE}${path}`, { method, headers, ...(serialized === undefined ? {} : { body: serialized }) }); }
    catch (_) { fail("NETWORK", "The local Zotero request did not complete."); }
    const status = Number(response?.status ?? response?.statusCode);
    if (!Number.isInteger(status) || status < 100 || status > 599) fail("INVALID_RESPONSE", "Zotero returned an invalid status.");
    const receivedId = header(response, "Zotero-Server-ID");
    if (receivedId && receivedId !== serverId) fail("SERVER_CHANGED", "The local Zotero server changed. Refresh the library first.", { status });
    if (!expected.includes(status)) throw httpError(status, response, authorization, await responseReason(response, key));
    if (!receivedId) fail("INVALID_RESPONSE", "Zotero did not confirm its server identity.");
    return response;
  }

  function record(row) {
    if (!plain(row) || !plain(row.data)) fail("INVALID_RESPONSE", "Zotero returned an invalid item.");
    const data = row.data;
    const key = row.key ?? data.key;
    const itemVersion = row.version ?? data.version;
    if (!validKey(key) || !version(itemVersion) || (data.key !== undefined && data.key !== key)
      || (data.version !== undefined && data.version !== itemVersion) || typeof data.itemType !== "string"
      || !/^[A-Za-z][A-Za-z0-9]*$/.test(data.itemType) || (data.parentItem && !validKey(data.parentItem))) {
      fail("INVALID_RESPONSE", "Zotero returned an invalid item identity.");
    }
    let copy;
    try {
      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized) > MAX_RECORD) throw new Error();
      copy = JSON.parse(serialized);
    } catch (_) { fail("INVALID_RESPONSE", "The Zotero item is too large or malformed."); }
    const result = { ...copy, key, version: itemVersion, serverId };
    if (data.itemType === "note") {
      if (typeof data.note !== "string" || Buffer.byteLength(data.note) > MAX_TEXT) fail("INVALID_RESPONSE", "Zotero returned an invalid note.");
      result.noteHTML = data.note;
    }
    if (data.itemType === "annotation") {
      if (!validKey(data.parentItem) || typeof data.annotationType !== "string" || typeof data.annotationPosition !== "string") {
        fail("INVALID_RESPONSE", "Zotero returned an invalid annotation.");
      }
      try {
        result.position = JSON.parse(data.annotationPosition);
        if (!plain(result.position) || !Number.isInteger(result.position.pageIndex) || result.position.pageIndex < 0) throw new Error();
      } catch (_) { fail("INVALID_RESPONSE", "Zotero returned an invalid annotation position."); }
    }
    return result;
  }

  async function get(key, missing = false) {
    itemKey(key);
    const response = await call(`/users/0/items/${key}?format=json&include=data`, { expected: missing ? [200, 404] : [200] });
    if (Number(response.status ?? response.statusCode) === 404) return null;
    const result = record(await json(response));
    if (result.key !== key) fail("INVALID_RESPONSE", "Zotero returned a different item.");
    return result;
  }

  function paper(value) {
    if (!value || value.deleted || ["attachment", "annotation", "note"].includes(value.itemType)) {
      fail("INVALID_RESPONSE", "The parent item is not an available Zotero paper.");
    }
    return value;
  }
  async function pdf(key, parentKey) {
    const result = await get(key);
    if (result.deleted || result.itemType !== "attachment" || result.contentType !== "application/pdf"
      || (parentKey !== undefined && result.parentItem !== parentKey)) {
      fail("INVALID_RESPONSE", "The annotation parent is not the expected PDF attachment.");
    }
    if (result.parentItem) paper(await get(result.parentItem));
    return result;
  }

  async function children(key, type) {
    const result = [];
    const seen = new Set();
    let total = null;
    let libraryVersion = null;
    do {
      const response = await call(`/users/0/items/${key}/children?format=json&include=data&itemType=${type}&limit=${PAGE_SIZE}&start=${result.length}`);
      const totalText = header(response, "Total-Results");
      const currentTotal = /^\d+$/.test(totalText || "") ? Number(totalText) : NaN;
      const currentVersion = header(response, "Last-Modified-Version");
      if (!Number.isSafeInteger(currentTotal) || currentTotal > MAX_CHILDREN || !/^\d+$/.test(currentVersion || "")) {
        fail("INVALID_RESPONSE", "Zotero returned invalid pagination metadata.");
      }
      if (total !== null && (total !== currentTotal || libraryVersion !== currentVersion)) {
        fail("CONFLICT", "Zotero changed during this refresh. Reload the paper.");
      }
      total = currentTotal;
      libraryVersion = currentVersion;
      const page = await json(response);
      if (!Array.isArray(page) || page.length !== Math.min(PAGE_SIZE, total - result.length)) {
        fail("INVALID_RESPONSE", "Zotero returned an incomplete child-item page.");
      }
      for (const row of page) {
        const value = record(row);
        if (value.parentItem !== key || value.itemType !== type || value.deleted || seen.has(value.key)) {
          fail("INVALID_RESPONSE", "Zotero returned an unexpected child item.");
        }
        seen.add(value.key);
        result.push(value);
      }
    } while (result.length < total);
    return result;
  }

  async function loadPaper(parentKey, pdfKeys = []) {
    itemKey(parentKey);
    input(Array.isArray(pdfKeys) && pdfKeys.length <= 128 && pdfKeys.every(validKey), "Valid PDF attachment keys are required.");
    const keys = [...new Set(pdfKeys)];
    paper(await get(parentKey));
    for (const key of keys) await pdf(key, parentKey);
    const notes = await children(parentKey, "note");
    const annotations = [];
    for (const key of keys) annotations.push(...await children(key, "annotation"));
    return { serverId, parentKey, notes, annotations };
  }

  async function discoverNotes(since = null) {
    input(since === null || version(since), "A valid note discovery cursor is required.");
    const notes = [], seen = new Set();
    let total = null, libraryVersion = null;
    do {
      const query = new URLSearchParams({ format: "json", include: "data", itemType: "note", includeTrashed: "0",
        limit: String(PAGE_SIZE), start: String(notes.length) });
      if (since !== null) query.set("since", String(since));
      const response = await call(`/users/0/items?${query}`);
      const count = header(response, "Total-Results"), modified = header(response, "Last-Modified-Version");
      if (!/^\d+$/.test(count || "") || !/^\d+$/.test(modified || "")
        || !Number.isSafeInteger(Number(count)) || Number(count) > MAX_CHILDREN || !version(Number(modified))) {
        fail("INVALID_RESPONSE", "Zotero returned invalid note discovery metadata.");
      }
      if (total !== null && (total !== Number(count) || libraryVersion !== Number(modified))) {
        fail("CONFLICT", "Zotero changed during note discovery. Refresh again.");
      }
      total = Number(count); libraryVersion = Number(modified);
      if (since !== null && libraryVersion < since) fail("CONFLICT", "The Zotero discovery cursor is ahead of this library.");
      const page = await json(response);
      if (!Array.isArray(page) || page.length !== Math.min(PAGE_SIZE, total - notes.length)) {
        fail("INVALID_RESPONSE", "Zotero returned an incomplete note discovery page.");
      }
      for (const row of page) {
        const value = record(row);
        if (value.itemType !== "note" || value.deleted || seen.has(value.key)) fail("INVALID_RESPONSE", "Zotero returned an unexpected discovered note.");
        seen.add(value.key); notes.push(value);
      }
    } while (notes.length < total);
    return { serverId, libraryVersion, notes };
  }

  async function getNoteState(entry) {
    input(plain(entry) && entry.serverId === serverId && validKey(entry.key) && validKey(entry.parentKey)
      && (entry.itemType === undefined || entry.itemType === "note"),
    "A shared-note identity from this Zotero server is required.");
    // A complete child list can omit both trashed and reparented notes. The
    // keyed native endpoint includes trash; only a server-confirmed 404 means
    // the key is absent. Reads do not inherit a cached version or write key.
    const current = await get(entry.key, true);
    if (!current) return { status: "missing", record: null };
    if (current.itemType !== "note" || ![undefined, false, true, 0, 1].includes(current.deleted)) {
      fail("INVALID_RESPONSE", "Zotero returned an unexpected shared-note state.");
    }
    // A note moved to another paper, or made standalone, is still a native
    // note. Its new parent must not authorize removing the old paper's mirror.
    if (current.parentItem !== entry.parentKey) return { status: "moved", record: current };
    return { status: current.deleted === true || current.deleted === 1 ? "deleted" : "active", record: current };
  }

  async function authorize() {
    const response = await call("/local/authorize", { method: "POST", body: { appName: "Noema Obsidian" }, authorization: true });
    const value = await json(response);
    if (!plain(value) || typeof value.key !== "string" || !API_KEY.test(value.key) || typeof value.remember !== "boolean") {
      fail("INVALID_RESPONSE", "Zotero returned an invalid authorization result.");
    }
    return { key: value.key, remember: value.remember };
  }

  function contentMatches(value, fields) {
    for (const [name, expected] of Object.entries(fields)) {
      if (name === "annotationPosition") {
        try {
          if (JSON.stringify(value.position) !== JSON.stringify(JSON.parse(expected))) return false;
        } catch (_) { return false; }
      } else if (value[name] !== expected) return false;
    }
    return true;
  }
  function contentFields(payload) {
    return Object.fromEntries(Object.entries(payload).filter(([name]) => name === "note" || name.startsWith("annotation")));
  }
  function creationOptions(options) {
    input(plain(options) && Object.keys(options).every(name => name === "itemKey"), "Valid creation options are required.");
    return options;
  }
  async function createNote(parentKey, html, key, options = {}) {
    itemKey(parentKey); html = noteHTML(html); apiKey(key); creationOptions(options);
    if (options.itemKey !== undefined) {
      fail("UNSUPPORTED_OPTION", "Zotero 10's local API cannot create a new note with a supplied item key.");
    }
    paper(await get(parentKey));
    return createServerKeyed({ itemType: "note", parentItem: parentKey, note: html, tags: [], collections: [], relations: {} }, key);
  }

  async function createServerKeyed(payload, key) {
    const kind = payload.itemType === "note" ? "note" : "highlight";
    try {
      // Zotero 10's keyed-new-item branch sets _identified before fromJSON
      // loads primaryData. Let Zotero allocate the note or annotation key.
      const response = await call("/users/0/items", { method: "POST", body: [payload], key });
      const value = await json(response);
      if (!plain(value) || !plain(value.successful) || !plain(value.unchanged) || !plain(value.failed)
        || [value.successful, value.unchanged, value.failed].some(map => Object.keys(map).some(index => index !== "0"))) {
        fail("INVALID_RESPONSE", `Zotero returned an invalid ${kind} creation result.`);
      }
      if ([value.successful, value.unchanged, value.failed].filter(map => Object.hasOwn(map, "0")).length !== 1) {
        fail("INVALID_RESPONSE", `Zotero returned an ambiguous ${kind} creation result.`);
      }
      if (value.failed["0"]) {
        const status = Number(value.failed["0"].code);
        throw httpError(Number.isInteger(status) ? status : 400, response, false, boundedReason(value.failed["0"].message, key));
      }
      if (!value.successful["0"] || Object.keys(value.unchanged).length) {
        fail("INVALID_RESPONSE", `Zotero did not return the newly created ${kind}.`);
      }
      const saved = record(value.successful["0"]);
      if (saved.deleted || saved.itemType !== payload.itemType || saved.parentItem !== payload.parentItem || !contentMatches(saved, contentFields(payload))) {
        fail("CONFLICT", `The saved Zotero ${kind} differs from this draft. Refresh the paper before saving again.`,
          { itemKey: saved.key, record: saved });
      }
      return saved;
    } catch (error) {
      if (!["NETWORK", "REMOTE_ERROR", "INVALID_RESPONSE", "SERVER_CHANGED"].includes(error.code)) throw error;
      // Without a client key, a lost result cannot be recovered by guessing an
      // identifier. Never repeat the POST: Zotero may already have committed it.
      fail("WRITE_UNCERTAIN", `The ${kind} write outcome is unknown. Check Zotero and refresh this paper before submitting it again.`);
    }
  }

  async function currentRecord(value, type, trashed = false) {
    input(plain(value) && value.serverId === serverId && value.itemType === type && validKey(value.key)
      && validKey(value.parentItem) && version(value.version)
      && (trashed ? value.deleted === true || value.deleted === 1 : !value.deleted),
    "An editable record from this Zotero server is required.");
    const current = await get(value.key);
    if (!!current.deleted !== trashed || current.itemType !== type || current.parentItem !== value.parentItem || current.version !== value.version) {
      fail("CONFLICT", "The Zotero item changed. Reload this paper before saving.");
    }
    if (type === "note") paper(await get(current.parentItem));
    else {
      // Native item JSON currently omits this flag. Respect it if a future API
      // supplies it; PDF binaries are never touched regardless of its presence.
      if (value.annotationIsExternal || current.annotationIsExternal) fail("FORBIDDEN", "External PDF annotations cannot be edited through this bridge.");
      await pdf(current.parentItem);
    }
    return current;
  }

  async function patch(value, fields, key) {
    try {
      await call(`/users/0/items/${value.key}`, { method: "PATCH", body: fields, key, expected: [204], precondition: value.version });
    } catch (error) {
      if (["NETWORK", "REMOTE_ERROR", "INVALID_RESPONSE"].includes(error.code)) {
        fail("WRITE_UNCERTAIN", "The write outcome is unknown. Reload the paper before saving again.", { itemKey: value.key });
      }
      throw error;
    }
    const saved = await get(value.key);
    if (saved.itemType !== value.itemType || saved.parentItem !== value.parentItem || !contentMatches(saved, fields)) {
      fail("CONFLICT", "The saved item changed. Reload this paper.", { itemKey: value.key, record: saved });
    }
    return saved;
  }

  async function saveNote(value, html, key) {
    html = noteHTML(html); apiKey(key);
    const current = await currentRecord(value, "note");
    return patch(current, { note: html }, key);
  }

  async function createHighlight(attachmentKey, value, key, options = {}) {
    itemKey(attachmentKey); apiKey(key); creationOptions(options);
    if (options.itemKey !== undefined) {
      fail("UNSUPPORTED_OPTION", "Zotero 10's local API cannot create a new highlight with a supplied item key.");
    }
    input(plain(value), "Highlight details are required.");
    const selectedText = annotationText(value.text, "Highlight text"); input(selectedText.length > 0, "Highlight text is required.");
    const comment = annotationText(value.comment ?? "", "Annotation comment");
    const pageLabel = annotationText(value.pageLabel ?? "", "Page label", 1024);
    const color = annotationColor(value.color);
    const type = annotationType(value.type === undefined ? "highlight" : value.type);
    const position = highlightPosition(value.position);
    input(typeof value.sortIndex === "string" && /^\d{5}\|\d{6}\|\d{5}$/.test(value.sortIndex)
      && Number(value.sortIndex.slice(0, 5)) === position.pageIndex, "The PDF annotation sort index is invalid.");
    await pdf(attachmentKey);
    return createServerKeyed({ itemType: "annotation", parentItem: attachmentKey, annotationType: type,
      annotationText: selectedText, annotationComment: comment, annotationColor: color,
      annotationPageLabel: pageLabel, annotationSortIndex: value.sortIndex, annotationPosition: JSON.stringify(position),
      tags: [], collections: [], relations: {} }, key);
  }

  async function saveComment(value, comment, key) {
    comment = annotationText(comment, "Annotation comment"); apiKey(key);
    const current = await currentRecord(value, "annotation");
    return patch(current, { annotationComment: comment }, key);
  }

  async function patchTrashState(value, deleted, key) {
    const kind = value.itemType;
    try {
      // Zotero 10 Item.fromJSON normalizes this flag to boolean and saveTx
      // updates deletedItems. DELETE invokes eraseTx and is never used here.
      await call(`/users/0/items/${value.key}`, { method: "PATCH", body: { deleted: Number(deleted) },
        key, expected: [204], precondition: value.version });
    } catch (error) {
      if (["NETWORK", "REMOTE_ERROR", "INVALID_RESPONSE", "SERVER_CHANGED"].includes(error.code)) {
        fail("WRITE_UNCERTAIN", `The ${kind} recovery state is unknown. Refresh the paper before trying again.`, { itemKey: value.key });
      }
      throw error;
    }
    let saved;
    try { saved = await get(value.key); }
    catch (_) {
      fail("WRITE_UNCERTAIN", `The ${kind} recovery state could not be verified. Refresh the paper before trying again.`, { itemKey: value.key });
    }
    const preserved = kind === "note" ? { note: value.note }
      : Object.fromEntries(Object.entries(value).filter(([name]) => name.startsWith("annotation")));
    if (saved.itemType !== kind || saved.parentItem !== value.parentItem || !contentMatches(saved, preserved)) {
      fail("CONFLICT", `The ${kind} content changed while updating its recovery state. Refresh the paper.`, { itemKey: value.key, record: saved });
    }
    // Native _postToJSON emits true for trashed items and ordinarily omits
    // false. An omitted flag therefore verifies restoration, never trashing.
    const savedDeleted = saved.deleted === true || saved.deleted === 1;
    const savedRestored = saved.deleted === undefined || saved.deleted === false || saved.deleted === 0;
    if (!(saved.version > value.version) || (!savedDeleted && !savedRestored) || (deleted && saved.deleted === undefined)) {
      fail("WRITE_UNCERTAIN", `The ${kind} recovery state could not be verified. Refresh the paper before trying again.`, { itemKey: value.key });
    }
    if (savedDeleted !== deleted) {
      fail("CONFLICT", `The ${kind} recovery state changed in Zotero. Refresh the paper.`, { itemKey: value.key, record: saved });
    }
    return saved;
  }

  async function trashAnnotation(value, key) {
    apiKey(key);
    const current = await currentRecord(value, "annotation");
    return patchTrashState(current, true, key);
  }

  async function restoreAnnotation(value, key) {
    apiKey(key);
    const current = await currentRecord(value, "annotation", true);
    return patchTrashState(current, false, key);
  }

  async function trashNote(value, key) {
    apiKey(key);
    input(plain(value) && [undefined, false, 0].includes(value.deleted), "An active Zotero note is required.");
    const current = await currentRecord(value, "note");
    if (![undefined, false, 0].includes(current.deleted)) {
      fail("INVALID_RESPONSE", "Zotero returned an unexpected shared-note state.");
    }
    return patchTrashState(current, true, key);
  }

  async function getAnnotation(value) {
    input(plain(value) && value.serverId === serverId && value.itemType === "annotation" && validKey(value.key)
      && validKey(value.parentItem), "An annotation record from this Zotero server is required.");
    const current = await get(value.key);
    if (current.itemType !== "annotation" || current.parentItem !== value.parentItem) {
      fail("CONFLICT", "The Zotero annotation identity changed. Refresh the paper.");
    }
    if (value.annotationIsExternal || current.annotationIsExternal) fail("FORBIDDEN", "External PDF annotations cannot be edited through this bridge.");
    await pdf(current.parentItem);
    return current;
  }

  async function saveAnnotationStyle(value, style, key) {
    apiKey(key);
    input(plain(style) && Object.keys(style).length > 0
      && Object.keys(style).every(name => name === "color" || name === "type"), "Choose an annotation color or type to update.");
    const fields = {};
    if (Object.hasOwn(style, "color")) fields.annotationColor = annotationColor(style.color);
    if (Object.hasOwn(style, "type")) fields.annotationType = annotationType(style.type);
    const current = await currentRecord(value, "annotation");
    if (!["highlight", "underline"].includes(current.annotationType)) {
      fail("UNSUPPORTED_ANNOTATION", "Only highlight and underline annotations can change style through this bridge.");
    }
    if (contentMatches(current, fields)) return current;
    const saved = await patch(current, fields, key);
    const preserved = Object.fromEntries(Object.entries(current).filter(([name]) => name.startsWith("annotation") && !Object.hasOwn(fields, name)));
    if (!contentMatches(saved, preserved)) {
      fail("CONFLICT", "The annotation content changed while saving its style. Reload this paper.", { itemKey: value.key, record: saved });
    }
    return saved;
  }

  return Object.freeze({ loadPaper, discoverNotes, getNoteState, authorize, createNote, saveNote, createHighlight, saveComment, saveAnnotationStyle,
    trashNote, trashAnnotation, restoreAnnotation, getAnnotation });
}

module.exports = { createClient, SharedError };
