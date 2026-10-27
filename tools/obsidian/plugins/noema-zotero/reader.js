const KEY = /^[A-Z0-9]{8}$/;
const TYPES = new Set(["highlight", "underline", "image", "note", "ink"]);
const COLOR = /^#[0-9a-f]{6}$/i;
// Installed Zotero annotations.js ANNOTATION_COLORS; these are database colors.
const ZOTERO_COLORS = Object.freeze([
  ["Yellow", "#ffd400"], ["Red", "#ff6666"], ["Green", "#5fb236"], ["Blue", "#2ea8e5"],
  ["Purple", "#a28ae5"], ["Magenta", "#e56eee"], ["Orange", "#f19837"], ["Gray", "#aaaaaa"]
].map(([name, color]) => Object.freeze({ name, color })));
const MARK_TYPES = new Set(["highlight", "underline"]);

function attachmentKey(plugin, filePath) {
  const prefix = `${plugin.app.vault.configDir}/zotero/pdfs/`;
  if (typeof filePath !== "string" || !filePath.startsWith(prefix)) return null;
  const name = filePath.slice(prefix.length);
  return /^[A-Z0-9]{8}\.pdf$/.test(name) ? name.slice(0, -4) : null;
}

function filePath(leaf) {
  return leaf?.view?.file?.path || leaf?.getViewState?.()?.state?.file || "";
}

function pdfScope(plugin, leaf) {
  const path = filePath(leaf), key = attachmentKey(plugin, path);
  if (key) return { path, key, zotero: true };
  if (plugin.localPdf && plugin.readerSettings?.enableLocalPdf !== false && typeof path === "string"
    && /\.pdf$/i.test(path) && !/[\\\x00-\x1f\x7f:]/.test(path) && !path.startsWith("/")
    && !path.split("/").some(part => !part || part === "." || part === "..")) {
    // A malformed managed alias must never fall through to local ownership.
    if (path.toLowerCase().startsWith(`${plugin.app.vault.configDir}/zotero/`.toLowerCase())) return null;
    return { path, key: null, zotero: false };
  }
  return null;
}

function viewerParts(leaf) {
  const child = leaf.view?.viewer?.child;
  const host = child?.pdfViewer;
  return { child, host, viewer: host?.pdfViewer, bus: host?.eventBus || host?.pdfViewer?.eventBus };
}

function pageViews(viewer) {
  if (Array.isArray(viewer?._pages)) return viewer._pages;
  if (typeof viewer?.getPageView === "function" && Number.isInteger(viewer.pagesCount)) {
    return Array.from({ length: viewer.pagesCount }, (_, index) => viewer.getPageView(index)).filter(Boolean);
  }
  return [];
}

function positionOf(record) {
  const value = record.position || record.annotationPosition || record.data?.annotationPosition;
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

function validRect(rect) {
  return Array.isArray(rect) && rect.length === 4 && rect.every(value => Number.isFinite(value) && Math.abs(value) <= 1e6)
    && rect[2] > rect[0] && rect[3] > rect[1];
}

function annotationData(record) { return record.data || record; }
function countLabel(count) { return count ? `${count} ${count === 1 ? "annotation" : "annotations"}` : "No annotations"; }

function menuSelectionText(value) {
  // PDF++ exposes one-line text rather than its native range. Compare the
  // snapshot without depending on its internal text-normalization helpers.
  return value.normalize("NFKC").replace(/\0/g, "").replace(/-[\r\n]+(?=[a-zA-Z])/g, "")
    .replace(/\s+/g, " ").replace(/([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]) (?=[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff])/g, "$1").trim();
}

function selectionTextRanges(range, layer) {
  const doc = layer.ownerDocument;
  if (!doc?.createTreeWalker || !doc.createRange || !range.comparePoint) return null;
  const parts = [], walker = doc.createTreeWalker(layer, 4); // NodeFilter.SHOW_TEXT
  let node, visited = 0;
  try {
    while ((node = walker.nextNode())) {
      if (++visited > 100000) return null;
      const length = node.textContent?.length || 0;
      if (!length || range.comparePoint(node, length) < 0 || range.comparePoint(node, 0) > 0) continue;
      const part = doc.createRange();
      part.selectNodeContents(node);
      if (range.comparePoint(node, 0) < 0) part.setStart(range.startContainer, range.startOffset);
      if (range.comparePoint(node, length) > 0) part.setEnd(range.endContainer, range.endOffset);
      if (!part.collapsed && part.toString()) parts.push({ node, range: part });
    }
  } catch { return null; }
  return parts.length ? parts : null;
}

function coalesceSelectionChars(chars) {
  const lines = [];
  for (const { rect, axis, baseline } of chars) {
    let line = lines.find(candidate => candidate.axis === axis && Math.abs(candidate.baseline - baseline) <= 0.25);
    if (!line) { line = { axis, baseline, rects: [] }; lines.push(line); }
    line.rects.push(rect);
  }
  const rects = [];
  for (const line of lines) {
    const along = line.axis === "horizontal" ? 0 : 1, across = 1 - along;
    line.rects.sort((a, b) => a[along] - b[along]);
    let merged;
    for (const rect of line.rects) {
      // A small kerning gap can join a run; a column gap cannot join it.
      if (merged && rect[along] <= merged[along + 2] + 0.5) {
        merged[along + 2] = Math.max(merged[along + 2], rect[along + 2]);
        merged[across] = Math.min(merged[across], rect[across]);
        merged[across + 2] = Math.max(merged[across + 2], rect[across + 2]);
      } else { merged = rect.slice(); rects.push(merged); }
    }
  }
  return rects;
}

function nativeSelectionRects(pageView, parts) {
  const native = pageView.textLayer?.textLayer;
  const divs = native?.textDivs, items = native?.textContentItems;
  if (!parts || !Array.isArray(divs) || !Array.isArray(items) || divs.length !== items.length || divs.length > 100000) return null;
  const indexes = new Map(divs.map((div, index) => [div, index])), chars = [];
  try {
    for (const part of parts) {
      let div = part.node.parentElement;
      while (div && !indexes.has(div)) div = div.parentElement;
      const item = div && items[indexes.get(div)];
      if (!item || item.dir !== "ltr" || div.textContent !== item.str || !Array.isArray(item.chars)
        || !item.chars.length || item.chars.length > 100000 || !Array.isArray(item.transform)
        || item.transform.length !== 6 || !item.transform.every(Number.isFinite)) return null;
      const [a, b, c, d, x, y] = item.transform;
      const axis = Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && a && d ? "horizontal"
        : Math.abs(a) < 1e-6 && Math.abs(d) < 1e-6 && b && c ? "vertical" : null;
      if (!axis || item.chars.some(char => typeof char.c !== "string") || item.chars.map(char => char.c).join("") !== item.str) return null;
      const prefix = div.ownerDocument.createRange();
      prefix.selectNodeContents(div);
      prefix.setEnd(part.range.startContainer, part.range.startOffset);
      const start = prefix.toString().length;
      prefix.setEnd(part.range.endContainer, part.range.endOffset);
      const end = prefix.toString().length;
      if (end <= start || end > item.str.length) return null;
      let offset = 0;
      for (const char of item.chars) {
        const next = offset + char.c.length;
        if (next > start && offset < end) {
          if (!validRect(char.r)) { if (char.c.trim()) return null; }
          else chars.push({ rect: char.r.slice(), axis, baseline: axis === "horizontal" ? y : x });
        }
        offset = next;
      }
    }
  } catch { return null; }
  return chars.length ? coalesceSelectionChars(chars) : null;
}

function normalizeSelectionRects(values) {
  const rects = [];
  const contains = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
  for (const value of values) {
    const rect = value.map(coordinate => Math.round(coordinate * 1000) / 1000);
    if (!validRect(rect) || rects.some(existing => contains(existing, rect)
      || existing.every((coordinate, index) => Math.abs(coordinate - rect[index]) < 0.05))) continue;
    const first = rects.findIndex(existing => contains(rect, existing));
    if (first < 0) rects.push(rect);
    else {
      rects[first] = rect;
      for (let index = rects.length - 1; index > first; index--) if (contains(rect, rects[index])) rects.splice(index, 1);
    }
  }
  return rects;
}

// Prefer verified native character boxes. Browser text boxes remain the fallback
// and use the viewport inverse, including page rotation, into PDF coordinates.
function captureSelection(plugin, leaf, selection, color = "#ffd400", type = "highlight") {
  if (typeof color !== "string" || !COLOR.test(color)) throw new Error("Choose a valid annotation color.");
  if (!MARK_TYPES.has(type)) throw new Error("Choose Highlight or Underline for the selection.");
  const scope = pdfScope(plugin, leaf);
  if (!scope) throw new Error("Open a supported PDF in Noema before highlighting.");
  const { key } = scope;
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) throw new Error("Select text in the PDF first.");
  const range = selection.getRangeAt(0);
  const element = node => node?.nodeType === 1 ? node : node?.parentElement;
  const start = element(range.startContainer);
  const end = element(range.endContainer);
  const pageEl = start?.closest(".page[data-page-number]");
  const endPage = end?.closest(".page[data-page-number]");
  const textLayer = start?.closest(".textLayer");
  const container = leaf.view?.containerEl;
  if (!pageEl || !endPage || !container?.contains(pageEl) || !container.contains(endPage)
    || !textLayer || !end.closest(".textLayer")) throw new Error("Select text in the PDF first.");
  if (pageEl !== endPage) throw new Error("Select text on one page at a time to create a highlight.");
  if (textLayer !== end.closest(".textLayer")) throw new Error("Select text in the PDF first.");
  const page = Number(pageEl.dataset.pageNumber);
  const { child, viewer } = viewerParts(leaf);
  const pageView = viewer?.getPageView?.(page - 1) || child?.getPage?.(page);
  const viewport = pageView?.viewport;
  if (!Number.isInteger(page) || page < 1 || !viewport?.convertToPdfPoint || pageView?.div !== pageEl) {
    throw new Error("The PDF page is still loading. Try again when its text is visible.");
  }
  const origin = (pageEl.querySelector(".canvasWrapper") || pageEl).getBoundingClientRect();
  if (!(origin.width > 0 && origin.height > 0 && viewport.width > 0 && viewport.height > 0)) throw new Error("The PDF page is not visible.");
  const text = selection.toString().trim();
  if (!text) throw new Error("Select text in the PDF first.");
  if (text.length > 50000) throw new Error("Select a smaller passage to create a highlight.");
  const parts = selectionTextRanges(range, textLayer);
  let values = nativeSelectionRects(pageView, parts);
  if (values) {
    const corners = [[0, 0], [viewport.width, 0], [0, viewport.height], [viewport.width, viewport.height]]
      .map(point => viewport.convertToPdfPoint(...point));
    const bounds = [Math.min(...corners.map(point => point[0])), Math.min(...corners.map(point => point[1])),
      Math.max(...corners.map(point => point[0])), Math.max(...corners.map(point => point[1]))];
    values = values.map(rect => [Math.max(rect[0], bounds[0]), Math.max(rect[1], bounds[1]), Math.min(rect[2], bounds[2]), Math.min(rect[3], bounds[3])]);
  } else {
    values = [];
    const boxes = parts ? parts.flatMap(part => Array.from(part.range.getClientRects())) : Array.from(range.getClientRects());
    for (const rect of boxes) {
      if (rect.width <= 0.5 || rect.height <= 0.5) continue;
      const left = Math.max(rect.left, origin.left), top = Math.max(rect.top, origin.top);
      const right = Math.min(rect.right, origin.right), bottom = Math.min(rect.bottom, origin.bottom);
      if (right <= left || bottom <= top) continue;
      const a = viewport.convertToPdfPoint((left - origin.left) * viewport.width / origin.width, (top - origin.top) * viewport.height / origin.height);
      const b = viewport.convertToPdfPoint((right - origin.left) * viewport.width / origin.width, (bottom - origin.top) * viewport.height / origin.height);
      values.push([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
    }
  }
  const rects = normalizeSelectionRects(values);
  if (!rects.length) throw new Error("Select text in the PDF first.");
  if (rects.length > 200) throw new Error("Select a smaller passage to create a highlight.");
  return { key, ...(scope.zotero ? {} : { path: scope.path }), payload: { text, comment: "", color: color.toLowerCase(), type, pageLabel: String(pageView.pageLabel || page),
    sortIndex: `${String(page - 1).padStart(5, "0")}|000000|00000`, position: { pageIndex: page - 1, rects } } };
}

function rectInViewport(viewport, rect) {
  if (!validRect(rect) || typeof viewport?.convertToViewportRectangle !== "function") return null;
  const value = viewport.convertToViewportRectangle(rect);
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return null;
  return { left: Math.min(value[0], value[2]), top: Math.min(value[1], value[3]), width: Math.abs(value[2] - value[0]), height: Math.abs(value[3] - value[1]) };
}

function normalizedDegrees(degrees) { return (Math.round(degrees) % 360 + 360) % 360; }

function textRotationForRect(pageView, rect) {
  const counts = new Map();
  const items = pageView?.textLayer?.textLayer?.textContentItems;
  if (!Array.isArray(items) || !validRect(rect)) return 0;
  for (const item of items) {
    const transform = item?.transform;
    if (!Array.isArray(transform) || transform.length !== 6 || !transform.every(Number.isFinite) || !Array.isArray(item.chars)) continue;
    const rotation = normalizedDegrees(Math.atan2(transform[1], transform[0]) * 180 / Math.PI);
    if (![0, 90, 180, 270].includes(rotation)) continue;
    for (const char of item.chars) {
      if (!validRect(char?.r)) continue;
      const x = (char.r[0] + char.r[2]) / 2, y = (char.r[1] + char.r[3]) / 2;
      if (x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]) counts.set(rotation, (counts.get(rotation) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] || 0;
}

function underlineInViewport(viewport, rect, textRotation = 0) {
  const area = rectInViewport(viewport, rect);
  if (!area) return null;
  const transform = viewport.transform;
  const scale = Array.isArray(transform) && transform.length === 6 && transform.every(Number.isFinite)
    ? Math.hypot(transform[0], transform[1]) : Number(viewport.scale);
  if (!Number.isFinite(scale) || !(scale > 0)) return null;
  const pageRotation = Array.isArray(transform) ? -Math.atan2(transform[1], transform[0]) * 180 / Math.PI : Number(viewport.rotation) || 0;
  const rotation = normalizedDegrees(textRotation + pageRotation);
  // Zotero Page._pushUnderline: a filled strip one PDF unit thick. The
  // asymmetric top/left offsets are deliberate native reading geometry.
  if (rotation === 0) return { ...area, top: area.top + area.height - scale, height: scale };
  if (rotation === 90) return { ...area, left: area.left + area.width - scale, width: scale };
  if (rotation === 180) return { ...area, top: area.top - scale, height: scale };
  if (rotation === 270) return { ...area, left: area.left - scale, width: scale };
  return null;
}

function paperColorScheme(pageView) {
  // PDF pages default to white independently of Obsidian's application theme.
  // Only an explicit PDF.js page recoloring requests the additive dark mode.
  const background = pageView?.pageColors?.background;
  if (typeof background !== "string" || !/^#[0-9a-f]{6}$/i.test(background)) return "light";
  const rgb = [1, 3, 5].map(offset => parseInt(background.slice(offset, offset + 2), 16) / 255);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < .5 ? "dark" : "light";
}

function installReader(plugin) {
  // Obsidian resolves its virtual module in main.js only. Auxiliary modules
  // receive the API from the entry point instead of Node's module resolver.
  const { Notice, setIcon, Menu } = plugin.obsidian || {};
  if (typeof Notice !== "function" || typeof setIcon !== "function") throw new Error("The Obsidian reader API is unavailable.");
  const workspace = plugin.app.workspace;
  const sessions = new Map();
  const nativeMenuSelections = new WeakMap(), extendedMenus = new WeakSet();
  let restoreNativeMenu = () => {};
  let active = true;
  const live = () => active && plugin.active !== false;
  const current = session => live() && sessions.get(session.leaf) === session && session.leaf.view === session.view
    && pdfScope(plugin, session.leaf)?.path === session.path;
  const notice = message => { if (live()) new Notice(message); };
  const savedColor = typeof plugin.readerHighlightColor === "string" ? plugin.readerHighlightColor.toLowerCase() : "";
  plugin.readerHighlightColor = ZOTERO_COLORS.some(choice => choice.color === savedColor) ? savedColor : "#ffd400";
  plugin.readerMarkType = MARK_TYPES.has(plugin.readerMarkType) ? plugin.readerMarkType : "highlight";

  function updateChoices() {
    for (const session of sessions.values()) {
      const label = `${plugin.readerMarkType === "underline" ? "Underline" : "Highlight"}${session.zotero ? " in Zotero" : " locally"}`;
      for (const choice of session.colorButtons || []) {
        const selected = choice.color === plugin.readerHighlightColor;
        choice.button.setAttribute("aria-checked", String(selected));
        choice.button.tabIndex = selected ? 0 : -1;
      }
      if (session.typeSelect) session.typeSelect.value = plugin.readerMarkType;
      if (session.highlightButton) {
        session.highlightButton.setAttribute("aria-label", label); session.highlightButton.title = label;
        if (session.highlightLabel) session.highlightLabel.textContent = "Save mark";
      }
      session.selectionPopup?.update();
    }
  }

  function rememberSelection(session) {
    if (!current(session)) return;
    try {
      session.selection = captureSelection(plugin, session.leaf, session.leaf.view.containerEl.ownerDocument.getSelection(),
        plugin.readerHighlightColor, plugin.readerMarkType);
    } catch { /* Toolbar focus may temporarily collapse an otherwise valid selection. */ }
  }

  function selectionForAction(leaf) {
    const session = sessions.get(leaf);
    const doc = leaf?.view?.containerEl?.ownerDocument;
    try {
      const captured = captureSelection(plugin, leaf, doc?.getSelection(), plugin.readerHighlightColor, plugin.readerMarkType);
      if (session && current(session)) session.selection = captured;
      return captured;
    } catch (error) {
      if (!session || !current(session) || !session.selection || session.selection.key !== session.key
        || (!session.zotero && session.selection.path !== session.path)
        || !(session.tools?.contains(doc?.activeElement) || session.selectionPopup?.el.contains(doc?.activeElement))) throw error;
      return { key: session.selection.key, ...(session.zotero ? {} : { path: session.path }),
        payload: { ...session.selection.payload, color: plugin.readerHighlightColor, type: plugin.readerMarkType } };
    }
  }

  function detachTools(session) {
    closeSelectionPopup(session);
    session.tools?.remove(); session.tools = null;
    if (!session.toolbar?.querySelector?.(".nz-zotero-reader-tools")) session.toolbar?.classList?.remove("nz-unified-pdf-toolbar");
  }

  function removeSession(session) {
    session.generation++;
    session.observer?.disconnect();
    closeSelectionPopup(session);
    for (const [doc, event, callback, capture] of session.selectionEvents || []) doc.removeEventListener(event, callback, capture);
    session.selection = null;
    for (const [bus, event, callback] of session.events) bus.off?.(event, callback);
    detachTools(session);
    for (const overlay of session.overlays) overlay.remove();
    session.overlays.clear();
    if (sessions.get(session.leaf) === session) sessions.delete(session.leaf);
  }

  function invoke(session, record) {
    if (!current(session)) return;
    const edit = session.zotero ? plugin.editAnnotationComment?.bind(plugin) : plugin.localPdf?.editAnnotation;
    if (!edit) return;
    Promise.resolve(edit(record)).then(() => refreshDocument(session)).catch(() => notice("The annotation comment could not be updated."));
  }

  function decorate(element, session, record, type, color) {
    const data = annotationData(record);
    const key = record.key || data.key;
    const label = `Edit ${type} comment${data.annotationComment ? `: ${data.annotationComment}` : data.annotationText ? `: ${data.annotationText}` : ""}`;
    element.setAttribute("data-annotation-key", key);
    element.setAttribute("role", "button");
    element.setAttribute("tabindex", "0");
    element.setAttribute("aria-label", label.slice(0, 1000));
    element.setAttribute("title", label.slice(0, 1000));
    element.style.setProperty("--nz-annotation-color", color);
    element.addEventListener("click", event => { event.stopPropagation(); invoke(session, record); });
    element.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); invoke(session, record); }
    });
  }

  function renderPage(session, pageView, pageIndex) {
    if (!current(session) || !pageView?.div || !pageView.viewport?.convertToViewportRectangle) return;
    for (const overlay of [...session.overlays]) {
      if (overlay.parentElement === pageView.div || !overlay.isConnected) { overlay.remove(); session.overlays.delete(overlay); }
    }
    const viewport = pageView.viewport;
    if (!(viewport.width > 0 && viewport.height > 0)) return;
    const doc = pageView.div.ownerDocument;
    let layer;
    for (const record of session.records) {
      const data = annotationData(record), position = positionOf(record);
      const key = record.key || data.key, type = data.annotationType;
      if (!KEY.test(key || "") || !TYPES.has(type) || position?.pageIndex !== pageIndex) continue;
      const rects = Array.isArray(position.rects) ? position.rects.filter(validRect) : [];
      const paths = type === "ink" && Array.isArray(position.paths) ? position.paths : [];
      if (!rects.length && !paths.length) continue;
      if (!layer) {
        layer = doc.createElement("div");
        layer.className = "nz-zotero-overlay";
        layer.dataset.zoteroAttachmentKey = session.key;
        // A positioned z-index wrapper isolates multiply blending from the PDF
        // canvas. Zotero uses display:contents for this exact reason.
        Object.assign(layer.style, { display: "contents", pointerEvents: "none" });
        layer.dataset.colorScheme = paperColorScheme(pageView);
        pageView.div.appendChild(layer);
        session.overlays.add(layer);
      }
      const color = COLOR.test(data.annotationColor || "") ? data.annotationColor : "#ffd400";
      const textRotation = type === "underline" ? textRotationForRect(pageView, rects[0]) : 0;
      let handleTop = null;
      for (const rect of rects) {
        const area = type === "underline" ? underlineInViewport(viewport, rect, textRotation) : rectInViewport(viewport, rect);
        if (!area || !area.width || !area.height) continue;
        const el = doc.createElement("span");
        el.className = `nz-zotero-mark nz-zotero-${type}`;
        Object.assign(el.style, { position: "absolute", left: `${area.left / viewport.width * 100}%`, top: `${area.top / viewport.height * 100}%`,
          width: `${area.width / viewport.width * 100}%`, height: `${area.height / viewport.height * 100}%`, pointerEvents: "none", zIndex: "1" });
        el.setAttribute("aria-hidden", "true");
        el.style.setProperty("--nz-annotation-color", color);
        if (handleTop === null) handleTop = area.top;
        if (type === "note") el.textContent = "✎";
        layer.appendChild(el);
      }
      if (paths.length && typeof viewport.convertToViewportPoint === "function") {
        const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.classList.add("nz-zotero-mark", "nz-zotero-ink");
        svg.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
        Object.assign(svg.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "1" });
        svg.setAttribute("aria-hidden", "true");
        svg.style.setProperty("--nz-annotation-color", color);
        for (const points of paths) {
          if (!Array.isArray(points) || points.length < 4 || points.length > 100000 || points.length % 2 || !points.every(value => Number.isFinite(value) && Math.abs(value) <= 1e6)) continue;
          const converted = [];
          for (let index = 0; index < points.length; index += 2) converted.push(viewport.convertToViewportPoint(points[index], points[index + 1]));
          if (!converted.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) continue;
          const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", converted.map((point, index) => `${index ? "L" : "M"}${point[0]} ${point[1]}`).join(" "));
          path.setAttribute("fill", "none"); path.setAttribute("stroke", color);
          path.setAttribute("stroke-width", String(Math.max(0.5, Math.min(100, Number(position.width) || 1)) * (Number(viewport.scale) || 1)));
          path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
          path.style.pointerEvents = "none";
          if (handleTop === null) handleTop = Math.min(...converted.map(point => point[1]));
          svg.appendChild(path);
        }
        layer.appendChild(svg);
      }
      if (handleTop !== null) {
        const handle = doc.createElement("button");
        handle.type = "button"; handle.className = "nz-annotation-handle clickable-icon";
        Object.assign(handle.style, { position: "absolute", right: "4px", top: `${Math.max(0, Math.min(viewport.height - 20, handleTop)) / viewport.height * 100}%`, pointerEvents: "auto", zIndex: "6" });
        decorate(handle, session, record, type, color);
        setIcon(handle, "message-square");
        layer.appendChild(handle);
      }
    }
  }

  function render(session) {
    if (!current(session)) return;
    const { viewer } = viewerParts(session.leaf);
    pageViews(viewer).forEach((pageView, index) => renderPage(session, pageView, index));
  }

  async function load(session) {
    const generation = ++session.generation;
    session.statusText = "Loading annotations…";
    if (session.status) { session.status.textContent = session.statusText; session.status.title = session.statusText; }
    try {
      const records = session.zotero ? await plugin.annotationsFor(session.key) : await plugin.localPdf.annotationsFor(session.path);
      if (!current(session) || generation !== session.generation) return;
      session.records = Array.isArray(records) ? records : [];
      session.statusText = countLabel(session.records.length);
      if (session.status) { session.status.textContent = session.statusText; session.status.title = session.statusText; }
      attach(session); render(session);
    } catch {
      if (current(session) && generation === session.generation) {
        session.statusText = "Annotations unavailable";
        if (session.status) { session.status.textContent = session.statusText; session.status.title = session.statusText; }
      }
    }
  }

  async function highlight(leaf, snapshot) {
    if (!live()) return false;
    try {
      const captured = snapshot || selectionForAction(leaf);
      const session = sessions.get(leaf);
      if (session?.busy) return false;
      if (session) { session.busy = true; if (session.highlightButton) session.highlightButton.disabled = true; }
      try {
        if (!session || !current(session) || (session.zotero ? captured.key !== session.key : captured.path !== session.path)) return false;
        if (session.zotero) await plugin.createHighlight(captured.key, captured.payload);
        else await plugin.localPdf.createAnnotation(session.path, captured.payload);
        if (!live()) return false;
        await refreshDocument(session);
        notice(`${captured.payload.type === "underline" ? "Underline" : "Highlight"} saved ${session.zotero ? "in Zotero" : "locally"}.`);
        return true;
      } finally {
        if (session && current(session)) { session.busy = false; if (session.highlightButton) session.highlightButton.disabled = false; }
      }
    } catch (error) {
      const message = error?.message || "The Zotero highlight could not be created.";
      const session = sessions.get(leaf);
      if (session && current(session)) {
        session.statusText = message;
        if (session.status) { session.status.textContent = message; session.status.title = message; }
      }
      notice(message);
      return false;
    }
  }

  async function addSelection(leaf, snapshot) {
    if (!live()) return;
    try {
      const captured = snapshot || selectionForAction(leaf);
      const session = sessions.get(leaf);
      if (session?.addingSelection) return;
      if (session) { session.addingSelection = true; if (session.addSelectionButton) session.addSelectionButton.disabled = true; }
      try {
        if (!session || !current(session)) return;
        if (session.zotero) await plugin.addSelectionToNote(captured);
        else await plugin.localPdf.addSelection(captured);
        return true;
      }
      finally {
        if (session && current(session)) { session.addingSelection = false; if (session.addSelectionButton) session.addSelectionButton.disabled = false; }
      }
    } catch (error) { notice(error?.message || "The PDF selection could not be added to a note."); return false; }
  }

  async function copyQuote(leaf, snapshot) {
    try {
      const captured = snapshot || selectionForAction(leaf), path = filePath(leaf);
      const file = leaf.view.file || plugin.app.vault.getAbstractFileByPath?.(path);
      const title = captured.key ? plugin.itemForAttachment?.(captured.key)?.title : file?.basename;
      const page = captured.payload.position.pageIndex + 1;
      const link = plugin.app.fileManager.generateMarkdownLink(file, "", `#page=${page}`, `${title || "PDF"} · p. ${captured.payload.pageLabel}`);
      const quoted = captured.payload.text.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char])
        .replace(/([\\`*_\[\]{}!|])/g, "\\$1");
      const text = `${quoted.split(/\r?\n/).map(line => `> ${line}`).join("\n")}\n>\n> ${link}`;
      await leaf.view.containerEl.ownerDocument.defaultView.navigator.clipboard.writeText(text);
      notice("PDF quote and page link copied.");
      return true;
    } catch (error) { notice(error?.message || "The PDF quote could not be copied."); return false; }
  }

  function closeSelectionPopup(session) {
    session.selectionPopup?.el.remove();
    session.selectionPopup = null;
  }

  function openSelectionPopup(session, snapshot, focus = false) {
    if (!current(session) || workspace.activeLeaf !== session.leaf) return;
    const root = session.view.containerEl, doc = root.ownerDocument;
    if (!doc.body) return;
    let captured, anchor;
    try {
      captured = snapshot || selectionForAction(session.leaf);
      const selection = doc.getSelection();
      const rects = selection?.rangeCount ? [...selection.getRangeAt(0).getClientRects()]
        .filter(rect => rect.width > 0 && rect.height > 0) : [];
      anchor = rects.at(-1) || session.selectionAnchor;
      if (!anchor || (session.zotero ? captured.key !== session.key : captured.path !== session.path)) return;
    } catch { return; }
    for (const other of sessions.values()) closeSelectionPopup(other);
    const child = viewerParts(session.leaf).child;
    const valid = () => current(session) && workspace.activeLeaf === session.leaf
      && viewerParts(session.leaf).child === child && session.selectionPopup === popup;
    const el = doc.createElement("div"); el.className = "nz-selection-toolbar";
    el.setAttribute("role", "dialog"); el.setAttribute("aria-label", session.zotero ? "Zotero selection annotations" : "PDF selection annotations");
    el.tabIndex = -1;
    const colors = doc.createElement("div"); colors.className = "nz-selection-colors nz-reader-colors";
    colors.setAttribute("role", "radiogroup"); colors.setAttribute("aria-label", "Annotation color"); el.appendChild(colors);
    const popup = { el, busy: false, update: () => {
      for (const choice of colorButtons) {
        const selected = choice.color === plugin.readerHighlightColor;
        choice.button.setAttribute("aria-checked", String(selected)); choice.button.tabIndex = selected ? 0 : -1;
      }
    } };
    const colorButtons = ZOTERO_COLORS.map((choice, index) => {
      const button = doc.createElement("button"); button.type = "button"; button.className = "nz-reader-color";
      button.title = choice.name; button.setAttribute("role", "radio"); button.setAttribute("aria-label", choice.name);
      button.style.setProperty("--nz-color", choice.color);
      button.addEventListener("click", () => { if (valid() && !popup.busy) { plugin.readerHighlightColor = choice.color; updateChoices(); } });
      button.addEventListener("keydown", event => {
        const offset = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
        if ((!offset && !["Home", "End"].includes(event.key)) || !valid() || popup.busy) return;
        event.preventDefault();
        const target = event.key === "Home" ? 0 : event.key === "End" ? ZOTERO_COLORS.length - 1 : (index + offset + ZOTERO_COLORS.length) % ZOTERO_COLORS.length;
        plugin.readerHighlightColor = ZOTERO_COLORS[target].color; updateChoices(); colorButtons[target].button.focus();
      });
      colors.appendChild(button); return { button, color: choice.color };
    });
    const actions = doc.createElement("div"); actions.className = "nz-selection-actions"; el.appendChild(actions);
    const comment = doc.createElement("textarea"); comment.className = "nz-selection-comment"; comment.hidden = true;
    comment.setAttribute("aria-label", "Annotation comment"); comment.placeholder = "Add a comment…"; comment.rows = 3; el.appendChild(comment);
    const message = doc.createElement("div"); message.className = "nz-selection-message";
    message.setAttribute("role", "status"); el.appendChild(message);
    const capture = type => ({ ...captured, payload: { ...captured.payload, color: plugin.readerHighlightColor,
      type: type || plugin.readerMarkType, ...(comment.value ? { comment: comment.value } : {}) } });
    const finish = async run => {
      if (!valid() || popup.busy || session.busy) return;
      popup.busy = true; message.textContent = "";
      const controls = el.querySelectorAll("button, textarea"); controls.forEach(control => { control.disabled = true; });
      try {
        if (await run() && valid()) { closeSelectionPopup(session); doc.getSelection()?.removeAllRanges?.(); }
      } catch (error) { if (valid()) message.textContent = error?.message || "The selection could not be saved."; }
      finally { popup.busy = false; controls.forEach(control => { control.disabled = false; }); }
    };
    const action = (label, icon, run, text = "") => {
      const button = doc.createElement("button"); button.type = "button"; button.className = "nz-selection-action";
      button.title = label; button.setAttribute("aria-label", label);
      const glyph = doc.createElement("span"); setIcon(glyph, icon); button.appendChild(glyph);
      if (text) { const span = doc.createElement("span"); span.textContent = text; button.appendChild(span); }
      button.addEventListener("click", run); actions.appendChild(button); return button;
    };
    const mark = type => finish(async () => {
      plugin.readerMarkType = type; updateChoices();
      const saved = await highlight(session.leaf, capture(type));
      if (!saved && valid()) message.textContent = session.statusText || "The annotation could not be saved.";
      return saved;
    });
    action("Highlight selection", "highlighter", () => mark("highlight"), "Highlight");
    action("Underline selection", "underline", () => mark("underline"), "Underline");
    const commentButton = action("Add annotation comment", "message-square", () => {
      if (!valid() || popup.busy) return;
      comment.hidden = !comment.hidden; commentButton.setAttribute("aria-expanded", String(!comment.hidden));
      position(); if (!comment.hidden) comment.focus();
    });
    commentButton.setAttribute("aria-expanded", "false");
    if (session.zotero ? typeof plugin.addSelectionToNote === "function" : plugin.localPdf) {
      action(session.zotero ? "Add to shared note" : "Add to PDF note", "notebook-pen", () => finish(() => addSelection(session.leaf, capture())));
    }
    if (plugin.app.fileManager?.generateMarkdownLink && doc.defaultView?.navigator?.clipboard?.writeText) {
      action("Copy quote with page link", "copy", () => finish(() => copyQuote(session.leaf, capture())));
    }
    action("Close annotation options", "x", () => { if (valid() && !popup.busy) closeSelectionPopup(session); });
    el.addEventListener("mousedown", event => { if (event.target !== comment) event.preventDefault(); });
    el.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSelectionPopup(session); }
      else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); mark(plugin.readerMarkType); }
    });
    function position() {
      const bounds = root.getBoundingClientRect(), win = doc.defaultView;
      const left = Math.max(8, bounds.left + 8), right = Math.min(win?.innerWidth || bounds.right, bounds.right) - 8;
      const top = Math.max(8, bounds.top + 8), bottom = Math.min(win?.innerHeight || bounds.bottom, bounds.bottom) - 8;
      el.style.maxWidth = `${Math.max(0, right - left)}px`;
      const size = el.getBoundingClientRect();
      el.style.left = `${Math.max(left, Math.min(anchor.left, right - size.width))}px`;
      const below = anchor.bottom + 8;
      el.style.top = `${Math.max(top, Math.min(below + size.height <= bottom ? below : anchor.top - size.height - 8, bottom - size.height))}px`;
    }
    session.selection = captured; session.selectionAnchor = anchor; session.selectionPopup = popup;
    doc.body.appendChild(el); popup.update(); position();
    if (focus) colorButtons.find(choice => choice.color === plugin.readerHighlightColor)?.button.focus();
  }

  function paperDetails(session) {
    if (!current(session) || !session.zotero || typeof plugin.obsidian.Modal !== "function") return;
    const item = plugin.itemForAttachment?.(session.key);
    if (!item) { notice("The paper metadata is unavailable. Refresh My Library."); return; }
    const modal = new plugin.obsidian.Modal(plugin.app);
    modal.modalEl?.classList.add("nz-zotero-paper-details");
    modal.onOpen = () => {
      const root = modal.contentEl;
      root.createEl("h2", { text: item.title || "Paper details" });
      for (const [label, value] of [["Authors", item.creators], ["Venue", item.venue], ["Year", item.year], ["DOI", item.doi]]) {
        if (!value) continue;
        const row = root.createDiv({ cls: "nz-reader-paper-detail" });
        row.createEl("strong", { text: label }); row.createSpan({ text: String(value) });
      }
      const tags = [...new Set((Array.isArray(item.tags) ? item.tags : []).filter(value =>
        typeof value === "string" && value.length <= 1024 && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value)))];
      if (tags.length) {
        const row = root.createDiv({ cls: "nz-reader-paper-detail" });
        row.createEl("strong", { text: "Zotero tags" });
        const list = row.createDiv({ cls: "nz-reader-zotero-tags", attr: { "aria-label": "Zotero tags" } });
        for (const tag of tags) list.createSpan({ cls: "nz-reader-zotero-tag", text: tag });
      }
      const link = root.createEl("a", { text: "Open in Zotero", href: plugin.zoteroUri(item.key) });
      link.addEventListener("click", () => modal.close());
    };
    modal.open();
  }

  async function notesMenu(session, event) {
    if (!current(session) || session.zotero || typeof Menu !== "function") return;
    try {
      const info = await plugin.localPdf.notesInfo(session.path);
      if (!current(session)) return;
      const menu = new Menu();
      const action = (title, icon, callback) => menu.addItem(item => item.setTitle(title).setIcon(icon).onClick(() => {
        if (!current(session)) return;
        return Promise.resolve(callback(session.path)).catch(error => notice(error?.message || "PDF notes could not be updated."));
      }));
      if (info.deleted && info.canRestore) action("Restore deleted PDF notes", "rotate-ccw", plugin.localPdf.restoreNotes);
      else action(info.exists ? "Open PDF notes" : "Create PDF notes", "notebook-pen", plugin.localPdf.openNotes);
      if (info.canMove) action("Move notes beside PDF", "folder-input", plugin.localPdf.moveNotesToPdfDirectory);
      if (info.exists) action("Delete PDF notes…", "trash-2", plugin.localPdf.deleteNotes);
      if (info.canRestore && !info.deleted) action("Restore deleted PDF notes", "rotate-ccw", plugin.localPdf.restoreNotes);
      menu.showAtMouseEvent(event);
    } catch (error) { notice(error?.message || "PDF note options could not be opened."); }
  }

  function configure() {
    for (const session of sessions.values()) { closeSelectionPopup(session); detachTools(session); }
    scan();
  }

  function attach(session) {
    if (!current(session)) return;
    const { child, bus } = viewerParts(session.leaf);
    if (bus && bus !== session.bus && typeof bus.on === "function" && typeof bus.off === "function") {
      for (const [oldBus, event, callback] of session.events) oldBus.off(event, callback);
      session.events = []; session.bus = bus;
      for (const event of ["pagerendered", "pagesinit", "pagesloaded", "scalechanging", "rotationchanging"]) {
        const callback = () => { closeSelectionPopup(session); schedule(session); };
        bus.on(event, callback); session.events.push([bus, event, callback]);
      }
    }
    // Keep native navigation and annotation controls in one normal-flow row.
    // Native control nodes stay intact, including their input/event listeners.
    const toolbar = child?.toolbar?.toolbarEl || session.leaf.view?.containerEl?.querySelector(".pdf-toolbar");
    const host = toolbar;
    if (toolbar && (session.toolbar !== toolbar || session.tools?.parentElement !== host)) {
      detachTools(session);
      session.toolbar = toolbar;
      toolbar.classList?.add("nz-unified-pdf-toolbar");
      const doc = toolbar.ownerDocument, tools = doc.createElement("div");
      tools.className = "nz-zotero-reader-tools";
      tools.dataset.alignment = plugin.readerSettings?.readerAlignment || "center";
      tools.dataset.density = plugin.readerSettings?.readerDensity || "auto";
      tools.dataset.source = session.zotero ? "zotero" : "local";
      tools.setAttribute("role", "group"); tools.setAttribute("aria-label", session.zotero ? "Zotero annotations" : "PDF annotations");
      const bar = doc.createElement("div"); bar.className = "nz-reader-bar"; tools.appendChild(bar);
      const controls = doc.createElement("div"); controls.className = "nz-reader-controls"; bar.appendChild(controls);
      const colors = doc.createElement("div"); colors.className = "nz-reader-colors";
      colors.setAttribute("role", "radiogroup"); colors.setAttribute("aria-label", "Annotation color");
      session.colorButtons = ZOTERO_COLORS.map((choice, index) => {
        const el = doc.createElement("button"); el.type = "button"; el.className = "nz-reader-color clickable-icon";
        el.setAttribute("role", "radio"); el.setAttribute("aria-label", choice.name); el.title = choice.name;
        el.style.setProperty("--nz-color", choice.color);
        el.addEventListener("mousedown", event => { rememberSelection(session); event.preventDefault(); });
        const choose = () => { if (current(session)) { plugin.readerHighlightColor = choice.color; updateChoices(); } };
        el.addEventListener("click", choose);
        el.addEventListener("keydown", event => {
          const offset = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
          if (!offset && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault(); rememberSelection(session);
          const target = event.key === "Home" ? 0 : event.key === "End" ? ZOTERO_COLORS.length - 1 : (index + offset + ZOTERO_COLORS.length) % ZOTERO_COLORS.length;
          if (current(session)) {
            plugin.readerHighlightColor = ZOTERO_COLORS[target].color; updateChoices(); session.colorButtons[target].button.focus();
          }
        });
        colors.appendChild(el); return { color: choice.color, button: el };
      });
      controls.appendChild(colors);
      const typeLabel = doc.createElement("label"); typeLabel.className = "nz-reader-type";
      const typeText = doc.createElement("span"); typeText.className = "nz-reader-type-label"; typeText.textContent = "Mark type";
      typeLabel.appendChild(typeText);
      const typeSelect = doc.createElement("select"); typeSelect.className = "nz-reader-mark-type"; typeSelect.setAttribute("aria-label", "Mark type");
      for (const [value, label] of [["highlight", "Highlight"], ["underline", "Underline"]]) {
        const option = doc.createElement("option"); option.value = value; option.textContent = label; typeSelect.appendChild(option);
      }
      typeSelect.addEventListener("mousedown", () => rememberSelection(session));
      typeSelect.addEventListener("keydown", () => rememberSelection(session));
      typeSelect.addEventListener("change", () => {
        if (current(session) && MARK_TYPES.has(typeSelect.value)) { plugin.readerMarkType = typeSelect.value; updateChoices(); }
      });
      session.typeSelect = typeSelect; typeLabel.appendChild(typeSelect); controls.appendChild(typeLabel);
      const button = (label, icon, callback) => {
        const el = doc.createElement("button"); el.type = "button"; el.className = "nz-reader-action clickable-icon";
        el.setAttribute("aria-label", label); el.title = label;
        const glyph = doc.createElement("span"); setIcon(glyph, icon); el.appendChild(glyph);
        const shortLabel = { "Add selection to note": "Add note", "Copy quote with page link": "Quote", "Paper notes": "Notes",
          "PDF notes": "Notes", "Paper details": "Details", "Restore removed annotation": "Restore", "Refresh annotations": "Refresh" };
        const text = doc.createElement("span"); text.className = "nz-reader-action-label"; text.textContent = shortLabel[label] || label; el.appendChild(text);
        el.addEventListener("mousedown", event => event.preventDefault());
        el.addEventListener("click", callback); controls.appendChild(el); return el;
      };
      session.highlightButton = button(session.zotero ? "Highlight in Zotero" : "Highlight locally", "highlighter", () => { if (current(session)) highlight(session.leaf); });
      session.highlightLabel = session.highlightButton.lastChild;
      if (session.zotero ? typeof plugin.addSelectionToNote === "function" : plugin.localPdf) {
        session.addSelectionButton = button("Add selection to note", "notebook-pen", () => { if (current(session)) addSelection(session.leaf); });
        session.addSelectionButton.classList.add("nz-reader-add-selection");
      }
      if (plugin.app.fileManager?.generateMarkdownLink && doc.defaultView?.navigator?.clipboard?.writeText) {
        button("Copy quote with page link", "copy", () => { if (current(session)) copyQuote(session.leaf); });
      }
      button(session.zotero ? "Paper notes" : "PDF notes", "notebook-pen", () => {
        if (!current(session)) return;
        const opened = session.zotero ? plugin.openPaperNotes(session.key) : plugin.localPdf.openNotes(session.path);
        Promise.resolve(opened).catch(() => notice("PDF notes could not be opened."));
      });
      if (!session.zotero && typeof Menu === "function" && typeof plugin.localPdf.notesInfo === "function") {
        const options = button("PDF note options", "chevron-down", event => notesMenu(session, event));
        options.classList.add("nz-reader-options"); options.setAttribute("aria-haspopup", "menu");
      }
      if (session.zotero && typeof plugin.obsidian.Modal === "function") button("Paper details", "info", () => paperDetails(session));
      if (!session.zotero && typeof plugin.localPdf.restoreAnnotations === "function") {
        button("Restore removed annotation", "rotate-ccw", () => {
          if (current(session)) Promise.resolve(plugin.localPdf.restoreAnnotations(session.path)).then(() => refreshDocument(session))
            .catch(() => notice("Removed annotations could not be restored."));
        });
      }
      button("Refresh annotations", "refresh-cw", async event => {
        if (!current(session) || session.refreshing) return;
        session.refreshing = true;
        const target = event.currentTarget;
        if (target) target.disabled = true;
        try {
          if (session.zotero) {
            const item = plugin.itemForAttachment(session.key);
            if (!KEY.test(item?.key || "")) throw new Error("The parent Zotero item is unavailable.");
            await plugin.refreshPaper(item.key);
          }
          if (current(session)) await refreshDocument(session);
        } catch { notice(session.zotero ? "Zotero annotations could not be refreshed. Check the Zotero connection." : "Local annotations could not be refreshed."); }
        finally { session.refreshing = false; if (target && current(session)) target.disabled = false; }
      });
      const status = doc.createElement("span"); status.className = "nz-reader-status"; status.setAttribute("aria-live", "polite");
      status.textContent = session.statusText || countLabel(session.records.length); status.title = status.textContent; tools.appendChild(status);
      session.status = status; session.tools = tools;
      host.appendChild(tools);
      updateChoices();
    }
  }

  function onViewerReady(session) {
    const component = session.view?.viewer;
    if (!current(session) || typeof component?.then !== "function" || session.readyComponent === component) return;
    session.readyComponent = component;
    // Native PDFViewerComponent.then waits for its child and toolbar to load.
    // Its callback can run synchronously when the component is already ready.
    component.then(() => {
      if (current(session) && session.readyComponent === component) { attach(session); render(session); }
    });
  }

  function schedule(session) {
    if (!current(session) || session.scheduled) return;
    session.scheduled = true;
    const callback = () => { session.scheduled = false; if (current(session)) { attach(session); render(session); } };
    const win = session.leaf.view?.containerEl?.ownerDocument?.defaultView;
    if (win?.requestAnimationFrame) win.requestAnimationFrame(callback); else queueMicrotask(callback);
  }

  function scan() {
    if (!live()) return;
    const leaves = workspace.getLeavesOfType("pdf");
    for (const session of sessions.values()) if (session.leaf !== workspace.activeLeaf) closeSelectionPopup(session);
    for (const session of [...sessions.values()]) if (!leaves.includes(session.leaf) || !current(session)) removeSession(session);
    for (const leaf of leaves) {
      const scope = pdfScope(plugin, leaf);
      if (!scope) continue;
      let session = sessions.get(leaf);
      if (!session) {
        session = { leaf, view: leaf.view, ...scope, records: [], overlays: new Set(), events: [], selectionEvents: [], generation: 0, scheduled: false, busy: false };
        sessions.set(leaf, session);
        const root = leaf.view?.containerEl;
        const doc = root?.ownerDocument;
        if (doc?.addEventListener && doc?.removeEventListener) {
          const selectionChanged = () => {
            if (!current(session)) return;
            try { session.selection = captureSelection(plugin, leaf, doc.getSelection(), plugin.readerHighlightColor, plugin.readerMarkType); }
            catch {
              if (!(session.tools?.contains(doc.activeElement) || session.selectionPopup?.el.contains(doc.activeElement))) {
                session.selection = null; closeSelectionPopup(session);
              }
            }
          };
          const mouseDown = event => {
            if (!current(session)) return;
            if (session.selectionPopup?.el.contains(event.target)) return;
            closeSelectionPopup(session);
            if (session.tools?.contains(event.target)) rememberSelection(session); else session.selection = null;
          };
          doc.addEventListener("selectionchange", selectionChanged);
          doc.addEventListener("mousedown", mouseDown, true);
          session.selectionEvents.push([doc, "selectionchange", selectionChanged, false], [doc, "mousedown", mouseDown, true]);
          const showSelection = event => {
            if (plugin.readerSettings?.readerSelectionToolbar === false || !current(session)
              || workspace.activeLeaf !== leaf || !root.contains(event.target) || !event.target?.closest?.(".textLayer")) return;
            if (event.type === "mouseup" && event.button !== 0) return;
            if (event.type === "keyup" && !["Shift", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            openSelectionPopup(session);
          };
          const dismissSelection = event => {
            if (!session.selectionPopup?.el.contains(event.target)) closeSelectionPopup(session);
          };
          const keyDown = event => { if (event.key === "Escape") closeSelectionPopup(session); };
          for (const [name, callback, capture] of [["mouseup", showSelection, false], ["keyup", showSelection, false],
            ["scroll", dismissSelection, true], ["keydown", keyDown, false], ["contextmenu", dismissSelection, true]]) {
            doc.addEventListener(name, callback, capture); session.selectionEvents.push([doc, name, callback, capture]);
          }
          const win = doc.defaultView;
          if (win?.addEventListener && win?.removeEventListener) {
            win.addEventListener("resize", dismissSelection);
            session.selectionEvents.push([win, "resize", dismissSelection, false]);
          }
          const contextMenu = event => {
            if (!current(session) || !event || typeof event !== "object" || !root.contains(event.target)
              || !event.target?.closest?.(".textLayer")) return;
            try {
              const captured = captureSelection(plugin, leaf, doc.getSelection(), plugin.readerHighlightColor, plugin.readerMarkType);
              const page = event.target.closest(".page[data-page-number]");
              if (Number(page?.dataset?.pageNumber) !== captured.payload.position.pageIndex + 1) return;
              session.selectionAnchor = [...doc.getSelection().getRangeAt(0).getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).at(-1);
              nativeMenuSelections.set(event, { session, captured, child: viewerParts(leaf).child });
            } catch { /* Native menus remain unchanged without a supported selection. */ }
          };
          doc.addEventListener("contextmenu", contextMenu, true);
          session.selectionEvents.push([doc, "contextmenu", contextMenu, true]);
          rememberSelection(session);
        }
        const Observer = root?.ownerDocument?.defaultView?.MutationObserver;
        if (root && Observer) {
          session.observer = new Observer(mutations => {
            // Ignore our own overlay/tool DOM to avoid observer-render loops.
            const changed = mutations.some(mutation => !mutation.target?.closest?.(".nz-zotero-overlay, .nz-zotero-reader-tools")
              && [...mutation.addedNodes, ...mutation.removedNodes].some(node => node.nodeType === 1
                && !node.matches?.(".nz-zotero-overlay, .nz-zotero-reader-tools")
                && (node.matches?.(".page, .pdf-container, .pdf-toolbar, .textLayer, .canvasWrapper") || node.querySelector?.(".page, .pdf-toolbar"))));
            if (changed) schedule(session);
          });
          session.observer.observe(root, { childList: true, subtree: true });
        }
        attach(session); onViewerReady(session); load(session);
      } else { attach(session); onViewerReady(session); render(session); }
    }
  }

  async function refresh(key) {
    if (!live()) return;
    scan();
    await Promise.all([...sessions.values()].filter(session => !key || session.key === key || session.path === key).map(session => load(session)));
  }

  function refreshDocument(session) {
    return refresh(session.zotero ? session.key : session.path);
  }

  function dispose() {
    if (!active) return;
    active = false;
    restoreNativeMenu();
    for (const session of [...sessions.values()]) removeSession(session);
  }

  function appendSelectionMenu(menu, session, captured, child) {
    if (!current(session) || typeof menu?.addItem !== "function" || extendedMenus.has(menu)) return;
    const leaf = session.leaf;
    const valid = () => current(session) && workspace.activeLeaf === leaf && viewerParts(leaf).child === child;
    if (!valid()) return;
    try {
      session.selectionAnchor = [...session.view.containerEl.ownerDocument.getSelection().getRangeAt(0).getClientRects()]
        .filter(rect => rect.width > 0 && rect.height > 0).at(-1);
    } catch { /* The native hook may already have captured the selection anchor. */ }
    extendedMenus.add(menu);
    if (session.zotero ? typeof plugin.addSelectionToNote === "function" : plugin.localPdf) {
      menu.addItem(item => {
        item.setTitle(session.zotero ? "Add to shared note" : "Add to PDF note").setIcon("notebook-pen");
        item.setSection?.("selection");
        item.onClick(() => { if (valid()) return addSelection(leaf, captured); });
      });
    }
    for (const [type, label, icon] of [["highlight", "Highlight", "highlighter"], ["underline", "Underline", "underline"]]) {
      menu.addItem(item => {
        item.setTitle(`${label}${session.zotero ? " in Zotero" : " locally"}`).setIcon(icon);
        item.setSection?.("selection");
        item.onClick(() => { if (valid()) return highlight(leaf, { ...captured, payload: { ...captured.payload, type } }); });
      });
    }
    menu.addItem(item => {
      item.setTitle("Annotation options…").setIcon("palette");
      item.setSection?.("selection");
      item.onClick(() => { if (valid()) openSelectionPopup(session, captured, true); });
    });
  }

  function installNativeMenuHook() {
    const prototype = Menu?.prototype;
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "showAtMouseEvent");
    if (typeof descriptor?.value !== "function" || (!descriptor.writable && !descriptor.configurable)) return;
    const original = descriptor.value;
    const wrapped = function(event, ...args) {
      const snapshot = nativeMenuSelections.get(event);
      if (snapshot) {
        nativeMenuSelections.delete(event);
        appendSelectionMenu(this, snapshot.session, snapshot.captured, snapshot.child);
      }
      return original.call(this, event, ...args);
    };
    // Native PDF listeners bind their handler before plugins attach. Scope the
    // shared menu hook to an exact captured PDF event; every other menu delegates.
    Object.defineProperty(prototype, "showAtMouseEvent", { ...descriptor, value: wrapped });
    restoreNativeMenu = () => {
      if (prototype.showAtMouseEvent === wrapped) Object.defineProperty(prototype, "showAtMouseEvent", descriptor);
    };
  }

  function extendPdfMenu(menu, params) {
    if (!live() || typeof menu?.addItem !== "function" || !Number.isInteger(params?.pageNumber) || params.pageNumber < 1
      || typeof params.selection !== "string" || !params.selection.trim() || params.selection.length > 50000 || params.annot != null) return;
    const leaf = workspace.activeLeaf;
    const session = sessions.get(leaf);
    if (!session || !current(session)) return;
    let child, captured;
    try {
      const pdfPlus = plugin.app.plugins?.getPlugin?.("pdf-plus");
      child = pdfPlus?.lib?.getPDFViewerChild?.();
      if (!child || child !== viewerParts(leaf).child) return;
      // Capture the actual range now; the event's text cannot provide geometry.
      captured = captureSelection(plugin, leaf, leaf.view.containerEl.ownerDocument.getSelection(), plugin.readerHighlightColor, plugin.readerMarkType);
      if (captured.key !== session.key || captured.payload.position.pageIndex + 1 !== params.pageNumber
        || menuSelectionText(captured.payload.text) !== menuSelectionText(params.selection)) return;
    } catch { return; }
    appendSelectionMenu(menu, session, captured, child);
  }

  plugin.addCommand({ id: "highlight-selection-in-zotero", name: "Highlight selection in Zotero", callback: () => {
    if (attachmentKey(plugin, filePath(workspace.activeLeaf))) return highlight(workspace.activeLeaf);
    notice("Open a Zotero PDF before using this command.");
  } });
  plugin.addCommand({ id: "mark-pdf-selection", name: "Mark PDF selection", callback: () => highlight(workspace.activeLeaf) });
  plugin.addCommand({ id: "copy-pdf-quote", name: "Copy PDF quote with page link", callback: () => copyQuote(workspace.activeLeaf) });
  plugin.addCommand({ id: "pdf-selection-options", name: "PDF selection annotation options", callback: () => {
    const session = sessions.get(workspace.activeLeaf);
    if (session) openSelectionPopup(session, null, true);
  } });
  if (typeof plugin.addSelectionToNote === "function" || plugin.localPdf) {
    plugin.addCommand({ id: "add-pdf-selection-to-note", name: "Add PDF selection to note", callback: () => addSelection(workspace.activeLeaf) });
  }
  installNativeMenuHook();
  for (const event of ["file-open", "layout-change", "active-leaf-change"]) plugin.registerEvent(workspace.on(event, scan));
  plugin.registerEvent(workspace.on("pdf-menu", extendPdfMenu));
  plugin.register(dispose);
  workspace.onLayoutReady(scan);
  return { refresh, dispose, configure, highlightSelection: () => highlight(workspace.activeLeaf), addSelectionToNote: () => addSelection(workspace.activeLeaf) };
}

module.exports = { installReader, attachmentKey, pdfScope, captureSelection, positionOf, rectInViewport, underlineInViewport, textRotationForRect, paperColorScheme, ZOTERO_COLORS };
