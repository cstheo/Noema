"use strict";

const { createHash } = require("node:crypto");

const KEY = /^[A-Z0-9]{8}$/;
const SERVER = /^[A-Za-z0-9_-]{1,128}$/;
const LIMIT = 2 * 1024 * 1024;
const OWNED = new Set(["zotero-server-id", "zotero-key", "zotero-parent-key", "zotero-version"]);
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAPER_FIELDS = new Set(["paper", "authors", "paper-tags", "conference", "proceedings", "journal", "year", "doi", "url"]);
const HTML_TAGS = new Set("a abbr b blockquote br caption cite code col colgroup dd del div dl dt em h1 h2 h3 h4 h5 h6 hr i img li mark ol p pre s small span strong sub sup table tbody td th thead tr u ul".split(" "));
const VOID = new Set(["br", "col", "hr", "img"]);
const BASIC_ATTRIBUTES = { a: new Set(["href", "title"]), ol: new Set(["start"]), li: new Set(["value"]) };

function text(value, label = "Note content") {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  if (Buffer.byteLength(value, "utf8") > LIMIT) throw new Error(`${label} exceeds the 2 MiB note limit.`);
  return value.replace(/\r\n?/g, "\n");
}

function identity(value) {
  if (!value || !SERVER.test(value.serverId || "") || !KEY.test(value.key || "")
    || !KEY.test(value.parentKey || "") || !Number.isSafeInteger(value.version) || value.version < 0) {
    throw new Error("The note has invalid Zotero identity metadata.");
  }
  return { serverId: value.serverId, key: value.key, parentKey: value.parentKey, version: value.version };
}

function contentHash(value) {
  return createHash("sha256").update(text(value), "utf8").digest("hex");
}

function noteFilename(title, index = 1) {
  if (!Number.isSafeInteger(index) || index < 1 || index > 10000) throw new Error("A valid note filename index is required.");
  let stem = text(typeof title === "string" ? title : "Paper note", "Paper title").normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, "");
  if (!stem) stem = "Paper note";
  let prefix = "", length = 0;
  for (const point of stem) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (length + bytes > 220) break;
    prefix += point;
    length += bytes;
  }
  return `${prefix.replace(/[. ]+$/g, "")}${index === 1 ? "" : ` (${index})`}.md`;
}

function scalar(value) {
  const input = value.trim();
  if (input.startsWith('"')) {
    const match = input.match(/^("(?:\\.|[^"\\])*")(?:\s+#.*)?$/);
    if (!match) throw new Error("The note frontmatter contains an invalid quoted value.");
    return JSON.parse(match[1]);
  }
  if (input.startsWith("'")) {
    const match = input.match(/^'((?:''|[^'])*)'(?:\s+#.*)?$/);
    if (!match) throw new Error("The note frontmatter contains an invalid quoted value.");
    return match[1].replace(/''/g, "'");
  }
  return input.replace(/\s+#.*$/, "").trim();
}

function parseMarkdown(value, registered) {
  const source = text(value).replace(/^\uFEFF/, "");
  if (!source.startsWith("---\n")) throw new Error("The note is missing paper frontmatter.");
  const end = source.indexOf("\n---", 4);
  if (end < 0 || !/^\n---(?:\n|$)/.test(source.slice(end))) throw new Error("The note frontmatter is incomplete.");
  const headerLines = source.slice(4, end).split("\n");
  const values = {};
  for (const line of headerLines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (!match || (!OWNED.has(match[1]) && match[1] !== "title")) continue;
    if (Object.hasOwn(values, match[1])) throw new Error(`Duplicate frontmatter field: ${match[1]}.`);
    values[match[1]] = scalar(match[2]);
  }
  let checked = {};
  const legacy = [...OWNED].some(field => Object.hasOwn(values, field));
  if (legacy) {
    const version = values["zotero-version"];
    if (!/^\d+$/.test(String(version ?? ""))) throw new Error("The note version must be a nonnegative integer.");
    checked = identity({ serverId: values["zotero-server-id"], key: values["zotero-key"],
      parentKey: values["zotero-parent-key"], version: Number(version) });
  }
  let body = source.slice(end + 4);
  if (body.startsWith("\n")) body = body.slice(1);
  if (body.startsWith("\n")) body = body.slice(1);
  const marker = body.match(/^<!-- noema-shared-note:([0-9a-f-]+) -->\n(?:\n)?/);
  const fileId = marker?.[1];
  if (fileId && !FILE_ID.test(fileId)) throw new Error("The shared-note file identity is invalid.");
  if (marker) body = body.slice(marker[0].length);
  if (/^<!-- noema-shared-note:/m.test(body)) throw new Error("Duplicate or misplaced shared-note identity marker.");
  if (registered) {
    const expected = identity(registered);
    if (legacy && (checked.serverId !== expected.serverId || checked.parentKey !== expected.parentKey
      || (checked.key !== expected.key && !(registered.pendingCreation && checked.key === registered.pendingKey)))) {
      throw new Error("The Markdown file belongs to a different Zotero note.");
    }
    if (fileId && fileId !== registered.fileId || !legacy && (!fileId || !FILE_ID.test(registered.fileId || ""))) {
      throw new Error("Shared-note identity changed. Keep its hidden file marker intact.");
    }
    if (!legacy) checked = expected;
  }
  return { ...checked, fileId, legacy, title: typeof values.title === "string" ? values.title : "", body, headerLines };
}

// Bibliographic fields come from the parent paper. Empty fields are omitted.
function paperProperties(paper) {
  if (!paper) return [];
  const fields = [];
  const add = (name, value) => { if (typeof value === "string" && value.trim()) fields.push(`${name}: ${JSON.stringify(text(value.trim(), "Paper metadata"))}`); };
  add("paper", paper.title);
  const authors = (Array.isArray(paper.authors) ? paper.authors : []).filter(value => typeof value === "string" && value.trim());
  if (authors.length) fields.push(`authors: ${JSON.stringify(authors.map(value => text(value.trim(), "Author")))}`);
  // A regular list preserves Zotero's spaces and case without altering native
  // Obsidian tags. This metadata belongs to the parent paper, not its child note.
  const tags = [...new Set((Array.isArray(paper.tags) ? paper.tags : []).filter(value =>
    typeof value === "string" && value.length <= 1024 && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value)))];
  if (tags.length) fields.push(`paper-tags: ${JSON.stringify(tags)}`);
  add("conference", paper.conference || (paper.itemType === "conferencePaper" ? paper.proceedings : ""));
  if (paper.proceedings && paper.proceedings !== paper.conference) add("proceedings", paper.proceedings);
  add("journal", paper.journal);
  if (/^\d{4}$/.test(paper.year || "")) fields.push(`year: ${paper.year}`);
  add("doi", paper.doi);
  add("url", paper.url);
  return fields;
}

function makeMarkdown({ serverId, key, parentKey, version, fileId, paper, title = "Paper note", body = "", existing, registered } = {}) {
  const checked = identity({ serverId, key, parentKey, version });
  if (!FILE_ID.test(fileId || "")) throw new Error("A private registry file identity is required for shared notes.");
  let preserved;
  if (existing !== undefined) {
    const previous = parseMarkdown(existing, registered || { ...checked, fileId });
    if (previous.serverId !== serverId || previous.parentKey !== parentKey
      || (previous.key !== key && !(registered?.pendingCreation && registered.pendingKey === key))) {
      throw new Error("The existing Markdown file belongs to a different Zotero note.");
    }
    // Remove entire owned YAML blocks, keeping user properties and nested values.
    preserved = [];
    let skip = false;
    for (const line of previous.headerLines) {
      const mapping = line.match(/^(?![-?](?:\s|$))("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^ \t#][^:]*):(?:\s|$)/);
      if (mapping) {
        const field = scalar(mapping[1]);
        // Missing tag metadata in an older cache is unknown; only a known
        // array, including [], can replace the previous Zotero tag property.
        skip = field.startsWith("zotero-") || (paper && PAPER_FIELDS.has(field)
          && (field !== "paper-tags" || Array.isArray(paper.tags)));
      }
      if (!skip) preserved.push(line);
    }
    // The generated alias repeated the title; retain meaningful custom aliases.
    preserved = preserved.filter(line => line !== `aliases: [${JSON.stringify(previous.title)}]`);
  } else {
    const label = text(title, "Paper title");
    preserved = [`title: ${JSON.stringify(label)}`];
  }
  const fields = [
    ...preserved, ...paperProperties(paper)
  ];
  return `---\n${fields.join("\n")}\n---\n\n<!-- noema-shared-note:${fileId} -->\n\n${text(body)}`;
}

function parser(DOMParser) {
  if (typeof DOMParser !== "function") throw new Error("A DOMParser from Obsidian is required for note conversion.");
  return new DOMParser();
}

function unsafeHTML(source) {
  // Check before parsing so active elements cannot initiate resource loading.
  return /<\s*(?:script|style|iframe|object|embed|form|input|button|link|meta|base)\b/i.test(source)
    || /\s+on[a-z]+\s*=/i.test(source)
    || /(?:href|src|action)\s*=\s*["']?\s*(?:javascript|vbscript)\s*:/i.test(source);
}

function inspectHTML(source, DOMParser) {
  const html = text(source, "Zotero note HTML");
  if (unsafeHTML(html)) throw new Error("Active HTML cannot be synchronized. Keep it in a separate local note.");
  const document = parser(DOMParser).parseFromString(html, "text/html");
  for (const node of document.body.querySelectorAll("*")) {
    if (!HTML_TAGS.has(node.localName)) throw new Error(`Unsupported note HTML element: ${node.localName}.`);
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || name === "srcdoc") throw new Error("Active HTML attributes cannot be synchronized.");
      if (["href", "src", "action", "xlink:href"].includes(name)) {
        const compact = value.replace(/[\u0000-\u0020]/g, "");
        if (/^(?:javascript|vbscript):/i.test(compact) || (/^data:/i.test(compact) && !/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(compact))) {
          throw new Error("The note contains an unsafe resource URL.");
        }
      }
      if (name === "style" && /(?:url\s*\(|expression\s*\(|@import)/i.test(value)) throw new Error("External or active CSS cannot be synchronized.");
    }
  }
  return document;
}

function rich(node) {
  const elements = node.nodeType === 1 ? [node, ...node.querySelectorAll("*")] : [];
  return elements.some(element => Array.from(element.attributes).some(attribute =>
    !BASIC_ATTRIBUTES[element.localName]?.has(attribute.name.toLowerCase())
  )) || elements.some(element => ["img", "table", "mark", "span", "div"].includes(element.localName));
}

function escapeHTML(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function remoteToMarkdown(value, { htmlToMarkdown, DOMParser } = {}) {
  const html = text(value, "Zotero note HTML");
  let document;
  try { document = inspectHTML(html, DOMParser); }
  catch (error) {
    // Unsupported HTML is visible as source text, never rendered as active HTML.
    const fence = "`".repeat((html.match(/`+/g) || []).reduce((length, run) => Math.max(length, run.length + 1), 3));
    return { body: `${fence}html\n${html}\n${fence}`, canPush: false, reasons: [error.message] };
  }
  let container = document.body;
  const wrapper = container.children.length === 1 ? container.firstElementChild : null;
  if (wrapper?.localName === "div" && Array.from(wrapper.attributes).every(a => a.name === "data-schema-version")) container = wrapper;
  const chunks = [];
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === 8 || (node.nodeType === 3 && !node.textContent.trim())) continue;
    const source = node.nodeType === 1 ? node.outerHTML : escapeHTML(node.textContent);
    if (rich(node) || typeof htmlToMarkdown !== "function") chunks.push(source);
    else {
      const converted = htmlToMarkdown(source);
      if (typeof converted !== "string") throw new Error("htmlToMarkdown must return text synchronously.");
      chunks.push(converted.trim());
    }
  }
  return { body: chunks.filter(Boolean).join("\n\n"), canPush: true, reasons: [] };
}

function htmlToken(source, start) {
  const match = source.slice(start).match(/^<(\/)?([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/);
  if (!match) return null;
  let quote = null;
  for (let i = start + match[0].length; i < source.length; i++) {
    const char = source[i];
    if (quote) { if (char === quote) quote = null; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return { tag: match[2].toLowerCase(), close: !!match[1], end: i + 1,
      empty: /\/\s*>$/.test(source.slice(start, i + 1)) };
  }
  throw new Error("The Markdown contains an incomplete HTML tag.");
}

function protectHTML(body, DOMParser) {
  const prefix = `NOEMAZOTERORAW${contentHash(body).slice(0, 24).toUpperCase()}TOKEN`;
  if (body.includes(prefix)) throw new Error("The note contains a reserved conversion marker.");
  const fragments = [];
  let output = "", cursor = 0, i = 0, codeFence = null;
  while (i < body.length) {
    const atLine = i === 0 || body[i - 1] === "\n";
    if (atLine) {
      const fence = body.slice(i).match(/^ {0,3}(`{3,}|~{3,})([^\n]*)/);
      if (fence) {
        if (!codeFence) codeFence = fence[1];
        else if (fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length && !fence[2].trim()) codeFence = null;
        i += fence[0].length;
        continue;
      }
    }
    if (codeFence) { i++; continue; }
    if (body[i] === "`") {
      const ticks = body.slice(i).match(/^`+/)[0];
      const end = body.indexOf(ticks, i + ticks.length);
      i = end < 0 ? i + ticks.length : end + ticks.length;
      continue;
    }
    if (body[i] !== "<" || (i > 0 && body[i - 1] === "\\")) { i++; continue; }
    const token = htmlToken(body, i);
    if (!token) { i++; continue; }
    if (token.close) throw new Error("The Markdown contains an unmatched HTML closing tag.");
    if (!HTML_TAGS.has(token.tag)) throw new Error(`Unsupported note HTML element: ${token.tag}.`);
    let end = token.end;
    if (!token.empty && !VOID.has(token.tag)) {
      const stack = [token.tag];
      while (stack.length && end < body.length) {
        const next = body.indexOf("<", end);
        if (next < 0) break;
        if (body.startsWith("<!--", next)) {
          const commentEnd = body.indexOf("-->", next + 4);
          if (commentEnd < 0) throw new Error("The Markdown contains an incomplete HTML comment.");
          end = commentEnd + 3;
          continue;
        }
        const nested = htmlToken(body, next);
        if (!nested) { end = next + 1; continue; }
        if (nested.close) {
          if (nested.tag !== stack.pop()) throw new Error("The Markdown contains unbalanced raw HTML.");
        } else if (!nested.empty && !VOID.has(nested.tag)) stack.push(nested.tag);
        end = nested.end;
      }
      if (stack.length) throw new Error("The Markdown contains incomplete raw HTML.");
    }
    const raw = body.slice(i, end);
    inspectHTML(raw, DOMParser);
    const marker = `${prefix}${fragments.length}END`;
    fragments.push({ marker, raw });
    output += body.slice(cursor, i) + marker;
    cursor = end;
    i = end;
  }
  return { body: output + body.slice(cursor), fragments };
}

async function markdownToZotero(value, { markdownToHTML, DOMParser } = {}) {
  const body = text(value);
  if (typeof markdownToHTML !== "function") throw new Error("A Markdown-to-HTML renderer from Obsidian is required.");
  // These constructs cannot round-trip through Zotero's HTML note editor.
  if (/^\s*[-*+]\s+\[[ xX]\]\s/m.test(body) || /^\s*```(?:dataview(?:js)?|tasks)\b/m.test(body)
    || /!\[\[/.test(body)) throw new Error("Task checkboxes, executable queries, and wiki embeds cannot be synchronized safely.");
  const protectedBody = protectHTML(body, DOMParser);
  let html = text(await markdownToHTML(protectedBody.body), "Rendered note HTML");
  for (const fragment of protectedBody.fragments) {
    if (html.split(fragment.marker).length !== 2) throw new Error("The Markdown renderer changed protected Zotero HTML.");
    // A whole raw block must not be nested inside a renderer-generated paragraph.
    html = html.replace(new RegExp(`<p(?:\\s[^>]*)?>\\s*${fragment.marker}\\s*</p>`, "g"), fragment.raw);
    html = html.replace(fragment.marker, fragment.raw);
  }
  inspectHTML(html, DOMParser);
  return `<div data-schema-version="9">${html}</div>`;
}

function createBaseline({ serverId, key, parentKey, version, localBody, remoteHTML, canPush = true } = {}) {
  const checked = identity({ serverId, key, parentKey, version });
  const body = text(localBody), html = text(remoteHTML, "Zotero note HTML");
  if (typeof canPush !== "boolean") throw new Error("The baseline requires an explicit conversion safety flag.");
  return { schema: 1, ...checked, localBody: body, remoteHTML: html, canPush,
    localHash: contentHash(body), remoteHash: contentHash(html) };
}

function decideSync({ base, local, remote } = {}) {
  const result = (action, reason) => ({ action, reason });
  if (!remote) return result("conflict", "The Zotero note is unavailable. The local Markdown note has been preserved.");
  let checked;
  try { checked = identity(remote); text(remote.html, "Zotero note HTML"); }
  catch (error) { return result("conflict", error.message); }
  if (!local) return result("pull", "Create the local note from Zotero.");
  try { identity(local); text(local.body); }
  catch (error) { return result("conflict", error.message); }
  if (["serverId", "key", "parentKey"].some(field => local[field] !== checked[field])) {
    return result("conflict", "The Markdown and Zotero identities differ. Neither side has been changed.");
  }
  try {
    identity(base);
    if (base.schema !== 1 || typeof base.canPush !== "boolean"
      || ["serverId", "key", "parentKey"].some(field => base[field] !== checked[field])
      || contentHash(base.localBody) !== base.localHash || contentHash(base.remoteHTML) !== base.remoteHash) throw new Error("invalid");
  } catch (_) { return result("conflict", "No matching synchronization baseline exists. Review both versions before replacing either side."); }
  if (local.version !== base.version || remote.version < base.version) {
    return result("conflict", "The note version does not match its synchronization baseline.");
  }
  const localChanged = contentHash(local.body) !== base.localHash;
  const remoteChanged = contentHash(remote.html) !== base.remoteHash;
  if (localChanged && base.canPush === false) {
    return result("conflict", "The source note uses unsupported HTML. Its local source mirror cannot replace the Zotero note.");
  }
  if (localChanged && (remoteChanged || remote.version !== base.version)) {
    return result("conflict", "Both sides changed since the last synchronization. Review both versions.");
  }
  if (remoteChanged) return result("pull", "Only the Zotero note changed.");
  if (localChanged) return result("push", "Only the local Markdown body changed. Explicit write authorization is required.");
  return result("unchanged", remote.version === base.version ? "Both sides are unchanged." : "Only the Zotero version changed; advance the saved baseline.");
}

module.exports = { noteFilename, makeMarkdown, parseMarkdown, paperProperties, remoteToMarkdown, markdownToZotero,
  contentHash, createBaseline, decideSync };
