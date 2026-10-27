"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const KEY = /^[A-Z0-9]{8}$/;
const SERVER = /^[A-Za-z0-9_-]{1,128}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const TRASH_WARNING = "Annotation removed in Zotero. Its recovery record is saved, but the local status could not be updated. Use Removed annotations to restore it.";
const RESTORE_WARNING = "Annotation restored in Zotero. The local recovery list could not be updated. Refresh it before taking another action.";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// Recovery records are JSON data, never executable objects or authorization.
// Reject lossy serialization so the original annotation remains intact.
function cloneData(value, limit = MAX_RECORD_BYTES) {
  let nodes = 0;
  const ancestors = new Set();
  function copy(current, depth) {
    if (++nodes > 100000 || depth > 32) fail("INVALID_RECOVERY", "The annotation recovery record is too complex.");
    if (current === null || typeof current === "boolean" || typeof current === "string") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (!Array.isArray(current) && !plain(current)) fail("INVALID_RECOVERY", "The annotation recovery record must contain plain JSON data.");
    if (ancestors.has(current) || Object.getOwnPropertySymbols(current).length) fail("INVALID_RECOVERY", "The annotation recovery record must contain plain JSON data.");
    ancestors.add(current);
    const result = Array.isArray(current) ? [] : {};
    if (Array.isArray(current) && (Object.keys(current).length !== current.length
      || Object.keys(current).some((key, index) => key !== String(index)))) {
      fail("INVALID_RECOVERY", "The annotation recovery record contains an invalid array.");
    }
    for (const name of Object.keys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || ["__proto__", "prototype", "constructor"].includes(name)) {
        fail("INVALID_RECOVERY", "The annotation recovery record must contain plain JSON data.");
      }
      result[name] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(current);
    return result;
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > limit) fail("INVALID_RECOVERY", "The annotation recovery record is too large.");
  return result;
}

function record(value, serverId) {
  if (!plain(value)) fail("INVALID_RECOVERY", "A native Zotero annotation record is required.");
  const result = cloneData(value);
  if (result.serverId !== serverId || result.itemType !== "annotation" || !KEY.test(result.key || "")
    || !KEY.test(result.parentItem || "") || !Number.isSafeInteger(result.version) || result.version < 0
    || typeof result.annotationType !== "string" || !result.annotationType || result.annotationType.length > 64
    || ![undefined, false, true, 0, 1].includes(result.deleted)) {
    fail("INVALID_RECOVERY", "An annotation from the current Zotero database is required.");
  }
  return result;
}

function deleted(value) { return value.deleted === true || value.deleted === 1; }

function entry(value, serverId) {
  value = cloneData(value, 2 * MAX_RECORD_BYTES + 2048);
  if (!plain(value) || !ID.test(value.id || "") || value.serverId !== serverId || !KEY.test(value.parentKey || "")
    || !["pending", "trashed"].includes(value.status) || typeof value.createdAt !== "string"
    || value.createdAt.length !== 24 || !Number.isFinite(Date.parse(value.createdAt))) {
    fail("INVALID_RECOVERY", "The annotation recovery entry is invalid.");
  }
  const original = record(value.record, serverId);
  if (deleted(original) || original.annotationIsExternal) fail("INVALID_RECOVERY", "The original annotation recovery record is invalid.");
  const trashed = value.trashedRecord === null ? null : record(value.trashedRecord, serverId);
  if ((value.status === "pending" && trashed !== null) || (value.status === "trashed" && (!trashed || !deleted(trashed)))
    || (trashed && (trashed.key !== original.key || trashed.parentItem !== original.parentItem))) {
    fail("INVALID_RECOVERY", "The annotation recovery state is invalid.");
  }
  return { id: value.id, serverId, parentKey: value.parentKey, record: original, trashedRecord: trashed,
    status: value.status, createdAt: value.createdAt };
}

function createAnnotationTrash(plugin, { filesystem = fs } = {}) {
  const states = new Map();
  const locks = new Set();
  let writes = Promise.resolve();

  function context() {
    if (plugin.active !== true) fail("PLUGIN_DISABLED", "The Zotero bridge was disabled.");
    plugin.ensureActive?.();
    const serverId = plugin.snapshot?.serverId;
    if (typeof serverId !== "string" || !SERVER.test(serverId)) fail("SERVER_CHANGED", "Open Zotero and refresh My Library first.");
    if (typeof plugin.storageReal !== "string" || !path.isAbsolute(plugin.storageReal)) {
      fail("INVALID_RECOVERY", "The annotation recovery storage is unavailable.");
    }
    const storageRoot = plugin.storageReal;
    const folder = path.join(storageRoot, "shared", crypto.createHash("sha256").update(serverId).digest("hex").slice(0, 24));
    return { serverId, storageRoot, folder, file: path.join(folder, "annotations-trash.json") };
  }

  function guard(current) {
    if (plugin.active !== true) fail("PLUGIN_DISABLED", "The Zotero bridge was disabled.");
    plugin.ensureActive?.();
    if (plugin.snapshot?.serverId !== current.serverId || plugin.storageReal !== current.storageRoot) {
      fail("SERVER_CHANGED", "The Zotero database changed. Refresh the paper before taking another action.");
    }
  }

  async function storage(current) {
    guard(current);
    // storageReal is the plugin's resolved root. Each child must remain a real
    // directory there; a vault symlink must not redirect recovery data.
    for (const folder of [current.storageRoot, path.join(current.storageRoot, "shared"), current.folder]) {
      let info;
      try { info = await filesystem.lstat(folder); }
      catch (error) { if (error.code === "ENOENT" && folder !== current.storageRoot) return null; throw error; }
      guard(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fail("INVALID_RECOVERY", "Annotation recovery folders must be real directories inside Zotero storage.");
      const resolved = await filesystem.realpath(folder);
      guard(current);
      if (resolved !== folder) fail("INVALID_RECOVERY", "Annotation recovery folders must remain inside Zotero storage.");
    }
    let info;
    try { info = await filesystem.lstat(current.file); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    guard(current);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_STORE_BYTES) {
      fail("INVALID_RECOVERY", "The annotation recovery file must be a regular bounded file inside Zotero storage. It was kept.");
    }
    const resolved = await filesystem.realpath(current.file);
    guard(current);
    if (resolved !== current.file) fail("INVALID_RECOVERY", "The annotation recovery file must remain inside Zotero storage. It was kept.");
    return info;
  }

  async function load(current) {
    guard(current);
    let state = states.get(current.file);
    if (!state) {
      state = { entries: new Map(), completed: new Map(), loaded: false, loading: null };
      states.set(current.file, state);
    }
    if (state.loaded) return state;
    if (!state.loading) {
      const pending = (async () => {
        let saved;
        try {
          const info = await storage(current);
          guard(current);
          if (info) {
            const serialized = await filesystem.readFile(current.file, "utf8");
            guard(current);
            if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) fail("INVALID_RECOVERY", "The annotation recovery file is too large. It was kept.");
            try { saved = JSON.parse(serialized); }
            catch { fail("INVALID_RECOVERY", "The annotation recovery file could not be read. It was kept."); }
          }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        guard(current);
        const entries = new Map();
        if (saved !== undefined) {
          if (!plain(saved) || saved.schema !== 1 || saved.serverId !== current.serverId
            || !Array.isArray(saved.entries) || saved.entries.length > MAX_ENTRIES) {
            fail("INVALID_RECOVERY", "The annotation recovery file has an unsupported identity or format. It was kept.");
          }
          const ids = new Set();
          for (const value of saved.entries) {
            const recovery = entry(value, current.serverId);
            if (entries.has(recovery.record.key) || ids.has(recovery.id)) fail("INVALID_RECOVERY", "The annotation recovery file contains duplicate entries. It was kept.");
            ids.add(recovery.id);
            entries.set(recovery.record.key, recovery);
          }
        }
        state.entries = entries;
        state.loaded = true;
        return state;
      })();
      state.loading = pending;
      pending.finally(() => { if (state.loading === pending) state.loading = null; }).catch(() => {});
    }
    const loaded = await state.loading;
    guard(current);
    return loaded;
  }

  function persist(state, current) {
    const pending = writes.catch(() => {}).then(async () => {
      guard(current);
      const entries = [...state.entries.values()].filter(value => !state.completed.has(value.id));
      const serialized = JSON.stringify({ schema: 1, serverId: current.serverId, entries });
      if (entries.length > MAX_ENTRIES || Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) {
        fail("INVALID_RECOVERY", "The annotation recovery storage is full. Restore removed annotations before removing more.");
      }
      const temporary = path.join(current.folder, `annotations-trash.json.${crypto.randomUUID()}.tmp`);
      try {
        await storage(current);
        for (const folder of [path.join(current.storageRoot, "shared"), current.folder]) {
          guard(current);
          try { await filesystem.mkdir(folder, { mode: 0o700 }); }
          catch (error) { if (error.code !== "EEXIST") throw error; }
          await storage(current);
        }
        await storage(current);
        guard(current);
        await filesystem.writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
        await storage(current);
        const info = await filesystem.lstat(temporary);
        guard(current);
        if (info.isSymbolicLink() || !info.isFile() || await filesystem.realpath(temporary) !== temporary) {
          fail("INVALID_RECOVERY", "The annotation recovery temporary file changed. Your recovery records were kept.");
        }
        guard(current);
        await filesystem.rename(temporary, current.file);
      } finally {
        try {
          // Cleanup may run after disable or a server change, but must still
          // stay in the captured physical folder if a path was substituted.
          for (const folder of [current.storageRoot, path.join(current.storageRoot, "shared"), current.folder]) {
            const info = await filesystem.lstat(folder);
            if (info.isSymbolicLink() || !info.isDirectory() || await filesystem.realpath(folder) !== folder) throw new Error();
          }
          await filesystem.unlink(temporary);
        } catch { /* Renamed, never created, or no longer safely reachable. */ }
      }
    });
    writes = pending;
    return pending;
  }

  async function locked(current, key, run) {
    const token = `${current.file}:${key}`;
    if (locks.has(token)) fail("ANNOTATION_BUSY", "This annotation is already being updated. Wait for that action to finish.");
    locks.add(token);
    try { return await run(); } finally { locks.delete(token); }
  }

  async function list(parentKey) {
    if (typeof parentKey !== "string" || !KEY.test(parentKey)) fail("INVALID_RECOVERY", "A valid Zotero paper key is required.");
    const current = context();
    const state = await load(current);
    guard(current);
    return [...state.entries.values()].filter(value => value.parentKey === parentKey && !state.completed.has(value.id))
      .map(value => entry(value, current.serverId));
  }

  async function trash(value, write, read) {
    const current = context();
    let original = record(value, current.serverId);
    if (deleted(original) || original.annotationIsExternal || typeof write !== "function"
      || (read !== undefined && typeof read !== "function")) {
      fail("INVALID_RECOVERY", "An editable active annotation and a write callback are required.");
    }
    const item = plugin.itemForAttachment?.(original.parentItem);
    if (!KEY.test(item?.key || "")) fail("INVALID_RECOVERY", "This annotation is not part of the current Zotero paper library.");
    const parentKey = item.key;
    return locked(current, original.key, async () => {
      const state = await load(current);
      guard(current);
      const previous = state.entries.get(original.key);
      if (previous && !read) fail("RECOVERY_PENDING", "Refresh this annotation's Zotero state before retrying removal.");
      if (previous && (previous.parentKey !== parentKey || previous.record.parentItem !== original.parentItem)) {
        fail("INVALID_RECOVERY", "The annotation recovery identity changed. Refresh the paper.");
      }
      let observed;
      if (read) {
        observed = record(await read(cloneData(original)), current.serverId);
        guard(current);
        if (observed.key !== original.key || observed.parentItem !== original.parentItem
          || observed.version < original.version || observed.annotationIsExternal) {
          fail("CONFLICT", "This annotation changed in Zotero. Refresh and review it before removing.");
        }
        if (!deleted(observed)) {
          const fields = value => Object.fromEntries(Object.entries(value).filter(([name]) => name.startsWith("annotation")));
          if (!isDeepStrictEqual(fields(observed), fields(original))) {
            fail("CONFLICT", "This annotation changed in Zotero. Refresh and review it before removing.");
          }
          // A metadata-only version change is safe to retry. Persist the fresh
          // baseline and let the native version precondition protect the PATCH.
          original = observed;
        }
      }
      if (!previous && state.entries.size >= MAX_ENTRIES) fail("INVALID_RECOVERY", "The annotation recovery storage is full. Restore removed annotations before removing more.");
      const recovery = previous && deleted(observed) ? previous : {
        id: crypto.randomUUID(), serverId: current.serverId, parentKey, record: original,
        trashedRecord: null, status: "pending", createdAt: new Date().toISOString() };
      if (recovery !== previous) {
        state.entries.set(original.key, recovery);
        try { await persist(state, current); guard(current); }
        catch (error) {
          if (state.entries.get(original.key)?.id === recovery.id) {
            if (previous) state.entries.set(original.key, previous);
            else state.entries.delete(original.key);
          }
          throw error;
        }
      }
      // Keep pending recovery across uncertain results. A retry reads Zotero
      // first: an already-committed removal never sends a second native write.
      const result = observed && deleted(observed) ? observed : await write(entry(recovery, current.serverId));
      let saved;
      try {
        saved = record(result, current.serverId);
        if (saved.key !== original.key || saved.parentItem !== original.parentItem || !deleted(saved)) throw new Error();
      } catch {
        fail("WRITE_UNCERTAIN", "The annotation removal could not be verified. Refresh and retry, or restore it under Removed annotations.");
      }
      try {
        guard(current);
        recovery.trashedRecord = saved;
        recovery.status = "trashed";
        await persist(state, current);
        return { saved, warning: null, entry: entry(recovery, current.serverId) };
      } catch { return { saved, warning: TRASH_WARNING, entry: entry(recovery, current.serverId) }; }
    });
  }

  async function restore(value, write) {
    const current = context();
    const requested = entry(value, current.serverId);
    if (typeof write !== "function") fail("INVALID_RECOVERY", "An annotation restore callback is required.");
    return locked(current, requested.record.key, async () => {
      const state = await load(current);
      guard(current);
      const completed = state.completed.get(requested.id);
      if (completed) return { saved: record(completed.saved, current.serverId), warning: completed.warning };
      const recovery = state.entries.get(requested.record.key);
      if (!recovery || !isDeepStrictEqual(recovery, requested)) {
        fail("RECOVERY_CHANGED", "This annotation recovery entry changed. Refresh Removed annotations before restoring it.");
      }
      guard(current);
      const result = await write(entry(recovery, current.serverId));
      let saved;
      try {
        saved = record(result, current.serverId);
        if (saved.key !== recovery.record.key || saved.parentItem !== recovery.record.parentItem || deleted(saved)) throw new Error();
      } catch {
        fail("WRITE_UNCERTAIN", "The annotation restoration could not be verified. Refresh Removed annotations to reconcile it.");
      }
      // Keep a local completion receipt before disk cleanup. A cleanup failure
      // must never make a successful Restore call its native mutation again.
      const receipt = { saved, warning: RESTORE_WARNING };
      state.completed.set(recovery.id, receipt);
      state.entries.delete(recovery.record.key);
      // Receipts only prevent repeat calls in this instance. Missing or older
      // generations also reject, so their bounded cache can expire safely.
      if (state.completed.size > MAX_ENTRIES) state.completed.delete(state.completed.keys().next().value);
      try {
        guard(current);
        await persist(state, current);
        receipt.warning = null;
      } catch { /* The durable entry remains conservative for the next start. */ }
      return { saved, warning: receipt.warning };
    });
  }

  return Object.freeze({ list, trash, restore });
}

module.exports = { createAnnotationTrash };
