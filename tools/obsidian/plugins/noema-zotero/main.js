const obsidian = require("obsidian");
const { Plugin, ItemView, MarkdownRenderChild, Notice, SuggestModal, setIcon } = obsidian;
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { createRequire } = require("node:module");
const { Buffer } = require("node:buffer");

const VIEW = "noema-zotero-library";
const KEY = /^[A-Z0-9]{8}$/;
const PAGE_SIZE = 50;

function icon(parent, name, className = "nz-icon") {
  const el = parent.createSpan({ cls: className });
  setIcon(el, name);
  return el;
}

function action(parent, label, callback, iconName, className = "") {
  const button = parent.createEl("button", { cls: `nz-action ${className}`, attr: { type: "button", "aria-label": label, title: label } });
  if (iconName) icon(button, iconName);
  button.createSpan({ text: label });
  button.addEventListener("click", callback);
  return button;
}

function pdfs(item) {
  return (item.attachments || []).filter(attachment => attachment.contentType === "application/pdf");
}

function itemTags(item) {
  return [...new Set((Array.isArray(item.tags) ? item.tags : []).filter(value =>
    typeof value === "string" && value.length <= 1024 && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value)))];
}

class PdfPicker extends SuggestModal {
  constructor(app, attachments, open) {
    super(app);
    this.attachments = attachments;
    this.openAttachment = open;
    this.setPlaceholder("Choose a PDF attachment…");
  }
  getSuggestions(query) {
    return this.attachments.filter(a => a.title.toLowerCase().includes(query.toLowerCase()));
  }
  renderSuggestion(attachment, el) { el.setText(attachment.title || attachment.key); }
  onChooseSuggestion(attachment) { this.openAttachment(attachment); }
}

class LibraryView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.collection = "";
    this.query = "";
    this.tags = [];
    this.tagMode = "all";
    this.tagQuery = "";
    this.pdfOnly = false;
    this.descendants = true;
    this.sort = "title";
    this.direction = "asc";
    this.page = 0;
    this.expanded = new Set();
  }
  getViewType() { return VIEW; }
  getDisplayText() { return "Zotero · My Library"; }
  getIcon() { return "library"; }
  async onOpen() {
    this.contentEl.addClass("nz-library");
    this.plugin.views.add(this);
    this.render();
    await this.plugin.refresh();
  }
  async onClose() { this.plugin.views.delete(this); }
  getState() { return this.plugin.libraryQuery.normalizeState(this); }
  async setState(state, result) {
    Object.assign(this, this.plugin.libraryQuery.normalizeState(state));
    this.page = 0;
    this.render();
    await super.setState(state, result);
  }
  saveState() { this.plugin.app.workspace.requestSaveLayout?.(); }
  render() {
    const root = this.contentEl;
    root.empty();
    const snapshot = this.plugin.snapshot;
    if (snapshot && this.collection && !snapshot.collections.some(c => c.key === this.collection)) this.collection = "";
    if (snapshot) {
      const availableTags = new Set(snapshot.items.flatMap(itemTags));
      this.tags = this.tags.filter(tag => availableTags.has(tag));
    }
    const header = root.createDiv({ cls: "nz-header" });
    const intro = header.createDiv({ cls: "nz-intro" });
    const heading = intro.createEl("h1", { text: "My Library" });
    const count = snapshot?.items?.length || 0;
    const pdfCount = snapshot?.items?.filter(i => pdfs(i).length > 0).length || 0;
    heading.title = snapshot ? `${count.toLocaleString()} items · ${pdfCount.toLocaleString()} with PDFs · ${snapshot.collections.length} collections` : "Zotero library";
    const controls = header.createDiv({ cls: "nz-header-actions" });
    const state = this.plugin.syncing ? "Refreshing" : this.plugin.error ? "Cached" : snapshot ? "Local" : "Not connected";
    if (this.plugin.syncing || this.plugin.error || !snapshot) controls.createSpan({ cls: `nz-status ${this.plugin.error ? "is-cached" : ""}`, text: state });
    const refresh = action(controls, "Refresh", () => this.plugin.refresh(true), "refresh-cw");
    refresh.disabled = this.plugin.syncing;
    if (this.plugin.error) {
      const status = root.createDiv({ cls: "nz-connection", attr: { role: "status" } });
      status.setText(`${this.plugin.error}${snapshot ? " Showing the last saved library." : ""}`);
    } else if (snapshot) {
      refresh.title = `Refresh library · Updated ${new Date(snapshot.fetchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    }
    if (!snapshot) {
      root.createDiv({ cls: "nz-empty", text: this.plugin.syncing ? "Loading your library…" : "Open Zotero, then choose Refresh. Its local API must be enabled in Settings → Advanced." });
      return;
    }
    const layout = root.createDiv({ cls: "nz-layout" });
    this.treeEl = layout.createEl("nav", { cls: "nz-tree", attr: { "aria-label": "Zotero collections" } });
    this.renderTree();
    const main = layout.createDiv({ cls: "nz-main" });
    const toolbar = main.createDiv({ cls: "nz-toolbar" });
    const searchWrap = toolbar.createDiv({ cls: "nz-search" });
    icon(searchWrap, "search");
    const search = searchWrap.createEl("input", { type: "search", placeholder: "Search papers, authors or Zotero tags…", attr: { "aria-label": "Search papers" } });
    search.value = this.query;
    search.addEventListener("input", () => { this.query = search.value; this.page = 0; this.renderResults(); this.saveState(); });
    const tools = toolbar.createDiv({ cls: "nz-toolbar-controls" });
    this.tagsMenu = null;
    if (snapshot.items.some(item => itemTags(item).length)) this.renderTagMenu(tools);
    const filter = tools.createEl("select", { attr: { "aria-label": "PDF availability" } });
    filter.createEl("option", { text: "All items", value: "all" });
    filter.createEl("option", { text: "With PDF", value: "pdf" });
    filter.value = this.pdfOnly ? "pdf" : "all";
    filter.addEventListener("change", () => { this.pdfOnly = filter.value === "pdf"; this.page = 0; this.renderResults(); this.saveState(); });
    const order = tools.createDiv({ cls: "nz-sort-controls" });
    const sort = order.createEl("select", { attr: { "aria-label": "Sort papers", title: "Sort papers" } });
    for (const option of this.plugin.libraryQuery.SORT_OPTIONS) sort.createEl("option", { text: option.label, value: option.value });
    sort.value = this.sort;
    sort.addEventListener("change", () => {
      const option = this.plugin.libraryQuery.SORT_OPTIONS.find(option => option.value === sort.value);
      this.sort = option?.value || "title"; this.direction = option?.direction || "asc";
      this.page = 0; this.renderResults(); this.saveState();
    });
    this.directionButton = order.createEl("button", { cls: "nz-sort-direction", attr: { type: "button" } });
    this.directionButton.addEventListener("click", () => { this.direction = this.direction === "asc" ? "desc" : "asc"; this.page = 0; this.renderResults(); this.saveState(); });
    this.scopeEl = main.createDiv({ cls: "nz-scope" });
    this.activeTagsEl = main.createDiv({ cls: "nz-active-filters" });
    this.resultsEl = main.createDiv({ cls: "nz-results" });
    this.footerEl = main.createDiv({ cls: "nz-pagination" });
    this.renderResults();
  }
  selectTag(tag) {
    const value = itemTags({ tags: [tag] })[0];
    if (!value) return;
    if (this.tags.includes(value)) this.tags = this.tags.filter(tag => tag !== value);
    else if (this.tags.length < 64) this.tags = [...this.tags, value];
    else return;
    this.page = 0;
    this.renderResults();
    this.saveState();
  }
  clearTags() {
    this.tags = []; this.page = 0; this.renderResults(); this.saveState();
  }
  renderTagMenu(parent) {
    this.tagsMenu = parent.createEl("details", { cls: "nz-tags-menu" });
    this.tagsSummary = this.tagsMenu.createEl("summary", { cls: "nz-filter-trigger", attr: { "aria-label": "Filter by Zotero tags", title: "Filter by Zotero tags" } });
    icon(this.tagsSummary, "tags");
    this.tagsSummary.createSpan({ text: "Tags" });
    this.tagCountEl = this.tagsSummary.createSpan({ cls: "nz-filter-count" });
    icon(this.tagsSummary, "chevron-down");
    const panel = this.tagsMenu.createDiv({ cls: "nz-tags-panel" });
    const head = panel.createDiv({ cls: "nz-tags-panel-head" });
    head.createEl("strong", { text: "Zotero tags" });
    this.tagModeSelect = head.createEl("select", { attr: { "aria-label": "Zotero tag matching" } });
    this.tagModeSelect.createEl("option", { text: "Match all", value: "all" });
    this.tagModeSelect.createEl("option", { text: "Match any", value: "any" });
    this.tagModeSelect.addEventListener("change", () => { this.tagMode = this.tagModeSelect.value === "any" ? "any" : "all"; this.page = 0; this.renderResults(); this.saveState(); });
    const search = panel.createEl("input", { type: "search", placeholder: "Find a tag…", attr: { "aria-label": "Search Zotero tags" } });
    search.value = this.tagQuery;
    search.addEventListener("input", () => { this.tagQuery = search.value; this.renderTagOptions(); });
    this.tagOptionsEl = panel.createDiv({ cls: "nz-tag-options" });
    this.tagOptionsEl.title = "Counts follow collection, search and PDF filters.";
    this.tagOptionsSignature = null;
    this.tagInputs = new Map();
    const footer = panel.createDiv({ cls: "nz-tags-panel-footer" });
    this.clearTagButton = action(footer, "Clear tags", () => this.clearTags(), null, "nz-clear-tags");
    this.clearTagButton.setAttribute("aria-label", "Clear Zotero tag filters");
    action(footer, "Done", () => { this.tagsMenu.open = false; this.tagsSummary.focus(); });
    this.tagsMenu.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.tagsMenu.open = false; this.tagsSummary.focus(); }
    });
  }
  renderTagOptions() {
    if (!this.tagsMenu) return;
    this.tagCountEl.setText(String(this.tags.length));
    this.tagCountEl.hidden = !this.tags.length;
    this.tagsSummary.classList.toggle("is-filtered", this.tags.length > 0);
    this.tagModeSelect.value = this.tagMode;
    this.clearTagButton.disabled = !this.tags.length;
    const query = this.tagQuery.trim().toLowerCase();
    const facets = (this.tagFacets || []).filter(({ tag }) => !query || tag.toLowerCase().includes(query));
    const signature = JSON.stringify(facets);
    if (signature !== this.tagOptionsSignature) {
      this.tagOptionsSignature = signature;
      this.tagOptionsEl.empty(); this.tagInputs.clear();
      for (const { tag, count } of facets) {
        const row = this.tagOptionsEl.createEl("label", { cls: "nz-tag-option" });
        const input = row.createEl("input", { type: "checkbox", attr: { "aria-label": `Filter by Zotero tag ${tag}` } });
        input.addEventListener("change", () => this.selectTag(tag));
        this.tagInputs.set(tag, input);
        row.createSpan({ cls: "nz-tag-name", text: tag, attr: { title: tag } });
        row.createSpan({ cls: "nz-tag-option-count", text: count.toLocaleString() });
      }
      if (!facets.length) this.tagOptionsEl.createDiv({ cls: "nz-tag-options-empty", text: query ? "No tags match this search." : "No tags in this view." });
    }
    for (const [tag, input] of this.tagInputs) { input.checked = this.tags.includes(tag); input.disabled = this.tags.length >= 64 && !input.checked; }
  }
  renderTree() {
    const snapshot = this.plugin.snapshot;
    this.treeEl.empty();
    const counts = new Map();
    for (const item of snapshot.items) for (const key of item.collections || []) counts.set(key, (counts.get(key) || 0) + 1);
    const selectRow = (parent, key, name, count, depth, children) => {
      const row = parent.createDiv({ cls: `nz-collection ${this.collection === key ? "is-selected" : ""}` });
      row.style.setProperty("--nz-depth", depth);
      if (children.length) {
        const toggle = row.createEl("button", { cls: "nz-toggle", attr: { type: "button", "aria-label": `${this.expanded.has(key) ? "Collapse" : "Expand"} ${name}`, "aria-expanded": String(this.expanded.has(key)) } });
        setIcon(toggle, this.expanded.has(key) ? "chevron-down" : "chevron-right");
        toggle.addEventListener("click", () => { this.expanded.has(key) ? this.expanded.delete(key) : this.expanded.add(key); this.renderTree(); });
      } else row.createSpan({ cls: "nz-toggle-space" });
      const button = row.createEl("button", { cls: "nz-collection-button", attr: { type: "button", "aria-label": `Browse ${name}${count ? `, ${count} items` : ""}`, "aria-current": this.collection === key ? "page" : "false" } });
      icon(button, key ? "folder" : "library");
      button.createSpan({ cls: "nz-collection-name", text: name });
      if (count) button.createSpan({ cls: "nz-count", text: count.toLocaleString() });
      button.addEventListener("click", () => { this.collection = key; this.page = 0; this.renderTree(); this.renderResults(); this.saveState(); });
    };
    selectRow(this.treeEl, "", "My Library", snapshot.items.length, 0, []);
    const childrenByParent = new Map();
    for (const collection of snapshot.collections) {
      const parent = collection.parentKey || "";
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push(collection);
    }
    for (const children of childrenByParent.values()) children.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    if (!this.initializedTree) {
      for (const collection of snapshot.collections) if (childrenByParent.has(collection.key)) this.expanded.add(collection.key);
      this.initializedTree = true;
    }
    const visit = (parent, depth, seen) => {
      for (const collection of childrenByParent.get(parent) || []) {
        if (seen.has(collection.key)) continue;
        const next = new Set(seen).add(collection.key);
        const children = childrenByParent.get(collection.key) || [];
        selectRow(this.treeEl, collection.key, collection.name, counts.get(collection.key) || 0, depth, children);
        if (this.expanded.has(collection.key)) visit(collection.key, depth + 1, next);
      }
    };
    visit("", 0, new Set());
  }
  renderResults() {
    if (!this.resultsEl) return;
    const snapshot = this.plugin.snapshot;
    this.scopeEl.empty();
    const collection = snapshot.collections.find(c => c.key === this.collection);
    const ancestry = [];
    let ancestor = collection;
    const ancestors = new Set();
    while (ancestor && !ancestors.has(ancestor.key)) {
      ancestors.add(ancestor.key);
      ancestry.unshift(ancestor.name);
      ancestor = snapshot.collections.find(c => c.key === ancestor.parentKey);
    }
    this.scopeEl.createEl("h2", { text: collection?.name || "All items", attr: { title: ancestry.join(" / ") } });
    const label = this.scopeEl.createEl("label", { cls: "nz-descendants" });
    const checkbox = label.createEl("input", { type: "checkbox" });
    checkbox.checked = this.descendants;
    checkbox.disabled = !collection;
    label.createSpan({ text: "Include subcollections" });
    checkbox.addEventListener("change", () => { this.descendants = checkbox.checked; this.page = 0; this.renderResults(); this.saveState(); });
    const keys = new Set(this.collection ? [this.collection] : []);
    if (this.collection && this.descendants) {
      let grew;
      do {
        grew = false;
        for (const child of snapshot.collections) if (keys.has(child.parentKey) && !keys.has(child.key)) { keys.add(child.key); grew = true; }
      } while (grew);
    }
    const query = this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const scoped = snapshot.items.filter(item => (!this.collection || (item.collections || []).some(key => keys.has(key)))
      && (!this.pdfOnly || pdfs(item).length)
      && query.every(term => [item.title, item.creators, item.year, item.doi, item.venue, ...itemTags(item)].join(" ").toLowerCase().includes(term)));
    this.tagFacets = this.plugin.libraryQuery.tagFacets(scoped, this.tags);
    this.renderTagOptions();
    this.activeTagsEl.empty();
    this.activeTagsEl.hidden = !this.tags.length;
    if (this.tags.length > 1) this.activeTagsEl.createSpan({ cls: "nz-match-label", text: this.tagMode === "any" ? "Any tag" : "All tags" });
    for (const tag of this.tags) {
      const selected = this.activeTagsEl.createEl("button", { cls: "nz-tag-chip nz-active-tag", attr: { type: "button", "aria-label": `Remove Zotero tag filter ${tag}`, title: `Remove Zotero tag filter ${tag}` } });
      icon(selected, "tag");
      selected.createSpan({ text: tag });
      icon(selected, "x");
      selected.addEventListener("click", () => this.selectTag(tag));
    }
    if (this.tags.length > 1) action(this.activeTagsEl, "Clear", () => this.clearTags(), null, "nz-clear-active-tags");
    const items = this.plugin.libraryQuery.sortItems(scoped.filter(item => this.plugin.libraryQuery.matchesTags(item, this.tags, this.tagMode)), this.sort, this.direction);
    this.directionButton.empty();
    icon(this.directionButton, this.direction === "asc" ? "arrow-up" : "arrow-down");
    this.directionButton.setAttribute("aria-label", this.direction === "asc" ? "Sort ascending" : "Sort descending");
    this.directionButton.title = `${this.direction === "asc" ? "Ascending" : "Descending"} · Click to reverse`;
    this.page = Math.min(this.page, Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1));
    this.scopeEl.createSpan({ cls: "nz-result-count", text: `${items.length.toLocaleString()} ${items.length === 1 ? "item" : "items"}` });
    this.resultsEl.empty();
    if (!items.length) this.resultsEl.createDiv({ cls: "nz-empty", text: "No items match this view." });
    for (const item of items.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE)) {
      const row = this.resultsEl.createDiv({ cls: "nz-paper" });
      const available = pdfs(item);
      const paperIcon = row.createDiv({ cls: `nz-paper-icon ${available.length ? "has-pdf" : ""}` });
      icon(paperIcon, available.length ? "file-text" : "file");
      const detail = row.createDiv({ cls: "nz-paper-detail" });
      const title = detail.createEl("button", { cls: "nz-paper-title", text: item.title || "Untitled item", attr: { type: "button", title: available.length ? "Read PDF in Obsidian" : "Open item in Zotero" } });
      title.addEventListener("click", () => this.plugin.openItem(item));
      const authors = Array.isArray(item.authors) && item.authors.length ? item.authors : (item.creators || "").split(";").map(name => name.trim()).filter(Boolean);
      const authorLabel = authors.length > 2 ? `${authors.slice(0, 2).join(", ")} et al.` : authors.join(", ");
      detail.createDiv({ cls: "nz-paper-meta", text: [item.year, item.venue, authorLabel || (item.itemType === "attachment" ? "Standalone attachment" : "")].filter(Boolean).join(" · "), attr: { title: [item.year, item.venue, item.creators || authors.join("; ")].filter(Boolean).join(" · ") } });
      const tags = itemTags(item);
      if (tags.length) {
        const chips = detail.createDiv({ cls: "nz-paper-tags", attr: { "aria-label": "Zotero tags" } });
        const ordered = [...tags.filter(tag => this.tags.includes(tag)), ...tags.filter(tag => !this.tags.includes(tag))];
        for (const tag of ordered.slice(0, 3)) {
          const chip = chips.createEl("button", { cls: `nz-tag-chip ${this.tags.includes(tag) ? "is-selected" : ""}`, attr: { type: "button", "aria-label": `Toggle Zotero tag filter ${tag}`, "aria-pressed": String(this.tags.includes(tag)), title: tag } });
          chip.createSpan({ text: tag });
          chip.addEventListener("click", () => this.selectTag(tag));
        }
        if (ordered.length > 3) chips.createSpan({ cls: "nz-tag-overflow", text: `+${ordered.length - 3}`, attr: { title: ordered.slice(3).join(" · ") } });
      }
      const buttons = row.createDiv({ cls: "nz-paper-actions" });
      if (available.length) action(buttons, "PDF", () => this.plugin.openItem(item), "book-open", "nz-pdf-action");
      else buttons.createSpan({ cls: "nz-no-pdf", text: "No PDF" });
      action(buttons, "Notes", () => this.plugin.openPaperNotes(item.key), "notebook-pen", "nz-pdf-action");
      const zotero = buttons.createEl("a", { cls: "nz-zotero-link", href: this.plugin.zoteroUri(item.key), attr: { title: "Show item in Zotero", "aria-label": `Show ${item.title} in Zotero` } });
      icon(zotero, "external-link");
    }
    this.resultsEl.scrollTop = 0;
    this.footerEl.empty();
    const start = items.length ? this.page * PAGE_SIZE + 1 : 0;
    this.footerEl.createSpan({ text: `${start.toLocaleString()}–${Math.min(items.length, (this.page + 1) * PAGE_SIZE).toLocaleString()} of ${items.length.toLocaleString()}` });
    const pages = this.footerEl.createDiv({ cls: "nz-page-actions" });
    const previous = action(pages, "Previous", () => { this.page--; this.renderResults(); }, "chevron-left");
    previous.disabled = this.page === 0;
    const next = action(pages, "Next", () => { this.page++; this.renderResults(); }, "chevron-right");
    next.disabled = (this.page + 1) * PAGE_SIZE >= items.length;
  }
}

module.exports = class NoemaZotero extends Plugin {
  loadLocalModules(pluginPath) {
    const load = createRequire(path.join(pluginPath, "main.js"));
    // Obsidian reevaluates main.js on plugin reload, but Node retains the
    // auxiliary exports and their captured functions. Evict only our modules.
    const files = ["bridge.js", "library-query.js", "shared.js", "notes.js", "fields.js", "sync.js", "paper-view.js", "paper-note-template.js", "reader.js", "annotation-trash.js", "note-archive.js", "authorization-store.js", "reader-settings.js", "local-pdf.js"];
    const ids = files.map(file => load.resolve(path.join(pluginPath, file)));
    for (const id of ids) delete load.cache[id];
    return load;
  }
  async onload() {
    this.active = true;
    const configPath = `${this.app.vault.configDir}/noema.json`;
    if (!(await this.app.vault.adapter.exists(configPath))) throw new Error("Deploy Noema tools/config.toml before enabling Noema Zotero.");
    this.noemaConfig = JSON.parse(await this.app.vault.adapter.read(configPath));
    this.views = new Set();
    this.paperTitles = new Map();
    this.pdfTitleOverrides = new Map();
    this.snapshot = null;
    this.error = "";
    this.syncing = false;
    this.storage = `${this.app.vault.configDir}/zotero`;
    this.pdfPrefix = `${this.storage}/pdfs`;
    this.storageReal = path.join(this.app.vault.adapter.getBasePath(), this.storage);
    const pluginPath = path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir);
    const load = this.loadLocalModules(pluginPath);
    this.bridge = load(path.join(pluginPath, "bridge.js"));
    this.libraryQuery = load(path.join(pluginPath, "library-query.js"));
    this.guardPdfMutations();
    this.guardPdfIndex();
    // Direct loopback transport avoids Electron's system proxy/network path.
    this.request = (url, options = {}) => new Promise((resolve, reject) => {
      this.ensureActive();
      const endpoint = new URL(url);
      const method = options.method || "GET";
      const authorization = method === "POST" && endpoint.pathname === "/api/local/authorize";
      const itemWrite = ["POST", "PATCH"].includes(method) && /^\/api\/users\/0\/items(?:\/[A-Z0-9]{8})?$/.test(endpoint.pathname);
      if (endpoint.origin !== new URL(this.bridge.BASE_URL).origin || endpoint.username || endpoint.password || endpoint.hash
        || !(method === "GET" && endpoint.pathname.startsWith("/api/users/0/") || authorization || itemWrite)) {
        reject(new Error("Only the local Zotero library is available."));
        return;
      }
      const request = http.request(endpoint, { method, agent: false, headers: { "Zotero-API-Version": "3", ...options.headers } }, response => {
        const chunks = [];
        let length = 0;
        response.on("data", chunk => {
          length += chunk.length;
          if (length > 8 * 1024 * 1024) { request.destroy(new Error("The Zotero response exceeded the metadata size limit.")); return; }
          chunks.push(chunk);
        });
        response.once("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
        response.once("error", reject);
        response.once("aborted", () => reject(new Error("Zotero interrupted the response.")));
      });
      const timer = setTimeout(() => request.destroy(new Error(authorization ? "Zotero authorization timed out. Try again when you can respond to its dialog." : "Zotero did not respond in time.")), authorization ? 120000 : 15000);
      request.once("close", () => clearTimeout(timer));
      request.once("error", reject);
      request.end(options.body);
    });
    try {
      const snapshot = JSON.parse(await fs.readFile(path.join(this.storageReal, "library.json"), "utf8"));
      if (snapshot.schema === 1 && Array.isArray(snapshot.collections) && Array.isArray(snapshot.items)) {
        this.snapshot = snapshot;
        this.error = "Waiting for Zotero.";
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Noema Zotero: cache could not be read", error);
    }
    this.obsidian = obsidian;
    await load(path.join(pluginPath, "reader-settings.js")).installReaderSettings(this);
    load(path.join(pluginPath, "sync.js")).installShared(this);
    load(path.join(pluginPath, "paper-view.js")).installPaperView(this);
    this.localPdf = load(path.join(pluginPath, "local-pdf.js")).installLocalPdf(this);
    this.reader = load(path.join(pluginPath, "reader.js")).installReader(this);
    this.refreshReaderAnnotations = key => this.reader.refresh(key);
    if (this.snapshot?.serverId) { await this.initializeShared(); await this.refreshNoteMetadata(); }
    this.rebuildPaperTitles();
    this.registerEvent(this.app.workspace.on("file-open", () => this.updatePdfTabTitles()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.updatePdfTabTitles()));
    this.app.workspace.onLayoutReady(() => {
      if (!this.active) return;
      // Native Vault startup connects events and rebuilds the adapter index after onload.
      this.restorePdfAliases().then(() => {
        if (this.active) this.updatePdfTabTitles();
      }).catch(error => {
        if (this.active) console.warn("Noema Zotero: PDF aliases could not be restored", error);
      });
      this.refresh();
    });
    this.registerView(VIEW, leaf => new LibraryView(leaf, this));
    this.addCommand({ id: "open-library", name: "Open My Library", callback: () => this.openLibrary() });
    this.addCommand({ id: "refresh-library", name: "Refresh My Library", callback: () => this.refresh(true) });
    this.addRibbonIcon("library", "Open Zotero My Library", () => this.openLibrary());
    this.registerMarkdownCodeBlockProcessor("noema-zotero", (source, el, context) => {
      const child = new MarkdownRenderChild(el);
      context.addChild(child);
      const match = source.trim().match(/^field:\s*([a-z][a-z0-9/-]*)$/);
      if (!match) {
        const card = el.createDiv({ cls: "nz-entry" });
        icon(card, "library");
        card.createDiv().createEl("strong", { text: "Zotero · My Library" });
        action(card, "Open library", () => this.openLibrary(), "arrow-up-right", "mod-cta");
      }
      if (match) {
        const field = match[1];
        const list = el.createDiv({ cls: "nz-field-notes" });
        const render = () => {
          list.empty();
          const directory = field === "unfiled" ? this.fieldCatalog?.directory(null) : this.fieldCatalog?.get(field) ? this.fieldCatalog.directory(field) : null;
          if (!directory) { list.createDiv({ text: "Refresh My Library to load this field." }); return; }
          const files = this.app.vault.getMarkdownFiles().filter(file => path.posix.dirname(file.path) === directory && file.basename !== "README")
            .sort((a, b) => a.basename.localeCompare(b.basename));
          if (!files.length) { list.createDiv({ text: field === "unfiled" ? "No unfiled paper notes." : "No paper notes yet." }); return; }
          const ul = list.createEl("ul");
          for (const file of files) {
            const li = ul.createEl("li");
            const link = li.createEl("a", { text: file.basename, href: file.path, cls: "internal-link" });
            link.addEventListener("click", event => { event.preventDefault(); this.app.workspace.openLinkText(file.path, context.sourcePath); });
            const entry = this.mirrors.get(file.path);
            if (field === "unfiled" && entry) action(li, "Choose field", () => this.openPaperNotes(entry.parentKey));
          }
        };
        render();
        if (this.snapshot?.serverId) this.initializeShared().then(render).catch(() => {});
        for (const event of ["create", "delete", "rename"]) child.registerEvent(this.app.vault.on(event, render));
        child.registerEvent(this.app.workspace.on("noema-zotero:notes-changed", render));
      }
    });
    if (!this.active) return;
    this.registerInterval(window.setInterval(() => { if (this.active) this.refresh(); }, this.noemaConfig.zotero.refresh_seconds * 1000));
  }
  async openLibrary() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }
  notifyViews() { for (const view of this.views) view.render(); }
  refresh(showNotice = false) {
    if (this.refreshing) return this.refreshing;
    this.syncing = true;
    this.notifyViews();
    this.refreshing = (async () => {
      try {
        const snapshot = await this.bridge.loadLibrary({ request: this.request, previous: this.snapshot });
        if (!this.active) return;
        await fs.mkdir(this.storageReal, { recursive: true });
        const temporary = path.join(this.storageReal, "library.json.tmp");
        await fs.writeFile(temporary, JSON.stringify(snapshot), "utf8");
        await fs.rename(temporary, path.join(this.storageReal, "library.json"));
        this.snapshot = snapshot;
        await this.initializeShared();
        await this.refreshNoteMetadata();
        await this.refreshSharedNotes();
        this.rebuildPaperTitles();
        this.updatePdfTabTitles();
        this.error = "";
        if (showNotice) new Notice("Zotero library refreshed.");
      } catch (error) {
        console.error("Noema Zotero: refresh failed", error);
        this.error = error.code === "LIBRARY_CHANGED"
          ? "Zotero changed during this refresh. Choose Refresh to try again."
          : error.message?.includes("403")
          ? "Enable the local API in Zotero Settings → Advanced."
          : error.message || "Zotero is unavailable. Open Zotero and choose Refresh.";
        if (showNotice) new Notice(this.error);
      } finally {
        this.syncing = false;
        this.refreshing = null;
        if (this.active) this.notifyViews();
      }
    })();
    return this.refreshing;
  }
  zoteroUri(key) { return KEY.test(key) ? `zotero://select/library/items/${key}` : "zotero://select/library"; }
  openItem(item) {
    const attachments = pdfs(item);
    if (!attachments.length) { window.open(this.zoteroUri(item.key)); return; }
    const open = attachment => this.openPdf(attachment, item.title).catch(error => {
      if (error.code === "PLUGIN_DISABLED") return;
      console.error("Noema Zotero: PDF could not be opened", error);
      new Notice("The original PDF could not be opened. Use the Zotero link to locate it.");
    });
    if (attachments.length > 1) new PdfPicker(this.app, attachments, open).open();
    else open(attachments[0]);
  }
  rebuildPaperTitles() {
    this.paperTitles.clear();
    for (const item of this.snapshot?.items || []) {
      if (typeof item.title !== "string" || !item.title.trim()) continue;
      for (const attachment of pdfs(item)) if (KEY.test(attachment.key)) this.paperTitles.set(attachment.key, item.title.trim());
    }
  }
  paperTitle(filePath) {
    if (typeof filePath !== "string" || !filePath.startsWith(`${this.pdfPrefix}/`)) return null;
    const name = filePath.slice(this.pdfPrefix.length + 1);
    return /^[A-Z0-9]{8}\.pdf$/.test(name) ? this.paperTitles.get(name.slice(0, -4)) || null : null;
  }
  updatePdfTabTitles() {
    if (!this.active) return;
    const leaves = this.app.workspace.getLeavesOfType("pdf");
    const currentViews = new Set(leaves.map(leaf => leaf.view));
    for (const [view, record] of this.pdfTitleOverrides) {
      if (currentViews.has(view)) continue;
      if (view.getDisplayText === record.wrapped) view.getDisplayText = record.original;
      this.pdfTitleOverrides.delete(view);
    }
    for (const leaf of leaves) {
      const view = leaf.view;
      const title = this.paperTitle(view?.file?.path || view?.getState?.()?.file);
      let record = this.pdfTitleOverrides.get(view);
      if (!record && title && typeof view.getDisplayText === "function") {
        const original = view.getDisplayText;
        const plugin = this;
        const wrapped = function (...args) {
          // WorkspaceLeaf.getViewState may call getDisplayText to serialize
          // the title. Read the view's own state without re-entering the leaf.
          return (plugin.active && plugin.paperTitle(this.file?.path || this.getState?.()?.file)) || original.apply(this, args);
        };
        record = { original, wrapped, title: undefined, leaf };
        this.pdfTitleOverrides.set(view, record);
        view.getDisplayText = wrapped;
      }
      if (record && record.title !== title) {
        record.title = title;
        record.leaf = leaf;
        // Supported by the installed desktop adapter, but not a public API.
        if (typeof leaf.updateHeader === "function") leaf.updateHeader();
      }
    }
  }
  async indexPdf(alias) {
    this.ensureActive();
    const adapter = this.app.vault.adapter;
    if (typeof adapter.reconcileFileInternal !== "function" || typeof adapter.reconcileFolderCreation !== "function") {
      throw new Error("The current Obsidian adapter cannot index a managed PDF alias.");
    }
    await adapter.reconcileFolderCreation(this.storage, this.storage);
    this.ensureActive();
    await adapter.reconcileFolderCreation(this.pdfPrefix, this.pdfPrefix);
    this.ensureActive();
    adapter.trigger("raw", alias);
    await adapter.reconcileFileInternal(alias, alias);
    this.ensureActive();
    const file = this.app.vault.getFileByPath(alias);
    if (!file) throw new Error("Obsidian could not index the PDF alias.");
    return file;
  }
  guardPdfIndex() {
    const adapter = this.app.vault.adapter;
    if (["listRecursiveChild", "reconcileFile", "reconcileFileInternal", "getFullRealPath", "trigger"].some(name => typeof adapter[name] !== "function")) return;
    const plugin = this;
    this.indexGuards = [];
    const matches = value => value === this.storage || value === this.pdfPrefix
      || (typeof value === "string" && value.startsWith(`${this.pdfPrefix}/`) && /^[A-Z0-9]{8}\.pdf$/.test(value.slice(this.pdfPrefix.length + 1)));
    const reconcile = async (realPath, logicalPath, forceDelete, delegate) => {
      try {
        const physical = adapter.getFullRealPath(realPath);
        const stat = await fs.lstat(physical);
        if (!plugin.active) return delegate();
        const folder = logicalPath === plugin.storage || logicalPath === plugin.pdfPrefix;
        if (folder ? !stat.isDirectory() : !stat.isSymbolicLink()) return;
        adapter.trigger("raw", logicalPath);
        await adapter.reconcileFileInternal(realPath, logicalPath);
      } catch (error) {
        if (!plugin.active) return delegate();
        if (error.code === "ENOENT") {
          adapter.trigger("raw", logicalPath);
          await adapter.reconcileDeletion(realPath, logicalPath, forceDelete);
        } else console.warn("Noema Zotero: PDF alias indexing failed", error);
      }
    };
    for (const name of ["listRecursiveChild", "reconcileFile"]) {
      const original = adapter[name];
      const guarded = function (...args) {
        const real = name === "listRecursiveChild" ? (args[0] ? `${args[0]}/${args[1]}` : args[1]) : args[0];
        const logical = name === "listRecursiveChild" ? real : args[1];
        const delegate = () => original.apply(this, args);
        if (!plugin.active || !matches(logical)) return delegate();
        return reconcile(real, logical, name === "reconcileFile" ? args[2] ?? true : true, delegate);
      };
      adapter[name] = guarded;
      this.indexGuards.push({ name, original, guarded });
    }
  }
  guardPdfMutations() {
    const adapter = this.app.vault.adapter;
    this.mutationGuards = [];
    const protects = value => {
      if (typeof value !== "string") return false;
      const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\/+|\/+$/g, "");
      return normalized === this.storage || normalized === this.pdfPrefix || normalized.startsWith(`${this.pdfPrefix}/`);
    };
    for (const name of ["write", "writeBinary", "append", "appendBinary", "process", "rename", "copy", "remove", "rmdir", "trashSystem", "trashLocal"]) {
      const original = adapter[name];
      if (typeof original !== "function") continue;
      const plugin = this;
      const guarded = function (...args) {
        const paths = name === "rename" || name === "copy" ? args.slice(0, 2) : args.slice(0, 1);
        if (plugin.active && paths.some(protects)) {
          return Promise.reject(new Error("Original Zotero PDFs are read-only in Noema. Manage them in Zotero."));
        }
        return original.apply(this, args);
      };
      adapter[name] = guarded;
      this.mutationGuards.push({ name, original, guarded });
    }
  }
  async restorePdfAliases() {
    let names;
    try { names = await fs.readdir(path.join(this.storageReal, "pdfs")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const name of names) {
      if (!this.active) return;
      if (!/^[A-Z0-9]{8}\.pdf$/.test(name)) continue;
      const alias = `${this.pdfPrefix}/${name}`;
      const real = path.join(this.storageReal, "pdfs", name);
      try {
        if (!(await fs.lstat(real)).isSymbolicLink()) continue;
        await this.indexPdf(alias);
      } catch (error) { console.warn("Noema Zotero: a saved PDF alias is unavailable", name, error.message); }
    }
  }
  async openPdf(attachment, title) {
    this.ensureActive();
    if (!KEY.test(attachment.key)) throw new Error("Invalid Zotero attachment key.");
    let target = attachment.path;
    if (target) {
      try { await fs.access(target, fs.constants.R_OK); }
      catch { target = null; }
    }
    if (!target) target = await this.bridge.resolvePdfPath({ request: this.request, attachmentKey: attachment.key });
    this.ensureActive();
    if (!path.isAbsolute(target) || !/\.pdf$/i.test(target)) throw new Error("Zotero did not return a local PDF.");
    target = await fs.realpath(target);
    const vaultRoot = await fs.realpath(this.app.vault.adapter.getBasePath());
    if (target === vaultRoot || target.startsWith(`${vaultRoot}${path.sep}`)) throw new Error("The original PDF must be outside this vault.");
    if (!(await fs.stat(target)).isFile()) throw new Error("The PDF path is not a file.");
    await fs.access(target, fs.constants.R_OK);
    this.ensureActive();
    const alias = `${this.pdfPrefix}/${attachment.key}.pdf`;
    const aliasReal = path.join(this.storageReal, "pdfs", `${attachment.key}.pdf`);
    await fs.mkdir(path.dirname(aliasReal), { recursive: true });
    this.ensureActive();
    try {
      const stat = await fs.lstat(aliasReal);
      this.ensureActive();
      if (!stat.isSymbolicLink()) throw new Error("The PDF alias path is occupied by a regular file.");
      const existing = await fs.readlink(aliasReal);
      this.ensureActive();
      if (existing !== target) { await fs.unlink(aliasReal); await fs.symlink(target, aliasReal); }
    } catch (error) {
      if (error.code === "ENOENT") { this.ensureActive(); await fs.symlink(target, aliasReal); }
      else throw error;
    }
    this.ensureActive();
    const file = await this.indexPdf(alias);
    this.ensureActive();
    if (typeof title === "string" && title.trim()) this.paperTitles.set(attachment.key, title.trim());
    const workspace = this.app.workspace;
    const tabGroup = workspace.getMostRecentLeaf()?.parent;
    const readers = this.app.workspace.getLeavesOfType("pdf");
    const matches = candidate => (candidate.view?.file?.path || candidate.getViewState?.()?.state?.file) === alias;
    const existing = readers.find(candidate => matches(candidate) && candidate.parent === tabGroup);
    if (existing) {
      await workspace.revealLeaf(existing);
    } else {
      const previous = readers.find(matches);
      const leaf = workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true, ...(previous ? { eState: previous.getEphemeralState() } : {}) });
      this.ensureActive();
      // Replace this paper's former split pane only after its new tab opens.
      if (previous) previous.detach();
    }
    this.updatePdfTabTitles();
  }
  ensureActive() {
    if (this.active) return;
    const error = new Error("The Zotero bridge was disabled.");
    error.code = "PLUGIN_DISABLED";
    throw error;
  }
  onunload() {
    this.active = false;
    this.views.clear();
    const adapter = this.app.vault.adapter;
    for (const { name, original, guarded } of this.mutationGuards || []) if (adapter[name] === guarded) adapter[name] = original;
    for (const { name, original, guarded } of this.indexGuards || []) if (adapter[name] === guarded) adapter[name] = original;
    for (const [view, record] of this.pdfTitleOverrides || []) {
      if (view.getDisplayText === record.wrapped) {
        view.getDisplayText = record.original;
        if (typeof record.leaf.updateHeader === "function") record.leaf.updateHeader();
      }
    }
    this.pdfTitleOverrides?.clear();
  }
};
