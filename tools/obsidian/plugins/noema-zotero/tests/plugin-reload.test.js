"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const helpers = ["bridge.js", "library-query.js", "shared.js", "notes.js", "fields.js", "sync.js", "paper-view.js", "paper-note-template.js", "reader.js", "annotation-trash.js", "note-archive.js", "authorization-store.js", "reader-settings.js", "local-pdf.js"];
const forbidden = () => { throw new Error("Native I/O is prohibited in the reload fixture."); };

class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  registerEvent() {} registerView() {} addCommand() {} addRibbonIcon() {}
  registerMarkdownCodeBlockProcessor() {} registerInterval() {}
}

function pluginClass() {
  const module = { exports: {} };
  vm.runInNewContext(mainSource, {
    module, exports: module.exports, console,
    setTimeout: forbidden, clearTimeout: forbidden,
    window: { setInterval: () => 1, open: forbidden },
    require(name) {
      if (name === "obsidian") return {
        Plugin, ItemView: class {}, MarkdownRenderChild: class {}, Notice: class {}, SuggestModal: class {}, setIcon() {}
      };
      if (name === "node:fs/promises") return {
        async readFile() { throw Object.assign(new Error("No fixture library cache."), { code: "ENOENT" }); }
      };
      if (name === "node:http") return { request: forbidden };
      if (["node:path", "node:module", "node:buffer"].includes(name)) return require(name);
      throw new Error(`Unexpected main.js import: ${name}`);
    }
  }, { filename: "noema-zotero/main.js" });
  return module.exports;
}

const NoemaZotero = pluginClass();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noema-plugin-reload-"));
  const dir = path.join(root, ".obsidian", "plugins", "noema-zotero");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.js"), "module.exports = {};\n");
  const unrelated = path.join(root, "unrelated.js");
  fs.writeFileSync(unrelated, "module.exports = { preserve: true };\n");
  const load = createRequire(path.join(dir, "main.js"));
  const ready = [];
  const app = {
    vault: { configDir: ".obsidian", adapter: { getBasePath: () => root, async exists(name) { return name === ".obsidian/noema.json"; }, async read(name) { assert.equal(name,".obsidian/noema.json"); return JSON.stringify({zotero:{research_folder:"corpus/research",refresh_seconds:60}}); } } },
    workspace: { on() { return {}; }, onLayoutReady(callback) { ready.push(callback); }, getLeavesOfType() { return []; } }
  };
  const manifest = { dir: ".obsidian/plugins/noema-zotero" };
  const f = {
    root, dir, load, unrelated, ready,
    plugin() {
      const plugin = new NoemaZotero(app, manifest);
      // Adapter guards are outside this regression; no native adapter is present.
      plugin.guardPdfMutations = () => {};
      plugin.guardPdfIndex = () => {};
      return plugin;
    },
    write(revision) {
      const value = JSON.stringify(revision);
      const sources = {
        "bridge.js": `module.exports = { revision: ${value}, read: () => ${value} };\n`,
        "library-query.js": `module.exports = { revision: ${value} };\n`,
        "shared.js": `module.exports = { revision: ${value}, createClient: () => () => ${value} };\n`,
        "fields.js": `module.exports = { revision: ${value} };\n`,
        "notes.js": `module.exports = { revision: ${value}, parse: () => ${value} };\n`,
        "sync.js": `const { createClient } = require('./shared.js');\nconst helpers = require('./notes.js');\nconst template = require('./paper-note-template.js');\nconst client = createClient();\nmodule.exports = { revision: ${value}, client, notes: helpers, template, installShared(plugin) { plugin.sharedClientFixture = client; plugin.syncRevision = ${value}; plugin.noteTemplateFixture = template; } };\n`,
        "paper-view.js": `const helpers = require('./notes.js');\nmodule.exports = { revision: ${value}, notes: helpers, installPaperView(plugin) { plugin.paperViewRevision = ${value}; } };\n`,
        "paper-note-template.js": `module.exports = { revision: ${value}, initialize: () => ${value} };\n`,
        "reader.js": `const { createClient } = require('./shared.js');\nmodule.exports = { revision: ${value}, installReader(plugin) { if (!plugin.readerSettings || !plugin.localPdf) throw new Error('Reader dependencies were not installed.'); plugin.readerRevision = ${value}; return { revision: ${value}, client: createClient(), refresh() {} }; } };\n`,
        "annotation-trash.js": `module.exports = { revision: ${value}, createAnnotationTrash: () => ({ revision: ${value} }) };\n`,
        "note-archive.js": `module.exports = { revision: ${value}, createNoteArchive: () => ({ revision: ${value} }) };\n`,
        "authorization-store.js": `module.exports = { revision: ${value}, createAuthorizationStore: () => ({ revision: ${value} }) };\n`,
        "reader-settings.js": `module.exports = { revision: ${value}, async installReaderSettings(plugin) { await Promise.resolve(); plugin.readerSettings = { readerAlignment: 'center' }; plugin.readerSettingsRevision = ${value}; } };\n`,
        "local-pdf.js": `const template = require('./paper-note-template.js');\nmodule.exports = { revision: ${value}, template, installLocalPdf(plugin) { if (!plugin.readerSettings) throw new Error('Reader settings were not installed.'); return { revision: ${value}, template }; } };\n`
      };
      for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(dir, name), source);
    },
    cleanup() {
      for (const id of Object.keys(require.cache)) if (id.startsWith(`${root}${path.sep}`)) delete require.cache[id];
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  f.write("old");
  return f;
}

test("reload replaces every owned helper and the client captured by sync", () => {
  const f = fixture();
  try {
    const old = Object.fromEntries(helpers.map(name => [name, f.load(path.join(f.dir, name))]));
    assert.equal(old["sync.js"].client(), "old");
    f.write("new");
    // Re-evaluating main alone cannot change Node's cached auxiliary exports.
    assert.equal(f.load(path.join(f.dir, "shared.js")), old["shared.js"]);
    assert.equal(f.load(path.join(f.dir, "sync.js")).client(), "old");
    const load = f.plugin().loadLocalModules(f.dir);
    for (const name of helpers) {
      const fresh = load(path.join(f.dir, name));
      assert.notEqual(fresh, old[name], name);
      assert.equal(fresh.revision, "new", name);
    }
    const freshSync = load(path.join(f.dir, "sync.js"));
    assert.equal(freshSync.client(), "new");
    assert.equal(freshSync.notes.parse(), "new");
    assert.equal(freshSync.template.initialize(), "new");
    assert.equal(load(path.join(f.dir, "local-pdf.js")).template, freshSync.template);
    assert.equal(load(path.join(f.dir, "paper-view.js")).notes.parse(), "new");
    // Eviction never mutates functions still held by an unloaded instance.
    assert.equal(old["sync.js"].client(), "old");
    assert.equal(old["shared.js"].createClient()(), "old");
    assert.equal(old["bridge.js"].read(), "old");
    assert.equal(old["sync.js"].template.initialize(), "old");
  } finally { f.cleanup(); }
});

test("reload preserves unrelated cache entries and built-in module identity", () => {
  const f = fixture();
  try {
    const unrelated = f.load(f.unrelated);
    const entry = f.load.cache[f.load.resolve(f.unrelated)];
    const crypto = f.load("node:crypto");
    const unlisted = path.join(f.dir, "unlisted.js");
    fs.writeFileSync(unlisted, "module.exports = { preserve: true };\n");
    const localUnlisted = f.load(unlisted);
    for (const name of helpers) f.load(path.join(f.dir, name));
    f.write("new");
    const load = f.plugin().loadLocalModules(f.dir);
    assert.equal(load(f.unrelated), unrelated);
    assert.equal(load.cache[load.resolve(f.unrelated)], entry);
    assert.equal(load(unlisted), localUnlisted);
    assert.equal(load("node:crypto"), crypto);
  } finally { f.cleanup(); }
});

test("onload invokes the scoped loader before bridge and all auxiliary imports", async () => {
  const f = fixture();
  try {
    const oldPlugin = f.plugin();
    await oldPlugin.onload();
    assert.equal(oldPlugin.bridge.revision, "old");
    assert.equal(oldPlugin.sharedClientFixture(), "old");
    oldPlugin.onunload();
    f.write("new");
    const plugin = f.plugin();
    await plugin.onload();
    assert.equal(plugin.bridge.revision, "new");
    assert.equal(plugin.syncRevision, "new");
    assert.equal(plugin.sharedClientFixture(), "new");
    assert.equal(plugin.paperViewRevision, "new");
    assert.equal(plugin.readerRevision, "new");
    assert.equal(plugin.readerSettingsRevision, "new");
    assert.equal(plugin.localPdf.revision, "new");
    assert.equal(plugin.noteTemplateFixture.initialize(), "new");
    assert.equal(plugin.localPdf.template, plugin.noteTemplateFixture);
    assert.equal(plugin.reader.client(), "new");
    assert.equal(oldPlugin.sharedClientFixture(), "old");
    assert.equal(oldPlugin.active, false);
    plugin.onunload();
  } finally { f.cleanup(); }
});

test("early onload failure still uses the refreshed bridge without starting native I/O", async () => {
  const f = fixture();
  try {
    const oldBridge = f.load(path.join(f.dir, "bridge.js"));
    f.write("new");
    const plugin = f.plugin();
    const sentinel = new Error("Stop immediately after bridge initialization.");
    plugin.guardPdfMutations = () => { throw sentinel; };
    await assert.rejects(plugin.onload(), error => error === sentinel);
    assert.notEqual(plugin.bridge, oldBridge);
    assert.equal(plugin.bridge.revision, "new");
    assert.equal(f.ready.length, 0);
    plugin.onunload();
  } finally { f.cleanup(); }
});
