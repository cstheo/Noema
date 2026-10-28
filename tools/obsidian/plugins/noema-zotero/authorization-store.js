"use strict";

const API_KEY = /^[A-Za-z0-9]{32}$/;
const MAX_SERVER_ID_LENGTH = 256;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function storageUnavailable() {
  return failure("AUTHORIZATION_STORAGE_UNAVAILABLE", "Obsidian secret storage is unavailable or locked. Authorization can only be remembered for this session.");
}

function validateKey(key) {
  if (typeof key !== "string" || key.length !== 32 || !API_KEY.test(key)) {
    throw failure("AUTHORIZATION_KEY_INVALID", "The Zotero authorization credential is invalid. Authorize Noema again.");
  }
  return key;
}

// Credentials are held only by Obsidian's public secretStorage API. Its
// synchronous methods keep the active-library checks around each operation.
function createAuthorizationStore(plugin) {
  function guard(serverId) {
    plugin.ensureActive();
    if (typeof serverId !== "string" || !serverId.trim() || serverId.length > MAX_SERVER_ID_LENGTH) {
      throw failure("AUTHORIZATION_SERVER_INVALID", "A valid Zotero server identity is required for authorization.");
    }
    if (plugin.snapshot?.serverId !== serverId) {
      throw failure("AUTHORIZATION_SERVER_CHANGED", "The Zotero database changed during authorization. Refresh My Library first.");
    }
  }

  function storage(serverId) {
    guard(serverId);
    let value;
    try {
      value = plugin.app?.secretStorage;
      if (!value || ["getSecret", "setSecret", "deleteSecret"].some(method => typeof value[method] !== "function")) {
        throw storageUnavailable();
      }
    } catch {
      guard(serverId);
      throw storageUnavailable();
    }
    guard(serverId);
    return value;
  }

  function secretId(serverId) {
    return `nz-${Buffer.from(serverId, "utf8").toString("hex")}`;
  }

  function call(value, method, serverId, ...args) {
    guard(serverId);
    let result, failed = false;
    try { result = value[method](secretId(serverId), ...args); }
    catch { failed = true; }
    guard(serverId);
    if (failed) throw storageUnavailable();
    return result;
  }

  function storedKey(value, serverId) {
    const key = call(value, "getSecret", serverId);
    return key === null ? null : validateKey(key);
  }

  return {
    load(serverId) {
      return storedKey(storage(serverId), serverId);
    },
    save(serverId, key) {
      guard(serverId);
      validateKey(key);
      call(storage(serverId), "setSecret", serverId, key);
    },
    remove(serverId, expectedKey) {
      guard(serverId);
      if (expectedKey !== undefined) validateKey(expectedKey);
      const value = storage(serverId);
      // An explicit Forget action also needs to clear a malformed saved value.
      // Conditional removal protects a replacement grant from an older 401.
      if (expectedKey !== undefined) {
        const key = storedKey(value, serverId);
        if (key !== expectedKey) return false;
      }
      const removed = call(value, "deleteSecret", serverId);
      if (typeof removed !== "boolean") throw storageUnavailable();
      return removed;
    }
  };
}

module.exports = { createAuthorizationStore };
