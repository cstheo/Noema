"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const paperNoteTemplate = require("./paper-note-template.js");

const KEY = /^[A-F0-9]{8}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const TYPES = new Set(["highlight", "underline"]);
const MAX_TEXT = 200000;
const MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const queues = new Map();

function pdfPath(value, configDir = ".obsidian") {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\\\x00-\x1f\x7f:]/.test(value)
    || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..") || !/\.pdf$/i.test(value)) {
    throw new Error("A PDF path inside this vault is required.");
  }
  if (value.toLowerCase().startsWith(`${configDir}/zotero/pdfs/`.toLowerCase())) throw new Error("Zotero PDF aliases must use the shared Zotero annotation bridge.");
  return value;
}

function checkedText(value, label) {
  if (typeof value !== "string" || value.length > MAX_TEXT || /[\x00\x0b\x0c]/.test(value)) {
    throw new Error(`${label} must be text within the 200,000 character limit.`);
  }
  return value.replace(/\r\n?/g, "\n");
}

function checkedPayload(value) {
  if (!value || !TYPES.has(value.type)) throw new Error("Choose Highlight or Underline for this PDF annotation.");
  if (!COLOR.test(value.color || "")) throw new Error("A valid annotation color is required.");
  let position = value.position;
  if (typeof position === "string") {
    if (position.length > MAX_BYTES) throw new Error("The PDF selection geometry is too large.");
    try { position = JSON.parse(position); } catch { throw new Error("The PDF selection geometry is invalid."); }
  }
  // Keep the renderer's ordered PDF-space rectangle bounds. Invalid geometry
  // is rejected at the storage boundary, rather than silently disappearing.
  if (!position || !Number.isSafeInteger(position.pageIndex) || position.pageIndex < 0 || position.pageIndex > 100000
    || !Array.isArray(position.rects) || !position.rects.length || position.rects.length > 10000
    || position.rects.some(rect => !Array.isArray(rect) || rect.length !== 4
      || !rect.every(number => Number.isFinite(number) && Math.abs(number) <= 1e6) || rect[2] <= rect[0] || rect[3] <= rect[1])) {
    throw new Error("The PDF selection requires a page and finite, ordered rectangles.");
  }
  const text = checkedText(value.text, "Selected passage");
  if (!text.trim()) throw new Error("Select a passage in the PDF first.");
  const comment = checkedText(value.comment ?? "", "Annotation comment");
  const pageLabel = checkedText(value.pageLabel ?? String(position.pageIndex + 1), "Page label");
  if (pageLabel.length > 100 || /[\r\n]/.test(pageLabel)) throw new Error("The PDF page label is invalid.");
  return { type: value.type, color: value.color.toLowerCase(), text, comment, pageLabel,
    position: { pageIndex: position.pageIndex, rects: position.rects.map(rect => rect.slice()) } };
}

function hashPath(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function notePath(value) {
  const raw = path.posix.basename(value).replace(/\.pdf$/i, "").replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, " ").trim() || "PDF";
  let stem = "";
  for (const char of raw) { if (Buffer.byteLength(stem + char) > 180) break; stem += char; }
  return path.posix.join(path.posix.dirname(value), `${stem}.notes.md`);
}
function checkedNotePath(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\\\x00-\x1f\x7f:]/.test(value) || value.startsWith("/")
    || value.split("/").some(part => !part || part === "." || part === "..") || !/\.md$/i.test(value)) throw new Error("The PDF companion note path is invalid.");
  return value;
}
function markdownText(value) { return value.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]); }
function quoteText(value) { return markdownText(value).replace(/([\\`*_{}\[\]()!|])/g, "\\$1"); }

function installLocalPdf(plugin) {
  const vault = plugin.app.vault;
  const config = vault.configDir || ".obsidian";
  if (typeof config !== "string" || !config || /[\\\x00-\x1f:]/.test(config) || config.startsWith("/")
    || config.split("/").some(part => !part || part === "." || part === "..")) throw new Error("The Obsidian configuration path is invalid.");
  const base = path.resolve(vault.adapter.getBasePath());
  const folder = path.join(base, config, "pdf", "annotations");
  const deletedFolder = path.join(base, config, "pdf", "deleted-notes");
  let disposed = false;
  const notice = message => { if (plugin.obsidian?.Notice) new plugin.obsidian.Notice(message); };
  const active = () => { if (disposed || plugin.active === false) throw new Error("The PDF annotation plugin was disabled."); };
  const serial = action => {
    const previous = queues.get(base) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => { active(); return action(); });
    queues.set(base, current);
    current.finally(() => { if (queues.get(base) === current) queues.delete(base); }).catch(() => {});
    return current;
  };

  async function directories(target, create = false) {
    const realBase = await fs.realpath(base);
    if (realBase !== base) throw new Error("The PDF vault root must be a real directory.");
    const relative = path.relative(base, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("PDF storage must remain inside the vault.");
    let current = base;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (create) { try { await fs.mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; } }
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(current) !== current) {
        throw new Error("PDF annotation folders must remain real directories inside the vault.");
      }
    }
  }

  async function documentFile(input) {
    active();
    const checked = pdfPath(input, config), absolute = path.join(base, checked);
    await directories(path.dirname(absolute));
    const info = await fs.lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || await fs.realpath(absolute) !== absolute) throw new Error("The local PDF must be a regular vault file.");
    active();
    return checked;
  }

  function validateState(state, expected) {
    if (!state || state.version !== 1 || state.path !== expected || !Array.isArray(state.annotations) || !Array.isArray(state.archivedAnnotations)
      || state.annotations.length + state.archivedAnnotations.length > 10000 || !/^[0-9a-f]{32}$/.test(state.noteId || "")) {
      throw new Error("The annotation sidecar belongs to another PDF or has invalid metadata. It was kept.");
    }
    checkedNotePath(state.notesPath);
    if (state.notesCreated !== undefined && typeof state.notesCreated !== "boolean" || state.noteDeleted !== undefined && typeof state.noteDeleted !== "boolean"
      || state.deletedNotes !== undefined && (!Array.isArray(state.deletedNotes) || state.deletedNotes.length > 1000)) {
      throw new Error("The PDF note registry is invalid. Its sidecar was kept.");
    }
    for (const entry of state.deletedNotes || []) {
      if (!UUID.test(entry?.id || "") || entry.noteId !== state.noteId || !/^[0-9a-f]{64}$/.test(entry.contentHash || "")
        || typeof entry.deletedAt !== "string" || !Number.isFinite(Date.parse(entry.deletedAt))) throw new Error("The archived PDF note registry is invalid.");
      checkedNotePath(entry.path);
    }
    if (state.noteMove !== undefined) {
      const move = state.noteMove;
      if (!move || move.from !== state.notesPath || !/^[0-9a-f]{64}$/.test(move.contentHash || "")) throw new Error("The pending PDF note move is invalid.");
      checkedNotePath(move.from); checkedNotePath(move.to);
      if (move.from === move.to) throw new Error("The pending PDF note move has identical paths.");
    }
    const keys = new Set();
    for (const record of [...state.annotations, ...state.archivedAnnotations]) {
      if (!KEY.test(record?.key || "") || record.localPdfPath !== expected || keys.has(record.key)) {
        throw new Error("The PDF annotation identity is invalid or duplicated. Its sidecar was kept.");
      }
      keys.add(record.key);
      const data = record.data;
      if (!data || data.annotationComment === undefined) throw new Error("The PDF annotation data is incomplete.");
      checkedPayload({ type: data.annotationType, color: data.annotationColor, text: data.annotationText,
        comment: data.annotationComment, position: data.annotationPosition, pageLabel: data.annotationPageLabel });
    }
    return state;
  }

  async function readState(checked) {
    const filename = path.join(folder, `${hashPath(checked)}.json`);
    try {
      await directories(folder);
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES || await fs.realpath(filename) !== filename) throw new Error("The annotation sidecar must be a regular file within the 8 MiB limit.");
      const source = await fs.readFile(filename, "utf8");
      let state;
      try { state = JSON.parse(source); } catch { throw new Error("The PDF annotation sidecar is malformed. It was kept."); }
      const current = { filename, source, state: validateState(state, checked) };
      if (current.state.noteMove) await recoverNoteMove(current);
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { filename, source: null, state: { version: 1, path: checked, notesPath: notePath(checked), noteId: crypto.randomBytes(16).toString("hex"),
        notesCreated: false, noteDeleted: false, deletedNotes: [], annotations: [], archivedAnnotations: [] } };
    }
  }

  async function publish(current, state) {
    active();
    validateState(state, state.path);
    const source = JSON.stringify(state, null, 2) + "\n";
    if (Buffer.byteLength(source) > MAX_BYTES) throw new Error("The PDF annotation sidecar exceeds its 8 MiB limit.");
    await directories(folder, true);
    const temporary = `${current.filename}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(source, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await directories(folder); active();
      if (current.source === null) {
        // Exclusive publication keeps a concurrent or mismatched sidecar intact.
        await fs.link(temporary, current.filename);
      } else {
        const info = await fs.lstat(current.filename);
        if (!info.isFile() || info.isSymbolicLink() || await fs.readFile(current.filename, "utf8") !== current.source) {
          throw new Error("The PDF annotation sidecar changed outside this plugin. Existing marks were kept; refresh before editing.");
        }
        await fs.rename(temporary, current.filename);
      }
      current.source = source;
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") notice("An annotation temporary file could not be cleaned up."); }); }
  }

  async function annotationsFor(input) {
    return serial(async () => { const checked = await documentFile(input); return structuredClone((await readState(checked)).state.annotations); });
  }

  async function createAnnotation(input, payload) {
    const checked = pdfPath(input, config), selection = checkedPayload(payload);
    return serial(async () => {
      await documentFile(checked);
      const current = await readState(checked), existing = new Set([...current.state.annotations, ...current.state.archivedAnnotations].map(record => record.key));
      let key;
      for (let attempt = 0; attempt < 32; attempt++) { const candidate = crypto.randomBytes(4).toString("hex").toUpperCase(); if (!existing.has(candidate)) { key = candidate; break; } }
      if (!key) throw new Error("A unique PDF annotation key could not be allocated.");
      const record = { key, localPdfPath: checked, data: { annotationType: selection.type, annotationColor: selection.color,
        annotationText: selection.text, annotationComment: selection.comment, annotationPosition: selection.position, annotationPageLabel: selection.pageLabel } };
      current.state.annotations.push(record);
      await publish(current, current.state);
      return structuredClone(record);
    });
  }

  function sourceLink(checked, target, payload) {
    const file = vault.getAbstractFileByPath(checked), page = payload.position.pageIndex + 1;
    // The physical page is always safe in a Markdown alias, even when a PDF's
    // display label contains bracket characters or unusual metadata.
    const alias = `PDF · p. ${page}`;
    if (file && plugin.app.fileManager?.generateMarkdownLink) {
      return plugin.app.fileManager.generateMarkdownLink(file, target, `#page=${page}`, alias);
    }
    const relative = path.posix.relative(path.posix.dirname(target), checked);
    const escaped = encodeURI(relative).replace(/[?#()[\]<>]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return `[PDF · p. ${page}](<${escaped}#page=${page}>)`;
  }

  function noteMarker(state) { return `<!-- noema-local-pdf-note:${state.noteId} -->`; }
  function ownedNote(source, state) {
    return typeof source === "string" && Buffer.byteLength(source) <= MAX_BYTES
      && source.split(noteMarker(state)).length === 2 && (source.match(/<!-- noema-local-pdf-note:/g) || []).length === 1;
  }

  function savedNote(file, source) {
    for (const leaf of plugin.app.workspace.getLeavesOfType?.("markdown") || []) {
      if (leaf.view?.file?.path !== file.path || typeof leaf.view.editor?.getValue !== "function") continue;
      const editor = leaf.view.editor.getValue();
      if (typeof editor === "string" && editor.replace(/\r\n?/g, "\n") !== source.replace(/\r\n?/g, "\n")) {
        throw new Error("The PDF note has unsaved editor text. Wait for it to save before moving or deleting the note.");
      }
    }
  }

  async function readNote(current, missing = false) {
    const target = checkedNotePath(current.state.notesPath), absolute = path.join(base, target);
    try {
      await directories(path.dirname(absolute));
      const info = await fs.lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES || await fs.realpath(absolute) !== absolute) throw new Error("The PDF companion note must be a regular vault file within the 8 MiB limit.");
      const file = vault.getAbstractFileByPath(target);
      if (!file) throw new Error("The companion note is not indexed. Refresh Obsidian before editing it.");
      const source = await vault.read(file);
      if (!ownedNote(source, current.state)) throw new Error("The companion note identity does not match this PDF. The existing note was kept.");
      return { file, source, marker: noteMarker(current.state) };
    } catch (error) { if (missing && error.code === "ENOENT") return null; throw error; }
  }

  async function availableNotePath(current, preferred) {
    checkedNotePath(preferred);
    await directories(path.dirname(path.join(base, preferred)));
    for (let attempt = 0; attempt < 32; attempt++) {
      const suffix = attempt ? `.${hashPath(current.state.path).slice(0, 16)}${attempt > 1 ? `-${attempt - 1}` : ""}` : "";
      const candidate = suffix ? preferred.replace(/\.notes\.md$/, `${suffix}.notes.md`) : preferred;
      const absolute = path.join(base, candidate);
      try {
        const info = await fs.lstat(absolute);
        if (info.isFile() && !info.isSymbolicLink() && info.size <= MAX_BYTES && ownedNote(await fs.readFile(absolute, "utf8"), current.state)) return candidate;
      } catch (error) { if (error.code === "ENOENT") return candidate; throw error; }
    }
    throw new Error("No unused companion note filename is available. Existing files were kept.");
  }

  async function ensureNote(current) {
    if (current.state.noteDeleted) {
      // A completed file restoration can outlive a failed metadata publication.
      // Adopt only the matching owned note; never create it during this repair.
      const restored = await readNote(current, true);
      if (!restored) throw new Error("This PDF note was deleted. Use Restore PDF note from the Notes menu.");
      current.state.noteDeleted = false; await publish(current, current.state);
      return restored;
    }
    const preferred = notePath(current.state.path);
    let existing;
    // Newly reserved names may be occupied by an unrelated user file. Pick a
    // deterministic suffix without adopting or replacing the occupied note.
    if (current.state.notesCreated !== true && current.state.notesPath === preferred) {
      const target = await availableNotePath(current, preferred);
      if (target !== current.state.notesPath) { current.state.notesPath = target; await publish(current, current.state); }
    }
    existing = await readNote(current, true);
    if (existing) {
      if (current.state.notesCreated !== true) { current.state.notesCreated = true; await publish(current, current.state); }
      return existing;
    }
    if (current.state.notesCreated !== true && current.state.notesPath !== preferred) current.state.notesPath = await availableNotePath(current, preferred);
    const target = checkedNotePath(current.state.notesPath);
    await directories(path.dirname(path.join(base, target)));
    current.state.notesCreated = true;
    await publish(current, current.state);
    const title = path.posix.basename(current.state.path).replace(/\.pdf$/i, "");
    active();
    await vault.create(target, `---\ntitle: ${JSON.stringify(title)}\ntype: pdf-note\n---\n\n${noteMarker(current.state)}\n\n# PDF notes\n\n${sourceLink(current.state.path, target, { position: { pageIndex: 0 }, pageLabel: "1" })}\n\n${paperNoteTemplate.markdown}`);
    return readNote(current);
  }

  async function companion(input) {
    const checked = await documentFile(input), current = await readState(checked);
    // Register ownership before note creation so interrupted saves cannot leave
    // an existing note associated with a newly generated identity on the next run.
    if (current.source === null) await publish(current, current.state);
    return { checked, current, note: await ensureNote(current) };
  }

  async function openNotes(input) {
    const note = await serial(async () => (await companion(input)).note.file);
    active(); await plugin.app.workspace.getLeaf("tab").openFile(note);
    return note;
  }

  async function recoverNoteMove(current) {
    const move = current.state.noteMove;
    const before = await readNote(current, true);
    const after = await readNote({ ...current, state: { ...current.state, notesPath: move.to } }, true);
    if (before && after) throw new Error("Both PDF note move paths exist. Their contents were kept; resolve the move conflict first.");
    if (!after && (!before || hashPath(before.source) !== move.contentHash)) throw new Error("The pending PDF note move changed. Its files and registry were kept.");
    // Native rename updates links after moving the file. A sole destination
    // with the exact ownership marker is authoritative even when its body now
    // differs from the prepared source. Never replace that current content.
    if (after) { current.state.notesPath = move.to; current.state.notesCreated = true; }
    delete current.state.noteMove;
    await publish(current, current.state);
  }

  async function notesInfo(input) {
    return serial(async () => {
      const checked = await documentFile(input), current = await readState(checked);
      if (current.state.notesCreated !== true && current.state.notesPath === notePath(checked)) current.state.notesPath = await availableNotePath(current, notePath(checked));
      const note = await readNote(current, true);
      if (!note && current.state.notesCreated !== true && !current.state.noteDeleted) current.state.notesPath = await availableNotePath(current, notePath(checked));
      const archived = current.state.deletedNotes || [];
      return { path: current.state.notesPath, exists: !!note, canMove: !!note && path.posix.dirname(current.state.notesPath) !== path.posix.dirname(checked),
        canDelete: !!note, canRestore: !note && archived.length > 0, deleted: !note && !!current.state.noteDeleted };
    });
  }

  async function moveNotesToPdfDirectory(input) {
    const file = await serial(async () => {
      const checked = await documentFile(input), current = await readState(checked);
      const note = await readNote(current);
      savedNote(note.file, note.source);
      if (current.state.noteDeleted) throw new Error("Restore the PDF note before moving it.");
      if (path.posix.dirname(note.file.path) === path.posix.dirname(checked)) return note.file;
      const target = await availableNotePath(current, notePath(checked));
      try { await fs.lstat(path.join(base, target)); throw new Error("A note already exists at the move destination. Both files were kept."); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const rename = plugin.app.fileManager?.renameFile?.bind(plugin.app.fileManager) || vault.rename?.bind(vault);
      if (!rename) throw new Error("The Obsidian file rename API is unavailable.");
      current.state.noteMove = { from: current.state.notesPath, to: target, contentHash: hashPath(note.source) };
      await publish(current, current.state);
      try {
        const latest = await readNote(current);
        savedNote(latest.file, latest.source);
        if (latest.source !== note.source) throw new Error("The PDF note changed before moving. Its latest text was kept; try again.");
        await directories(path.dirname(path.join(base, target)));
        active();
        await rename(latest.file, target);
      } catch (error) {
        // fileManager.renameFile can reject after vault.rename succeeds, for
        // example while updating links. Resolve the actual files before any
        // rollback; an unknown outcome retains the prepared recovery pointer.
        try { await recoverNoteMove(current); }
        catch (recoveryError) { throw new Error(`${error.message} ${recoveryError.message}`, { cause: error }); }
        if (current.state.notesPath === target) {
          notice("The PDF note moved, but Obsidian could not finish updating links. Its current content was kept.");
          return (await readNote(current)).file;
        }
        throw error;
      }
      current.state.notesPath = target; current.state.notesCreated = true;
      delete current.state.noteMove;
      await publish(current, current.state);
      return (await readNote(current)).file;
    });
    active(); await plugin.app.workspace.getLeaf("tab").openFile(file);
    return file;
  }

  async function archiveNote(source) {
    if (typeof source !== "string" || Buffer.byteLength(source) > MAX_BYTES) throw new Error("The PDF note exceeds the archive limit.");
    await directories(deletedFolder, true);
    const id = crypto.randomUUID(), destination = path.join(deletedFolder, `${id}.md`), temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(source, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await directories(deletedFolder); active(); await fs.link(temporary, destination);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") notice("A PDF note archive temporary file was kept."); }); }
    return id;
  }

  async function readNoteArchive(entry, state) {
    if (!UUID.test(entry?.id || "")) throw new Error("The PDF note archive identity is invalid.");
    await directories(deletedFolder);
    const absolute = path.join(deletedFolder, `${entry.id}.md`), info = await fs.lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES || await fs.realpath(absolute) !== absolute) throw new Error("The PDF note archive must be a regular file.");
    const source = await fs.readFile(absolute, "utf8");
    if (hashPath(source) !== entry.contentHash || !ownedNote(source, state)) throw new Error("The archived PDF note changed or belongs to another PDF. It was kept.");
    return source;
  }

  async function deleteNotes(input) {
    const checked = pdfPath(input, config);
    const prepared = await serial(async () => {
      await documentFile(checked);
      const current = await readState(checked), note = await readNote(current);
      savedNote(note.file, note.source);
      return { path: current.state.notesPath, noteId: current.state.noteId, source: note.source };
    });
    return modal("Delete PDF note", (content, close) => {
      metadata(content, prepared.path);
      content.createEl("p", { text: "Move this companion note to Obsidian's local Trash? A recovery copy will be kept. The PDF and its annotations remain available." });
      buttons(content, close, () => serial(async () => {
        await documentFile(checked);
        const current = await readState(checked);
        if (current.state.notesPath !== prepared.path || current.state.noteId !== prepared.noteId) throw new Error("The PDF note location changed. Reopen the delete dialog.");
        const note = await readNote(current);
        savedNote(note.file, note.source);
        if (note.source !== prepared.source) throw new Error("The PDF note changed while confirming deletion. Its latest text was kept; reopen the dialog.");
        if (typeof vault.trash !== "function") throw new Error("Obsidian's local Trash API is unavailable. Your note was kept.");
        const id = await archiveNote(note.source);
        const entry = { id, path: prepared.path, noteId: prepared.noteId, contentHash: hashPath(note.source), deletedAt: new Date().toISOString() };
        current.state.deletedNotes = [...(current.state.deletedNotes || []), entry]; current.state.noteDeleted = true;
        await publish(current, current.state);
        try {
          const latest = await readNote(current);
          savedNote(latest.file, latest.source);
          if (latest.source !== prepared.source) throw new Error("The PDF note changed while archiving. Its latest text was kept; reopen the dialog.");
          active(); await vault.trash(latest.file, false);
        } catch (error) {
          current.state.noteDeleted = false;
          await publish(current, current.state).catch(() => {});
          throw error;
        }
        return { path: prepared.path, archiveId: id, deleted: true };
      }), undefined, "Delete note");
    });
  }

  async function restoreNotes(input) {
    const file = await serial(async () => {
      const checked = await documentFile(input), current = await readState(checked);
      if (await readNote(current, true)) throw new Error("The PDF companion note already exists. Its current content was kept.");
      const entry = current.state.deletedNotes?.at(-1);
      if (!entry) throw new Error("No deleted companion note is available for this PDF.");
      const source = await readNoteArchive(entry, current.state), target = checkedNotePath(current.state.notesPath);
      await directories(path.dirname(path.join(base, target)));
      // Retain archive metadata until the exclusive vault creation succeeds.
      active(); const restored = await vault.create(target, source);
      current.state.noteDeleted = false; current.state.notesCreated = true;
      await publish(current, current.state);
      return restored;
    });
    active(); await plugin.app.workspace.getLeaf("tab").openFile(file);
    return file;
  }

  function modal(title, build, classes = []) {
    const Modal = plugin.obsidian?.Modal;
    if (!Modal) throw new Error("The Obsidian note editor is unavailable.");
    return new Promise(resolve => {
      const dialog = new Modal(plugin.app);
      const container = dialog.modalEl || dialog.contentEl;
      container.classList?.add("nz-note-modal", "nz-local-pdf-modal", ...classes);
      let finished = false;
      const close = result => { if (!finished) { finished = true; resolve(result); } dialog.close(); };
      dialog.onClose = () => { if (!finished) { finished = true; resolve(null); } };
      dialog.onOpen = () => {
        const content = dialog.contentEl;
        content.empty(); content.createEl("h2", { text: title });
        build(content, close);
      };
      dialog.open();
    });
  }

  function buttons(content, close, save, remove, saveLabel = "Save") {
    const row = content.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => close(null));
    let busy = false;
    const run = async (button, action) => {
      if (busy) return; busy = true; button.disabled = true;
      try { close(await action()); } catch (error) { notice(error.message); } finally { busy = false; button.disabled = false; }
    };
    if (remove) {
      const button = row.createEl("button", { text: "Remove annotation", cls: "nz-local-pdf-delete", attr: { title: "Keep a recoverable copy in the PDF sidecar archive" } });
      button.addEventListener("click", () => run(button, remove));
    }
    const button = row.createEl("button", { text: saveLabel, cls: saveLabel === "Delete note" ? "nz-local-pdf-delete" : "mod-cta" });
    button.addEventListener("click", () => run(button, save));
    content.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && saveLabel === "Save") {
        event.preventDefault(); run(button, save);
      }
    });
  }

  function commentBox(content, value) {
    const label = content.createEl("label", { text: "Comment", cls: "nz-local-comment-label" });
    const textarea = label.createEl("textarea", { cls: "nz-note-editor", attr: { rows: "6", placeholder: "Add a comment…", "aria-label": "Comment" } });
    textarea.value = value;
    return textarea;
  }

  function metadata(content, checked, page) {
    return content.createEl("p", { cls: "nz-local-pdf-meta", text: `${path.posix.basename(checked)}${page !== undefined ? ` · p. ${page}` : ""}`,
      attr: { title: checked } });
  }

  async function addSelection(captured) {
    if (!captured || captured.key !== null) throw new Error("Choose a local vault PDF selection.");
    const checked = await documentFile(captured.path), payload = checkedPayload(captured.payload);
    return modal("Add PDF selection to note", (content, close) => {
      metadata(content, checked, payload.pageLabel);
      content.createEl("blockquote", { cls: "nz-local-pdf-quote", text: payload.text });
      const comment = commentBox(content, payload.comment);
      buttons(content, close, async () => {
        const value = checkedText(comment.value, "Note comment");
        const file = await serial(async () => {
          const { current, note } = await companion(checked);
          const quote = payload.text.split("\n").map(line => `> ${quoteText(line)}`).join("\n");
          const block = `\n\n${quote}\n\n${sourceLink(checked, current.state.notesPath, payload)}${value.trim() ? `\n\n${markdownText(value)}` : ""}\n`;
          if (typeof vault.process !== "function") throw new Error("Safe PDF note saving requires Obsidian's vault.process API.");
          await vault.process(note.file, source => {
            active();
            if (source !== note.source) throw new Error("The companion note changed while saving. Your edit was kept; try saving again.");
            return source + block;
          });
          return note.file;
        });
        active(); await plugin.app.workspace.getLeaf("tab").openFile(file);
        return file;
      });
    });
  }

  async function editAnnotation(record) {
    if (!record || !KEY.test(record.key || "")) throw new Error("A local PDF annotation key is required.");
    const checked = pdfPath(record.localPdfPath, config);
    const original = await serial(async () => {
      await documentFile(checked);
      const current = await readState(checked), found = current.state.annotations.find(value => value.key === record.key);
      if (!found) throw new Error("This PDF annotation was already removed or belongs to another PDF.");
      return structuredClone(found);
    });
    const mutate = (comment, remove) => serial(async () => {
      await documentFile(checked);
      const current = await readState(checked), index = current.state.annotations.findIndex(value => value.key === original.key);
      if (index < 0) throw new Error("This PDF annotation was already removed.");
      const latest = current.state.annotations[index];
      if (JSON.stringify(latest) !== JSON.stringify(original)) throw new Error("This PDF annotation changed while its editor was open. Reopen it before saving.");
      if (remove) { current.state.annotations.splice(index, 1); current.state.archivedAnnotations.push({ ...latest, removedAt: new Date().toISOString() }); }
      else latest.data.annotationComment = checkedText(comment, "Annotation comment");
      await publish(current, current.state);
      return { key: original.key, localPdfPath: checked, removed: !!remove };
    });
    return modal("PDF annotation comment", (content, close) => {
      metadata(content, checked, original.data.annotationPageLabel);
      content.createEl("blockquote", { cls: "nz-local-pdf-quote", text: original.data.annotationText });
      const comment = commentBox(content, original.data.annotationComment);
      buttons(content, close, () => mutate(comment.value, false), () => mutate("", true));
    }, ["nz-annotation-modal"]);
  }

  async function restoreAnnotations(input) {
    const checked = pdfPath(input, config);
    const archived = await serial(async () => {
      await documentFile(checked);
      return structuredClone((await readState(checked)).state.archivedAnnotations);
    });
    if (!archived.length) { notice("No removed annotations are available for this PDF."); return null; }
    return modal("Restore PDF annotation", (content, close) => {
      const label = content.createEl("label", { text: "Removed annotation" });
      const select = label.createEl("select", { attr: { "aria-label": "Removed annotation" } });
      for (const record of archived.slice().reverse()) {
        select.createEl("option", { text: `p. ${record.data.annotationPageLabel} · ${record.data.annotationType} · ${record.data.annotationColor} · ${record.data.annotationText.slice(0, 120)}`,
          attr: { value: record.key } });
      }
      select.value = archived.at(-1).key;
      buttons(content, close, async () => {
        const selected = select.value;
        if (!KEY.test(selected || "")) throw new Error("Choose a removed PDF annotation first.");
        const restored = await serial(async () => {
          await documentFile(checked);
          const current = await readState(checked), index = current.state.archivedAnnotations.findIndex(record => record.key === selected);
          if (index < 0) throw new Error("This annotation was already restored. Reopen the restore dialog.");
          const record = current.state.archivedAnnotations.splice(index, 1)[0];
          delete record.removedAt;
          current.state.annotations.push(record);
          await publish(current, current.state);
          return structuredClone(record);
        });
        await plugin.reader?.refresh?.(checked);
        return restored;
      }, undefined, "Restore");
    });
  }

  async function movePdf(newPath, oldPath, movedFolder) {
    const previous = pdfPath(oldPath, config), checked = pdfPath(newPath, config);
      await documentFile(checked);
      const current = await readState(previous);
      if (current.source === null) return;
      const destination = await readState(checked);
      if (destination.source !== null) throw new Error("Both PDF paths already have annotations. Their sidecars were kept separately; resolve the rename conflict before adding new marks.");
      current.state.path = checked;
      for (const record of [...current.state.annotations, ...current.state.archivedAnnotations]) record.localPdfPath = checked;
      if (movedFolder && current.state.notesPath.startsWith(`${movedFolder.from}/`)) {
        current.state.notesPath = `${movedFolder.to}/${current.state.notesPath.slice(movedFolder.from.length + 1)}`;
      }
      // Preserve the companion note's original path and marker, including all
      // user-authored content. Obsidian updates existing PDF links on rename.
      await publish(destination, current.state);
      if (await fs.readFile(current.filename, "utf8") !== current.source) throw new Error("The old sidecar changed during rename. Both copies were kept.");
      await fs.unlink(current.filename);
  }

  const onRename = (file, oldPath) => {
    if (typeof file?.path !== "string" || typeof oldPath !== "string") return;
    if (/\.pdf$/i.test(oldPath)) {
      try { pdfPath(file.path, config); pdfPath(oldPath, config); } catch { return; }
      serial(() => movePdf(file.path, oldPath)).catch(error => notice(`PDF annotations were kept: ${error.message}`));
      return;
    }
    // A folder rename emits one event rather than one per child PDF.
    if (!Array.isArray(file.children) || !oldPath || /[\\\x00-\x1f:]/.test(oldPath)
      || oldPath.startsWith("/") || oldPath.split("/").some(part => !part || part === "." || part === "..")) return;
    serial(async () => {
      let files;
      try { await directories(folder); files = await fs.readdir(folder); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      for (const filename of files) {
        if (!/^[0-9a-f]{64}\.json$/.test(filename)) continue;
        const absolute = path.join(folder, filename), info = await fs.lstat(absolute);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error("An invalid sidecar was kept during folder rename.");
        let state;
        try { state = JSON.parse(await fs.readFile(absolute, "utf8")); } catch { throw new Error("A malformed sidecar was kept during folder rename."); }
        if (typeof state.path !== "string" || !state.path.startsWith(`${oldPath}/`)) continue;
        if (filename !== `${hashPath(state.path)}.json`) throw new Error("A mismatched sidecar was kept during folder rename.");
        await movePdf(`${file.path}/${state.path.slice(oldPath.length + 1)}`, state.path, { from: oldPath, to: file.path });
      }
    }).catch(error => notice(`PDF annotations were kept: ${error.message}`));
  };
  if (typeof vault.on === "function") plugin.registerEvent(vault.on("rename", onRename));
  const dispose = () => { disposed = true; };
  plugin.register?.(dispose);
  return { annotationsFor, createAnnotation, editAnnotation, addSelection, openNotes, notesInfo, moveNotesToPdfDirectory, deleteNotes, restoreNotes, restoreAnnotations, dispose };
}

module.exports = { installLocalPdf, pdfPath, checkedPayload, hashPath, notePath };
