const VIEW = "noema-zotero-paper-notes";
const KEY = /^[A-Z0-9]{8}$/;
const { ZOTERO_COLORS } = require("./reader.js");
const { createAnnotationTrash } = require("./annotation-trash.js");
const paperNoteTemplate = require("./paper-note-template.js");

function escapeMarkdown(value) {
  return String(value || "").replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, "\\$&");
}

function passageMarkdown(item, source) {
  if (!KEY.test(source?.attachmentKey || "") || !String(source.text || "").trim()) throw new Error("Select a passage in this paper's PDF first.");
  if (source.annotationKey && !KEY.test(source.annotationKey)) throw new Error("The annotation identity is unavailable.");
  const page = Number.isInteger(source.pageIndex) && source.pageIndex >= 0 ? source.pageIndex + 1 : 1;
  const uri = `zotero://open-pdf/library/items/${source.attachmentKey}?${source.annotationKey ? `annotation=${source.annotationKey}` : `page=${page}`}`;
  const quote = String(source.text).trim().split(/\r?\n/).map(line => `> ${escapeMarkdown(line)}`).join("\n");
  const citation = `[${escapeMarkdown(item.title)} · p. ${escapeMarkdown(source.pageLabel || page)}](${uri})`;
  return `${quote}\n\n${citation}${source.comment ? `\n\n${escapeMarkdown(String(source.comment).trim())}` : ""}\n`;
}

function plainHTML(html) {
  return new DOMParser().parseFromString(html || "", "text/html").body.textContent || "";
}

function installPaperView(plugin) {
  const { ItemView, Modal, SuggestModal, Notice, setIcon, MarkdownRenderer, Component } = plugin.obsidian;
  plugin.noteTargets = new Map();
  plugin.annotationTrash = createAnnotationTrash(plugin);

  function button(parent, label, run, primary = false) {
    const el = parent.createEl("button", { text: label, cls: primary ? "mod-cta" : "", attr: { type: "button" } });
    el.addEventListener("click", async () => {
      el.disabled = true;
      try { await run(); } catch (error) { new Notice(error.message || "The shared note could not be updated."); }
      finally { if (el.isConnected) el.disabled = false; }
    });
    return el;
  }

  async function runAnnotationAction(record, write) {
    const saved = await plugin.withWrite(write, true);
    if (plugin.active === false || saved.serverId !== plugin.snapshot?.serverId) return saved;
    const item = plugin.itemForAttachment(record.parentItem);
    const applySaved = () => {
      if (plugin.active === false || saved.serverId !== plugin.snapshot?.serverId) return;
      const state = item && plugin.paperCache.get(item.key);
      if (state?.serverId === saved.serverId) {
        let found = false;
        state.annotations = state.annotations.flatMap(value => {
          if (value.key !== record.key) return [value];
          found = true;
          return value.version > saved.version ? [value] : saved.deleted ? [] : [saved];
        });
        if (!found && !saved.deleted) state.annotations.push(saved);
      }
      for (const view of plugin.paperViews) if (view.parentKey === item?.key) view.render();
    };
    // A committed write stays successful if a later refresh fails. Update the
    // visible cached mark first, then wait out older reads before fetching anew.
    applySaved();
    let refreshFailed = false;
    try { await plugin.refreshReaderAnnotations?.(record.parentItem); } catch { refreshFailed = true; }
    try {
      if (item) {
        try { await plugin.paperLoads?.get(item.key); } catch { /* Fetch fresh below. */ }
        applySaved();
        await plugin.refreshPaper(item.key);
      }
      for (const view of plugin.paperViews) if (view.parentKey === item?.key) view.render();
    } catch {
      refreshFailed = true; applySaved();
      try { await plugin.refreshReaderAnnotations?.(record.parentItem); } catch { /* The cached cards already reflect the save. */ }
    }
    if (refreshFailed) new Notice("Saved in Zotero. Refresh annotations to update the view.");
    return saved;
  }

  class AnnotationCommentModal extends Modal {
    constructor(record) { super(plugin.app); this.record = record; this.busy = false; this.closed = false; }
    onOpen() {
      this.modalEl.addClass("nz-annotation-modal");
      this.contentEl.createEl("h2", { text: "Annotation comment" });
      const input = this.contentEl.createEl("textarea", { cls: "nz-note-editor", attr: { "aria-label": "Annotation comment", placeholder: "Add a comment…" } });
      input.value = this.record.annotationComment || "";
      const status = this.contentEl.createDiv({ cls: "nz-note-warning", attr: { role: "status" } });
      const actions = this.contentEl.createDiv({ cls: "nz-note-buttons nz-annotation-modal-actions" });
      const controls = [];
      const run = async action => {
        if (this.busy || this.closed) return;
        this.busy = true; input.disabled = true; controls.forEach(control => { control.disabled = true; });
        status.setText("");
        try { await action(); if (!this.closed) this.close(); }
        catch (error) { if (!this.closed) status.setText(error.message || "The annotation could not be updated."); }
        finally {
          this.busy = false;
          if (!this.closed) { input.disabled = false; controls.forEach(control => { control.disabled = false; }); }
        }
      };
      const trash = button(actions, "Remove annotation", () => run(() => plugin.trashAnnotation(this.record)));
      trash.setAttribute("title", "Restore it later in Paper notes → Removed annotations");
      trash.addClass("nz-annotation-trash"); controls.push(trash);
      if (this.record.annotationComment) {
        const clear = button(actions, "Clear comment", () => run(() => runAnnotationAction(this.record,
          key => plugin.sharedClient().saveComment(this.record, "", key))));
        clear.setAttribute("title", "Remove the comment and keep the annotation"); controls.push(clear);
      }
      const trailing = actions.createDiv({ cls: "nz-annotation-modal-save" });
      controls.push(button(trailing, "Cancel", () => { if (!this.busy) this.close(); }));
      controls.push(button(trailing, "Save to Zotero", () => run(() => runAnnotationAction(this.record,
        key => plugin.sharedClient().saveComment(this.record, input.value, key))), true));
      input.focus();
    }
    onClose() { this.closed = true; this.contentEl.empty(); }
  }

  class NoteModal extends Modal {
    constructor(item, text = "") { super(plugin.app); this.item = item; this.text = text; this.serverId = plugin.snapshot?.serverId; this.previewRevision = 0; this.closed = false; }
    onOpen() {
      this.modalEl.addClass("nz-note-modal");
      this.contentEl.createEl("h2", { text: this.text ? "Add to paper note" : "New paper note" });
      this.contentEl.createDiv({ cls: "nz-composer-paper", text: this.item.title });
      const targetLabel = this.contentEl.createEl("label", { cls: "nz-composer-target", text: "Destination" });
      const target = targetLabel.createEl("select", { attr: { "aria-label": "Destination paper note" } });
      target.createEl("option", { text: "New reading note", value: "" });
      const existingNotes = plugin.mirrorsFor(this.item.key).filter(note => note.canPush && !note.conflictPath);
      for (const note of existingNotes) {
        const prefix = `${this.item.title} · `;
        target.createEl("option", { text: note.title.startsWith(prefix) ? note.title.slice(prefix.length) : note.title, value: note.path });
      }
      const name = this.contentEl.createEl("input", { cls: "nz-note-name", type: "text", value: "Reading notes", attr: { "aria-label": "Note title", placeholder: "Note title" } });
      if (this.text) {
        const preferred = plugin.noteTargets.get(this.item.key) || (existingNotes.length === 1 ? existingNotes[0].path : "");
        if (existingNotes.some(note => note.path === preferred)) target.value = preferred;
        name.hidden = !!target.value;
      }
      const tabs = this.contentEl.createDiv({ cls: "nz-composer-tabs", attr: { role: "tablist", "aria-label": "Note editor view" } });
      const writeTab = tabs.createEl("button", { text: "Write", attr: { type: "button", role: "tab", "aria-selected": "true" } });
      const previewTab = tabs.createEl("button", { text: "Preview", attr: { type: "button", role: "tab", "aria-selected": "false" } });
      const formatting = this.contentEl.createDiv({ cls: "nz-composer-format", attr: { role: "toolbar", "aria-label": "Markdown formatting" } });
      const input = this.contentEl.createEl("textarea", { cls: "nz-note-editor", attr: { "aria-label": "Paper note in Markdown", placeholder: "Summarize the finding, connect ideas, or record questions…" } });
      const drafts = { new: paperNoteTemplate.initialize(this.text), append: this.text };
      let draftKind = target.value ? "append" : "new";
      input.value = drafts[draftKind];
      target.addEventListener("change", () => {
        drafts[draftKind] = input.value;
        draftKind = target.value ? "append" : "new";
        input.value = drafts[draftKind];
        name.hidden = !!target.value;
        // A destination switch invalidates any pending rendered preview.
        ++this.previewRevision;
        input.hidden = false; formatting.hidden = false; preview.hidden = true;
        writeTab.setAttribute("aria-selected", "true"); previewTab.setAttribute("aria-selected", "false");
      });
      const insert = (prefix, suffix = "", fallback = "text") => {
        const start = input.selectionStart, end = input.selectionEnd;
        const selected = input.value.slice(start, end) || fallback;
        input.setRangeText(`${prefix}${selected}${suffix}`, start, end, "select");
        input.focus();
      };
      for (const [label, prefix, suffix, fallback] of [
        ["Bold", "**", "**", "text"], ["Italic", "*", "*", "text"],
        ["Heading", "## ", "", "Heading"], ["List", "- ", "", "Idea"],
        ["Quote", "> ", "", "Passage"], ["Link", "[", "](https://)", "Source"]
      ]) button(formatting, label, () => insert(prefix, suffix, fallback));
      const preview = this.contentEl.createDiv({ cls: "nz-composer-preview markdown-rendered" });
      preview.hidden = true;
      this.component = new Component(); this.component.load();
      writeTab.addEventListener("click", () => {
        ++this.previewRevision; input.hidden = false; formatting.hidden = false; preview.hidden = true;
        writeTab.setAttribute("aria-selected", "true"); previewTab.setAttribute("aria-selected", "false"); input.focus();
      });
      previewTab.addEventListener("click", async () => {
        const revision = ++this.previewRevision;
        input.hidden = true; formatting.hidden = true; preview.hidden = false;
        writeTab.setAttribute("aria-selected", "false"); previewTab.setAttribute("aria-selected", "true");
        const rendered = document.createElement("div");
        try {
          await MarkdownRenderer.render(plugin.app, input.value || "*Your note preview will appear here.*", rendered, target.value || plugin.fieldCatalog?.directory(null) || "", this.component);
          if (!this.closed && revision === this.previewRevision) preview.replaceChildren(...rendered.childNodes);
        } catch (error) { if (!this.closed && revision === this.previewRevision) preview.setText(error.message); }
      });
      const status = this.contentEl.createDiv({ cls: "nz-note-warning", attr: { role: "status" } });
      const actions = this.contentEl.createDiv({ cls: "nz-note-buttons" });
      button(actions, "Cancel", () => this.close());
      button(actions, "Save & open note", async () => {
        try {
          plugin.ensureActive();
          if (plugin.snapshot?.serverId !== this.serverId) throw new Error("The Zotero database changed. Reopen this paper before saving the note.");
          const entry = target.value ? await plugin.appendToPaperNote(this.item.key, target.value, input.value) : await plugin.createNoteDraft(this.item, name.value, input.value);
          plugin.noteTargets.set(this.item.key, entry.path);
          this.close();
          for (const view of plugin.paperViews) if (view.parentKey === this.item.key) view.render();
        } catch (error) { status.setText(error.message); }
      }, true);
      input.focus();
    }
    onClose() { this.closed = true; ++this.previewRevision; this.component?.unload(); this.contentEl.empty(); }
  }

  class ArchivedNoteModal extends Modal {
    constructor(entry) { super(plugin.app); this.entry = entry; this.closed = false; }
    async onOpen() {
      this.modalEl.addClass("nz-note-modal");
      this.contentEl.createEl("h2", { text: this.entry.title || "Archived paper note" });
      this.contentEl.createDiv({ cls: "nz-note-message", text: "Deleted in Zotero. This archived copy is read-only; saving a local copy does not recreate a Zotero note." });
      const body = this.contentEl.createDiv({ cls: "nz-composer-preview markdown-rendered" });
      const status = this.contentEl.createDiv({ cls: "nz-note-warning" });
      this.component = new Component(); this.component.load();
      try {
        const local = await plugin.readArchivedNote(this.entry);
        if (this.closed) return;
        await MarkdownRenderer.render(plugin.app, local.body, body, this.entry.path, this.component);
        if (this.closed) return;
        const actions = this.contentEl.createDiv({ cls: "nz-note-buttons" });
        button(actions, "Save local copy", async () => { await plugin.saveArchivedCopy(this.entry); this.close(); }, true);
        button(actions, "Close", () => this.close());
      } catch (error) { if (!this.closed) status.setText(error.message); }
    }
    onClose() { this.closed = true; this.component?.unload(); this.contentEl.empty(); }
  }

  class MarkModal extends Modal {
    constructor(record) { super(plugin.app); this.record = record; }
    onOpen() {
      this.contentEl.createEl("h2", { text: "Edit Zotero mark" });
      let color = (this.record.annotationColor || "#ffd400").toLowerCase();
      const palette = this.contentEl.createDiv({ cls: "nz-reader-colors nz-mark-colors", attr: { role: "radiogroup", "aria-label": "Zotero annotation color" } });
      const swatches = ZOTERO_COLORS.map(value => {
        const swatch = palette.createEl("button", { cls: "nz-reader-color", attr: { type: "button", role: "radio", "aria-label": value.name, title: value.name } });
        swatch.style.setProperty("--nz-color", value.color);
        swatch.addEventListener("click", () => { color = value.color; update(); });
        swatch.addEventListener("keydown", event => {
          const index = swatches.indexOf(swatch);
          const next = { ArrowRight: (index + 1) % swatches.length, ArrowDown: (index + 1) % swatches.length, ArrowLeft: (index + swatches.length - 1) % swatches.length, ArrowUp: (index + swatches.length - 1) % swatches.length, Home: 0, End: swatches.length - 1 }[event.key];
          if (next === undefined) return;
          event.preventDefault(); color = ZOTERO_COLORS[next].color; update(); swatches[next].focus();
        });
        return swatch;
      });
      const update = () => swatches.forEach((swatch, index) => {
        const selected = ZOTERO_COLORS[index].color === color;
        swatch.setAttribute("aria-checked", String(selected)); swatch.tabIndex = selected ? 0 : -1;
      });
      update();
      const label = this.contentEl.createEl("label", { cls: "nz-composer-target", text: "Mark type" });
      const type = label.createEl("select", { attr: { "aria-label": "Zotero mark type" } });
      type.createEl("option", { value: "highlight", text: "Highlight" });
      type.createEl("option", { value: "underline", text: "Underline" });
      type.value = this.record.annotationType;
      const status = this.contentEl.createDiv({ cls: "nz-note-warning", attr: { role: "status" } });
      const actions = this.contentEl.createDiv({ cls: "nz-note-buttons" });
      button(actions, "Cancel", () => this.close());
      button(actions, "Save to Zotero", async () => {
        try {
          await plugin.withWrite(key => plugin.sharedClient().saveAnnotationStyle(this.record, { color, type: type.value }, key), true);
          const item = plugin.itemForAttachment(this.record.parentItem);
          if (item) await plugin.refreshPaper(item.key);
          plugin.refreshReaderAnnotations?.();
          for (const view of plugin.paperViews) if (view.parentKey === item?.key) view.render();
          this.close();
        } catch (error) { status.setText(error.message); }
      }, true);
    }
    onClose() { this.contentEl.empty(); }
  }

  class FieldModal extends SuggestModal {
    constructor(parentKey) { super(plugin.app); this.parentKey = parentKey; this.setPlaceholder("Choose a paper field…"); }
    getSuggestions(query) {
      return [{ name: "Use Zotero mapping", id: undefined }, { name: "Unfiled", id: "" }, ...plugin.fieldCatalog.fields]
        .filter(field => `${field.name} ${field.id || ""}`.toLowerCase().includes(query.toLowerCase()));
    }
    renderSuggestion(field, el) { el.setText(field.name); }
    async onChooseSuggestion(field) {
      try { await plugin.classifyPaper(this.parentKey, field.id); }
      catch (error) { new Notice(error.message); }
    }
  }

  class PaperView extends ItemView {
    constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.parentKey = ""; this.message = ""; this.loading = false; this.removed = []; }
    getViewType() { return VIEW; }
    getDisplayText() { return `${this.item()?.title || "Paper"} · Notes`; }
    getIcon() { return "notebook-pen"; }
    item() { return this.plugin.snapshot?.items.find(item => item.key === this.parentKey); }
    getState() { return { parentKey: this.parentKey }; }
    async setState(state, result) {
      this.parentKey = KEY.test(state?.parentKey || "") ? state.parentKey : "";
      this.removed = [];
      await super.setState(state, result);
      if (this.parentKey) await this.refresh();
    }
    async onOpen() {
      this.contentEl.addClass("nz-paper-notes");
      this.plugin.paperViews.add(this);
      this.registerInterval(window.setInterval(() => this.refresh(), 30000));
      this.render();
    }
    async onClose() { this.plugin.paperViews.delete(this); }
    async refreshRemoved() {
      const parentKey = this.parentKey, serverId = this.plugin.snapshot?.serverId;
      const removed = await this.plugin.annotationTrash.list(parentKey);
      if (this.parentKey !== parentKey || this.plugin.snapshot?.serverId !== serverId) return;
      this.removed = removed;
      if (this.plugin.active !== false) this.render();
    }
    async refresh() {
      if (!this.parentKey || this.loading) return;
      this.loading = true;
      try {
        await this.refreshRemoved();
        await this.plugin.refreshPaper(this.parentKey);
        this.message = "";
      } catch (error) { this.message = error.message; }
      finally { this.loading = false; if (this.plugin.active) this.render(); }
    }
    render() {
      const root = this.contentEl;
      root.empty();
      const item = this.item();
      if (!item) { root.createDiv({ text: "Open a paper from My Library to view its notes.", cls: "nz-empty" }); return; }
      const header = root.createDiv({ cls: "nz-notes-header" });
      header.createEl("h1", { text: item.title });
      const actions = header.createDiv({ cls: "nz-note-buttons" });
      button(actions, "New note", () => new NoteModal(item).open(), true);
      button(actions, "Refresh", () => this.refresh());
      button(actions, "Sync notes", async () => {
        await this.plugin.syncPaperNotes(item.key, true);
        await this.refresh();
      });
      const zotero = actions.createEl("a", { text: "Open in Zotero ↗", href: this.plugin.zoteroUri(item.key) });
      zotero.addClass("nz-note-zotero");
      const automatic = this.plugin.writeKey && this.plugin.writeRemember;
      actions.createSpan({ cls: "nz-sync-state", text: automatic ? "Auto sync" : this.plugin.writeKey ? "Manual sync" : "Local only",
        attr: { title: automatic ? "Saved notes sync automatically to Zotero." : this.plugin.writeKey ? "Use Sync notes for the current one-time authorization." : "Notes are saved locally. Enable writeback to share them with Zotero." } });
      if (!this.plugin.writeKey) button(actions, "Enable writeback", () => this.plugin.enableWriteback());
      if (this.plugin.fieldCatalog) {
        const filing = root.createDiv({ cls: "nz-field-picker" });
        filing.createSpan({ text: "Field" });
        const classification = this.plugin.paperField(item.key);
        const choose = button(filing, this.plugin.fieldCatalog.get(classification.field)?.name || "Unfiled", () => new FieldModal(item.key).open());
        choose.setAttribute("aria-label", "Choose paper field");
        filing.createSpan({ cls: "nz-sync-state", text: classification.reason });
      }
      if (this.message) root.createDiv({ cls: "nz-note-warning", text: this.message, attr: { role: "status" } });
      const state = this.plugin.paperCache.get(item.key);
      root.createEl("h2", { text: "Notes" });
      const notes = this.plugin.mirrorsFor(item.key);
      if (!notes.length) root.createDiv({ cls: "nz-note-empty", text: "No notes yet." });
      for (const note of notes) {
        const card = root.createDiv({ cls: "nz-shared-note" });
        const heading = card.createDiv({ cls: "nz-note-heading" });
        button(heading, note.title || "Paper note", () => this.plugin.openMirror(note.path));
        const remove = button(heading, "Delete note", () => this.plugin.trashPaperNote(note));
        remove.addClass("nz-note-delete");
        remove.setAttribute("aria-label", "Delete paper note");
        remove.setAttribute("title", note.draft ? "Archive this local draft and move it to Obsidian Trash" : "Move this note to Zotero Trash and archive its local copy");
        if (note.pendingCreation || note.pendingKey) {
          remove.disabled = true;
          remove.setAttribute("title", "Refresh and confirm this note's creation before deleting it");
        }
        card.createDiv({ cls: "nz-note-preview", text: note.preview });
        if (note.message) card.createDiv({ cls: "nz-note-warning", text: note.message });
        if (note.conflictPath) button(card, "Open Zotero version", () => this.plugin.openMirror(note.conflictPath));
        if (note.conflictPath) {
          const choices = card.createDiv({ cls: "nz-note-buttons" });
          button(choices, "Keep Noema version", () => this.plugin.resolveNoteConflict(note, "local"));
          button(choices, "Use Zotero version", () => this.plugin.resolveNoteConflict(note, "remote"));
        }
      }
      const removedNotes = this.plugin.deletedMirrorsFor?.(item.key) || [];
      if (removedNotes.length) {
        const removed = root.createEl("details", { cls: "nz-removed-notes" });
        removed.createEl("summary", { text: `Removed notes (${removedNotes.length})` });
        removed.createDiv({ cls: "nz-note-message", text: "If the note is in Zotero’s Trash, restore it there and refresh this paper to sync it back." });
        for (const note of removedNotes) {
          const card = removed.createDiv({ cls: "nz-shared-note" });
          card.createEl("strong", { text: note.title || "Paper note" });
          card.createDiv({ cls: "nz-note-preview", text: note.preview || "" });
          card.createDiv({ cls: "nz-note-warning", text: note.message || "Deleted in Zotero. Your local copy is archived." });
          if (note.archiveId) button(card, "Open archived copy", () => new ArchivedNoteModal(note).open());
        }
      }
      root.createEl("h2", { text: "Annotations" });
      const annotations = state?.annotations || [];
      if (!annotations.length) root.createDiv({ cls: "nz-note-empty", text: "No annotations yet." });
      for (const record of annotations) {
        const card = root.createDiv({ cls: "nz-shared-annotation" });
        if (/^#[0-9a-f]{6}$/i.test(record.annotationColor || "")) card.style.setProperty("--nz-mark-color", record.annotationColor);
        const meta = card.createDiv({ cls: "nz-annotation-meta" });
        meta.createSpan({ text: `Page ${record.annotationPageLabel || (record.position?.pageIndex ?? 0) + 1} · ${record.annotationType}` });
        const link = meta.createEl("a", { href: `zotero://open-pdf/library/items/${record.parentItem}?annotation=${record.key}`, attr: { title: "Show annotation in Zotero", "aria-label": "Show annotation in Zotero" } });
        setIcon(link, "external-link");
        if (record.annotationText) card.createEl("blockquote", { text: record.annotationText });
        if (record.annotationComment) card.createDiv({ cls: "nz-annotation-comment", text: record.annotationComment });
        const controls = card.createDiv({ cls: "nz-note-buttons nz-annotation-actions" });
        button(controls, record.annotationComment ? "Edit comment" : "Add comment", () => this.plugin.editAnnotationComment(record));
        if (["highlight", "underline"].includes(record.annotationType)) button(controls, "Edit color / type", () => new MarkModal(record).open());
        if (record.annotationText) button(controls, "Add to note", () => new NoteModal(item, passageMarkdown(item, {
          attachmentKey: record.parentItem, annotationKey: record.key, text: record.annotationText,
          comment: record.annotationComment, pageLabel: record.annotationPageLabel, pageIndex: record.position?.pageIndex
        })).open());
        const trash = button(controls, "Remove", () => this.plugin.trashAnnotation(record));
        trash.addClass("nz-annotation-trash"); trash.setAttribute("aria-label", "Remove annotation");
        trash.setAttribute("title", "Restore it later in Removed annotations");
      }
      if (this.removed.length) {
        const removed = root.createEl("details", { cls: "nz-removed-notes" });
        removed.createEl("summary", { text: `Removed annotations (${this.removed.length})` });
        for (const entry of this.removed) {
          const card = removed.createDiv({ cls: "nz-removed-annotation" });
          card.createSpan({ text: entry.record.annotationText || entry.record.annotationComment || `Page ${entry.record.annotationPageLabel || (entry.record.position?.pageIndex ?? 0) + 1} · ${entry.record.annotationType}` });
          button(card, "Restore", () => this.plugin.restoreAnnotation(entry));
        }
      }
    }
  }

  plugin.registerView(VIEW, leaf => new PaperView(leaf, plugin));
  plugin.openPaperNotes = async key => {
    const item = plugin.snapshot?.items.find(item => item.key === key || item.attachments.some(attachment => attachment.key === key));
    if (!item) { new Notice("This PDF is not part of the current Zotero library."); return; }
    const workspace = plugin.app.workspace;
    const group = workspace.getMostRecentLeaf()?.parent;
    const existing = workspace.getLeavesOfType(VIEW).find(leaf => leaf.parent === group && leaf.view.parentKey === item.key);
    if (existing) { await workspace.revealLeaf(existing); await existing.view.refresh(); }
    else await workspace.getLeaf("tab").setViewState({ type: VIEW, state: { parentKey: item.key }, active: true });
  };
  plugin.trashAnnotation = async record => {
    let recovery;
    try {
      const saved = await runAnnotationAction(record, async key => {
        const client = plugin.sharedClient();
        recovery = await plugin.annotationTrash.trash(record,
          pending => client.trashAnnotation(pending.record, key),
          current => client.getAnnotation(current));
        return recovery.saved;
      });
      new Notice(recovery.warning || "Annotation removed. Restore it in Paper notes → Removed annotations.");
      return saved;
    } finally {
      for (const view of plugin.paperViews) {
        try { await view.refreshRemoved?.(); } catch { /* The recovery file stays available for the next refresh. */ }
      }
    }
  };
  plugin.restoreAnnotation = async entry => {
    let recovery;
    try {
      const saved = await runAnnotationAction(entry.record, async key => {
        recovery = await plugin.annotationTrash.restore(entry, async () => {
          const client = plugin.sharedClient();
          const current = await client.getAnnotation(entry.record);
          if (!current.deleted) return current;
          const expected = entry.trashedRecord || entry.record;
          for (const name of Object.keys(expected).filter(name => name.startsWith("annotation"))) {
            if (current[name] !== expected[name]) throw new Error("This annotation changed in Zotero. Refresh and review it before restoring.");
          }
          return client.restoreAnnotation(current, key);
        });
        return recovery.saved;
      });
      new Notice(recovery.warning || "Annotation restored in Zotero.");
      return saved;
    } finally {
      for (const view of plugin.paperViews) {
        try { await view.refreshRemoved?.(); } catch { /* Retry the local recovery list on refresh. */ }
      }
    }
  };
  plugin.editAnnotationComment = record => new AnnotationCommentModal(record).open();
  plugin.addSelectionToNote = async captured => {
    const item = plugin.itemForAttachment(captured?.key);
    if (!item) throw new Error("This PDF is not part of the current Zotero library.");
    await plugin.initializeShared();
    new NoteModal(item, passageMarkdown(item, {
      attachmentKey: captured.key, text: captured.payload.text,
      pageLabel: captured.payload.pageLabel, pageIndex: captured.payload.position.pageIndex
    })).open();
  };
  return { VIEW };
}

module.exports = { installPaperView, plainHTML, passageMarkdown };
