"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SERVER = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 2 * 1024 * 1024;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function createNoteArchive(plugin, { filesystem = fs } = {}) {
  function context() {
    if (plugin.active !== true) fail("PLUGIN_DISABLED", "The Zotero bridge was disabled.");
    plugin.ensureActive?.();
    const serverId = plugin.snapshot?.serverId;
    if (typeof serverId !== "string" || !SERVER.test(serverId)) fail("SERVER_CHANGED", "Open Zotero and refresh My Library first.");
    const storageRoot = plugin.storageReal;
    if (typeof storageRoot !== "string" || !path.isAbsolute(storageRoot) || path.resolve(storageRoot) !== storageRoot) {
      fail("INVALID_ARCHIVE", "The note archive storage is unavailable.");
    }
    const shared = path.join(storageRoot, "shared");
    const partition = path.join(shared, serverId);
    const folder = path.join(partition, "deleted-notes");
    const ancestors = [];
    let current = path.parse(storageRoot).root;
    ancestors.push(current);
    for (const part of storageRoot.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      ancestors.push(current);
    }
    return { serverId, storageRoot, shared, partition, folder, directories: [...ancestors, shared, partition, folder],
      rootIndex: ancestors.length - 1 };
  }

  function guard(current) {
    if (plugin.active !== true) fail("PLUGIN_DISABLED", "The Zotero bridge was disabled.");
    plugin.ensureActive?.();
    if (plugin.snapshot?.serverId !== current.serverId || plugin.storageReal !== current.storageRoot) {
      fail("SERVER_CHANGED", "The Zotero database changed. Refresh the paper before archiving its note.");
    }
  }

  async function directories(current, { missing = false, cleanup = false } = {}) {
    for (let index = 0; index < current.directories.length; index++) {
      if (!cleanup) guard(current);
      const folder = current.directories[index];
      let info;
      try { info = await filesystem.lstat(folder); }
      catch (error) { if (missing && index > current.rootIndex && error.code === "ENOENT") return false; throw error; }
      if (!cleanup) guard(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fail("INVALID_ARCHIVE", "Note archive folders must be real directories inside Zotero storage.");
      const resolved = await filesystem.realpath(folder);
      if (!cleanup) guard(current);
      if (resolved !== folder) fail("INVALID_ARCHIVE", "Note archive folders must remain inside Zotero storage.");
    }
    return true;
  }

  async function regularFile(current, file) {
    await directories(current);
    const info = await filesystem.lstat(file);
    guard(current);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES) {
      fail("INVALID_ARCHIVE", "The archived note must be a regular file within the 2 MiB limit. It was kept.");
    }
    const resolved = await filesystem.realpath(file);
    guard(current);
    if (resolved !== file) fail("INVALID_ARCHIVE", "The archived note must remain inside Zotero storage. It was kept.");
    return info;
  }

  async function syncFile(current, file) {
    const expected = await regularFile(current, file);
    const handle = await filesystem.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = await handle.stat();
      guard(current);
      await directories(current);
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size) {
        fail("INVALID_ARCHIVE", "The note archive changed before it could be saved. Your note was kept.");
      }
      await handle.sync();
      guard(current);
      return actual;
    } finally { await handle.close(); }
  }

  async function save(source) {
    const current = context();
    if (typeof source !== "string") fail("INVALID_ARCHIVE", "The note archive requires the original Markdown text.");
    if (source.length > MAX_BYTES) fail("INVALID_ARCHIVE", "The note archive exceeds the 2 MiB limit. Your note was kept.");
    const bytes = Buffer.from(source, "utf8");
    if (bytes.length > MAX_BYTES || bytes.toString("utf8") !== source) {
      fail("INVALID_ARCHIVE", "The note archive requires valid UTF-8 Markdown within the 2 MiB limit. Your note was kept.");
    }
    await directories(current, { missing: true });
    for (const folder of [current.shared, current.partition, current.folder]) {
      guard(current);
      try { await filesystem.mkdir(folder, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      await directories(current, { missing: true });
    }
    await directories(current);
    const id = crypto.randomUUID();
    const file = path.join(current.folder, `${id}.md`);
    const temporary = path.join(current.folder, `${id}.${crypto.randomUUID()}.tmp`);
    try {
      guard(current);
      await filesystem.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      const synced = await syncFile(current, temporary);
      if (synced.size !== bytes.length) fail("INVALID_ARCHIVE", "The note archive source changed before it could be saved. Your note was kept.");
      await directories(current);
      guard(current);
      // Exclusive publication avoids overwriting even an existing UUID archive.
      // The temporary file and final name refer to the same synced inode.
      await filesystem.link(temporary, file);
      const published = await regularFile(current, file);
      if (published.dev !== synced.dev || published.ino !== synced.ino || published.size !== synced.size) {
        fail("INVALID_ARCHIVE", "The note archive source changed during publication. Your note was kept.");
      }
      const handle = await filesystem.open(current.folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directories(current); await handle.sync(); guard(current); }
      finally { await handle.close(); }
      guard(current);
      if (await read(id) !== source) fail("INVALID_ARCHIVE", "The note archive source changed before confirmation. Your note was kept.");
      guard(current);
      return id;
    } finally {
      try {
        // Only temporary names are cleaned. Archives survive every failure,
        // including a lifecycle change after their atomic publication.
        await directories(current, { cleanup: true });
        await filesystem.unlink(temporary);
      } catch { /* Never follow a substituted directory to clean a temp file. */ }
      guard(current);
    }
  }

  async function read(id) {
    if (typeof id !== "string" || !UUID.test(id)) fail("INVALID_ARCHIVE", "A valid note archive identity is required.");
    const current = context();
    const file = path.join(current.folder, `${id}.md`);
    const expected = await regularFile(current, file);
    const handle = await filesystem.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = await handle.stat();
      guard(current);
      await directories(current);
      if (!actual.isFile() || actual.size > MAX_BYTES || actual.dev !== expected.dev || actual.ino !== expected.ino) {
        fail("INVALID_ARCHIVE", "The archived note changed while opening it. It was kept.");
      }
      // Bound the read itself, including a file that grows after its stat.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        guard(current);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) fail("INVALID_ARCHIVE", "The archived note exceeds the 2 MiB limit. It was kept.");
      const published = await regularFile(current, file);
      if (published.dev !== actual.dev || published.ino !== actual.ino) {
        fail("INVALID_ARCHIVE", "The archived note changed while reading it. It was kept.");
      }
      guard(current);
      const bytes = buffer.subarray(0, length);
      const source = bytes.toString("utf8");
      if (!Buffer.from(source, "utf8").equals(bytes)) fail("INVALID_ARCHIVE", "The archived note is not valid UTF-8 Markdown. It was kept.");
      return source;
    } finally { await handle.close(); guard(current); }
  }

  return Object.freeze({ save, read });
}

module.exports = { createNoteArchive };
