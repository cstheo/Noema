const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const KEY = /^[A-Z0-9]{8}$/;

function installShared(plugin) {
  const { Notice, MarkdownRenderer, Component, htmlToMarkdown } = plugin.obsidian;
  const base = plugin.app.vault.adapter.getBasePath();
  const modules = name => require(path.join(base, plugin.manifest.dir, name));
  const helpers = modules("notes.js");
  const fields = modules("fields.js");
  const layout = fields.paths(plugin.noemaConfig.zotero.research_folder);
  const paperNoteTemplate = modules("paper-note-template.js");
  const { createClient } = modules("shared.js");
  const { createNoteArchive } = modules("note-archive.js");
  const archive = createNoteArchive(plugin);
  const { createAuthorizationStore } = modules("authorization-store.js");
  const authorizationStore = createAuthorizationStore(plugin);
  const { plainHTML } = modules("paper-view.js");
  plugin.paperViews = new Set();
  plugin.paperCache = new Map();
  plugin.paperLoads = new Map();
  plugin.mirrors = new Map();
  plugin.noteLocks = new Map();
  plugin.writeKey = null;
  plugin.writeRemember = false;
  let authorization = null;
  let authorizationGeneration = 0;
  let registryWrite = Promise.resolve();
  let noteFileCreation = Promise.resolve();
  let registryServer = null;
  let registryLoad = null;
  let registryGeneration = 0;
  let discoveryVersion = null;
  let paperFields = Object.create(null);
  let catalog = null;
  const metadataWrites = new Map();
  const autoSyncJobs = new Map();
  const noteDeletions = new Map();

  function automaticWriteback() {
    return plugin.active && plugin.writeKey && plugin.writeRemember;
  }
  function autoSyncEligible(entry) {
    return automaticWriteback() && plugin.snapshot?.serverId === entry.serverId
      && plugin.mirrors.get(entry.path) === entry && !entry.deleted && entry.canPush
      && !entry.conflictPath && !noteDeletions.has(entry);
  }
  function cancelAutoSync() {
    for (const job of autoSyncJobs.values()) window.clearTimeout(job.timer);
    autoSyncJobs.clear();
  }
  function cancelNoteAutoSync(entry) {
    const job = autoSyncJobs.get(entry.parentKey);
    if (!job) return;
    job.entries.delete(entry);
    if (!job.entries.size) {
      window.clearTimeout(job.timer);
      autoSyncJobs.delete(entry.parentKey);
    }
  }
  function currentAutoSync(job) {
    return autoSyncJobs.get(job.parentKey) === job && automaticWriteback()
      && plugin.snapshot?.serverId === job.serverId;
  }
  function armAutoSync(job) {
    window.clearTimeout(job.timer);
    job.timer = window.setTimeout(() => {
      delete job.timer;
      return runAutoSync(job);
    }, 1200);
  }
  function scheduleAutoSync(entry) {
    if (!autoSyncEligible(entry)) return;
    let job = autoSyncJobs.get(entry.parentKey);
    if (!job || job.serverId !== entry.serverId) {
      if (job) window.clearTimeout(job.timer);
      job = { parentKey: entry.parentKey, serverId: entry.serverId, entries: new Set(), running: false, pending: false };
      autoSyncJobs.set(entry.parentKey, job);
    }
    job.entries.add(entry);
    if (job.running) job.pending = true;
    else armAutoSync(job);
  }
  async function runAutoSync(job) {
    if (!currentAutoSync(job) || ![...job.entries].some(autoSyncEligible)) {
      if (autoSyncJobs.get(job.parentKey) === job) autoSyncJobs.delete(job.parentKey);
      return;
    }
    job.running = true;
    job.pending = false;
    try {
      // Joining an older (possibly read-only) refresh can miss a new save.
      // Wait for it, then reconcile the latest local source in a fresh pass.
      const previous = plugin.paperLoads.get(job.parentKey);
      if (previous) await previous.catch(() => {});
      if (!currentAutoSync(job) || ![...job.entries].some(autoSyncEligible)) return;
      await plugin.refreshPaper(job.parentKey);
    } catch (error) {
      if (currentAutoSync(job)) {
        for (const entry of job.entries) if (autoSyncEligible(entry)) {
          entry.message = `Automatic sync paused: ${error.message}`;
        }
        for (const view of plugin.paperViews) if (view.parentKey === job.parentKey) view.render();
      }
    } finally {
      job.running = false;
      // An edit arriving during a request needs another pass after that write.
      if (currentAutoSync(job) && job.pending && [...job.entries].some(autoSyncEligible)) armAutoSync(job);
      else if (autoSyncJobs.get(job.parentKey) === job) autoSyncJobs.delete(job.parentKey);
    }
  }

  function identity() {
    plugin.ensureActive();
    const serverId = plugin.snapshot?.serverId;
    if (typeof serverId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(serverId)) throw new Error("Open Zotero and refresh My Library first.");
    return serverId;
  }
  function partition() {
    return path.join(plugin.storageReal, "shared", identity());
  }
  async function loadFields() {
    const target = path.join(base, layout.catalog);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024
      || await fs.realpath(target) !== path.join(await fs.realpath(base), layout.catalog)) throw new Error("Research fields.json must be a regular file inside this vault.");
    const next = fields.createCatalog(JSON.parse(await fs.readFile(target, "utf8")), layout.root);
    if ([...plugin.mirrors.values()].some(entry => !next.validPath(entry.path))
      || Object.values(paperFields).some(field => field !== "" && !next.get(field))) {
      throw new Error("Move registered notes and clear field selections before removing a research field. Your files were kept.");
    }
    catalog = next;
    plugin.fieldCatalog = catalog;
  }
  function validPath(value) { return !!catalog?.validPath(value); }
  plugin.paperField = parentKey => catalog?.classify(plugin.snapshot?.items.find(item => item.key === parentKey),
    Object.hasOwn(paperFields, parentKey) ? paperFields[parentKey] : undefined) || { field: null, reason: "Load research fields", candidates: [] };
  async function registryStorage(folder, create = false) {
    if (!folder.startsWith(`${base}${path.sep}`) || !folder.startsWith(`${plugin.storageReal}${path.sep}`)) throw new Error("Shared-note storage must remain inside this vault.");
    const relative = path.relative(base, folder).split(path.sep);
    for (let index = 1; index <= relative.length; index++) {
      const current = path.join(base, ...relative.slice(0, index));
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!create) return false;
        await fs.mkdir(current, { mode: 0o700 }); stat = await fs.lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) throw new Error("Shared-note registry folders must be real directories inside this vault.");
      plugin.ensureActive();
    }
    const target = path.join(folder, "notes.json");
    try { await guardPrivateFile(target); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return true;
  }
  async function guardPrivateFile(target) {
    if (!target.startsWith(`${plugin.storageReal}${path.sep}`)) throw new Error("Shared-note storage must remain under the configured vault directory.");
    for (let part = target; part.startsWith(`${base}${path.sep}`); part = path.dirname(part)) {
      const stat = await fs.lstat(part);
      if (stat.isSymbolicLink() || await fs.realpath(part) !== part) throw new Error("Shared-note storage must use real files and directories inside this vault.");
    }
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("The shared-note registry or recovery file is invalid.");
    plugin.ensureActive();
  }
  function persist() {
    const serverId = identity();
    const folder = partition();
    const entries = [...plugin.mirrors.values()].filter(entry => entry.serverId === serverId).map(entry => ({ ...entry, preview: undefined, timer: undefined }));
    const selections = { ...paperFields }, cursor = discoveryVersion;
    registryWrite = registryWrite.catch(() => {}).then(async () => {
      if (!plugin.active || plugin.snapshot?.serverId !== serverId) return;
      await registryStorage(folder, true);
      const temporary = path.join(folder, `notes.json.${crypto.randomUUID()}.tmp`);
      await fs.writeFile(temporary, JSON.stringify({ schema: 1, serverId, entries, paperFields: selections, discoveryVersion: cursor }), { mode: 0o600, flag: "wx" });
      await registryStorage(folder);
      if (plugin.snapshot?.serverId !== serverId) throw new Error("The Zotero database changed while saving shared notes.");
      await fs.rename(temporary, path.join(folder, "notes.json"));
      plugin.app.workspace.trigger?.("noema-zotero:notes-changed");
    });
    return registryWrite;
  }
  async function ensureRegistry() {
    if (!catalog) await loadFields();
    const serverId = identity();
    if (registryServer === serverId) return;
    if (registryLoad?.serverId === serverId) return registryLoad.promise;
    const generation = ++registryGeneration;
    // A different local Zotero database cannot inherit another database's keys.
    plugin.writeKey = null;
    plugin.writeRemember = false;
    ++authorizationGeneration;
    cancelAutoSync();
    plugin.mirrors.clear();
    plugin.paperCache.clear();
    paperFields = Object.create(null);
    discoveryVersion = null;
    const folder = partition();
    const promise = (async () => {
      let saved;
      try {
        if (!await registryStorage(folder)) {
          const shared = path.dirname(folder);
          const candidates = await fs.readdir(shared, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
          for (const candidate of candidates.filter(candidate => candidate.isDirectory())) {
            const previous = path.join(shared, candidate.name), file = path.join(previous, "notes.json");
            let registry;
            try { await guardPrivateFile(file); registry = JSON.parse(await fs.readFile(file, "utf8")); }
            catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) continue; throw error; }
            if (registry.serverId === serverId) { await fs.rename(previous, folder); break; }
          }
        }
        if (await registryStorage(folder)) saved = JSON.parse(await fs.readFile(path.join(folder, "notes.json"), "utf8"));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      plugin.ensureActive();
      if (generation !== registryGeneration || plugin.snapshot?.serverId !== serverId) throw new Error("The Zotero database changed while loading shared notes.");
      if (saved?.schema === 1 && saved.serverId === serverId && Array.isArray(saved.entries)) {
        if (Number.isSafeInteger(saved.discoveryVersion) && saved.discoveryVersion >= 0) discoveryVersion = saved.discoveryVersion;
        for (const [key, field] of Object.entries(saved.paperFields || {})) {
          if (KEY.test(key) && field !== "" && !catalog.get(field)) throw new Error("A saved paper field is missing from fields.json. Restore the field before syncing.");
          if (KEY.test(key) && (field === "" || catalog.get(field))) paperFields[key] = field;
        }
        const fileIds = new Set();
        if (saved.entries.some(entry => entry.serverId === serverId && !validPath(entry.path))) throw new Error("A registered note has an unmanaged path. Restore its research field before syncing. Your files were kept.");
        for (const entry of saved.entries) if (entry.serverId === serverId && KEY.test(entry.key || "") && KEY.test(entry.parentKey || "") && validPath(entry.path)) {
          if (entry.fileId && fileIds.has(entry.fileId)) throw new Error("Duplicate shared-note identity in the private registry. Your files were kept.");
          if (entry.fileId) fileIds.add(entry.fileId);
          plugin.mirrors.set(entry.path, entry);
        }
      }
      let repaired = false;
      for (const entry of plugin.mirrors.values()) if (entry.pendingMove) {
        const { from, to } = entry.pendingMove;
        if (entry.path !== from || !validPath(from) || !validPath(to)) throw new Error("The saved note move is invalid. Your files were kept.");
        const exists = async value => { try { await fs.lstat(path.join(base, value)); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
        if (await exists(to)) {
          if (await exists(from)) throw new Error("Both note move paths exist. Review them before continuing sync.");
          await guardLocalFile({ ...entry, path: to }, { path: to });
          helpers.parseMarkdown(await fs.readFile(path.join(base, to), "utf8"), entry);
          plugin.mirrors.delete(from); entry.path = to; plugin.mirrors.set(to, entry);
        }
        delete entry.pendingMove; repaired = true;
      }
      for (const entry of plugin.mirrors.values()) if (!entry.fileId && !entry.deleted && fileFor(entry)) {
        await guardLocalFile(entry, fileFor(entry));
        const source = await plugin.app.vault.read(fileFor(entry));
        const parsed = helpers.parseMarkdown(source);
        if (parsed.legacy || !parsed.fileId) continue;
        // Recover only from the exact migration backup proving the original
        // server/key/parent/version. A marker or filename alone is not evidence.
        const backup = path.join(folder, "property-migrations", `${parsed.fileId}.md`);
        await guardPrivateFile(backup);
        const original = helpers.parseMarkdown(await fs.readFile(backup, "utf8"), entry);
        if (original.version !== entry.version || original.body !== entry.base?.localBody) throw new Error("The migrated note's ownership could not be verified. Your files were kept.");
        if ([...plugin.mirrors.values()].some(value => value !== entry && value.fileId === parsed.fileId)) throw new Error("Duplicate migrated shared-note identity. Your files were kept.");
        entry.fileId = parsed.fileId; repaired = true;
      }
      if (repaired) await persist();
      registryServer = serverId;
      try {
        const remembered = authorizationStore.load(serverId);
        if (remembered) {
          plugin.writeKey = remembered; plugin.writeRemember = true;
          for (const entry of plugin.mirrors.values()) scheduleAutoSync(entry);
        }
      } catch (_) {
        new Notice("Saved Zotero authorization could not be read. Choose Enable writeback to authorize this session.");
      }
    })().finally(() => { if (registryLoad?.promise === promise) registryLoad = null; });
    registryLoad = { serverId, promise };
    return promise;
  }
  async function ensureFolder(directory) {
    plugin.ensureActive();
    if (!validPath(`${directory}/note.md`)) throw new Error("Choose a managed paper-note directory.");
    const adapter = plugin.app.vault.adapter;
    const parts = directory.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const current = parts.slice(0, index).join("/");
      if (!(await adapter.exists(current))) { plugin.ensureActive(); await plugin.app.vault.createFolder(current); }
      const stat = await fs.lstat(path.join(base, current));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Paper-note folders must be real directories inside this vault.");
    }
    const physical = await fs.realpath(path.join(base, directory));
    const vault = await fs.realpath(base);
    if (!physical.startsWith(`${vault}${path.sep}`)) throw new Error("Shared notes must remain inside this vault.");
  }
  // Serialize allocations so concurrent drafts with the same paper title get
  // separate filenames. Deleted registry paths remain reserved for restoration.
  function createNamedNote(title, source, serverId, parentKey) {
    const create = noteFileCreation.catch(() => {}).then(async () => {
      const directory = catalog.directory(plugin.paperField(parentKey).field);
      await ensureFolder(directory);
      for (let index = 1; index <= 10000; index++) {
        plugin.ensureActive();
        if (identity() !== serverId) throw new Error("The Zotero database changed before saving the note. Try again in the current library.");
        const target = `${directory}/${helpers.noteFilename(title, index)}`;
        if (plugin.mirrors.has(target) || await plugin.app.vault.adapter.exists(target)) continue;
        plugin.ensureActive();
        if (identity() !== serverId) throw new Error("The Zotero database changed before saving the note. Try again in the current library.");
        // Native create rejects a destination occupied after the check; no
        // existing file is adopted, overwritten or merged.
        await plugin.app.vault.create(target, source);
        return target;
      }
      throw new Error("No available filename remains for this paper note.");
    });
    noteFileCreation = create;
    return create;
  }
  function fileFor(entry) { return plugin.app.vault.getFileByPath(entry.path); }
  async function guardLocalFile(entry, file) {
    plugin.ensureActive();
    if (!validPath(entry.path) || file?.path !== entry.path) throw new Error("The registered shared-note path changed. Your files were kept.");
    const vault = await fs.realpath(base);
    const parts = entry.path.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index++) {
      const folder = await fs.lstat(path.join(base, ...parts.slice(0, index)));
      if (folder.isSymbolicLink() || !folder.isDirectory()) throw new Error("Shared-note folders must be real directories inside this vault.");
    }
    const physical = path.join(base, entry.path);
    const stat = await fs.lstat(physical);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Shared Markdown notes must be regular files, not symbolic links.");
    const real = await fs.realpath(physical);
    if (real !== path.join(vault, entry.path) || !real.startsWith(`${vault}${path.sep}`)) throw new Error("Shared notes must remain inside this vault.");
    plugin.ensureActive();
    if (file.path !== entry.path) throw new Error("The shared-note path changed while syncing. Your files were kept.");
  }
  async function readLocal(entry) {
    const file = fileFor(entry);
    if (!file) throw new Error("The shared Markdown note is unavailable. Its Zotero note was kept.");
    await guardLocalFile(entry, file);
    const source = await plugin.app.vault.read(file);
    const parsed = helpers.parseMarkdown(source, entry);
    if (!parsed || parsed.serverId !== identity() || !localKeyMatches(entry, parsed.key) || parsed.parentKey !== entry.parentKey) throw new Error("Shared-note identity changed. Keep its hidden file marker and private registry intact.");
    return { source, parsed, file };
  }
  // A confirmed creation may have updated the Markdown header just before a
  // restart. Both identities are safe during that persisted transition only.
  function localKeyMatches(entry, key) {
    return key === entry.key || (entry.draft && entry.pendingCreation === true && KEY.test(entry.pendingKey || "") && key === entry.pendingKey);
  }
  function remoteInput(record) { return { serverId: record.serverId, key: record.key, parentKey: record.parentItem, version: record.version, html: record.note }; }
  function convert(html) { return helpers.remoteToMarkdown(html, { htmlToMarkdown, DOMParser }); }
  async function html(body, sourcePath) {
    return helpers.markdownToZotero(body, {
      DOMParser,
      markdownToHTML: async text => {
        const component = new Component();
        const el = document.createElement("div");
        component.load();
        try { await MarkdownRenderer.render(plugin.app, text, el, sourcePath, component); return el.innerHTML; }
        finally { component.unload(); }
      }
    });
  }
  function updatePreview(entry, body) { entry.preview = body.replace(/\s+/g, " ").slice(0, 220); }
  function baseline(entry, record, body) {
    entry.base = helpers.createBaseline({ serverId: record.serverId, key: record.key, parentKey: record.parentItem, version: record.version, localBody: body, remoteHTML: record.note, canPush: entry.canPush });
    entry.version = record.version;
    entry.draft = false;
    delete entry.pendingKey; delete entry.pendingBody; delete entry.pendingHTML; delete entry.pendingCreation; delete entry.pendingVersion;
    entry.message = "";
    entry.conflictPath = null;
    updatePreview(entry, body);
  }
  async function writeHeader(entry, record, local, body = local.parsed.body, allowConcurrent = false, metadataOnly = false) {
    if (!entry.fileId) entry.fileId = crypto.randomUUID();
    if (local.parsed.legacy) await persist();
    const paper = plugin.snapshot.items.find(item => item.key === entry.parentKey);
    const source = helpers.makeMarkdown({ serverId: record.serverId, key: record.key, parentKey: record.parentItem, version: record.version, fileId: entry.fileId, paper, title: local.parsed.title || entry.title, body, existing: local.source, registered: entry });
    // Recheck after network/conversion work so edits made meanwhile are retained.
    await guardLocalFile(entry, local.file);
    const fresh = await plugin.app.vault.read(local.file);
    if (fresh !== local.source) {
      if (!allowConcurrent) return false;
      const parsed = helpers.parseMarkdown(fresh, entry);
      if (!parsed || !localKeyMatches(entry, parsed.key) || parsed.parentKey !== entry.parentKey || parsed.serverId !== identity()) throw new Error("The note identity changed while syncing. Your file was kept.");
      await guardLocalFile(entry, local.file);
      plugin.ensureActive();
      if (record.serverId !== identity()) throw new Error("The Zotero database changed. Your Markdown file was kept.");
      await plugin.app.vault.modify(local.file, helpers.makeMarkdown({ serverId: record.serverId, key: record.key, parentKey: record.parentItem, version: record.version, fileId: entry.fileId, paper, title: parsed.title || entry.title, body: parsed.body, existing: fresh, registered: entry }));
      return true;
    }
    await guardLocalFile(entry, local.file);
    plugin.ensureActive();
    if (record.serverId !== identity()) throw new Error("The Zotero database changed. Your Markdown file was kept.");
    if (source !== fresh) {
      if (metadataOnly) metadataWrites.set(entry.path, source);
      await plugin.app.vault.modify(local.file, source);
    }
    return true;
  }
  async function conflict(entry, record) {
    entry.message = "Both apps changed this note. Review both versions, then choose which version to keep.";
    const target = `${entry.path.slice(0, -3)} - Zotero v${record.version}.md`;
    if (!plugin.app.vault.getFileByPath(target)) {
      const converted = convert(record.note);
      const source = helpers.makeMarkdown({ ...remoteInput(record), fileId: crypto.randomUUID(), paper: plugin.snapshot.items.find(item => item.key === entry.parentKey), title: `${entry.title} · Zotero version`, body: converted.body }).replace("---\n", "---\nsync_status: conflict\n");
      plugin.ensureActive();
      if (record.serverId !== identity()) throw new Error("The Zotero database changed. Refresh before importing notes.");
      await plugin.app.vault.create(target, source);
    }
    entry.conflictPath = target;
  }
  async function reconcile(record, manual, readOnly = false) {
    let entry = [...plugin.mirrors.values()].find(value => (value.key === record.key || value.pendingKey === record.key) && value.serverId === record.serverId);
    if (entry && noteDeletions.has(entry)) return;
    if (entry?.deleted) {
      const restored = await restoreRemoteMirror(entry);
      if (!restored) return;
      record = restored;
    }
    if (entry?.pendingKey === record.key) {
      const local = await readLocal(entry);
      const submitted = entry.pendingBody;
      const submittedHTML = entry.pendingHTML;
      const submittedVersion = entry.pendingVersion || record.version;
      await writeHeader(entry, record, local, local.parsed.body, true);
      entry.key = record.key;
      baseline(entry, record, submitted);
      if (record.note !== submittedHTML) {
        entry.base = helpers.createBaseline({ serverId: record.serverId, key: record.key, parentKey: record.parentItem, version: submittedVersion, localBody: submitted, remoteHTML: submittedHTML, canPush: entry.canPush });
        await conflict(entry, record);
      }
      return;
    }
    if (!entry) {
      const paper = plugin.snapshot.items.find(item => item.key === record.parentItem);
      const title = `${paper?.title || "Paper"} · ${plainHTML(record.note).split("\n")[0].slice(0, 60) || "Reading notes"}`;
      const converted = convert(record.note);
      const fileId = crypto.randomUUID();
      const source = helpers.makeMarkdown({ ...remoteInput(record), fileId, paper, title, body: converted.body });
      plugin.ensureActive();
      if (record.serverId !== identity()) throw new Error("The Zotero database changed. Refresh before importing notes.");
      const target = await createNamedNote(paper?.title || "Paper", source, record.serverId, record.parentItem);
      entry = { serverId: record.serverId, key: record.key, parentKey: record.parentItem, fileId, path: target, title, canPush: converted.canPush };
      baseline(entry, record, converted.body);
      if (!converted.canPush) entry.message = "This note contains unsupported rich content. Its Markdown view is read-only for synchronization.";
      plugin.mirrors.set(target, entry);
      return;
    }
    const local = await readLocal(entry);
    updatePreview(entry, local.parsed.body);
    if (entry.conflictPath) { entry.message = "Both apps changed this note. Review both versions, then choose which version to keep."; return; }
    const decision = helpers.decideSync({ base: entry.base, local: local.parsed, remote: remoteInput(record) });
    if (decision.action === "conflict") { await conflict(entry, record); return; }
    if (decision.action === "pull") {
      const converted = convert(record.note);
      if (!(await writeHeader(entry, record, local, converted.body))) { await conflict(entry, record); return; }
      entry.canPush = converted.canPush;
      baseline(entry, record, converted.body);
      if (!entry.canPush) entry.message = "This note contains unsupported rich content. Its Markdown view is read-only for synchronization.";
    } else if (decision.action === "push") {
      if (!entry.canPush) { entry.message = "This rich Zotero note is read-only for synchronization. Create a separate shared note for your edits."; return; }
      if (readOnly || !manual && !automaticWriteback()) { entry.message = "Local changes saved. Enable writeback and choose Always Allow for automatic sync, or Sync notes for a one-time write."; return; }
      const content = await html(local.parsed.body, entry.path);
      const saved = await plugin.withWrite(key => plugin.sharedClient().saveNote(record, content, key), manual);
      await writeHeader(entry, saved, local, local.parsed.body, true);
      baseline(entry, saved, local.parsed.body);
    } else {
      if (record.version !== entry.base.version) {
        if (!(await writeHeader(entry, record, local))) { await conflict(entry, record); return; }
        baseline(entry, record, local.parsed.body);
      }
      if (!entry.conflictPath) entry.message = "";
    }
  }
  async function syncDraft(entry, manual) {
    if (entry.deleted || noteDeletions.has(entry) || plugin.mirrors.get(entry.path) !== entry || entry.serverId !== identity()) return;
    if (entry.pendingCreation || entry.pendingKey) { entry.message = "The previous note creation is awaiting confirmation. Refresh this paper and inspect Zotero before creating another note; this draft will not be submitted again."; return; }
    if (!manual && !automaticWriteback()) return;
    const local = await readLocal(entry);
    updatePreview(entry, local.parsed.body);
    const content = await html(local.parsed.body, entry.path);
    let saved;
    let submitted = false;
    try {
      saved = await plugin.withWrite(async key => {
        entry.pendingCreation = true;
        entry.pendingBody = local.parsed.body;
        entry.pendingHTML = content;
        await persist();
        plugin.ensureActive();
        submitted = true;
        return plugin.sharedClient().createNote(entry.parentKey, content, key);
      }, manual);
    }
    catch (error) {
      if (submitted && ["WRITE_UNCERTAIN", "CONFLICT"].includes(error.code)) {
        if (KEY.test(error.itemKey || "")) entry.pendingKey = error.itemKey;
      } else {
        delete entry.pendingCreation; delete entry.pendingKey; delete entry.pendingBody; delete entry.pendingHTML;
      }
      await persist();
      throw error;
    }
    entry.pendingKey = saved.key;
    entry.pendingVersion = saved.version;
    // Persist the server's real key before adopting it in the private registry.
    await persist();
    await writeHeader(entry, saved, local, local.parsed.body, true);
    entry.key = saved.key;
    entry.canPush = true;
    baseline(entry, saved, local.parsed.body);
  }
  async function lock(entry, run) {
    const previous = plugin.noteLocks.get(entry) || Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    plugin.noteLocks.set(entry, current);
    try { return await current; }
    finally { if (plugin.noteLocks.get(entry) === current) plugin.noteLocks.delete(entry); }
  }

  async function archiveDeletedMirror(entry, { localDraft = false, prepared } = {}) {
    if (entry.draft && !localDraft || entry.pendingCreation || entry.pendingKey) return;
    const file = fileFor(entry);
    if (!file) {
      entry.deleted = true;
      entry.message = entry.archiveId ? "Deleted in Zotero. Your local copy is archived." : "Deleted in Zotero. No local copy was available to archive.";
      await persist();
      return;
    }
    const local = prepared?.local || await readLocal(entry);
    updatePreview(entry, local.parsed.body);
    const archiveId = prepared?.archiveId || await archive.save(local.source);
    // Save the recovery pointer before removing anything from the corpus.
    const previous = { deleted: entry.deleted, archiveId: entry.archiveId, deletedAt: entry.deletedAt, message: entry.message, localOnlyDeleted: entry.localOnlyDeleted };
    entry.deleted = true; entry.archiveId = archiveId; entry.deletedAt = new Date().toISOString();
    if (localDraft) entry.localOnlyDeleted = true;
    entry.message = localDraft ? "Deleted in Noema. Your local draft is archived." : "Deleted in Zotero. Your local copy is archived.";
    try { await persist(); }
    catch (error) { Object.assign(entry, previous); throw error; }
    await guardLocalFile(entry, local.file);
    if (await plugin.app.vault.read(local.file) !== local.source) throw new Error("The note changed while archiving. Its latest text was kept; refresh to try again.");
    await guardLocalFile(entry, local.file);
    if (entry.serverId !== identity()) throw new Error("The Zotero database changed. Your file was kept.");
    await plugin.app.vault.trash(local.file, false);
    metadataWrites.delete(entry.path);
    window.clearTimeout(entry.timer); delete entry.timer;
    if (plugin.noteTargets?.get(entry.parentKey) === entry.path) plugin.noteTargets.delete(entry.parentKey);
  }

  async function restoreRemoteMirror(entry) {
    if (entry.localOnlyDeleted) return false;
    // A restored native note uses its old baseline; local edits preserved in
    // the archive can still cause a normal conflict instead of being discarded.
    const state = await plugin.sharedClient().getNoteState(entry);
    if (state.status !== "active") return false;
    if (!fileFor(entry)) {
      let source, imported;
      if (entry.archiveId) {
        source = await archive.read(entry.archiveId);
        helpers.parseMarkdown(source, entry);
      } else {
        // No local source ever reached the archive. Import the confirmed native
        // text; a recorded archive that fails to read must still be kept.
        imported = convert(state.record.note);
        if (!entry.fileId) { entry.fileId = crypto.randomUUID(); await persist(); }
        source = helpers.makeMarkdown({ ...remoteInput(state.record), fileId: entry.fileId, paper: plugin.snapshot.items.find(item => item.key === entry.parentKey), title: entry.title, body: imported.body });
      }
      await ensureFolder(path.posix.dirname(entry.path));
      if (entry.serverId !== identity()) throw new Error("The Zotero database changed. Your archive was kept.");
      await plugin.app.vault.create(entry.path, source);
      if (imported) { entry.canPush = imported.canPush; baseline(entry, state.record, imported.body); }
    } else await readLocal(entry); // Never overwrite an unrelated file at the old path.
    entry.deleted = false;
    await persist();
    return state.record;
  }

  plugin.sharedClient = () => createClient({ request: plugin.request, serverId: identity() });
  plugin.trashPaperNote = async entry => {
    await ensureRegistry();
    const validEntry = () => {
      plugin.ensureActive();
      if (plugin.mirrors.get(entry?.path) !== entry || entry?.serverId !== identity() || entry.deleted) {
        throw new Error("Choose an active shared paper note from this Zotero library.");
      }
    };
    validEntry();
    if (noteDeletions.has(entry)) return noteDeletions.get(entry);
    const pending = lock(entry, async () => {
      // An earlier automatic creation may have confirmed a native key while
      // Delete waited for this lock. Decide which note to remove only now.
      validEntry();
      if (entry.pendingCreation || entry.pendingKey) throw new Error("This note's creation is awaiting confirmation. Refresh and inspect Zotero before deleting it.");
      let state;
      if (!entry.draft) {
        state = await plugin.sharedClient().getNoteState(entry);
        validEntry();
        if (state.status === "moved") throw new Error("This note moved to another Zotero paper. Refresh and review it before deleting.");
        if (state.status === "active" && state.record.version !== entry.version) throw new Error("This note changed in Zotero. Refresh and review it before deleting.");
      }
      const local = await readLocal(entry);
      const archiveId = await archive.save(local.source);
      validEntry();
      // Keep a durable recovery pointer before asking Zotero to trash a note.
      const previousArchive = entry.archiveId;
      entry.archiveId = archiveId;
      try { await persist(); }
      catch (error) { entry.archiveId = previousArchive; throw error; }
      validEntry();
      let nativeDeleted = false;
      if (state?.status === "active") {
        await plugin.withWrite(key => {
          validEntry();
          return plugin.sharedClient().trashNote(state.record, key);
        }, true);
        nativeDeleted = true;
      }
      try {
        validEntry();
        await archiveDeletedMirror(entry, { localDraft: !!entry.draft, prepared: { local, archiveId } });
      }
      catch (error) {
        if (!nativeDeleted) throw error;
        new Notice("Deleted in Zotero. The local file was kept because archiving could not finish. Refresh this paper to try again.");
        return { nativeDeleted: true, warning: error.message };
      }
      new Notice(entry.draft ? "Draft deleted. Its text is available in Paper notes → Removed notes." : "Note moved to Zotero Trash. Its local copy is available in Paper notes → Removed notes.");
      return { nativeDeleted, archived: true };
    });
    noteDeletions.set(entry, pending);
    cancelNoteAutoSync(entry);
    try { return await pending; }
    finally {
      if (noteDeletions.get(entry) === pending) noteDeletions.delete(entry);
      if (plugin.active) for (const view of plugin.paperViews) if (view.parentKey === entry.parentKey) view.render();
    }
  };
  plugin.itemForAttachment = key => plugin.snapshot?.items.find(item => item.attachments.some(file => file.key === key));
  const mirrorsFor = parentKey => [...plugin.mirrors.values()].filter(entry => entry.serverId === plugin.snapshot?.serverId && entry.parentKey === parentKey);
  plugin.mirrorsFor = parentKey => mirrorsFor(parentKey).filter(entry => !entry.deleted);
  plugin.deletedMirrorsFor = parentKey => mirrorsFor(parentKey).filter(entry => entry.deleted);
  plugin.readArchivedNote = async entry => {
    await ensureRegistry();
    if (plugin.mirrors.get(entry.path) !== entry || !entry.deleted || !entry.archiveId || entry.serverId !== identity()) throw new Error("Choose an archived note from this Zotero library.");
    const source = await archive.read(entry.archiveId);
    return { source, ...helpers.parseMarkdown(source, entry) };
  };
  plugin.saveArchivedCopy = async entry => {
    const local = await plugin.readArchivedNote(entry);
    const title = `${local.title || entry.title} · recovered`;
    const source = helpers.makeMarkdown({ ...entry, fileId: entry.fileId || crypto.randomUUID(), paper: plugin.snapshot.items.find(item => item.key === entry.parentKey), title, body: local.body, existing: local.source, registered: entry })
      .replace(/^<!-- noema-shared-note:[0-9a-f-]+ -->\n\n/m, "");
    plugin.ensureActive();
    if (entry.serverId !== identity()) throw new Error("The Zotero database changed. Your archive was kept.");
    const paper = plugin.snapshot.items.find(item => item.key === entry.parentKey);
    const target = await createNamedNote(`${paper?.title || "Paper"} · recovered`, source, entry.serverId, entry.parentKey);
    await plugin.openMirror(target);
    return target; // A recovered copy is local only, outside the sync registry.
  };
  plugin.openMirror = async target => {
    if (!validPath(target)) throw new Error("Only shared paper notes can be opened here.");
    const file = plugin.app.vault.getFileByPath(target);
    if (!file) throw new Error("This Markdown note is unavailable.");
    const workspace = plugin.app.workspace;
    const group = workspace.getMostRecentLeaf()?.parent;
    const existing = workspace.getLeavesOfType("markdown").find(leaf => leaf.parent === group && leaf.view.file?.path === target);
    if (existing) await workspace.revealLeaf(existing);
    else await workspace.getLeaf("tab").openFile(file, { active: true });
  };

  async function moveMirror(entry, field) {
    if (entry.deleted) return;
    if (entry.conflictPath || entry.pendingCreation) throw new Error("Resolve this paper's pending note or conflict before changing its field.");
    const directory = catalog.directory(field);
    if (path.posix.dirname(entry.path) === directory) return;
    const move = noteFileCreation.catch(() => {}).then(async () => {
      const local = await readLocal(entry);
      await ensureFolder(directory);
      let target;
      for (let index = 1; index <= 10000; index++) {
        const name = index === 1 ? path.posix.basename(entry.path) : helpers.noteFilename(local.parsed.title || entry.title, index);
        target = `${directory}/${name}`;
        if (!plugin.mirrors.has(target) && !await plugin.app.vault.adapter.exists(target)) break;
        target = null;
      }
      if (!target) throw new Error("No available filename remains in this field.");
      const from = entry.path;
      cancelNoteAutoSync(entry);
      entry.pendingMove = { from, to: target };
      await persist(); // Recovery can finish a move interrupted by app shutdown.
      await readLocal(entry);
      try { await plugin.app.fileManager.renameFile(local.file, target); }
      catch (error) {
        if (local.file.path !== target) {
          delete entry.pendingMove; await persist(); throw error;
        }
      }
      plugin.mirrors.delete(from); metadataWrites.delete(from);
      entry.path = target; delete entry.pendingMove; plugin.mirrors.set(target, entry);
      if (plugin.noteTargets?.get(entry.parentKey) === from) plugin.noteTargets.set(entry.parentKey, target);
      await persist();
      scheduleAutoSync(entry);
    });
    noteFileCreation = move;
    return move;
  }
  plugin.classifyPaper = (parentKey, field) => {
    if (!KEY.test(parentKey || "")) return Promise.reject(new Error("Choose a paper from My Library."));
    const previous = plugin.paperLoads.get(parentKey);
    const pending = (async () => {
      await previous;
      await ensureRegistry();
      if (field !== undefined && field !== "" && !catalog.get(field)) throw new Error("Choose an existing research field.");
      if (!plugin.snapshot.items.some(item => item.key === parentKey)) throw new Error("This paper is unavailable in the current library.");
      const entries = plugin.mirrorsFor(parentKey);
      if (entries.some(entry => entry.conflictPath || entry.pendingCreation || entry.pendingKey)) throw new Error("Resolve this paper's pending notes and conflicts before changing its field.");
      if (field === undefined) delete paperFields[parentKey];
      else paperFields[parentKey] = field;
      await persist();
      for (const entry of entries) await lock(entry, () => moveMirror(entry, plugin.paperField(parentKey).field));
      for (const view of plugin.paperViews) if (view.parentKey === parentKey) view.render();
      return plugin.paperField(parentKey);
    })().finally(() => { if (plugin.paperLoads.get(parentKey) === pending) plugin.paperLoads.delete(parentKey); });
    plugin.paperLoads.set(parentKey, pending);
    return pending;
  };
  plugin.enableWriteback = async () => {
    await ensureRegistry();
    if (plugin.writeKey) return;
    const serverId = identity();
    const generation = authorizationGeneration;
    if (!authorization || authorization.serverId !== serverId || authorization.generation !== generation) {
      const pending = (async () => {
        new Notice("Respond to Noema Obsidian's authorization dialog in Zotero. Zotero grants library-wide write access; this bridge writes only shared notes and annotations.", 15000);
        const granted = await plugin.sharedClient().authorize();
        plugin.ensureActive();
        if (identity() !== serverId || generation !== authorizationGeneration) throw new Error("The Zotero authorization context changed. Choose Enable writeback again.");
        if (granted.remember) {
          try { authorizationStore.save(serverId, granted.key); }
          catch (_) { new Notice("Writeback is enabled for this session, but its authorization could not be saved in Obsidian's secret storage."); }
        }
        plugin.ensureActive();
        if (identity() !== serverId || generation !== authorizationGeneration) throw new Error("The Zotero authorization context changed. Choose Enable writeback again.");
        plugin.writeKey = granted.key;
        plugin.writeRemember = granted.remember;
        new Notice(granted.remember ? "Shared-note writeback enabled." : "Zotero authorized one write. Choose Always Allow to enable automatic note synchronization.");
        for (const view of plugin.paperViews) view.render();
        if (granted.remember) for (const entry of plugin.mirrors.values()) scheduleAutoSync(entry);
      })().finally(() => { if (authorization?.promise === pending) authorization = null; });
      authorization = { serverId, generation, promise: pending };
    }
    return authorization.promise;
  };
  plugin.forgetWriteback = async () => {
    await ensureRegistry();
    const serverId = identity();
    ++authorizationGeneration;
    plugin.writeKey = null; plugin.writeRemember = false;
    cancelAutoSync();
    authorizationStore.remove(serverId);
    for (const view of plugin.paperViews) view.render();
  };
  plugin.withWrite = async (run, manual = false) => {
    await ensureRegistry();
    const serverId = identity();
    if (!plugin.writeKey && manual) await plugin.enableWriteback();
    if (identity() !== serverId) throw new Error("The Zotero database changed during authorization. Your write was not sent.");
    if (!plugin.writeKey) throw new Error("Enable writeback in Paper notes before sending changes to Zotero.");
    if (!manual && !plugin.writeRemember) throw new Error("Choose Always Allow for automatic sync, or Sync notes to use the one-time authorization.");
    const key = plugin.writeKey;
    if (!plugin.writeRemember) plugin.writeKey = null;
    try { plugin.ensureActive(); return await run(key); }
    catch (error) {
      if (["AUTH_REQUIRED", "UNAUTHORIZED", "AUTHORIZATION_REQUIRED"].includes(error.code)
        && plugin.snapshot?.serverId === serverId && (!plugin.writeKey || plugin.writeKey === key)) {
        plugin.writeKey = null; plugin.writeRemember = false;
        try { authorizationStore.remove(serverId, key); }
        catch (_) { new Notice("Zotero revoked this authorization, but its saved credential could not be removed. Use Forget saved Zotero authorization when secret storage is available."); }
      }
      throw error;
    }
  };
  plugin.refreshPaper = (parentKey, manual = false, readOnly = false) => {
    if (plugin.paperLoads.has(parentKey)) return plugin.paperLoads.get(parentKey);
    const pending = (async () => {
      await ensureRegistry();
      const item = plugin.snapshot?.items.find(item => item.key === parentKey);
      if (!item) throw new Error("This paper is unavailable in the current Zotero library.");
      const remote = await plugin.sharedClient().loadPaper(parentKey, item.attachments.filter(file => file.contentType === "application/pdf").map(file => file.key));
      plugin.ensureActive();
      if (remote.serverId !== identity()) throw new Error("The Zotero database changed during this refresh. Refresh again.");
      plugin.paperCache.set(parentKey, remote);
      for (const record of remote.notes) {
        const entry = [...plugin.mirrors.values()].find(value => (value.key === record.key || value.pendingKey === record.key) && value.serverId === record.serverId);
        const synchronize = async () => {
          await reconcile(record, manual, readOnly);
          if (entry && !entry.deleted && !entry.conflictPath && (layout.legacy.includes(path.posix.dirname(entry.path)) || Object.hasOwn(paperFields, parentKey))) {
            await moveMirror(entry, plugin.paperField(parentKey).field);
          }
        };
        try { if (entry) await lock(entry, synchronize); else await synchronize(); }
        catch (error) { if (entry) entry.message = error.message; else throw error; }
      }
      const keys = new Set(remote.notes.map(record => record.key));
      for (const entry of mirrorsFor(parentKey)) {
        if (entry.draft) {
          try { if (!readOnly) await lock(entry, () => syncDraft(entry, manual)); }
          catch (error) { entry.message = error.message; }
        } else if (!keys.has(entry.key)) {
          try { await lock(entry, async () => {
            const state = await plugin.sharedClient().getNoteState(entry);
            if (["deleted", "missing"].includes(state.status)) await archiveDeletedMirror(entry);
            else entry.message = state.status === "moved" ? "This note moved to another Zotero item. Your local copy was kept." : "Zotero changed during this refresh. Refresh again; your local copy was kept.";
          }); } catch (error) { entry.message = error.message; }
        }
      }
      await persist();
      plugin.refreshReaderAnnotations?.();
      for (const view of plugin.paperViews) if (view.parentKey === parentKey) view.render();
      return remote;
    })().finally(() => { if (plugin.paperLoads.get(parentKey) === pending) plugin.paperLoads.delete(parentKey); });
    plugin.paperLoads.set(parentKey, pending);
    return pending;
  };
  plugin.syncPaperNotes = (parentKey, manual = false) => plugin.refreshPaper(parentKey, manual);
  plugin.refreshSharedNotes = async () => {
    await ensureRegistry();
    await loadFields();
    const discovered = await plugin.sharedClient().discoverNotes(discoveryVersion);
    if (discovered.serverId !== identity()) throw new Error("The Zotero library changed during note discovery.");
    // A newly-created parent needs fresh bibliographic metadata before routing.
    const papers = new Set(plugin.snapshot.items.map(item => item.key));
    if (discovered.notes.some(record => record.parentItem && !papers.has(record.parentItem))) {
      throw new Error("Refresh My Library again to include a new note's parent paper.");
    }
    const parents = new Set([...plugin.mirrors.values()].map(entry => entry.parentKey));
    // Reuse the per-paper queue so discovery cannot import a note twice while
    // its paper is open or a pending draft creation is being reconciled.
    for (const record of discovered.notes) if (record.parentItem) parents.add(record.parentItem);
    for (const parentKey of parents) if (papers.has(parentKey)) {
      await plugin.paperLoads.get(parentKey);
      await plugin.refreshPaper(parentKey, false, true);
    }
    const previous = discoveryVersion;
    discoveryVersion = discovered.libraryVersion;
    try { await persist(); } catch (error) { discoveryVersion = previous; throw error; }
  };
  plugin.annotationsFor = async key => {
    const item = plugin.itemForAttachment(key);
    if (!item) return [];
    if (!plugin.paperCache.has(item.key)) await plugin.refreshPaper(item.key);
    return plugin.paperCache.get(item.key)?.annotations.filter(record => record.parentItem === key) || [];
  };
  plugin.createHighlight = async (key, payload) => {
    const item = plugin.itemForAttachment(key);
    if (!item) throw new Error("Only this library's paper PDFs can be annotated.");
    const record = await plugin.withWrite(apiKey => plugin.sharedClient().createHighlight(key, payload, apiKey), true);
    await plugin.refreshPaper(item.key);
    for (const view of plugin.paperViews) if (view.parentKey === item.key) view.render();
    return record;
  };
  plugin.createNoteDraft = async (item, title, body) => {
    await ensureRegistry();
    await plugin.paperLoads.get(item?.key);
    const serverId = identity();
    const currentItem = plugin.snapshot?.items.find(value => value.key === item?.key);
    if (!currentItem) throw new Error("This paper is unavailable in the current Zotero library.");
    if (serverId !== identity()) throw new Error("The Zotero database changed. Reopen this paper before creating a note.");
    if (!String(title || "").trim()) throw new Error("Give this note a title.");
    body = paperNoteTemplate.initialize(body ?? "");
    const alphabet = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    const key = [...crypto.randomBytes(8)].map(value => alphabet[value % alphabet.length]).join("");
    const label = `${currentItem.title} · ${String(title).trim()}`;
    const fileId = crypto.randomUUID();
    const source = helpers.makeMarkdown({ serverId: identity(), key, parentKey: item.key, version: 0, fileId, paper: currentItem, title: label, body });
    plugin.ensureActive();
    const target = await createNamedNote(currentItem.title, source, serverId, item.key);
    const entry = { serverId: identity(), key, parentKey: item.key, version: 0, fileId, path: target, title: label, draft: true, canPush: true, message: automaticWriteback() ? "Saved locally. Syncing to Zotero automatically…" : "Saved locally. Enable writeback and choose Always Allow for automatic sync." };
    updatePreview(entry, body);
    plugin.mirrors.set(target, entry);
    await finishLocalSave(entry);
    return entry;
  };
  async function finishLocalSave(entry) {
    let registered = false;
    try { await persist(); registered = true; }
    catch (error) {
      entry.message = "Your Markdown note was saved, but its synchronization registry could not be saved. Keep the file and refresh before syncing.";
      new Notice(entry.message);
    }
    try { await plugin.openMirror(entry.path); }
    catch (error) { new Notice(`Your note was saved. Its tab could not be opened: ${error.message}`); }
    if (registered) scheduleAutoSync(entry);
  }
  plugin.appendToPaperNote = async (parentKey, target, body) => {
    await ensureRegistry();
    const entry = plugin.mirrors.get(target);
    if (!entry || entry.deleted || entry.parentKey !== parentKey || entry.serverId !== identity()) throw new Error("Choose an active shared note belonging to this paper.");
    if (!entry.canPush || entry.conflictPath) throw new Error("Resolve this note's conflict or choose an editable shared note first.");
    if (!String(body || "").trim()) throw new Error("Write a note or select a passage before adding it.");
    await lock(entry, async () => {
      if (plugin.mirrors.get(target) !== entry || entry.deleted || !entry.canPush || entry.conflictPath || entry.parentKey !== parentKey || entry.serverId !== identity()) throw new Error("Choose an editable note belonging to this paper and resolve any conflict first.");
      const local = await readLocal(entry);
      const combined = `${local.parsed.body.trimEnd()}\n\n${String(body).trim()}\n`;
      await guardLocalFile(entry, local.file);
      plugin.ensureActive();
      if (entry.serverId !== identity()) throw new Error("The Zotero database changed. Your note was kept.");
      const fresh = await plugin.app.vault.read(local.file);
      if (fresh !== local.source) throw new Error("The note changed while adding this passage. Open it and try again.");
      await guardLocalFile(entry, local.file);
      if (entry.serverId !== identity()) throw new Error("The Zotero database changed. Your note was kept.");
      await plugin.app.vault.modify(local.file, `${local.source.trimEnd()}\n\n${String(body).trim()}\n`);
      updatePreview(entry, combined);
      entry.message = automaticWriteback() ? "Passage saved. Syncing to Zotero automatically…" : "Passage saved locally. Enable writeback and choose Always Allow for automatic sync.";
    });
    await finishLocalSave(entry);
    return entry;
  };
  plugin.resolveNoteConflict = async (entry, direction) => lock(entry, async () => {
    const remote = await plugin.sharedClient().loadPaper(entry.parentKey, []);
    const record = remote.notes.find(note => note.key === entry.key);
    if (!record) throw new Error("This note is unavailable in Zotero. Your copies were kept.");
    const local = await readLocal(entry);
    if (direction === "local") {
      if (!entry.canPush) throw new Error("This rich note cannot be safely replaced from Markdown.");
      const content = await html(local.parsed.body, entry.path);
      const saved = await plugin.withWrite(key => plugin.sharedClient().saveNote(record, content, key), true);
      await writeHeader(entry, saved, local, local.parsed.body, true);
      baseline(entry, saved, local.parsed.body);
    } else {
      const backup = `${entry.path.slice(0, -3)} - Noema ${Date.now()}.md`;
      plugin.ensureActive();
      if (record.serverId !== identity()) throw new Error("The Zotero database changed. Your files were kept.");
      await plugin.app.vault.create(backup, local.source.replace("---\n", "---\nsync_status: conflict\n"));
      const converted = convert(record.note);
      if (!(await writeHeader(entry, record, local, converted.body))) { await conflict(entry, record); return; }
      entry.canPush = converted.canPush;
      baseline(entry, record, converted.body);
    }
    await persist();
    for (const view of plugin.paperViews) view.render();
  });
  plugin.addCommand({ id: "enable-note-writeback", name: "Enable shared-note writeback", callback: () => plugin.enableWriteback().catch(error => new Notice(error.message)) });
  plugin.addCommand({ id: "forget-note-writeback", name: "Forget saved Zotero authorization", callback: () => plugin.forgetWriteback().then(() => new Notice("Saved Zotero authorization forgotten. Enable writeback to authorize again.")).catch(() => new Notice("Writeback was disabled, but saved authorization could not be removed from Obsidian's secret storage.")) });
  plugin.addCommand({ id: "sync-shared-note", name: "Sync current shared paper note", checkCallback: checking => {
    const file = plugin.app.workspace.getActiveFile();
    const entry = file && plugin.mirrors.get(file.path);
    if (!entry || entry.deleted) return false;
    if (!checking) plugin.syncPaperNotes(entry.parentKey, true).then(() => new Notice(entry.message || "Shared paper note synchronized.")).catch(error => new Notice(error.message));
    return true;
  } });
  plugin.addCommand({ id: "delete-current-note", name: "Delete current shared paper note", checkCallback: checking => {
    const file = plugin.app.workspace.getActiveFile();
    const entry = file && plugin.mirrors.get(file.path);
    if (!entry || entry.deleted) return false;
    if (!checking) plugin.trashPaperNote(entry).catch(error => new Notice(error.message));
    return true;
  } });
  plugin.addCommand({ id: "open-paper-notes", name: "Open current paper's shared notes", checkCallback: checking => {
    const file = plugin.app.workspace.getActiveFile();
    const key = file?.path.startsWith(`${plugin.pdfPrefix}/`) ? file.basename : plugin.mirrors.get(file?.path)?.parentKey;
    if (!KEY.test(key || "")) return false;
    if (!checking) plugin.openPaperNotes(key);
    return true;
  } });
  plugin.registerEvent(plugin.app.vault.on("modify", file => {
    const entry = plugin.mirrors.get(file.path);
    if (!entry || !autoSyncEligible(entry)) return;
    const schedule = () => {
      scheduleAutoSync(entry);
    };
    if (metadataWrites.has(file.path)) {
      const expectedSource = metadataWrites.get(file.path);
      // Vault watchers may report our write after modify() resolves. Compare
      // the saved source so bibliographic edits cannot trigger body writeback.
      plugin.app.vault.read(file).then(source => {
        if (metadataWrites.get(file.path) !== expectedSource || source === expectedSource) return;
        metadataWrites.delete(file.path);
        schedule();
      }).catch(() => {});
    } else schedule();
  }));
  plugin.registerInterval(window.setInterval(() => {
    const file = plugin.app.workspace.getActiveFile();
    const key = file?.path.startsWith(`${plugin.pdfPrefix}/`) ? file.basename : null;
    const parentKey = (key && plugin.itemForAttachment(key)?.key) || plugin.mirrors.get(file?.path)?.parentKey;
    if (parentKey && plugin.active) plugin.refreshPaper(parentKey).catch(() => {});
  }, 30000));
  plugin.register(() => {
    ++authorizationGeneration;
    plugin.writeKey = null;
    plugin.writeRemember = false;
    cancelAutoSync();
  });
  plugin.initializeShared = ensureRegistry;
  // Metadata refresh is local-only, including retained copies whose native note
  // disappeared. Persist ownership before removing legacy identity properties.
  plugin.refreshNoteMetadata = async () => {
    await ensureRegistry();
    for (const entry of [...plugin.mirrors.values()]) await lock(entry, async () => {
      if (plugin.mirrors.get(entry.path) !== entry || entry.deleted || entry.serverId !== identity()) return;
      const paper = plugin.snapshot.items.find(item => item.key === entry.parentKey);
      if (!paper || !Array.isArray(paper.authors)) return; // Older caches lack bibliographic fields.
      try {
        const local = await readLocal(entry);
        if (local.parsed.legacy && local.parsed.version !== entry.version
          && !(entry.pendingCreation && local.parsed.key === entry.pendingKey && local.parsed.version === entry.pendingVersion)) {
          throw new Error("The legacy note version differs from its saved registry. Your file was kept.");
        }
        await writeHeader(entry, { serverId: entry.serverId, key: local.parsed.key, parentItem: entry.parentKey, version: local.parsed.version }, local, local.parsed.body, false, true);
      } catch (error) { new Notice(`Paper properties could not be updated: ${error.message}`); }
    });
  };
}

module.exports = { installShared };
