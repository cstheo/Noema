(function (scope) {
  "use strict";

  // Intentionally conservative: text, media, annotations, attributes with
  // meaning, and unrecognized markup are authored content, even without text.
  function isBlankHTML(html) {
    if (typeof html !== "string") return false;
    return html
      .replace(/<div(?:\s+data-schema-version=(?:"\d+"|'\d+'))?\s*>|<\/div\s*>|<p\s*>|<\/p\s*>|<br\s*\/?\s*>/gi, "")
      .replace(/&nbsp;|&#160;|&#x0*a0;/gi, "")
      .trim() === "";
  }

  function createRuntime(Zotero, template, reportError = () => {}) {
    if (!template || typeof template.html !== "string") throw new TypeError("Paper note template is required.");
    const html = `<h1>Paper review</h1>${template.html}`;
    const restorers = new Map();
    let active = true;
    let editorRestorer = null;

    function report(error) {
      try { reportError(error); } catch (_) { /* Logging must not break native creation. */ }
    }

    function parentOf(item) {
      if (item.parentItemID) return Zotero.Items.get(item.parentItemID);
      if (item.parentItemKey) return Zotero.Items.getByLibraryAndKey(item.libraryID, item.parentItemKey);
      return null;
    }

    function eligibleChild(item) {
      if (!item || !item.isNote() || item.deleted || !isBlankHTML(item.getNote())) return false;
      const parent = parentOf(item);
      if (!parent || !parent.isRegularItem() || parent.deleted || parent.libraryID !== item.libraryID) return false;
      const library = Zotero.Libraries.get(item.libraryID);
      return !!library && library.editable === true;
    }

    function wrap(target, name, makeWrapper) {
      if (!target || typeof target[name] !== "function") return null;
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      const original = target[name];
      const wrapper = makeWrapper(original);
      Object.defineProperty(target, name, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: wrapper });
      return () => {
        // Another addon may have wrapped ours. Disable our behavior on shutdown,
        // but never remove that addon's wrapper or replace its descriptor.
        if (target[name] !== wrapper) return;
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete target[name];
      };
    }

    function installEditor() {
      if (editorRestorer || !active) return;
      editorRestorer = wrap(Zotero.EditorInstance?.prototype, "init", original => function (options) {
        if (active) {
          try {
            const item = options?.item;
            // UI drafts only. Saved/imported/synced/preassigned objects and
            // resumed ProseMirror states must retain their native content.
            if (options?.readOnly === false && !options.disableUI && options.state == null
              && item && item.id == null && item.key == null && item.version == null && item.synced == null
              && eligibleChild(item)) item.setNote(html);
          } catch (error) { report(error); }
        }
        // Preserve this, all arguments, the original Promise, and rejection.
        return original.apply(this, arguments);
      });
    }

    function isBlankChildPopup(pane, args) {
      if (!args[0] || !args[1] || (args[2] != null && (typeof args[2] !== "string" || args[2].trim()))) return false;
      const libraryIDs = pane.getSelectedLibraryIDs();
      if (libraryIDs.length !== 1) return false;
      const parent = Zotero.Items.getByLibraryAndKey(libraryIDs[0], args[1]);
      return !!parent && parent.isRegularItem() && !parent.deleted;
    }

    function installWindow(window) {
      if (!active || restorers.has(window)) return;
      const pane = window?.ZoteroPane;
      const restore = wrap(pane, "newNote", original => function () {
        if (!active) return original.apply(this, arguments);
        const args = Array.from(arguments);
        let childPopup = false;
        try { childPopup = isBlankChildPopup(this, args); } catch (error) { report(error); }
        // In 10.0.5 the legacy popup path supplies a null item ID to Notes.open.
        // Create through the normal native path, then open the real note ID.
        if (childPopup) args[0] = false;
        const result = original.apply(this, args);
        return Promise.resolve(result).then(async itemID => {
          if (active && Number.isInteger(itemID) && itemID > 0) {
            try {
              // The ID comes directly from this UI creation call. Never scan
              // the library for empty notes or change existing blank notes.
              const item = Zotero.Items.get(itemID);
              if (eligibleChild(item)) {
                item.setNote(html);
                await item.saveTx({ notifierData: { autoSyncDelay: Zotero.Notes.AUTO_SYNC_DELAY } });
              }
            } catch (error) { report(error); }
          }
          if (childPopup && Number.isInteger(itemID) && itemID > 0) {
            try { await this.openNote(itemID, { openInWindow: true }); } catch (error) { report(error); }
            return null; // Native popup creation's return contract.
          }
          return itemID;
        });
      });
      if (restore) restorers.set(window, restore);
    }

    function uninstallWindow(window) {
      const restore = restorers.get(window);
      if (restore) restore();
      restorers.delete(window);
    }

    function shutdown() {
      active = false;
      for (const restore of restorers.values()) restore();
      restorers.clear();
      if (editorRestorer) editorRestorer();
      editorRestorer = null;
    }

    return Object.freeze({ html, installEditor, installWindow, uninstallWindow, shutdown });
  }

  const api = Object.freeze({ isBlankHTML, createRuntime });
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (scope) scope.NoemaNativePaperTemplate = api;
})(typeof globalThis === "object" ? globalThis : this);
