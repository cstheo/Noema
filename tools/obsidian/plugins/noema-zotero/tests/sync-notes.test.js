"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const read = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const vm = require("node:vm");
const notes = require("../notes.js");
const fields = require("../fields.js");
const catalog = JSON.parse(read.readFileSync(path.join(__dirname, "../../../../../corpus/research/fields.json"), "utf8"));
const shared = require("../shared.js");
const paperNoteTemplate = require("../paper-note-template.js");
const { createNoteArchive } = require("../note-archive.js");
const { createAuthorizationStore } = require("../authorization-store.js");

const SOURCE = path.join(__dirname, "..", "sync.js");
const SERVER = "ServerAA22", PARENT = "PAPER222", NOTE = "NATE2222", AUTH = "A".repeat(32);
const asHTML = body => `<div data-schema-version="9"><p>${body}</p></div>`;
const asBody = html => html.replace(/<[^>]*>/g, "");
const DEFAULT_HEADINGS = ["## 1. Problem", "## 2. Contribution", "## 3. Insights", "## 4. Design", "## 5. Evaluation", "## 6. Limitation"];
const DEFAULT_BODY = `${DEFAULT_HEADINGS.join("\n\n")}\n\n`;
const draftBody = body => `${body}\n\n${DEFAULT_BODY}`;
const copy = value => JSON.parse(JSON.stringify(value));
const ioError = () => Object.assign(new Error("Isolated fixture I/O failure"), { code: "EIO" });
function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

// Real filesystem operations stay in this temporary vault. API requests and
// Markdown conversion are injected; conversion semantics have their own tests.
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "noema-sync-notes-")));
  await fs.mkdir(path.join(base, "corpus/research"), { recursive: true });
  await fs.writeFile(path.join(base, "corpus/research/fields.json"), JSON.stringify(catalog));
  const f = { base, files: new Map(), remote: new Map(), calls: [], cleanup: [], commands: [], notices: [],
    events: new Map(), version: 10, created: 0, activeFile: null, modifications: 0, deletions: 0, timeouts: [], timers: new Map(), nextTimer: 0, intervals: [], secrets: new Map(), secretCalls: [] };
  f.remote.set(PARENT, { key: PARENT, version: 1, itemType: "conferencePaper", title: "A Test Paper" });
  f.physical = relative => {
    const target = path.resolve(base, relative);
    assert(target.startsWith(`${base}${path.sep}`), "Fixture path escaped its temporary vault");
    return target;
  };
  f.registryPath = () => path.join(base, ".obsidian/zotero/shared",
    SERVER, "notes.json");
  f.registry = async () => JSON.parse(await fs.readFile(f.registryPath(), "utf8"));
  f.addFile = async (relative, body, exclusive = false) => {
    await fs.mkdir(path.dirname(f.physical(relative)), { recursive: true });
    await fs.writeFile(f.physical(relative), body, exclusive ? { flag: "wx" } : undefined);
    const file = { path: relative, basename: path.basename(relative, ".md"), extension: "md" };
    f.files.set(relative, file);
    return file;
  };
  const vault = {
    adapter: { getBasePath: () => base, async exists(relative) {
      try { await fs.access(f.physical(relative)); return true; } catch (_) { return false; }
    } },
    getFileByPath: relative => f.files.get(relative) || null,
    async createFolder(relative) { await fs.mkdir(f.physical(relative)); },
    async create(relative, body) {
      if (f.beforeCreate) await f.beforeCreate(relative, body);
      assert(!f.files.has(relative));
      return f.addFile(relative, body, true);
    },
    async read(file) {
      if (f.beforeRead) await f.beforeRead(file);
      const source = await fs.readFile(f.physical(file.path), "utf8");
      return f.afterRead ? f.afterRead(file, source) : source;
    },
    async modify(file, body) {
      if (f.beforeModify) await f.beforeModify(file, body);
      f.modifications++;
      await fs.writeFile(f.physical(file.path), body);
    },
    async trash(file, system) {
      assert.equal(system, false, "Shared-note removal uses Obsidian's recoverable local Trash");
      if (f.beforeDelete) await f.beforeDelete(file);
      const target = f.physical(`.trash/${path.basename(file.path)}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(f.physical(file.path), target); f.files.delete(file.path); f.deletions++;
    },
    on(event, callback) { f.events.set(event, callback); return { event, callback }; }
  };
  const workspace = {
    getActiveFile: () => f.activeFile,
    getMostRecentLeaf: () => ({ parent: "tabs" }),
    getLeavesOfType: () => [],
    getLeaf(mode) { assert.equal(mode, "tab"); return { async openFile(file) { f.activeFile = file; } }; },
    async revealLeaf() {}
  };
  const row = data => ({ key: data.key, version: data.version, data: copy(data) });
  f.request = async (url, options = {}) => {
    f.plugin.ensureActive();
    const endpoint = new URL(url), method = options.method || "GET";
    assert.equal(endpoint.origin, "http://127.0.0.1:23119");
    assert.equal(options.headers["Zotero-Server-ID"], SERVER);
    const call = { method, path: endpoint.pathname, body: options.body ? JSON.parse(options.body) : null };
    f.calls.push(call);
    if (f.requestHook) {
      const intercepted = await f.requestHook(call);
      if (intercepted && typeof intercepted.status === "number") return intercepted;
    }
    const result = (status, value, extra = {}) => ({ status, headers: {
      "Zotero-Server-ID": SERVER, "Last-Modified-Version": String(f.version), ...extra
    }, text: JSON.stringify(value) });
    if (method === "GET" && endpoint.pathname === "/api/users/0/items") {
      const since = Number(endpoint.searchParams.get("since") ?? -1);
      const values = [...f.remote.values()].filter(value => value.itemType === "note" && !value.deleted && value.version > since);
      const start = Number(endpoint.searchParams.get("start") || 0);
      return result(200, values.slice(start, start + 100).map(row), { "Total-Results": String(values.length) });
    }
    if (method === "POST" && endpoint.pathname === "/api/local/authorize") return result(200, { key: AUTH, remember: f.authorizationRemember ?? true });
    const children = endpoint.pathname.match(/^\/api\/users\/0\/items\/([A-Z0-9]{8})\/children$/);
    if (method === "GET" && children) {
      const type = endpoint.searchParams.get("itemType"), start = Number(endpoint.searchParams.get("start") || 0);
      const values = [...f.remote.values()].filter(value => value.parentItem === children[1] && value.itemType === type && !value.deleted);
      return result(200, values.slice(start, start + 100).map(row), { "Total-Results": String(values.length) });
    }
    const item = endpoint.pathname.match(/^\/api\/users\/0\/items\/([A-Z0-9]{8})$/);
    if (method === "GET" && item) return f.remote.has(item[1]) ? result(200, row(f.remote.get(item[1]))) : result(404, {});
    if (method === "POST" && endpoint.pathname === "/api/users/0/items") {
      assert.equal(options.headers["Zotero-API-Key"], AUTH);
      assert.equal(call.body.length, 1);
      const payload = call.body[0];
      assert.equal(payload.itemType, "note");
      assert.equal(payload.key, undefined, "New native notes must use a server-allocated key");
      assert.equal(payload.version, undefined);
      if (f.beforePost) await f.beforePost(payload);
      const key = `SRVRKEY${++f.created + 1}`;
      assert(!f.remote.has(key));
      const record = { ...payload, key, version: ++f.version };
      f.remote.set(key, record);
      if (f.afterPost) await f.afterPost(record);
      return result(200, { successful: { 0: row(record) }, unchanged: {}, failed: {} });
    }
    if (method === "PATCH" && item) {
      assert.equal(options.headers["Zotero-API-Key"], AUTH);
      const record = f.remote.get(item[1]);
      if (String(record.version) !== options.headers["If-Unmodified-Since-Version"]) return result(412, {});
      Object.assign(record, call.body, { version: ++f.version });
      return result(204, {});
    }
    throw new Error(`Unexpected mocked operation: ${method} ${endpoint.pathname}`);
  };
  function install() {
    const plugin = {
      obsidian: { Notice: class { constructor(message) { f.notices.push(message); } }, Component: class { load() {} unload() {} }, MarkdownRenderer: { async render() {} }, htmlToMarkdown: asBody },
      noemaConfig: { zotero: { research_folder: "corpus/research" } },
      active: true, manifest: { dir: ".obsidian/plugins/noema-zotero" },
      snapshot: { schema: 1, serverId: SERVER, items: [{ key: PARENT, title: "A Test Paper", authors: ["Ada Example", "Research Group"], conference: "Systems Conference", proceedings: "Systems Conference", journal: "", year: "2024", doi: "10.1000/example", url: "https://example.org/paper", attachments: [] }] },
      storageReal: path.join(base, ".obsidian/zotero"), pdfPrefix: ".obsidian/zotero/pdfs",
      app: { vault, workspace, fileManager: { async renameFile(file, target) {
        const old = file.path;
        await fs.rename(f.physical(old), f.physical(target));
        f.files.delete(old); file.path = target; file.basename = path.basename(target, ".md"); f.files.set(target, file);
      } }, secretStorage: {
        getSecret(name) { f.secretCalls.push({ operation: "get", name }); if (f.beforeSecretGet) f.beforeSecretGet(name); return f.secrets.get(name) ?? null; },
        setSecret(name, value) { f.secretCalls.push({ operation: "set", name }); if (f.beforeSecretSet) f.beforeSecretSet(name); f.secrets.set(name, value); },
        deleteSecret(name) { f.secretCalls.push({ operation: "delete", name }); if (f.beforeSecretDelete) f.beforeSecretDelete(name); return f.secrets.delete(name); }
      } }, request: f.request,
      ensureActive() { if (!this.active) throw Object.assign(new Error("The Zotero bridge was disabled."), { code: "PLUGIN_DISABLED" }); },
      registerEvent() {}, register(callback) { f.cleanup.push(callback); }, registerInterval() {}, addCommand(command) { f.commands.push(command); }
    };
    f.plugin = plugin;
    const module = { exports: {} };
    const helpers = { ...notes,
      remoteToMarkdown(html) { return f.convert ? f.convert(html) : { body: asBody(html), canPush: true, reasons: [] }; },
      async markdownToZotero(body) { if (f.beforeConvert) await f.beforeConvert(body); return asHTML(body); }
    };
    const filesystem = { ...fs,
      async writeFile(file, value, ...args) {
        if (/\/notes\.json\.[0-9a-f-]+\.tmp$/.test(String(file)) && f.beforeRegistryWrite) await f.beforeRegistryWrite(JSON.parse(value));
        return fs.writeFile(file, value, ...args);
      }
    };
    vm.runInNewContext(read.readFileSync(SOURCE, "utf8"), {
      module, console, DOMParser: class {}, document: { createElement: () => ({ innerHTML: "" }) },
      window: {
        setTimeout(callback, delay) {
          const id = ++f.nextTimer;
          f.timeouts.push(callback); f.timers.set(id, { callback, delay, active: true, cleared: false });
          return id;
        },
        clearTimeout(id) {
          const timer = f.timers.get(id);
          if (timer) { timer.active = false; timer.cleared = true; }
        },
        setInterval: callback => { f.intervals.push(callback); return 1; }
      },
      require(name) {
        if (name === "node:fs/promises") return filesystem;
        if (name.endsWith("/fields.js")) return fields;
        if (name.endsWith("/notes.js")) return helpers;
        if (name.endsWith("/shared.js")) return shared;
        if (name.endsWith("/paper-note-template.js")) return paperNoteTemplate;
        if (name.endsWith("/authorization-store.js")) return { createAuthorizationStore };
        if (name.endsWith("/note-archive.js")) return { createNoteArchive(plugin) {
          const store = createNoteArchive(plugin);
          return { read: id => store.read(id), async save(source) { if (f.beforeArchiveSave) await f.beforeArchiveSave(source); return store.save(source); } };
        } };
        if (name.endsWith("/paper-view.js")) return { plainHTML: asBody };
        return require(name);
      }
    }, { filename: SOURCE });
    module.exports.installShared(plugin);
    plugin.openPaperNotes = async () => {};
  }
  install();
  await f.plugin.initializeShared();
  f.authorize = () => { f.plugin.writeKey = AUTH; f.plugin.writeRemember = true; };
  f.entry = () => [...f.plugin.mirrors.values()][0];
  f.source = entry => fs.readFile(f.physical((entry || f.entry()).path), "utf8");
  f.local = async (entry = f.entry()) => notes.parseMarkdown(await f.source(entry), entry);
  f.setLocal = async (body, entry = f.entry()) => {
    const source = await f.source(entry), parsed = notes.parseMarkdown(source, entry);
    await fs.writeFile(f.physical(entry.path), notes.makeMarkdown({ ...parsed, body, existing: source, registered: entry }));
  };
  f.importNote = async (body = "Initial note") => {
    f.remote.set(NOTE, { key: NOTE, version: 1, itemType: "note", parentItem: PARENT, note: asHTML(body) });
    await f.plugin.refreshPaper(PARENT);
    return f.entry();
  };
  f.draft = (body = "Draft body") => f.plugin.createNoteDraft(f.plugin.snapshot.items[0], "Reading notes", body);
  f.legacy = async (entry = f.entry(), extra = "") => {
    const parsed = await f.local(entry);
    const source = `---\nzotero-server-id: "${entry.serverId}"\nzotero-key: "${entry.key}"\nzotero-parent-key: "${entry.parentKey}"\nzotero-version: ${entry.version}\n${parsed.headerLines.join("\n")}\n${extra}---\n\n${parsed.body}`;
    await fs.writeFile(f.physical(entry.path), source);
    delete entry.fileId;
    const registry = await f.registry();
    delete registry.entries.find(value => value.path === entry.path).fileId;
    await fs.writeFile(f.registryPath(), JSON.stringify(registry));
    return source;
  };
  f.bumpRemote = body => { const value = f.remote.get(NOTE); value.note = asHTML(body); value.version = ++f.version; };
  f.writes = method => f.calls.filter(call => (method ? call.method === method : ["POST", "PATCH"].includes(call.method)) && call.path !== "/api/local/authorize");
  f.emitModify = entry => f.events.get("modify")(f.files.get(entry.path));
  f.flushAutoSync = async () => {
    for (let iteration = 0; iteration < 50; iteration++) {
      const timers = [...f.timers.values()].filter(timer => timer.active);
      for (const timer of timers) timer.active = false;
      await Promise.all(timers.map(timer => Promise.resolve(timer.callback())));
      await Promise.all([...f.plugin.paperLoads.values()]);
      await Promise.all([...f.plugin.noteLocks.values()]);
      // Let metadata watcher reads and scheduler continuations finish before
      // deciding that the controlled timer queue is empty.
      await new Promise(resolve => setTimeout(resolve, 5));
      if (![...f.timers.values()].some(timer => timer.active) && !f.plugin.paperLoads.size && !f.plugin.noteLocks.size) return;
    }
    assert.fail("Automatic note synchronization did not settle within 50 timer turns");
  };
  f.restart = async () => {
    f.plugin.active = false;
    for (const callback of f.cleanup.splice(0)) callback();
    install();
    await f.plugin.initializeShared();
  };
  t.after(async () => {
    f.plugin.active = false;
    for (const callback of f.cleanup) callback();
    await fs.rm(base, { recursive: true, force: true });
  });
  return f;
}

test("imported paper note filenames use the parent title and preserve the child note label", async t => {
  const f = await fixture(t), entry = await f.importNote("A child note heading");
  assert.equal(entry.path, "corpus/research/papers/A Test Paper.md");
  assert.equal(entry.title, "A Test Paper · A child note heading");
  assert.equal((await f.local(entry)).title, entry.title);
  assert.equal((await f.local(entry)).body, "A child note heading");
  assert.equal((await f.registry()).entries[0].path, entry.path);
  assert.equal(f.writes().length, 0);
});

test("new drafts use the paper filename while retaining custom note titles", async t => {
  const f = await fixture(t);
  const entry = await f.plugin.createNoteDraft(f.plugin.snapshot.items[0], "My mechanism questions", "A question.");
  assert.equal(entry.path, "corpus/research/papers/A Test Paper.md");
  assert.equal(entry.title, "A Test Paper · My mechanism questions");
  assert.equal((await f.local(entry)).title, entry.title);
  assert.equal((await f.local(entry)).body, draftBody("A question."));
  const originalPath = entry.path;
  f.authorize();
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal(entry.draft, false);
  assert.equal(entry.path, originalPath, "Server-assigned note keys do not change the filename");
});

test("multiple imported child notes get concise numbered names and keep separate identities across reload", async t => {
  const f = await fixture(t);
  f.remote.set(NOTE, { key: NOTE, version: 1, itemType: "note", parentItem: PARENT, note: asHTML("First child") });
  f.remote.set("NATE3333", { key: "NATE3333", version: 1, itemType: "note", parentItem: PARENT, note: asHTML("Second child") });
  await f.plugin.refreshPaper(PARENT);
  const entries = [...f.plugin.mirrors.values()];
  assert.deepEqual(entries.map(entry => entry.path), [
    "corpus/research/papers/A Test Paper.md",
    "corpus/research/papers/A Test Paper (2).md"
  ]);
  assert.notEqual(entries[0].fileId, entries[1].fileId);
  const sources = await Promise.all(entries.map(entry => f.source(entry)));
  await f.restart();
  await f.plugin.refreshPaper(PARENT);
  assert.equal(f.plugin.mirrors.size, 2);
  for (let index = 0; index < entries.length; index++) {
    const restored = f.plugin.mirrors.get(entries[index].path);
    assert.equal(restored.key, entries[index].key);
    assert.equal(restored.fileId, entries[index].fileId);
    assert.equal(await f.source(restored), sources[index]);
  }
  assert.equal(f.writes().length, 0);
});

test("concurrent drafts for one paper allocate separate numbered files without merging", async t => {
  const f = await fixture(t);
  const entries = await Promise.all(["First", "Second", "Third"].map(body => f.draft(body)));
  assert.deepEqual(new Set(entries.map(entry => entry.path)), new Set([
    "corpus/research/papers/A Test Paper.md",
    "corpus/research/papers/A Test Paper (2).md",
    "corpus/research/papers/A Test Paper (3).md"
  ]));
  assert.equal(new Set(entries.map(entry => entry.fileId)).size, 3);
  for (let index = 0; index < entries.length; index++) {
    assert.equal((await f.local(entries[index])).body, draftBody(["First", "Second", "Third"][index]));
    assert.equal(f.plugin.mirrors.get(entries[index].path), entries[index]);
  }
  assert.equal((await f.registry()).entries.length, 3);
  assert.equal(f.writes().length, 0);
});

test("occupied unrelated and unindexed disk files are preserved while the next filename is allocated", async t => {
  const f = await fixture(t);
  const primary = "corpus/research/papers/A Test Paper.md";
  const orphan = "corpus/research/papers/A Test Paper (2).md";
  await f.addFile(primary, "My independent synthesis");
  await f.addFile(orphan, "An unindexed note must survive");
  f.files.delete(orphan);
  const entry = await f.importNote("Imported thought");
  assert.equal(entry.path, "corpus/research/papers/A Test Paper (3).md");
  assert.equal(await fs.readFile(f.physical(primary), "utf8"), "My independent synthesis");
  assert.equal(await fs.readFile(f.physical(orphan), "utf8"), "An unindexed note must survive");
  assert.equal(f.plugin.mirrors.has(primary), false);
  assert.equal(f.plugin.mirrors.has(orphan), false);
  assert.equal((await f.local(entry)).body, "Imported thought");
});

test("deleted mirror filenames remain reserved so a new draft cannot block restoration", async t => {
  const f = await fixture(t), original = await f.importNote("Archived original");
  const originalPath = original.path, originalSource = await f.source(original);
  f.remote.get(NOTE).deleted = true;
  await f.plugin.refreshPaper(PARENT);
  assert.equal(original.deleted, true);
  assert.equal(f.files.has(originalPath), false);
  const draft = await f.draft("New independent draft");
  assert.equal(draft.path, "corpus/research/papers/A Test Paper (2).md");
  f.remote.get(NOTE).deleted = false;
  await f.plugin.refreshPaper(PARENT, false, true);
  assert.equal(original.deleted, false);
  assert.equal(original.path, originalPath);
  assert.equal(await f.source(original), originalSource);
  assert.equal((await f.local(draft)).body, draftBody("New independent draft"));
  assert.equal(f.writes().length, 0);
});

test("papers whose titles sanitize to the same name keep separate numbered notes", async t => {
  const f = await fixture(t), first = f.plugin.snapshot.items[0];
  first.title = "A/B";
  const second = { ...first, key: "PAPER333", title: "A:B" };
  f.plugin.snapshot.items.push(second);
  const one = await f.plugin.createNoteDraft(first, "Reading notes", "First paper");
  const two = await f.plugin.createNoteDraft(second, "Reading notes", "Second paper");
  assert.equal(one.path, "corpus/research/papers/A B.md");
  assert.equal(two.path, "corpus/research/papers/A B (2).md");
  assert.equal(one.parentKey, PARENT);
  assert.equal(two.parentKey, "PAPER333");
  assert.equal((await f.local(one)).body, draftBody("First paper"));
  assert.equal((await f.local(two)).body, draftBody("Second paper"));
});

test("long Unicode titles are bounded only in filenames while metadata retains the original title", async t => {
  const f = await fixture(t), paper = f.plugin.snapshot.items[0];
  paper.title = "研究".repeat(90);
  const one = await f.draft("Unicode body"), two = await f.draft("Another body");
  assert.equal(path.basename(one.path), `${paper.title.slice(0, 73)}.md`);
  assert.equal(path.basename(two.path), `${paper.title.slice(0, 73)} (2).md`);
  assert(Buffer.byteLength(path.basename(one.path), "utf8") <= 223);
  assert.equal((await f.local(one)).title, `${paper.title} · Reading notes`);
  assert.equal((await f.local(one)).body, draftBody("Unicode body"));
});

test("a filename occupied during native create is not overwritten and the allocation queue remains usable", async t => {
  const f = await fixture(t);
  let raced = false;
  f.beforeCreate = async relative => {
    if (raced) return;
    raced = true;
    await fs.writeFile(f.physical(relative), "A concurrent independent note", { flag: "wx" });
  };
  await assert.rejects(f.draft("Rejected draft"), { code: "EEXIST" });
  assert.equal(await fs.readFile(f.physical("corpus/research/papers/A Test Paper.md"), "utf8"), "A concurrent independent note");
  assert.equal(f.plugin.mirrors.size, 0);
  const retried = await f.draft("Retry draft");
  assert.equal(retried.path, "corpus/research/papers/A Test Paper (2).md");
  assert.equal((await f.local(retried)).body, draftBody("Retry draft"));
  assert.equal(f.writes().length, 0);
});

test("blank new paper drafts contain the six default H2 sections once across reload", async t => {
  const f = await fixture(t), entries = [];
  for (const body of [undefined, ""]) {
    const entry = await f.plugin.createNoteDraft(f.plugin.snapshot.items[0], "Reading notes", body);
    entries.push(entry);
    assert.equal((await f.local(entry)).body, DEFAULT_BODY);
    assert.deepEqual((await f.local(entry)).body.split("\n").filter(line => /^## /.test(line)), DEFAULT_HEADINGS);
  }
  await f.restart();
  await f.plugin.refreshPaper(PARENT);
  for (const entry of entries) {
    assert.equal((await f.local(f.plugin.mirrors.get(entry.path))).body, DEFAULT_BODY);
  }
  assert.equal(f.writes().length, 0);
});

test("new paper drafts preserve the exact quote prefix before adding default sections", async t => {
  const f = await fixture(t);
  const quote = "> ## 1. Problem\n> A quoted heading is part of the passage.\n\nMy comment keeps its trailing spaces.  \n";
  const entry = await f.draft(quote), body = (await f.local(entry)).body;
  assert.ok(body.startsWith(quote));
  assert.equal(body, `${quote}\n${DEFAULT_BODY}`);
  assert.deepEqual(body.split("\n").filter(line => /^## /.test(line)), DEFAULT_HEADINGS);
  assert.equal(f.writes().length, 0);
});

test("draft submission is durable before one unkeyed POST, then adopts the server key", async t => {
  const f = await fixture(t), entry = await f.draft(), provisional = entry.key;
  f.authorize();
  f.beforePost = async () => {
    const saved = (await f.registry()).entries[0];
    assert.equal(saved.key, provisional);
    assert.equal(saved.pendingCreation, true);
    assert.equal(saved.pendingKey, undefined);
    assert.equal(saved.pendingBody, draftBody("Draft body"));
    assert.equal(saved.pendingHTML, asHTML(draftBody("Draft body")));
  };
  f.beforeModify = async () => {
    const saved = (await f.registry()).entries[0];
    assert.equal(saved.pendingKey, "SRVRKEY2");
    assert.equal(saved.pendingCreation, true);
  };
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal(f.writes("POST").length, 1);
  assert.notEqual(entry.key, provisional);
  assert.equal(entry.key, "SRVRKEY2");
  assert.equal((await f.local()).key, entry.key);
  assert.equal(entry.draft, false);
  assert.equal(entry.pendingCreation, undefined);
});

test("confirmed creation survives header failure and restart without a duplicate note", async t => {
  const f = await fixture(t), entry = await f.draft("Saved remotely"), provisional = entry.key;
  f.authorize();
  f.plugin.snapshot.items[0].year = "2025"; // A real metadata rewrite can fail after creation.
  f.beforeModify = () => { throw ioError(); };
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal((await f.registry()).entries[0].pendingKey, "SRVRKEY2");
  assert.equal((await f.local()).key, provisional);
  f.beforeModify = null;
  await f.setLocal("Concurrent edit after failed header");
  await f.restart();
  await f.plugin.refreshPaper(PARENT);
  assert.equal(f.writes("POST").length, 1);
  assert.equal(f.entry().key, "SRVRKEY2");
  assert.equal(f.entry().draft, false);
  assert.equal((await f.local()).body, "Concurrent edit after failed header");
  assert.equal(f.entry().base.localBody, draftBody("Saved remotely"));
});

test("lost creation response remains blocked after restart without guessing a matching note", async t => {
  const f = await fixture(t), draft = await f.draft("Unique draft");
  f.authorize();
  f.afterPost = () => { throw new Error("Isolated response lost after commit"); };
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal((await f.registry()).entries[0].pendingCreation, true);
  assert.equal(draft.pendingKey, undefined);
  f.afterPost = null;
  await f.restart();
  await f.plugin.refreshPaper(PARENT);
  f.authorize();
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal(f.writes("POST").length, 1);
  assert.equal([...f.remote.values()].filter(value => value.itemType === "note").length, 1);
  const pending = f.plugin.mirrors.get(draft.path);
  assert.equal(pending.draft, true);
  assert.equal(pending.pendingCreation, true);
  assert.equal(pending.pendingKey, undefined);
  assert.equal((await f.local(pending)).body, draftBody("Unique draft"));
});

test("failed pre-submit registry persistence starts no POST and keeps a retryable draft", async t => {
  const f = await fixture(t), entry = await f.draft();
  f.authorize();
  let failed = false;
  f.beforeRegistryWrite = saved => {
    if (!failed && saved.entries.some(value => value.pendingCreation && !value.pendingKey)) { failed = true; throw ioError(); }
  };
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal(f.writes("POST").length, 0);
  assert.equal(entry.pendingCreation, undefined);
  assert.equal(entry.draft, true);
  f.beforeRegistryWrite = null;
  await f.restart();
  f.authorize();
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal(f.writes("POST").length, 1);
});

test("failure persisting the returned key keeps confirmation durable and never rewrites the header early", async t => {
  const f = await fixture(t), entry = await f.draft(), provisional = entry.key;
  f.authorize();
  let failed = false;
  f.beforeRegistryWrite = saved => {
    if (!failed && saved.entries.some(value => value.pendingKey === "SRVRKEY2")) { failed = true; throw ioError(); }
  };
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal(f.modifications, 0);
  assert.equal((await f.local()).key, provisional);
  assert.equal((await f.registry()).entries[0].pendingKey, "SRVRKEY2");
  f.beforeRegistryWrite = null;
  await f.restart();
  await f.plugin.refreshPaper(PARENT);
  assert.equal(f.writes("POST").length, 1);
  assert.equal(f.entry().key, "SRVRKEY2");
});

test("a remapped header with an older pending registry recovers after restart", async t => {
  const f = await fixture(t);
  await f.draft();
  f.authorize();
  f.beforeRegistryWrite = saved => { if (saved.entries.some(value => value.draft === false)) throw ioError(); };
  await assert.rejects(f.plugin.syncPaperNotes(PARENT, true), /fixture I\/O/);
  assert.equal((await f.local()).key, "SRVRKEY2");
  const saved = (await f.registry()).entries[0];
  assert.equal(saved.draft, true);
  assert.equal(saved.pendingKey, "SRVRKEY2");
  f.beforeRegistryWrite = null;
  await f.restart();
  await f.plugin.refreshPaper(PARENT);
  assert.equal(f.writes("POST").length, 1);
  assert.equal(f.entry().draft, false);
  assert.equal(f.entry().key, "SRVRKEY2");
});

test("concurrent draft edits survive key remapping and remain separate from the submitted baseline", async t => {
  const f = await fixture(t), entry = await f.draft("Submitted body");
  f.authorize();
  f.afterPost = async () => f.setLocal("Later local body", entry);
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal((await f.local()).body, "Later local body");
  assert.equal(entry.base.localBody, draftBody("Submitted body"));
  assert.equal(f.remote.get("SRVRKEY2").note, asHTML(draftBody("Submitted body")));
  f.afterPost = null;
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal(f.writes("POST").length, 1);
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.remote.get("SRVRKEY2").note, asHTML("Later local body"));
});

test("a known created key with changed remote content remains resolvable without another POST", async t => {
  const f = await fixture(t), entry = await f.draft("Local draft");
  f.authorize();
  f.afterPost = record => { record.note = asHTML("Changed remotely"); record.version = ++f.version; };
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal(entry.pendingKey, "SRVRKEY2");
  f.afterPost = null;
  await f.plugin.refreshPaper(PARENT);
  assert(entry.conflictPath);
  await f.plugin.resolveNoteConflict(entry, "local");
  assert.equal(f.writes("POST").length, 1);
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(entry.key, "SRVRKEY2");
  assert.equal(entry.draft, false);
  assert.equal(f.remote.get("SRVRKEY2").note, asHTML(draftBody("Local draft")));
});

test("confirmed creation changed in Zotero keeps both versions until explicit remote resolution", async t => {
  const f = await fixture(t), entry = await f.draft("Submitted local version");
  f.authorize();
  f.plugin.snapshot.items[0].year = "2025";
  f.beforeModify = () => { throw ioError(); };
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal((await f.registry()).entries[0].pendingVersion, f.remote.get("SRVRKEY2").version);
  const submittedVersion = f.remote.get("SRVRKEY2").version;
  f.remote.get("SRVRKEY2").note = asHTML("Later Zotero version");
  f.remote.get("SRVRKEY2").version = ++f.version;
  f.beforeModify = null;
  await f.restart();
  await f.plugin.refreshPaper(PARENT);
  const recovered = f.entry();
  assert.equal(recovered.key, "SRVRKEY2");
  assert.equal(recovered.base.version, submittedVersion);
  assert(recovered.conflictPath);
  assert.equal((await f.local()).body, draftBody("Submitted local version"));
  await f.plugin.refreshPaper(PARENT);
  assert.equal((await f.local()).body, draftBody("Submitted local version"));
  await f.plugin.resolveNoteConflict(recovered, "remote");
  assert.equal((await f.local()).body, "Later Zotero version");
  assert.equal(recovered.conflictPath, null);
  const backup = [...f.files.keys()].find(value => value.includes(" - Noema "));
  assert(backup);
  assert.equal(notes.parseMarkdown(await fs.readFile(f.physical(backup), "utf8")).body, draftBody("Submitted local version"));
  assert.equal(f.writes("POST").length, 1);
  assert.equal(f.writes("PATCH").length, 0);
});

test("version-only remote changes update the header and baseline without a write request", async t => {
  const f = await fixture(t), entry = await f.importNote();
  f.remote.get(NOTE).version = ++f.version;
  await f.plugin.refreshPaper(PARENT);
  assert.equal((await f.local()).version, f.version);
  assert.equal(entry.base.version, f.version);
  assert.equal((await f.local()).body, "Initial note");
  assert.equal(f.writes().length, 0);
});

test("foreign local identity is preserved and cannot be pushed", async t => {
  const f = await fixture(t), entry = await f.importNote();
  const foreign = (await f.source()).replace(entry.fileId, crypto.randomUUID());
  await fs.writeFile(f.physical(entry.path), foreign);
  f.authorize();
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.match(entry.message, /identity changed/);
  assert.equal(f.writes().length, 0);
  assert.equal(await f.source(), foreign);
});

test("independent and concurrent pull edits preserve local content with a separate Zotero copy", async t => {
  const f = await fixture(t), entry = await f.importNote();
  f.bumpRemote("Changed in Zotero");
  let reads = 0;
  f.beforeRead = async file => { if (file.path === entry.path && ++reads === 2) await f.setLocal("Concurrent Noema edit"); };
  await f.plugin.refreshPaper(PARENT);
  f.beforeRead = null;
  assert.equal((await f.local()).body, "Concurrent Noema edit");
  assert(entry.conflictPath);
  assert.equal(notes.parseMarkdown(await fs.readFile(f.physical(entry.conflictPath), "utf8")).body, "Changed in Zotero");
  assert.equal(entry.base.localBody, "Initial note");
  assert.equal(f.writes().length, 0);
});

test("local changes remain local until authorized, then use a versioned PATCH", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.setLocal("Updated local note");
  await f.plugin.syncPaperNotes(PARENT);
  assert.equal(f.writes().length, 0);
  assert.match(entry.message, /Enable writeback/);
  f.authorize();
  await f.plugin.syncPaperNotes(PARENT);
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.remote.get(NOTE).note, asHTML("Updated local note"));
  assert.equal(entry.base.localBody, "Updated local note");
});

test("disable during conversion starts no write request", async t => {
  const f = await fixture(t);
  await f.importNote(); await f.setLocal("Deferred local write"); f.authorize();
  const started = deferred(), gate = deferred();
  f.beforeConvert = async () => { started.resolve(); await gate.promise; };
  const pending = f.plugin.syncPaperNotes(PARENT);
  await started.promise; f.plugin.active = false; gate.resolve();
  await pending.catch(() => {});
  assert.equal(f.writes().length, 0);
  assert.equal((await f.local()).body, "Deferred local write");
});

test("append saves into the chosen source note, preserving metadata and leaving Zotero untouched", async t => {
  const f = await fixture(t), entry = await f.importNote();
  const source = (await f.source()).replace("---\n\n", "custom: retained\n---\n\n");
  await fs.writeFile(f.physical(entry.path), source);
  const saved = await f.plugin.appendToPaperNote(PARENT, entry.path, "> Selected passage\n\nMy comment.");
  assert.equal(saved, entry);
  assert.equal((await f.local()).body, "Initial note\n\n> Selected passage\n\nMy comment.\n");
  assert((await f.source()).includes("custom: retained"));
  assert.equal(f.remote.get(NOTE).note, asHTML("Initial note"));
  assert.equal(f.writes().length, 0);
  assert.equal(f.activeFile.path, entry.path);
});

test("append rejects unregistered, wrong-paper, conflict and read-only targets", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.source();
  await assert.rejects(f.plugin.appendToPaperNote(PARENT, `${entry.path.slice(0, -3)} - conflict.md`, "New"), /belonging/);
  await assert.rejects(f.plugin.appendToPaperNote("PAPER333", entry.path, "New"), /belonging/);
  entry.conflictPath = "existing-conflict.md";
  await assert.rejects(f.plugin.appendToPaperNote(PARENT, entry.path, "New"), /conflict/);
  entry.conflictPath = null; entry.canPush = false;
  await assert.rejects(f.plugin.appendToPaperNote(PARENT, entry.path, "New"), /editable/);
  assert.equal(await f.source(), original);
  assert.equal(f.modifications, 0);
  assert.equal(f.writes().length, 0);
});

test("appending to an existing note preserves its authored layout without adding default sections", async t => {
  const f = await fixture(t), originalBody = "## Personal notes\n\nA finding kept in its original layout.";
  const entry = await f.importNote(originalBody), source = await f.source(entry), passage = "> Another passage\n\nA later comment.";
  await f.plugin.appendToPaperNote(PARENT, entry.path, passage);
  assert.equal(await f.source(entry), `${source}\n\n${passage}\n`);
  assert.equal((await f.local(entry)).body, `${originalBody}\n\n${passage}\n`);
  assert.equal((await f.local(entry)).body.split("\n").filter(line => DEFAULT_HEADINGS.includes(line)).length, 0);
  assert.equal(f.remote.get(NOTE).note, asHTML(originalBody));
  assert.equal(f.writes().length, 0);
});

test("a completed draft save returns its entry despite registry and tab-open failures", async t => {
  const f = await fixture(t);
  f.beforeRegistryWrite = () => { throw ioError(); };
  f.plugin.openMirror = async () => { throw new Error("Isolated navigation failure"); };
  const entry = await f.draft("Durable Markdown body");
  assert.equal(f.plugin.mirrors.get(entry.path), entry);
  assert.equal((await f.local(entry)).body, draftBody("Durable Markdown body"));
  assert.equal(f.files.size, 1);
  assert.equal(f.writes().length, 0);
  assert.match(entry.message, /registry could not be saved/);
  assert.equal(f.notices.length, 2);
});

test("a completed append returns its entry despite registry and tab-open failures", async t => {
  const f = await fixture(t), entry = await f.importNote();
  f.beforeRegistryWrite = () => { throw ioError(); };
  f.plugin.openMirror = async () => { throw new Error("Isolated navigation failure"); };
  assert.equal(await f.plugin.appendToPaperNote(PARENT, entry.path, "One passage"), entry);
  assert.equal((await f.local()).body, "Initial note\n\nOne passage\n");
  assert.equal(f.modifications, 1);
  assert.equal(f.writes().length, 0);
  assert.equal(f.notices.length, 2);
});

test("append validates the selected file's private identity marker", async t => {
  const f = await fixture(t), entry = await f.importNote();
  const foreign = (await f.source()).replace(entry.fileId, crypto.randomUUID());
  await fs.writeFile(f.physical(entry.path), foreign);
  await assert.rejects(f.plugin.appendToPaperNote(PARENT, entry.path, "New"), /identity changed/);
  assert.equal(await f.source(), foreign);
  assert.equal(f.modifications, 0);
});

test("append preserves an edit that arrives between its source reads", async t => {
  const f = await fixture(t), entry = await f.importNote();
  let reads = 0;
  f.beforeRead = async file => { if (file.path === entry.path && ++reads === 2) await f.setLocal("Concurrent edit"); };
  await assert.rejects(f.plugin.appendToPaperNote(PARENT, entry.path, "Passage"), /changed while adding/);
  f.beforeRead = null;
  assert.equal((await f.local()).body, "Concurrent edit");
  assert.equal(f.modifications, 0);
});

test("queued append rechecks conflicts after acquiring its note lock", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.source(), gate = deferred();
  f.plugin.noteLocks.set(entry, gate.promise);
  const pending = f.plugin.appendToPaperNote(PARENT, entry.path, "Passage");
  await new Promise(resolve => setImmediate(resolve));
  entry.conflictPath = "new-conflict.md";
  gate.resolve();
  await assert.rejects(pending, /conflict/);
  assert.equal(await f.source(), original);
  assert.equal(f.modifications, 0);
});

test("queued append rechecks read-only conversion after acquiring its note lock", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.source(), gate = deferred();
  f.plugin.noteLocks.set(entry, gate.promise);
  const pending = f.plugin.appendToPaperNote(PARENT, entry.path, "Passage");
  await new Promise(resolve => setImmediate(resolve));
  entry.canPush = false;
  gate.resolve();
  await assert.rejects(pending, /editable/);
  assert.equal(await f.source(), original);
  assert.equal(f.modifications, 0);
});

test("queued append refuses a replaced registry entry after acquiring its lock", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.source(), gate = deferred();
  f.plugin.noteLocks.set(entry, gate.promise);
  const pending = f.plugin.appendToPaperNote(PARENT, entry.path, "Passage");
  await new Promise(resolve => setImmediate(resolve));
  f.plugin.mirrors.delete(entry.path);
  gate.resolve();
  await assert.rejects(pending, /belonging/);
  assert.equal(await f.source(entry), original);
  assert.equal(f.modifications, 0);
});

test("disable during append's fresh read prevents the final local modification", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.source();
  let reads = 0;
  f.beforeRead = file => { if (file.path === entry.path && ++reads === 2) f.plugin.active = false; };
  await assert.rejects(f.plugin.appendToPaperNote(PARENT, entry.path, "Passage"), /disabled/);
  assert.equal(await f.source(), original);
  assert.equal(f.modifications, 0);
});

test("read-only rich-source mirrors cannot accept an appended passage", async t => {
  const f = await fixture(t);
  f.convert = html => ({ body: `\`\`\`html\n${html}\n\`\`\``, canPush: false, reasons: ["Unsupported source"] });
  const entry = await f.importNote("Rich content");
  assert.equal(entry.base.canPush, false);
  const original = await f.source();
  await assert.rejects(f.plugin.appendToPaperNote(PARENT, entry.path, "Passage"), /editable/);
  assert.equal(await f.source(), original);
  assert.equal(f.writes().length, 0);
});

test("registered note symlinks are rejected before reading or changing their targets", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.source();
  const target = path.join(f.base, "external.md");
  await fs.writeFile(target, original);
  await fs.unlink(f.physical(entry.path));
  await fs.symlink(target, f.physical(entry.path));
  let reads = 0;
  f.beforeRead = () => { reads++; };
  await assert.rejects(f.plugin.appendToPaperNote(PARENT, entry.path, "Passage"), /regular files/);
  assert.equal(reads, 0);
  assert.equal(await fs.readFile(target, "utf8"), original);
  assert.equal(f.modifications, 0);
});

test("a replaced notes folder symlink blocks sync even when its target remains inside the vault", async t => {
  const f = await fixture(t), entry = await f.importNote();
  const folder = path.dirname(f.physical(entry.path)), moved = path.join(f.base, "moved-notes");
  await fs.rename(folder, moved);
  await fs.symlink(moved, folder);
  let reads = 0;
  f.beforeRead = () => { reads++; };
  f.bumpRemote("Changed remote version");
  await f.plugin.refreshPaper(PARENT);
  assert.match(entry.message, /real directories/);
  assert.equal(reads, 0);
  assert.equal(notes.parseMarkdown(await fs.readFile(path.join(moved, path.basename(entry.path)), "utf8")).body, "Initial note");
  assert.equal(f.writes().length, 0);
});

test("legacy properties migrate after private ownership is durable, preserving exact text and custom fields", async t => {
  const f = await fixture(t), entry = await f.importNote("A thought\n\nSecond paragraph\n");
  const original = await f.legacy(entry, 'reading: active\ncustom:\n  topics:\n    - memory\nsummary: |\n  A personal summary\n');
  f.beforeModify = async () => {
    assert.match((await f.registry()).entries[0].fileId, /^[0-9a-f-]{36}$/);
    assert.equal(await f.source(), original);
  };
  await f.plugin.refreshNoteMetadata();
  const migrated = await f.source();
  assert.doesNotMatch(migrated, /^zotero-/m);
  assert.match(migrated, /authors: \["Ada Example","Research Group"\]/);
  assert.match(migrated, /conference: "Systems Conference"/);
  assert.match(migrated, /year: 2024/);
  assert.match(migrated, /reading: active\ncustom:\n  topics:\n    - memory\nsummary: \|\n  A personal summary/);
  assert.equal((await f.local()).body, "A thought\n\nSecond paragraph\n");
  assert.equal(entry.base.localBody, "A thought\n\nSecond paragraph\n");
  assert.equal(f.writes().length, 0);
});

test("failed identity persistence leaves legacy properties intact and can migrate after restart", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.legacy(entry);
  f.beforeRegistryWrite = () => { throw ioError(); };
  await f.plugin.refreshNoteMetadata();
  assert.equal(await f.source(), original);
  assert.equal((await f.registry()).entries[0].fileId, undefined);
  // A repeated attempt cannot bypass persistence just because memory has a UUID.
  await f.plugin.refreshNoteMetadata();
  assert.equal(await f.source(), original);
  f.beforeRegistryWrite = null;
  await f.restart();
  await f.plugin.refreshNoteMetadata();
  assert.doesNotMatch(await f.source(), /^zotero-/m);
  assert.equal((await f.local()).body, "Initial note");
  assert.equal(f.writes().length, 0);
});

test("failure rewriting legacy properties recovers with the same durable UUID after restart", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.legacy(entry);
  f.beforeModify = () => { throw ioError(); };
  await f.plugin.refreshNoteMetadata();
  const fileId = (await f.registry()).entries[0].fileId;
  assert(fileId);
  assert.equal(await f.source(), original);
  f.beforeModify = null;
  await f.restart();
  await f.plugin.refreshNoteMetadata();
  assert.equal(f.entry().fileId, fileId);
  assert.equal((await f.local()).body, "Initial note");
  assert.equal(f.writes().length, 0);
});

test("metadata refresh leaves a deleted note archived and never recreates it", async t => {
  const f = await fixture(t), entry = await f.importNote("Keep my local work");
  await f.legacy(entry);
  f.remote.delete(NOTE);
  await f.plugin.refreshPaper(PARENT);
  const message = entry.message;
  assert.match(message, /Deleted in Zotero/);
  await f.plugin.refreshNoteMetadata();
  assert.equal(entry.message, message);
  assert.equal((await f.plugin.readArchivedNote(entry)).body, "Keep my local work");
  assert.equal(f.files.has(entry.path), false);
  assert.equal(f.plugin.mirrorsFor(PARENT).length, 0);
  assert.equal(f.writes().length, 0);
});

test("concurrent text and custom property edits survive metadata migration", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.legacy(entry);
  let reads = 0;
  const edited = original.replace("---\n\nInitial note", "reading: active\n---\n\nConcurrent thought");
  f.beforeRead = async () => { if (++reads === 2) await fs.writeFile(f.physical(entry.path), edited); };
  await f.plugin.refreshNoteMetadata();
  f.beforeRead = null;
  assert.equal(await f.source(), edited);
  await f.plugin.refreshNoteMetadata();
  assert.equal((await f.local()).body, "Concurrent thought");
  assert.match(await f.source(), /reading: active/);
  assert.equal(entry.base.localBody, "Initial note");
  assert.equal(f.writes().length, 0);
});

test("a legacy version mismatch remains visible and cannot be laundered by metadata migration", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.legacy(entry);
  const changed = original.replace("zotero-version: 1", "zotero-version: 99");
  await fs.writeFile(f.physical(entry.path), changed);
  await f.plugin.refreshNoteMetadata();
  assert.equal(await f.source(), changed);
  assert.equal(f.writes().length, 0);
  assert.match(f.notices.at(-1), /version differs/);
});

test("imported notes and local drafts show the parent paper's original Zotero tags", async t => {
  const f = await fixture(t);
  f.plugin.snapshot.items[0].tags = ["Unikernel", "disaggregate memory"];
  const imported = await f.importNote();
  assert.match(await f.source(imported), /paper-tags: \["Unikernel","disaggregate memory"\]/);
  const draft = await f.draft();
  assert.match(await f.source(draft), /paper-tags: \["Unikernel","disaggregate memory"\]/);
  assert.equal((await f.local(imported)).body, "Initial note");
  assert.equal((await f.local(draft)).body, draftBody("Draft body"));
  assert.equal(f.writes().length, 0);
});

test("Zotero tag updates and removals preserve personal tags, unsynced body and baseline without autosync", async t => {
  const f = await fixture(t);
  f.plugin.snapshot.items[0].tags = ["Old tag"];
  const entry = await f.importNote();
  await f.setLocal("Unsynchronized thought\n");
  await fs.writeFile(f.physical(entry.path), (await f.source()).replace('\n---\n\n', '\ntags:\n  - personal-reading\n---\n\n'));
  f.authorize();
  const originalBaseline = copy(entry.base);
  f.plugin.snapshot.items[0].tags = ["Unikernel", "disaggregate memory"];
  await f.plugin.refreshNoteMetadata();
  assert.match(await f.source(), /paper-tags: \["Unikernel","disaggregate memory"\]/);
  assert.doesNotMatch(await f.source(), /Old tag/);
  f.emitModify(entry);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.timeouts.length, 0);
  f.plugin.snapshot.items[0].tags = [];
  await f.plugin.refreshNoteMetadata();
  f.emitModify(entry);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.doesNotMatch(await f.source(), /paper-tags:/);
  assert.match(await f.source(), /tags:\n  - personal-reading/);
  assert.equal((await f.local()).body, "Unsynchronized thought\n");
  assert.deepEqual(entry.base, originalBaseline);
  assert.equal(f.timeouts.length, 0);
  assert.equal(f.writes().length, 0);
});

test("an older cache with unknown tags keeps the previous paper-tag property", async t => {
  const f = await fixture(t);
  f.plugin.snapshot.items[0].tags = ["Unikernel"];
  await f.importNote();
  delete f.plugin.snapshot.items[0].tags;
  f.plugin.snapshot.items[0].year = "2025";
  await f.plugin.refreshNoteMetadata();
  assert.match(await f.source(), /paper-tags: \["Unikernel"\]/);
  assert.match(await f.source(), /year: 2025/);
  assert.equal(f.writes().length, 0);
});

test("clean-note metadata edits do not advance the private body baseline or issue writes", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.setLocal("Unsynchronized thought");
  f.plugin.snapshot.items[0].conference = "Updated Venue";
  await f.plugin.refreshNoteMetadata();
  assert.match(await f.source(), /conference: "Updated Venue"/);
  assert.equal((await f.local()).body, "Unsynchronized thought");
  assert.equal((await f.local()).version, entry.base.version);
  assert.equal(entry.base.localBody, "Initial note");
  assert.equal(f.writes().length, 0);
  await f.plugin.refreshPaper(PARENT);
  assert.match(entry.message, /Local changes saved/);
});

test("duplicate private file identities cannot authorize two paths after restart", async t => {
  const f = await fixture(t), entry = await f.importNote(), saved = await f.registry();
  saved.entries.push({ ...saved.entries[0], path: `${path.dirname(entry.path)}/Another note.md` });
  await fs.writeFile(f.registryPath(), JSON.stringify(saved));
  await assert.rejects(f.restart(), /Duplicate shared-note identity/);
  assert.equal(f.writes().length, 0);
});

test("metadata refresh preserves spaced, quoted and Unicode custom property blocks after a managed field", async t => {
  const f = await fixture(t), entry = await f.importNote();
  const custom = 'reading status: active\n"personal summary": |\n  My own text\n学习: ongoing\n"key: with colon": preserved\n-custom: kept\n';
  await fs.writeFile(f.physical(entry.path), (await f.source()).replace('\n---\n\n', `\n${custom}---\n\n`));
  await f.plugin.refreshNoteMetadata();
  assert((await f.source()).includes(custom));
  assert.equal((await f.local()).body, "Initial note");
  assert.equal(f.writes().length, 0);
});

test("metadata writes cannot trigger automatic content writeback, including delayed watcher notifications", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.setLocal("Unsynchronized thought");
  f.authorize();
  f.plugin.snapshot.items[0].conference = "Updated Venue";
  await f.plugin.refreshNoteMetadata();
  const file = f.files.get(entry.path);
  f.events.get("modify")(file);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.timeouts.length, 0);
  assert.equal(f.writes().length, 0);
  await f.setLocal("A later user edit");
  f.events.get("modify")(file);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.timeouts.length, 1);
  assert.equal(entry.base.localBody, "Initial note");
});

test("a slow watcher from an older metadata write cannot schedule sync after a newer metadata refresh", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.setLocal("Unsynchronized thought");
  f.authorize();
  f.plugin.snapshot.items[0].conference = "First Venue";
  await f.plugin.refreshNoteMetadata();
  const captured = deferred(), release = deferred();
  let delayed = false;
  f.afterRead = async (_, source) => {
    if (!delayed) { delayed = true; captured.resolve(); await release.promise; }
    return source;
  };
  const file = f.files.get(entry.path);
  f.events.get("modify")(file);
  await captured.promise;
  f.plugin.snapshot.items[0].conference = "Second Venue";
  await f.plugin.refreshNoteMetadata();
  f.afterRead = null;
  release.resolve();
  await new Promise(resolve => setTimeout(resolve, 10));
  f.events.get("modify")(file);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.timeouts.length, 0);
  assert.equal(f.writes().length, 0);
  assert.equal((await f.local()).body, "Unsynchronized thought");
  assert.equal(entry.base.localBody, "Initial note");
});

test("native Trash archives exact unsynchronized text before removing its active mirror", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.setLocal("My unsynchronized thought\n\nKeep this too\n");
  const source = (await f.source()).replace('\n---\n\n', '\nreading: active\n---\n\n');
  await fs.writeFile(f.physical(entry.path), source);
  f.remote.get(NOTE).deleted = 1;
  f.authorize();
  f.plugin.noteTargets = new Map([[PARENT, entry.path]]);
  f.beforeDelete = async () => {
    const saved = (await f.registry()).entries[0];
    assert.equal(saved.deleted, true);
    assert.equal(saved.archiveId, entry.archiveId);
    assert.equal((await f.plugin.readArchivedNote(entry)).source, source);
  };
  await f.plugin.refreshPaper(PARENT);
  assert.equal(f.files.has(entry.path), false);
  assert.equal(f.deletions, 1);
  assert.equal(f.plugin.mirrorsFor(PARENT).length, 0);
  assert.equal(f.plugin.deletedMirrorsFor(PARENT)[0], entry);
  assert.equal(f.plugin.noteTargets.has(PARENT), false);
  assert.equal((await f.plugin.readArchivedNote(entry)).source, source);
  assert.equal(await fs.readFile(f.physical(`.trash/${path.basename(entry.path)}`), "utf8"), source);
  assert.equal(entry.base.localBody, "Initial note");
  assert.equal(f.writes().length, 0);
  await f.restart();
  assert.equal((await f.plugin.readArchivedNote(f.entry())).source, source);
});

test("confirmed native 404 removes only the registered mirror, preserving unrelated notes", async t => {
  const f = await fixture(t), entry = await f.importNote();
  const independent = `${path.dirname(entry.path)}/My synthesis.md`;
  await f.addFile(independent, "A local synthesis");
  f.remote.delete(NOTE);
  await f.plugin.refreshSharedNotes();
  assert.equal(f.deletions, 1);
  assert.equal(await fs.readFile(f.physical(independent), "utf8"), "A local synthesis");
  assert.equal((await f.plugin.readArchivedNote(entry)).body, "Initial note");
  assert.equal(f.writes().length, 0);
});

for (const state of ["active", "moved", "offline", "malformed"]) test(`an absent child with ${state} item state cannot remove local text`, async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.source();
  // Hide the child from the listing; the separate keyed check must decide.
  f.remote.get(NOTE).deleted = 1;
  if (state === "moved") f.remote.get(NOTE).parentItem = "PPRB2222";
  if (state === "malformed") f.remote.get(NOTE).deleted = "yes";
  f.requestHook = call => {
    if (call.method === "GET" && call.path.endsWith(`/${NOTE}`)) {
      if (state === "active") f.remote.get(NOTE).deleted = 0;
      if (state === "offline") throw new Error("Zotero connection interrupted");
    }
  };
  await f.plugin.refreshPaper(PARENT);
  assert.equal(await f.source(), original);
  assert.equal(entry.deleted, undefined);
  assert.equal(f.deletions, 0);
  assert.equal(f.writes().length, 0);
  assert.match(entry.message, state === "moved" ? /moved/ : state === "active" ? /changed during/ : state === "offline" ? /did not complete/ : /unexpected shared-note state/);
});

test("archive or registry failure leaves the active note untouched", async t => {
  for (const failure of ["archive", "registry"]) {
    const f = await fixture(t), entry = await f.importNote(), original = await f.source();
    f.remote.get(NOTE).deleted = true;
    if (failure === "archive") f.beforeArchiveSave = () => { throw ioError(); };
    else f.beforeRegistryWrite = saved => { if (saved.entries.some(value => value.deleted)) throw ioError(); };
    await f.plugin.refreshPaper(PARENT);
    assert.equal(await f.source(), original);
    assert.equal(entry.deleted, undefined);
    assert.equal(f.deletions, 0);
    assert.match(entry.message, /I\/O failure/);
    assert.equal(f.writes().length, 0);
  }
});

test("an edit during archival is retained and the next refresh archives its newest text", async t => {
  const f = await fixture(t), entry = await f.importNote();
  f.remote.get(NOTE).deleted = true;
  f.beforeArchiveSave = async () => { await f.setLocal("An edit while archiving"); f.beforeArchiveSave = null; };
  await f.plugin.refreshPaper(PARENT);
  assert.equal((await f.local()).body, "An edit while archiving");
  assert.equal(f.deletions, 0);
  assert.match(entry.message, /changed while archiving/);
  await f.plugin.refreshPaper(PARENT);
  assert.equal(f.deletions, 1);
  assert.equal((await f.plugin.readArchivedNote(entry)).body, "An edit while archiving");
  assert.equal(f.writes().length, 0);
});

test("failed local Trash removal resumes after restart without losing a later edit", async t => {
  const f = await fixture(t), entry = await f.importNote();
  f.remote.get(NOTE).deleted = true;
  f.beforeDelete = () => { throw ioError(); };
  await f.plugin.refreshPaper(PARENT);
  assert.equal(entry.deleted, true);
  assert.equal((await f.plugin.readArchivedNote(entry)).body, "Initial note");
  await f.setLocal("A later retained edit");
  f.beforeDelete = null;
  await f.restart();
  await f.plugin.refreshPaper(PARENT);
  assert.equal(f.deletions, 1);
  assert.equal((await f.plugin.readArchivedNote(f.entry())).body, "A later retained edit");
});

test("restoring the same native note returns its mirror with local edits and its original baseline", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.setLocal("A personal unsynchronized thought");
  const source = await f.source();
  f.remote.get(NOTE).deleted = true;
  await f.plugin.refreshPaper(PARENT);
  await f.restart();
  f.remote.get(NOTE).deleted = false;
  f.remote.get(NOTE).version = ++f.version;
  await f.plugin.refreshPaper(PARENT);
  const restored = f.entry();
  assert.equal(restored.deleted, false);
  assert.equal(await f.source(), source);
  assert.equal(restored.base.localBody, "Initial note");
  assert.match(restored.message, /Both apps changed/);
  assert.equal(f.plugin.mirrorsFor(PARENT).length, 1);
  assert.equal(f.writes().length, 0);
});

test("a restored note still preserves both versions when its native text also changed", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.setLocal("My unsynchronized text");
  f.remote.get(NOTE).deleted = true;
  await f.plugin.refreshPaper(PARENT);
  f.remote.get(NOTE).deleted = false;
  f.bumpRemote("New native text");
  await f.plugin.refreshSharedNotes();
  assert.equal((await f.local()).body, "My unsynchronized text");
  assert.match(entry.message, /Both apps changed/);
  assert.equal(notes.parseMarkdown(await fs.readFile(f.physical(entry.conflictPath), "utf8")).body, "New native text");
  assert.equal(f.writes().length, 0);
});

test("native restoration imports current text if the local mirror was already missing before deletion", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await fs.unlink(f.physical(entry.path)); f.files.delete(entry.path);
  f.remote.get(NOTE).deleted = true;
  await f.plugin.refreshPaper(PARENT);
  assert.equal(entry.deleted, true);
  assert.equal(entry.archiveId, undefined);
  f.remote.get(NOTE).deleted = false;
  f.bumpRemote("The restored native text");
  await f.plugin.refreshSharedNotes();
  assert.equal((await f.local()).body, "The restored native text");
  assert.equal(entry.deleted, false);
  assert.equal(entry.base.localBody, "The restored native text");
  assert.equal(f.writes().length, 0);
});

test("restoration refuses an unrelated file occupying the original path", async t => {
  const f = await fixture(t), entry = await f.importNote();
  f.remote.get(NOTE).deleted = true;
  await f.plugin.refreshPaper(PARENT);
  await f.addFile(entry.path, "My unrelated note");
  f.remote.get(NOTE).deleted = false;
  await f.plugin.refreshPaper(PARENT);
  assert.equal(await f.source(), "My unrelated note");
  assert.equal(entry.deleted, true);
  assert.equal((await f.plugin.readArchivedNote(entry)).body, "Initial note");
  assert.equal(f.writes().length, 0);
});

test("archived copies can be recovered locally without registering or recreating native notes", async t => {
  const f = await fixture(t), entry = await f.importNote("Recovered thought");
  f.remote.get(NOTE).deleted = true;
  await f.plugin.refreshPaper(PARENT);
  f.authorize();
  const target = await f.plugin.saveArchivedCopy(entry);
  assert.equal(target, "corpus/research/papers/A Test Paper · recovered.md");
  const source = await fs.readFile(f.physical(target), "utf8");
  assert.match(source, /Recovered thought/);
  assert.doesNotMatch(source, /noema-shared-note:|^zotero-/m);
  assert.equal(f.plugin.mirrors.has(target), false);
  assert.equal(f.activeFile.path, target);
  await f.plugin.refreshSharedNotes();
  assert.equal(f.files.has(target), true);
  assert.equal(f.writes().length, 0);
});

test("repeated archived recovery creates separate concise copies without overwriting earlier text", async t => {
  const f = await fixture(t), entry = await f.importNote("A preserved archived thought");
  f.remote.get(NOTE).deleted = true;
  await f.plugin.refreshPaper(PARENT);
  const first = await f.plugin.saveArchivedCopy(entry);
  await fs.writeFile(f.physical(first), "An edited independent recovery");
  const second = await f.plugin.saveArchivedCopy(entry);
  assert.equal(first, "corpus/research/papers/A Test Paper · recovered.md");
  assert.equal(second, "corpus/research/papers/A Test Paper · recovered (2).md");
  assert.equal(await fs.readFile(f.physical(first), "utf8"), "An edited independent recovery");
  assert.match(await fs.readFile(f.physical(second), "utf8"), /A preserved archived thought/);
  assert.equal(f.plugin.mirrors.size, 1);
  assert.equal(f.plugin.mirrors.has(first), false);
  assert.equal(f.plugin.mirrors.has(second), false);
  assert.equal(f.writes().length, 0);
});

test("library refresh remains read-only for dirty mirrors and drafts during an authorized session", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.setLocal("Unsynchronized thought");
  await f.draft("Unsynchronized draft");
  f.authorize();
  await f.plugin.refreshSharedNotes();
  assert.equal(f.writes().length, 0);
  assert.equal((await f.local(entry)).body, "Unsynchronized thought");
  assert.equal(f.remote.get(NOTE).note, asHTML("Initial note"));
  assert.equal(f.plugin.mirrorsFor(PARENT).length, 2);
});

test("the active Markdown note polls native deletion without requiring its PDF to be open", async t => {
  const f = await fixture(t), entry = await f.importNote();
  f.activeFile = f.files.get(entry.path);
  f.remote.get(NOTE).deleted = true;
  for (const poll of f.intervals) poll();
  await f.plugin.paperLoads.get(PARENT);
  assert.equal(f.deletions, 1);
  assert.equal((await f.plugin.readArchivedNote(entry)).body, "Initial note");
});

test("a backed legacy migration can repair a stale registry before deletion sync", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.legacy(entry);
  await f.plugin.refreshNoteMetadata();
  const fileId = entry.fileId;
  const backup = path.join(path.dirname(f.registryPath()), "property-migrations", `${fileId}.md`);
  await fs.mkdir(path.dirname(backup), { recursive: true });
  await fs.writeFile(backup, original);
  const stale = await f.registry(); delete stale.entries[0].fileId;
  await fs.writeFile(f.registryPath(), JSON.stringify(stale));
  await f.restart();
  assert.equal(f.entry().fileId, fileId);
  f.remote.get(NOTE).deleted = true;
  await f.plugin.refreshSharedNotes();
  assert.equal(f.deletions, 1);
  assert.equal((await f.plugin.readArchivedNote(f.entry())).body, "Initial note");
});

test("a clean marker alone cannot repair a lost private registry identity", async t => {
  const f = await fixture(t), entry = await f.importNote(), original = await f.source();
  const stale = await f.registry(); delete stale.entries[0].fileId;
  await fs.writeFile(f.registryPath(), JSON.stringify(stale));
  await assert.rejects(f.restart(), /ENOENT/);
  assert.equal(await f.source(), original);
  assert.equal(f.deletions, 0);
  // Failed initialization must not mark that server as already loaded.
  await assert.rejects(f.plugin.initializeShared(), /ENOENT/);
});

test("a symlinked private registry cannot authorize deletion of a corpus note", async t => {
  const f = await fixture(t), entry = await f.importNote(), source = await f.source();
  const registry = f.registryPath(), moved = `${registry}.kept`;
  await fs.rename(registry, moved);
  await fs.symlink(moved, registry);
  f.remote.get(NOTE).deleted = true;
  await assert.rejects(f.plugin.refreshPaper(PARENT), /real files and directories/);
  assert.equal(await f.source(), source);
  assert.equal(f.deletions, 0);
  assert.equal(f.writes().length, 0);
});

test("Always Allow survives repeated writes and restart without another authorization request", async t => {
  const f = await fixture(t);
  await f.plugin.enableWriteback();
  for (let i = 0; i < 3; i++) assert.equal(await f.plugin.withWrite(key => key === AUTH, true), true);
  assert.equal(f.secrets.size, 1);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
  await f.restart();
  assert.equal(f.plugin.writeKey, AUTH);
  assert.equal(f.plugin.writeRemember, true);
  assert.equal(await f.plugin.withWrite(key => key === AUTH), true);
  await f.plugin.enableWriteback();
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
  const entry = await f.draft();
  assert(!JSON.stringify(await f.registry()).includes(AUTH));
  assert(!(await f.source(entry)).includes(AUTH));
  assert(f.secretCalls.every(call => /^[a-z0-9-]{1,64}$/.test(call.name)));
});

test("one-time Allow is not stored and is consumed even when its write fails", async t => {
  const f = await fixture(t); f.authorizationRemember = false;
  await assert.rejects(f.plugin.withWrite(() => { throw Object.assign(new Error("Native conflict"), { code: "CONFLICT" }); }, true), /Native conflict/);
  assert.equal(f.plugin.writeKey, null);
  assert.equal(f.secrets.size, 0);
  assert.equal(f.secretCalls.some(call => call.operation === "set"), false);
  assert.equal(await f.plugin.withWrite(key => key === AUTH, true), true);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 2);
  await f.restart();
  assert.equal(f.plugin.writeKey, null);
});

test("concurrent manual writes share one Always Allow dialog", async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  f.requestHook = async call => { if (call.path === "/api/local/authorize") { started.resolve(); await release.promise; } };
  const first = f.plugin.withWrite(key => key === AUTH, true);
  await started.promise;
  const second = f.plugin.withWrite(key => key === AUTH, true);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
  assert.equal(f.secretCalls.filter(call => call.operation === "set").length, 1);
});

test("failed secure storage preserves session authorization without exposing the credential", async t => {
  const f = await fixture(t);
  f.beforeSecretSet = () => { throw new Error(`Locked storage ${AUTH}`); };
  await f.plugin.enableWriteback();
  assert.equal(await f.plugin.withWrite(key => key === AUTH), true);
  assert.equal(f.secrets.size, 0);
  assert(f.notices.some(message => /could not be saved/.test(message)));
  assert(f.notices.every(message => !message.includes(AUTH)));
  await f.restart();
  assert.equal(f.plugin.writeKey, null);
});

test("unreadable saved authorization does not prevent loading notes or leak storage errors", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.plugin.enableWriteback();
  f.beforeSecretGet = () => { throw new Error(`Keychain failure ${AUTH}`); };
  await f.restart();
  assert.equal(f.plugin.writeKey, null);
  assert.equal(f.entry().key, entry.key);
  assert.equal((await f.local()).body, "Initial note");
  assert(f.notices.some(message => /could not be read/.test(message)));
  assert(f.notices.every(message => !message.includes(AUTH)));
});

test("an invalid stored credential is ignored and can be replaced by a fresh grant", async t => {
  const f = await fixture(t);
  await f.plugin.enableWriteback();
  const name = [...f.secrets.keys()][0];
  f.secrets.set(name, "invalid-secret-value");
  await f.restart();
  assert.equal(f.plugin.writeKey, null);
  assert(f.notices.every(message => !message.includes("invalid-secret-value")));
  await f.plugin.enableWriteback();
  assert.equal(f.secrets.get(name), AUTH);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 2);
});

test("native 401 forgets the revoked grant without retrying the write or authorization", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.plugin.enableWriteback();
  await f.setLocal("A changed note");
  f.requestHook = call => call.method === "PATCH" ? { status: 401, headers: { "Zotero-Server-ID": SERVER }, text: "{}" } : undefined;
  await f.plugin.refreshPaper(PARENT);
  assert.match(entry.message, /Authorize/);
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
  assert.equal(f.plugin.writeKey, null);
  assert.equal(f.plugin.writeRemember, false);
  assert.equal(f.secrets.size, 0);
  assert.equal((await f.local()).body, "A changed note");
  f.requestHook = null;
  await f.plugin.withWrite(key => key === AUTH, true);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 2);
});

for (const code of ["CONFLICT", "FORBIDDEN", "WRITE_UNCERTAIN"]) test(`${code} preserves remembered authorization and never retries a write`, async t => {
  const f = await fixture(t); await f.plugin.enableWriteback();
  let writes = 0;
  await assert.rejects(f.plugin.withWrite(() => { writes++; throw Object.assign(new Error("Native write failed"), { code }); }, true), /Native write failed/);
  assert.equal(writes, 1);
  assert.equal(f.plugin.writeKey, AUTH);
  assert.equal(f.secrets.size, 1);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
});

test("a late 401 from an older grant cannot erase a newer saved authorization", async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  await f.plugin.enableWriteback();
  const pending = f.plugin.withWrite(async () => { started.resolve(); await release.promise; throw Object.assign(new Error("Old grant revoked"), { code: "AUTHORIZATION_REQUIRED" }); });
  const rejected = assert.rejects(pending, /Old grant revoked/);
  await started.promise;
  const newer = "B".repeat(32);
  createAuthorizationStore(f.plugin).save(SERVER, newer);
  f.plugin.writeKey = newer; f.plugin.writeRemember = true;
  release.resolve(); await rejected;
  assert.equal(f.plugin.writeKey, newer);
  assert.equal([...f.secrets.values()][0], newer);
});

test("a pending authorization cannot save a credential after plugin disable", async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  f.requestHook = async call => { if (call.path === "/api/local/authorize") { started.resolve(); await release.promise; } };
  const pending = f.plugin.enableWriteback(), rejected = assert.rejects(pending, /disabled/);
  await started.promise; f.plugin.active = false; release.resolve(); await rejected;
  assert.equal(f.secrets.size, 0);
  assert.equal(f.plugin.writeKey, null);
});

test("a changed Zotero database cannot inherit a pending authorization or receive its write", async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  f.requestHook = async call => { if (call.path === "/api/local/authorize") { started.resolve(); await release.promise; } };
  let writes = 0;
  const pending = f.plugin.withWrite(() => { writes++; }, true), rejected = assert.rejects(pending, /context changed/);
  await started.promise;
  f.plugin.snapshot.serverId = "OtherServer222";
  release.resolve(); await rejected;
  assert.equal(writes, 0);
  assert.equal(f.secrets.size, 0);
  assert.equal(f.plugin.writeKey, null);
});

test("remembered credentials are restored only for their own Zotero database", async t => {
  const f = await fixture(t); await f.plugin.enableWriteback();
  f.plugin.snapshot.serverId = "OtherServer222";
  await f.plugin.initializeShared();
  assert.equal(f.plugin.writeKey, null);
  assert.equal(f.plugin.writeRemember, false);
  f.plugin.snapshot.serverId = SERVER;
  await f.plugin.initializeShared();
  assert.equal(f.plugin.writeKey, AUTH);
  assert.equal(f.plugin.writeRemember, true);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
});

test("forgetting authorization disables automatic writes and removes its saved credential", async t => {
  const f = await fixture(t); await f.plugin.enableWriteback();
  await f.plugin.forgetWriteback();
  assert.equal(f.plugin.writeKey, null);
  assert.equal(f.secrets.size, 0);
  await assert.rejects(f.plugin.withWrite(() => { throw new Error("Must not run"); }), /Enable writeback/);
  await f.restart();
  assert.equal(f.plugin.writeKey, null);
  assert.equal(await f.plugin.withWrite(key => key === AUTH, true), true);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 2);
});

test("forgetting a pending grant cancels it without clearing a newer authorization request", async t => {
  const f = await fixture(t), firstStarted = deferred(), secondStarted = deferred(), releaseFirst = deferred(), releaseSecond = deferred();
  let requests = 0;
  f.requestHook = async call => {
    if (call.path !== "/api/local/authorize") return;
    if (++requests === 1) { firstStarted.resolve(); await releaseFirst.promise; }
    else { secondStarted.resolve(); await releaseSecond.promise; }
  };
  const first = f.plugin.enableWriteback(), rejected = assert.rejects(first, /context changed/);
  await firstStarted.promise;
  await f.plugin.forgetWriteback();
  const second = f.plugin.enableWriteback(); await secondStarted.promise;
  releaseFirst.resolve(); await rejected;
  const third = f.plugin.enableWriteback();
  releaseSecond.resolve(); await Promise.all([second, third]);
  assert.equal(requests, 2);
  assert.equal(f.plugin.writeKey, AUTH);
  assert.equal(f.secrets.size, 1);
});

test("Forget can clear a malformed saved credential without requesting authorization", async t => {
  const f = await fixture(t); await f.plugin.enableWriteback();
  const name = [...f.secrets.keys()][0]; f.secrets.set(name, "Malformed credential");
  await f.restart(); await f.plugin.forgetWriteback();
  assert.equal(f.plugin.writeKey, null);
  assert.equal(f.secrets.size, 0);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
});

test("a lifecycle change inside secret storage cannot reenable a disabled plugin", async t => {
  const f = await fixture(t);
  f.beforeSecretSet = () => { f.plugin.active = false; };
  await assert.rejects(f.plugin.enableWriteback(), /disabled/);
  assert.equal(f.plugin.writeKey, null);
  assert.equal(f.plugin.writeRemember, false);
});

test("a new paper note automatically creates its Zotero child without an open notes view", async t => {
  const f = await fixture(t); f.authorize();
  const entry = await f.draft("A finding saved in Obsidian");
  f.activeFile = null;
  assert.equal(f.plugin.paperViews.size, 0);
  assert.equal(f.writes().length, 0, "Local save returns before the debounce sends a write");
  await f.flushAutoSync();
  assert.equal(f.writes("POST").length, 1);
  assert.equal(entry.draft, false);
  assert.equal(f.remote.get(entry.key).note, asHTML(draftBody("A finding saved in Obsidian")));
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 0);
});

test("an appended passage automatically reaches Zotero without relying on a modify notification", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  await f.plugin.appendToPaperNote(PARENT, entry.path, "A second finding");
  f.activeFile = null;
  await f.flushAutoSync();
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.remote.get(NOTE).note, asHTML("Initial note\n\nA second finding\n"));
  assert.equal((await f.local(entry)).body, entry.base.localBody);
});

test("editor changes automatically sync a registered note after switching to another tab", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  await f.setLocal("An editor change"); f.emitModify(entry); f.activeFile = null;
  await f.flushAutoSync();
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.remote.get(NOTE).note, asHTML("An editor change"));
});

test("repeated editor modifications debounce to one final note update", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  for (const body of ["First keystrokes", "More keystrokes", "Finished thought"]) {
    await f.setLocal(body); f.emitModify(entry);
  }
  assert([...f.timers.values()].some(timer => timer.cleared));
  await f.flushAutoSync();
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.remote.get(NOTE).note, asHTML("Finished thought"));
});

test("automatic edits wait for an in-flight read-only refresh and then run a fresh writable pass", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  const started = deferred(), release = deferred(); let held = false;
  f.requestHook = async call => {
    if (!held && call.method === "GET" && call.path.endsWith("/children")) {
      held = true; started.resolve(); await release.promise;
    }
  };
  const readOnly = f.plugin.refreshSharedNotes();
  await started.promise;
  await f.setLocal("Changed during the library refresh"); f.emitModify(entry);
  const automatic = f.flushAutoSync();
  assert.equal(f.writes().length, 0);
  release.resolve(); await Promise.all([readOnly, automatic]);
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.remote.get(NOTE).note, asHTML("Changed during the library refresh"));
});

test("a passage appended during a refresh is synchronized by a subsequent automatic pass", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  const started = deferred(), release = deferred(); let held = false;
  f.requestHook = async call => {
    if (!held && call.method === "GET" && call.path.endsWith("/children")) {
      held = true; started.resolve(); await release.promise;
    }
  };
  const readOnly = f.plugin.refreshSharedNotes(); await started.promise;
  await f.plugin.appendToPaperNote(PARENT, entry.path, "A passage added during refresh");
  const automatic = f.flushAutoSync(); release.resolve();
  await Promise.all([readOnly, automatic]);
  assert.equal(f.writes("PATCH").length, 1);
  assert.match(f.remote.get(NOTE).note, /A passage added during refresh/);
});

test("an editor change during an automatic write is sent in a later pass without losing either version", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  const started = deferred(), release = deferred(); let held = false;
  f.requestHook = async call => {
    if (!held && call.method === "PATCH") { held = true; started.resolve(); await release.promise; }
  };
  await f.setLocal("First submitted version"); f.emitModify(entry);
  const automatic = f.flushAutoSync(); await started.promise;
  await f.setLocal("Later editor version"); f.emitModify(entry);
  release.resolve(); await automatic;
  assert.equal(f.writes("PATCH").length, 2);
  assert.equal(f.writes("PATCH")[0].body.note, asHTML("First submitted version"));
  assert.equal(f.remote.get(NOTE).note, asHTML("Later editor version"));
  assert.equal((await f.local(entry)).body, "Later editor version");
});

test("editing a draft during automatic creation follows its new native key without creating a duplicate", async t => {
  const f = await fixture(t); f.authorize();
  const entry = await f.draft("The original draft"), started = deferred(), release = deferred();
  f.beforePost = async () => { started.resolve(); await release.promise; };
  const automatic = f.flushAutoSync(); await started.promise;
  assert.equal(entry.pendingCreation, true);
  await f.setLocal("A revision made during creation", entry); f.emitModify(entry);
  release.resolve(); await automatic;
  assert.equal(f.writes("POST").length, 1);
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(entry.draft, false);
  assert.equal((await f.local(entry)).key, entry.key);
  assert.equal(f.remote.get(entry.key).note, asHTML("A revision made during creation"));
  assert.equal([...f.remote.values()].filter(record => record.itemType === "note").length, 1);
});

test("enabling remembered authorization shares notes saved before authorization", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.setLocal("An edit waiting for authorization");
  const draft = await f.draft("A draft waiting for authorization");
  await f.flushAutoSync(); assert.equal(f.writes().length, 0);
  await f.plugin.enableWriteback(); f.activeFile = null;
  await f.flushAutoSync();
  assert.equal(f.writes("POST").length, 1);
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.remote.get(NOTE).note, asHTML("An edit waiting for authorization"));
  assert.equal(f.remote.get(draft.key).note, asHTML(draftBody("A draft waiting for authorization")));
  assert.equal((await f.local(entry)).body, entry.base.localBody);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
});

test("restored Always Allow authorization automatically syncs subsequent edits after restart", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.plugin.enableWriteback(); await f.flushAutoSync(); await f.restart();
  const restored = f.plugin.mirrors.get(entry.path);
  await f.setLocal("Edited after restart", restored); f.emitModify(restored); f.activeFile = null;
  await f.flushAutoSync();
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.remote.get(NOTE).note, asHTML("Edited after restart"));
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
});

test("remembered authorization resumes a locally saved draft whose debounce had not run before restart", async t => {
  const f = await fixture(t); await f.plugin.enableWriteback();
  const entry = await f.draft("A draft saved immediately before restart");
  assert.equal(f.writes().length, 0);
  await f.restart(); f.activeFile = null; await f.flushAutoSync();
  const restored = f.plugin.mirrors.get(entry.path);
  assert.equal(f.writes("POST").length, 1);
  assert.equal(restored.draft, false);
  assert.equal(f.remote.get(restored.key).note, asHTML(draftBody("A draft saved immediately before restart")));
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
});

test("automatic creation and polling leave a one-time Allow grant available for an explicit write", async t => {
  const f = await fixture(t); f.authorizationRemember = false;
  await f.plugin.enableWriteback(); const entry = await f.draft("A one-time manual note");
  f.emitModify(entry); await f.flushAutoSync();
  for (const poll of f.intervals) poll();
  await Promise.all([...f.plugin.paperLoads.values()]);
  assert.equal(f.writes().length, 0);
  assert.equal(f.plugin.writeKey, AUTH);
  assert.equal(f.secrets.size, 0);
  await f.plugin.syncPaperNotes(PARENT, true);
  assert.equal(f.writes("POST").length, 1);
  assert.equal(f.plugin.writeKey, null);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
});

test("an automatic conversion cannot consume a one-time grant that replaced remembered authorization", async t => {
  const f = await fixture(t), entry = await f.importNote();
  await f.plugin.enableWriteback(); await f.flushAutoSync();
  const started = deferred(), release = deferred();
  f.beforeConvert = async () => { started.resolve(); await release.promise; };
  await f.setLocal("An edit paused during Markdown conversion"); f.emitModify(entry);
  const automatic = f.flushAutoSync(); await started.promise;
  await f.plugin.forgetWriteback(); f.authorizationRemember = false;
  await f.plugin.enableWriteback();
  assert.equal(f.plugin.writeRemember, false);
  release.resolve(); await automatic;
  assert.equal(f.writes().length, 0);
  assert.equal(f.plugin.writeKey, AUTH);
  assert.equal(f.secrets.size, 0);
  assert.equal((await f.local(entry)).body, "An edit paused during Markdown conversion");
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 2);
});

test("queued automatic changes stop on disable, even if a cleared timer is delivered late", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  await f.setLocal("Keep this local edit"); f.emitModify(entry);
  const delayed = f.timeouts.at(-1);
  f.plugin.active = false; for (const callback of f.cleanup.splice(0)) callback();
  await delayed(); await f.flushAutoSync();
  assert.equal(f.writes().length, 0);
  assert.equal((await f.local(entry)).body, "Keep this local edit");
  assert([...f.timers.values()].every(timer => !timer.active));
});

test("an old database timer cannot send a note to a newly selected Zotero database", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  await f.setLocal("Original database edit"); f.emitModify(entry);
  const delayed = f.timeouts.at(-1);
  f.plugin.snapshot.serverId = "OtherServer222"; await f.plugin.initializeShared();
  await delayed(); await f.flushAutoSync();
  assert.equal(f.writes().length, 0);
  assert.equal((await f.local(entry)).body, "Original database edit");
  assert.equal(f.plugin.mirrors.size, 0);
  assert([...f.timers.values()].every(timer => !timer.active));
});

test("automatic writeback stops after a revoked grant without prompting or retrying", async t => {
  const f = await fixture(t), entry = await f.importNote(); await f.plugin.enableWriteback(); await f.flushAutoSync();
  f.requestHook = call => call.method === "PATCH" ? { status: 401, headers: { "Zotero-Server-ID": SERVER }, text: "{}" } : undefined;
  await f.setLocal("First edit after revocation"); f.emitModify(entry); await f.flushAutoSync();
  await f.setLocal("Second edit kept locally"); f.emitModify(entry); await f.flushAutoSync();
  assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.calls.filter(call => call.path === "/api/local/authorize").length, 1);
  assert.equal(f.plugin.writeKey, null);
  assert.equal(f.secrets.size, 0);
  assert.equal((await f.local(entry)).body, "Second edit kept locally");
});

test("automatic synchronization preserves concurrent Zotero changes as a conflict", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  await f.setLocal("The Obsidian version"); f.bumpRemote("The Zotero version"); f.emitModify(entry);
  await f.flushAutoSync();
  assert.equal(f.writes().length, 0);
  assert(entry.conflictPath);
  assert.equal((await f.local(entry)).body, "The Obsidian version");
  assert.equal(f.remote.get(NOTE).note, asHTML("The Zotero version"));
  f.emitModify(entry); await f.flushAutoSync(); assert.equal(f.writes().length, 0);
});

test("an uncertain automatic creation is never submitted again by later editor events", async t => {
  const f = await fixture(t); f.authorize();
  const entry = await f.draft("One automatically shared note");
  f.afterPost = () => { throw new Error("Isolated response lost after commit"); };
  await f.flushAutoSync();
  assert.equal(entry.pendingCreation, true);
  assert.equal(f.writes("POST").length, 1);
  await f.setLocal("A later local edit", entry); f.emitModify(entry); await f.flushAutoSync();
  assert.equal(f.writes("POST").length, 1);
  assert.equal([...f.remote.values()].filter(record => record.itemType === "note").length, 1);
  assert.equal((await f.local(entry)).body, "A later local edit");
});

test("a note deleted in Zotero while its edit is queued is archived rather than recreated", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  await f.setLocal("An edit saved before native deletion"); f.emitModify(entry);
  f.remote.get(NOTE).deleted = true; await f.flushAutoSync();
  assert.equal(f.writes().length, 0);
  assert.equal(entry.deleted, true);
  assert.equal((await f.plugin.readArchivedNote(entry)).body, "An edit saved before native deletion");
});

test("a failed local registry save does not schedule a new draft for automatic creation", async t => {
  const f = await fixture(t); f.authorize();
  f.beforeRegistryWrite = () => { throw ioError(); };
  const entry = await f.draft("A local note whose registry could not be saved");
  await f.flushAutoSync();
  assert.equal(f.writes().length, 0);
  assert.equal(entry.draft, true);
  assert.match(entry.message, /registry could not be saved/);
  assert.equal((await f.local(entry)).body, draftBody("A local note whose registry could not be saved"));
});

test("Delete paper note durably archives exact unsynchronized Markdown before one guarded native Trash write", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  await f.setLocal("An unsynchronized idea\n\nKeep its source and formatting.\n", entry);
  const source = await f.source(entry), originalBaseline = copy(entry.base);
  f.plugin.noteTargets = new Map([[PARENT, entry.path]]);
  f.requestHook = async call => {
    if (call.method !== "PATCH") return;
    assert.deepEqual(call.body, { deleted: 1 });
    const saved = (await f.registry()).entries.find(value => value.path === entry.path);
    assert(saved.archiveId); assert.equal(saved.deleted, undefined);
    assert.equal(await createNoteArchive(f.plugin).read(saved.archiveId), source);
    assert.equal(await f.source(entry), source);
  };
  const result = await f.plugin.trashPaperNote(entry);
  assert.equal(result.nativeDeleted, true); assert.equal(result.archived, true);
  assert.equal(f.writes("PATCH").length, 1); assert.equal(f.remote.get(NOTE).deleted, 1);
  assert.equal(f.remote.get(NOTE).note, asHTML("Initial note"));
  assert.equal(f.files.has(entry.path), false); assert.equal(f.deletions, 1);
  assert.equal((await f.plugin.readArchivedNote(entry)).source, source);
  assert.equal(await fs.readFile(f.physical(`.trash/${path.basename(entry.path)}`), "utf8"), source);
  assert.deepEqual(entry.base, originalBaseline); assert.equal(f.plugin.noteTargets.has(PARENT), false);
  await f.restart();
  assert.equal((await f.plugin.readArchivedNote(f.plugin.mirrors.get(entry.path))).source, source);
});

test("deleting an unsynchronized draft needs no Zotero request and cannot recreate it after refresh or restart", async t => {
  const f = await fixture(t); await f.plugin.enableWriteback();
  const entry = await f.draft("Only a local draft"), source = await f.source(entry);
  f.calls.length = 0;
  const result = await f.plugin.trashPaperNote(entry);
  assert.equal(result.nativeDeleted, false); assert.equal(result.archived, true);
  assert.equal(f.calls.length, 0); assert.equal(entry.localOnlyDeleted, true);
  assert.equal((await f.plugin.readArchivedNote(entry)).source, source);
  await f.plugin.syncPaperNotes(PARENT, true); await f.flushAutoSync();
  for (const poll of f.intervals) poll();
  await Promise.all([...f.plugin.paperLoads.values()]);
  await f.restart(); await f.plugin.syncPaperNotes(PARENT, true); await f.flushAutoSync();
  const restored = f.plugin.mirrors.get(entry.path);
  assert.equal(restored.deleted, true); assert.equal(restored.localOnlyDeleted, true);
  assert.equal(f.files.has(entry.path), false); assert.equal(f.plugin.mirrorsFor(PARENT).length, 0);
  assert.equal(f.writes().length, 0); assert.equal(f.calls.some(call => call.path === "/api/local/authorize"), false);
  assert.equal(f.calls.some(call => call.path.endsWith(`/${entry.key}`)), false);
});

for (const pendingState of [{ pendingCreation: true }, { pendingKey: "NATE3333" }]) test(`pending native creation ${Object.keys(pendingState)[0]} blocks deletion without querying guessed keys`, async t => {
  const f = await fixture(t), entry = await f.draft(), source = await f.source(entry);
  Object.assign(entry, pendingState); f.calls.length = 0;
  await assert.rejects(f.plugin.trashPaperNote(entry), /awaiting confirmation/);
  assert.equal(f.calls.length, 0); assert.equal(f.deletions, 0);
  assert.equal(await f.source(entry), source); assert.equal(entry.archiveId, undefined); assert.equal(entry.deleted, undefined);
});

test("Delete queued behind automatic creation uses the confirmed server key and never the draft key", async t => {
  const f = await fixture(t); f.authorize();
  const entry = await f.draft("A creation followed by deletion"), provisional = entry.key;
  const started = deferred(), release = deferred();
  f.beforePost = async () => { started.resolve(); await release.promise; };
  const automatic = f.flushAutoSync(); await started.promise;
  const deletion = f.plugin.trashPaperNote(entry); release.resolve();
  await deletion; await automatic;
  assert.equal(entry.draft, false); assert.notEqual(entry.key, provisional); assert.equal(entry.deleted, true);
  assert.equal(f.writes("POST").length, 1); assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.writes("PATCH")[0].path, `/api/users/0/items/${entry.key}`);
  assert.equal(f.calls.some(call => call.path.endsWith(`/${provisional}`)), false);
  assert.equal(f.remote.get(entry.key).deleted, 1); assert.equal(f.files.has(entry.path), false);
});

test("Delete cancels a queued editor write even if its cleared timer runs late", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  await f.setLocal("A queued editor change", entry); f.emitModify(entry);
  const lateTimer = f.timeouts.at(-1), source = await f.source(entry);
  await f.plugin.trashPaperNote(entry); await lateTimer(); await f.flushAutoSync();
  assert.equal(f.writes("PATCH").length, 1); assert.deepEqual(f.writes("PATCH")[0].body, { deleted: 1 });
  assert.equal(f.writes("POST").length, 0); assert.equal(f.remote.get(NOTE).note, asHTML("Initial note"));
  assert.equal((await f.plugin.readArchivedNote(entry)).source, source);
});

test("concurrent Delete requests share one native write and one local Trash operation", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  await Promise.all([f.plugin.trashPaperNote(entry), f.plugin.trashPaperNote(entry), f.plugin.trashPaperNote(entry)]);
  assert.equal(f.writes("PATCH").length, 1); assert.equal(f.deletions, 1);
  assert.equal(entry.deleted, true); assert.equal((await f.plugin.readArchivedNote(entry)).body, "Initial note");
});

for (const state of ["version", "moved", "offline", "malformed"]) test(`Delete preserves local text when keyed native state is ${state}`, async t => {
  const f = await fixture(t), entry = await f.importNote(), source = await f.source(entry);
  if (state === "version") f.bumpRemote("A changed native note");
  if (state === "moved") f.remote.get(NOTE).parentItem = "OTHER222";
  if (state === "malformed") f.remote.get(NOTE).deleted = "yes";
  if (state === "offline") f.requestHook = call => { if (call.method === "GET" && call.path.endsWith(`/${NOTE}`)) throw new Error("Disconnected"); };
  await assert.rejects(f.plugin.trashPaperNote(entry));
  assert.equal(await f.source(entry), source); assert.equal(entry.deleted, undefined);
  assert.equal(f.deletions, 0); assert.equal(f.writes().length, 0); assert.equal(entry.archiveId, undefined);
  assert.equal(f.calls.some(call => call.path === "/api/local/authorize"), false);
});

test("Delete rejects a version change during native validation without writing or removing the local file", async t => {
  const f = await fixture(t), entry = await f.importNote(), source = await f.source(entry); f.authorize();
  let reads = 0;
  f.requestHook = call => { if (call.method === "GET" && call.path.endsWith(`/${NOTE}`) && ++reads === 2) f.bumpRemote("Concurrent native edit"); };
  await assert.rejects(f.plugin.trashPaperNote(entry), error => error.code === "CONFLICT");
  assert.equal(f.writes().length, 0); assert.equal(f.deletions, 0); assert.equal(entry.deleted, undefined);
  assert.equal(await f.source(entry), source); assert.equal(await createNoteArchive(f.plugin).read(entry.archiveId), source);
});

for (const failure of ["archive", "registry"]) test(`Delete ${failure} preflight failure does not send a native write`, async t => {
  const f = await fixture(t), entry = await f.importNote(), source = await f.source(entry); f.authorize();
  if (failure === "archive") f.beforeArchiveSave = () => { throw ioError(); };
  else f.beforeRegistryWrite = saved => { if (saved.entries.some(value => value.archiveId)) throw ioError(); };
  await assert.rejects(f.plugin.trashPaperNote(entry));
  assert.equal(f.writes().length, 0); assert.equal(f.deletions, 0); assert.equal(entry.deleted, undefined);
  assert.equal(entry.archiveId, undefined); assert.equal(await f.source(entry), source);
});

test("a native Trash write rejection keeps the original local note and its recovery archive", async t => {
  const f = await fixture(t), entry = await f.importNote(), source = await f.source(entry); f.authorize();
  f.requestHook = call => call.method === "PATCH" ? { status: 403, headers: { "Zotero-Server-ID": SERVER }, text: "{}" } : undefined;
  await assert.rejects(f.plugin.trashPaperNote(entry), error => error.code === "FORBIDDEN");
  assert.equal(f.writes("PATCH").length, 1); assert.equal(f.deletions, 0); assert.equal(entry.deleted, undefined);
  assert.equal(f.remote.get(NOTE).deleted, undefined); assert.equal(await f.source(entry), source);
  assert.equal(await createNoteArchive(f.plugin).read(entry.archiveId), source);
});

test("a local Trash failure after verified native deletion reports success with a warning and retains recovery text", async t => {
  const f = await fixture(t), entry = await f.importNote(), source = await f.source(entry); f.authorize();
  f.beforeDelete = () => { throw ioError(); };
  const result = await f.plugin.trashPaperNote(entry);
  assert.equal(result.nativeDeleted, true); assert.match(result.warning, /I\/O failure/);
  assert.equal(f.remote.get(NOTE).deleted, 1); assert.equal(f.writes("PATCH").length, 1);
  assert.equal(f.deletions, 0); assert.equal(entry.deleted, true); assert.equal(await f.source(entry), source);
  assert.equal((await f.registry()).entries[0].archiveId, entry.archiveId);
  assert.equal((await f.plugin.readArchivedNote(entry)).source, source);
  assert(f.notices.some(message => /Deleted in Zotero.*local file was kept/.test(message)));
  f.beforeDelete = null; await f.plugin.refreshPaper(PARENT);
  assert.equal(f.files.has(entry.path), false); assert.equal(f.deletions, 1); assert.equal(f.writes("PATCH").length, 1);
});

test("an editor change during native Trash commit is kept locally and archived on the next refresh", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  f.requestHook = async call => { if (call.method === "PATCH") await f.setLocal("Edited while native Trash was saving", entry); };
  const result = await f.plugin.trashPaperNote(entry);
  assert.equal(result.nativeDeleted, true); assert.match(result.warning, /changed while archiving/);
  assert.equal((await f.local(entry)).body, "Edited while native Trash was saving");
  assert.equal(f.deletions, 0); f.requestHook = null;
  await f.plugin.refreshPaper(PARENT);
  assert.equal(f.deletions, 1); assert.equal((await f.plugin.readArchivedNote(entry)).body, "Edited while native Trash was saving");
});

test("a stale earlier children listing cannot resurrect a paper note deleted while it was loading", async t => {
  const f = await fixture(t), entry = await f.importNote(); f.authorize();
  const stale = { key: NOTE, version: 1, data: copy(f.remote.get(NOTE)) }, started = deferred(), release = deferred();
  let delayed = false;
  f.requestHook = async call => {
    if (!delayed && call.method === "GET" && call.path.endsWith(`/${PARENT}/children`)) {
      delayed = true; started.resolve(); await release.promise;
      return { status: 200, headers: { "Zotero-Server-ID": SERVER, "Total-Results": "1", "Last-Modified-Version": "1" }, text: JSON.stringify([stale]) };
    }
  };
  const refreshing = f.plugin.refreshPaper(PARENT); await started.promise;
  await f.plugin.trashPaperNote(entry); release.resolve(); await refreshing;
  assert.equal(entry.deleted, true); assert.equal(f.files.has(entry.path), false);
  assert.equal(f.plugin.mirrorsFor(PARENT).length, 0); assert.equal(f.writes("PATCH").length, 1);
});

for (const change of ["identity", "server", "unload"]) test(`Delete checks ${change} after archive work before native mutation`, async t => {
  const f = await fixture(t), entry = await f.importNote(), source = await f.source(entry); f.authorize();
  f.beforeArchiveSave = () => {
    if (change === "identity") f.plugin.mirrors.set(entry.path, { ...entry });
    if (change === "server") f.plugin.snapshot.serverId = "OtherServer222";
    if (change === "unload") f.plugin.active = false;
  };
  await assert.rejects(f.plugin.trashPaperNote(entry));
  assert.equal(f.writes().length, 0); assert.equal(f.deletions, 0);
  assert.equal(await f.source(entry), source); assert.equal(entry.deleted, undefined);
});

test("Delete rechecks registered note identity after interactive authorization before sending native Trash", async t => {
  const f = await fixture(t), entry = await f.importNote(), source = await f.source(entry);
  f.beforeSecretSet = () => { f.plugin.mirrors.set(entry.path, { ...entry }); };
  await assert.rejects(f.plugin.trashPaperNote(entry), /active shared paper note/);
  assert.equal(f.writes().length, 0); assert.equal(f.deletions, 0);
  assert.equal(f.remote.get(NOTE).deleted, undefined); assert.equal(await f.source(entry), source);
});

for (const change of ["server", "unload"]) test(`a ${change} change after native Trash verification retains local recovery and reports committed deletion`, async t => {
  const f = await fixture(t), entry = await f.importNote(), source = await f.source(entry); f.authorize();
  f.requestHook = call => {
    if (call.method !== "GET" || !call.path.endsWith(`/${NOTE}`) || !f.remote.get(NOTE).deleted) return;
    const value = copy(f.remote.get(NOTE));
    if (change === "server") f.plugin.snapshot.serverId = "OtherServer222";
    else f.plugin.active = false;
    return { status: 200, headers: { "Zotero-Server-ID": SERVER, "Last-Modified-Version": String(f.version) }, text: JSON.stringify({ key: value.key, version: value.version, data: value }) };
  };
  const result = await f.plugin.trashPaperNote(entry);
  assert.equal(result.nativeDeleted, true); assert(result.warning);
  assert.equal(f.writes("PATCH").length, 1); assert.equal(f.deletions, 0); assert.equal(await f.source(entry), source);
  assert.equal(f.remote.get(NOTE).deleted, 1); assert((await f.registry()).entries.find(value => value.path === entry.path).archiveId);
});

test("Delete current shared paper note command is available only for a registered active note", async t => {
  const f = await fixture(t), entry = await f.draft();
  const command = f.commands.find(value => value.id === "delete-current-note");
  assert(command); assert.equal(command.name, "Delete current shared paper note");
  f.activeFile = null; assert.equal(command.checkCallback(true), false);
  f.activeFile = await f.addFile("corpus/research/papers/Independent.md", "A personal synthesis");
  assert.equal(command.checkCallback(true), false);
  f.activeFile = f.files.get(entry.path); assert.equal(command.checkCallback(true), true);
  assert.equal(f.deletions, 0); assert.equal(f.writes().length, 0);
  await f.plugin.trashPaperNote(entry); assert.equal(command.checkCallback(true), false);
});

test("native notes inherit their parent field without write authorization", async t => {
  const f = await fixture(t);
  f.plugin.snapshot.items[0].tags = ["kernel-architecture", "libos"];
  const entry = await f.importNote("Native paper note");
  assert.match(entry.path, /^corpus\/research\/system\/os\/papers\//);
  assert.equal((await f.local()).body.trim(), "Native paper note");
  assert.equal(f.writes().length, 0);
});

test("discovery imports unseen parent notes, retains a cursor, and ignores standalone notes", async t => {
  const f = await fixture(t);
  f.plugin.snapshot.items[0].tags = ["field:system/storage"];
  f.remote.set(NOTE, { key: NOTE, version: ++f.version, itemType: "note", parentItem: PARENT, note: asHTML("New native note") });
  f.remote.set("STND2222", { key: "STND2222", version: f.version, itemType: "note", note: asHTML("Standalone") });
  await f.plugin.refreshSharedNotes();
  const entry = f.entry(), id = entry.fileId;
  assert.match(entry.path, /^corpus\/research\/system\/storage\/papers\//);
  assert.equal((await f.registry()).discoveryVersion, f.version);
  await f.plugin.refreshSharedNotes();
  assert.equal(f.plugin.mirrors.size, 1);
  assert.equal(f.entry().fileId, id);
  assert.equal(f.writes().length, 0);
});

test("classification moves all notes and preserves identity, body and writeback", async t => {
  const f = await fixture(t);
  const entry = await f.importNote("Keep my body");
  const original = await f.source(), id = entry.fileId, key = entry.key, baseline = copy(entry.base);
  await f.plugin.classifyPaper(PARENT, "system/os");
  assert.match(entry.path, /^corpus\/research\/system\/os\/papers\//);
  assert.equal(await f.source(), original);
  assert.equal(entry.fileId, id); assert.equal(entry.key, key); assert.deepEqual(copy(entry.base), baseline);
  f.authorize(); await f.setLocal("Edited after moving");
  await f.plugin.refreshPaper(PARENT);
  assert.match(f.remote.get(NOTE).note, /Edited after moving/);
  await f.restart();
  assert.equal(f.plugin.paperField(PARENT).field, "system/os");
  const next = await f.draft("Next child");
  assert.match(next.path, /^corpus\/research\/system\/os\/papers\//);
});

test("ambiguous parents go to Unfiled and can be selected locally", async t => {
  const f = await fixture(t);
  f.plugin.snapshot.items[0].tags = ["libos", "raft"];
  const entry = await f.importNote();
  assert.match(entry.path, /^corpus\/research\/papers\//);
  await f.plugin.classifyPaper(PARENT, "system/distributed-system");
  assert.equal(f.plugin.paperField(PARENT).field, "system/distributed-system");
  assert.equal(f.writes().length, 0);
});

test("legacy flat notes move into a field without changing their source or UUID", async t => {
  const f = await fixture(t);
  const entry = await f.importNote(), original = await f.source();
  const previous = entry.path;
  const legacy = `corpus/research/papers/notes/${path.basename(previous)}`;
  await fs.mkdir(path.dirname(f.physical(legacy)), { recursive: true });
  await f.plugin.app.fileManager.renameFile(f.files.get(previous), legacy);
  const saved = await f.registry(); saved.entries[0].path = legacy;
  await fs.writeFile(f.registryPath(), JSON.stringify(saved));
  await f.restart(); f.plugin.snapshot.items[0].tags = ["libos"];
  await f.plugin.refreshPaper(PARENT);
  assert.match(f.entry().path, /^corpus\/research\/system\/os\/papers\//);
  assert.equal(await f.source(), original);
  assert.equal(f.entry().fileId, entry.fileId);
});

test("interrupted file moves recover the saved identity on restart", async t => {
  const f = await fixture(t);
  const entry = await f.importNote(), from = entry.path;
  const target = `corpus/research/system/os/papers/${path.basename(from)}`;
  await fs.mkdir(path.dirname(f.physical(target)), { recursive: true });
  const saved = await f.registry();
  saved.paperFields = { [PARENT]: "system/os" }; saved.entries[0].pendingMove = { from, to: target };
  await fs.writeFile(f.registryPath(), JSON.stringify(saved));
  await f.plugin.app.fileManager.renameFile(f.files.get(from), target);
  await f.restart();
  assert.equal(f.entry().path, target); assert.equal(f.entry().fileId, entry.fileId);
  assert.equal((await f.registry()).entries[0].pendingMove, undefined);
  assert.equal((await f.local()).body.trim(), "Initial note");
});

test("removing a registered field fails without losing the private registry", async t => {
  const f = await fixture(t);
  await f.importNote(); await f.plugin.classifyPaper(PARENT, "system/os");
  const original = await fs.readFile(f.registryPath(), "utf8");
  await fs.writeFile(f.physical("corpus/research/fields.json"), JSON.stringify({ ...catalog, fields: catalog.fields.filter(field => field.id !== "system/os") }));
  await assert.rejects(f.restart(), /field|unmanaged path/);
  assert.equal(await fs.readFile(f.registryPath(), "utf8"), original);
});

test("clearing a local field selection restores Zotero routing", async t => {
  const f = await fixture(t);
  f.plugin.snapshot.items[0].tags = ["libos"];
  const entry = await f.importNote();
  await f.plugin.classifyPaper(PARENT, "ai");
  await f.plugin.classifyPaper(PARENT, undefined);
  assert.equal(f.plugin.paperField(PARENT).field, "system/os");
  assert.match(entry.path, /^corpus\/research\/system\/os\/papers\//);
  assert.equal(Object.hasOwn((await f.registry()).paperFields, PARENT), false);
});

test("discovery waits for classification, then fetches the paper before advancing its cursor", async t => {
  const f = await fixture(t), gate = deferred();
  f.remote.set(NOTE, { key: NOTE, version: ++f.version, itemType: "note", parentItem: PARENT, note: asHTML("Concurrent native note") });
  f.plugin.paperLoads.set(PARENT, gate.promise);
  const refresh = f.plugin.refreshSharedNotes();
  await new Promise(resolve => setImmediate(resolve));
  f.plugin.paperLoads.delete(PARENT); gate.resolve(); await refresh;
  assert.equal(f.plugin.mirrors.size, 1);
  assert.equal((await f.local()).body.trim(), "Concurrent native note");
  assert.equal((await f.registry()).discoveryVersion, f.version);
});

test("old Unfiled notes move directly into papers without changing their source or identity", async t => {
  const f = await fixture(t);
  const entry = await f.importNote(), original = await f.source();
  const previous = entry.path;
  const legacy = `corpus/research/papers/unfiled/${path.basename(previous)}`;
  await fs.mkdir(path.dirname(f.physical(legacy)), { recursive: true });
  await f.plugin.app.fileManager.renameFile(f.files.get(previous), legacy);
  const saved = await f.registry(); saved.entries[0].path = legacy;
  await fs.writeFile(f.registryPath(), JSON.stringify(saved));
  await f.restart(); await f.plugin.refreshSharedNotes();
  assert.equal(f.entry().path, previous);
  assert.equal(await f.source(), original);
  assert.equal(f.entry().fileId, entry.fileId);
  assert.equal(f.writes().length, 0);
  f.authorize(); await f.setLocal("Edited after flattening Unfiled");
  await f.plugin.refreshPaper(PARENT);
  assert.match(f.remote.get(NOTE).note, /Edited after flattening Unfiled/);
});


test("registry migration preserves note identities and baselines", async t => {
  const f = await fixture(t), entry = await f.importNote();
  const registry = await f.registry(), previous = path.join(path.dirname(path.dirname(f.registryPath())), "previous-layout");
  await fs.rename(path.dirname(f.registryPath()), previous);
  await f.restart();
  assert.equal(f.entry().fileId, entry.fileId);
  assert.deepEqual((await f.registry()).entries[0].base, registry.entries[0].base);
  assert.equal(f.writes().length, 0);
});
