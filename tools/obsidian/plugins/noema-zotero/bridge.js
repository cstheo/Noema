"use strict";

const { fileURLToPath } = require("node:url");
const { isAbsolute } = require("node:path");

const DEFAULT_BASE_URL = "http://127.0.0.1:23119/api";
const PAGE_SIZE = 100;
const KEY = /^[A-Z0-9]{8}$/;
const METADATA_SCHEMA = 3;

// request(url) must perform GET without following redirects. It returns status
// (or statusCode), headers (a record or Headers), and json/text as parsed values
// or async functions, supporting Obsidian requestUrl responses and fetch alike.
function localBase(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.port !== new URL(DEFAULT_BASE_URL).port || !/^\/api\/?$/.test(url.pathname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error(`Use the loopback Zotero API at ${DEFAULT_BASE_URL}.`);
  }
  return `${url.origin}/api`;
}

function header(response, name) {
  if (typeof response.headers?.get === "function") return response.headers.get(name);
  const entry = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1]) : null;
}

async function readJson(response) {
  if (typeof response.json === "function") return response.json();
  if (response.json !== undefined) return response.json;
  return JSON.parse(await readText(response));
}

async function readText(response) {
  if (typeof response.text === "function") return response.text();
  if (typeof response.text === "string") return response.text;
  throw new Error("The local Zotero API returned an unreadable response.");
}

async function get(request, url) {
  if (typeof request !== "function") throw new Error("A read-only Zotero request function is required.");
  const response = await request(url);
  const status = Number(response?.status ?? response?.statusCode);
  if (status !== 200) throw new Error(`The local Zotero API returned HTTP ${status || "unknown"}.`);
  return response;
}

function integer(value, label) {
  if (value === null || value === undefined || !/^\d+$/.test(String(value))) {
    throw new Error(`The local Zotero API did not provide a valid ${label}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`The Zotero ${label} is too large.`);
  return number;
}

function changed() {
  const error = new Error("Zotero changed during this refresh. Refresh again to get a consistent library.");
  error.code = "LIBRARY_CHANGED";
  return error;
}

function checkVersion(response, state) {
  const serverId = header(response, "Zotero-Server-ID");
  const version = integer(header(response, "Last-Modified-Version"), "library version");
  if (!serverId) throw new Error("The local Zotero API did not provide a server ID.");
  if (state.serverId === null) {
    state.serverId = serverId;
    state.libraryVersion = version;
  } else if (state.serverId !== serverId || state.libraryVersion !== version) {
    throw changed();
  }
}

function endpoint(base, path, params) {
  const url = new URL(`${base}/users/0/${path}`);
  for (const [key, values] of Object.entries(params)) {
    for (const value of Array.isArray(values) ? values : [values]) url.searchParams.append(key, String(value));
  }
  return url.href;
}

async function pages(request, base, path, params, state) {
  const result = [];
  const seen = new Set();
  let total = null;
  do {
    const response = await get(request, endpoint(base, path, {
      v: 3, format: "json", include: "data", ...params, limit: PAGE_SIZE, start: result.length
    }));
    checkVersion(response, state);
    const currentTotal = integer(header(response, "Total-Results"), "result count");
    if (total !== null && total !== currentTotal) throw changed();
    total = currentTotal;
    const page = await readJson(response);
    if (!Array.isArray(page) || page.length !== Math.min(PAGE_SIZE, total - result.length)) {
      throw new Error("The local Zotero API returned an incomplete page.");
    }
    for (const row of page) {
      const key = row?.key || row?.data?.key;
      if (!KEY.test(key || "") || !row?.data || seen.has(key)) {
        throw new Error("The local Zotero API returned invalid or duplicate records.");
      }
      seen.add(key);
      result.push(row);
    }
  } while (result.length < total);
  return result;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function creatorName(creator) {
  if (!creator || typeof creator !== "object" || Array.isArray(creator)) return "";
  // Zotero uses name for a single-field (corporate) creator. Preserve it as a
  // whole display name rather than splitting it into first/last components.
  return text(creator.name) || [text(creator.firstName), text(creator.lastName)].filter(Boolean).join(" ");
}

function deleted(data) {
  return data.deleted === true || data.deleted === 1 || data.deleted === "1";
}

function keys(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === "string" && KEY.test(value)))];
}

function validTag(value) {
  return typeof value === "string" && value.length <= 1024 && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

function tags(values) {
  // Display and filter by Zotero's original names without inferring a local
  // taxonomy or writing any library metadata back to Zotero.
  return [...new Set((Array.isArray(values) ? values : []).map(value => value?.tag).filter(validTag))];
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  // Keep Zotero's timestamp, including its explicit timezone, rather than
  // inventing a date or interpreting timezone-free input in the local zone.
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour = "0", offsetMinute = "0"] = match;
  const leapYear = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days[Number(month) - 1]
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
    && Number(offsetHour) < 24 && Number(offsetMinute) < 60 && Number.isFinite(Date.parse(value));
}

function timestamp(value) {
  return validTimestamp(value) ? value : "";
}

function pdfPath(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost") || url.search || url.hash) return null;
    const path = fileURLToPath(url);
    return isAbsolute(path) && !path.includes("\0") && /\.pdf$/i.test(path) ? path : null;
  } catch (_) {
    return null;
  }
}

function attachment(row) {
  const data = row.data;
  const result = {
    key: row.key || data.key,
    title: text(data.title) || text(data.filename),
    contentType: text(data.contentType),
    linkMode: typeof data.linkMode === "string" || typeof data.linkMode === "number" ? data.linkMode : ""
  };
  if (result.contentType.toLowerCase() === "application/pdf") {
    const path = pdfPath(row.links?.enclosure?.href);
    if (path) result.path = path;
  }
  return result;
}

function item(row, attachments) {
  const data = row.data;
  const key = row.key || data.key;
  const creators = Array.isArray(data.creators) ? data.creators : [];
  const conference = text(data.conferenceName);
  const proceedings = text(data.proceedingsTitle);
  const journal = text(data.publicationTitle);
  const publication = proceedings || journal || text(data.bookTitle);
  const date = text(data.date);
  return {
    key,
    title: text(data.title) || text(data.filename),
    creators: creators.map(creatorName).filter(Boolean).join("; "),
    authors: creators.filter(creator => creator?.creatorType === "author").map(creatorName).filter(Boolean),
    year: date.match(/\b\d{4}\b/)?.[0] || "",
    conference,
    proceedings,
    journal,
    publication,
    venue: conference || publication,
    date,
    dateAdded: timestamp(data.dateAdded),
    dateModified: timestamp(data.dateModified),
    publisher: text(data.publisher),
    itemType: text(data.itemType),
    url: text(data.url),
    doi: text(data.DOI) || text(data.doi),
    tags: tags(data.tags),
    collections: keys(data.collections),
    attachments: data.itemType === "attachment" ? [attachment(row)] : attachments.get(key) || []
  };
}

function reusableSnapshot(previous, state) {
  return previous?.schema === 1 && previous.metadataSchema === METADATA_SCHEMA && previous.serverId === state.serverId
    && previous.libraryVersion === state.libraryVersion
    && Array.isArray(previous.collections) && Array.isArray(previous.items)
    && previous.collections.every(collection => collection && KEY.test(collection.key || "")
      && typeof collection.name === "string" && Number.isSafeInteger(collection.itemCount)
      && collection.itemCount >= 0 && (collection.parentKey === null || KEY.test(collection.parentKey || "")))
    && previous.items.every(value => value && KEY.test(value.key || "")
      && ["title", "creators", "year", "itemType", "url", "doi", "conference", "proceedings", "journal",
        "publication", "venue", "date", "publisher"].every(field => typeof value[field] === "string")
      && Array.isArray(value.authors) && value.authors.every(author => typeof author === "string" && !!author.trim())
      && Array.isArray(value.tags) && value.tags.every(validTag) && new Set(value.tags).size === value.tags.length
      && [value.dateAdded, value.dateModified].every(value => value === "" || validTimestamp(value))
      && !["note", "annotation"].includes(value.itemType)
      && Array.isArray(value.collections) && value.collections.every(key => KEY.test(key || ""))
      && Array.isArray(value.attachments) && value.attachments.every(file => file && KEY.test(file.key || "")
        && typeof file.title === "string" && typeof file.contentType === "string"
        && ["string", "number"].includes(typeof file.linkMode)
        && (file.path === undefined || (typeof file.path === "string" && isAbsolute(file.path)
          && !file.path.includes("\0") && /\.pdf$/i.test(file.path)))));
}

async function probeVersion(request, base, state) {
  // Use versions rather than item data for the final consistency check.
  const probe = await get(request, endpoint(base, "items/top", {
    v: 3, format: "versions", itemType: ["-note", "-annotation"], includeTrashed: 0, limit: 1, start: 0
  }));
  checkVersion(probe, state);
}

/**
 * Fetch a complete read-only My Library snapshot. Notes and annotations are
 * excluded at request time; only selected bibliographic fields are retained.
 * A valid prior snapshot with the current metadata schema, server ID and
 * library version is reused after collection reads and a final version probe,
 * with a fresh fetchedAt. Older metadata shapes require a full fetch.
 * Changed identities/versions require a full refresh, accounting for deletions.
 * The prior snapshot is never mutated or incrementally merged.
 */
async function loadLibrary({ request, baseUrl = DEFAULT_BASE_URL, previous = null } = {}) {
  const base = localBase(baseUrl);
  const state = { serverId: null, libraryVersion: null };
  const rawCollections = await pages(request, base, "collections", {}, state);
  if (reusableSnapshot(previous, state)) {
    await probeVersion(request, base, state);
    return { schema: 1, metadataSchema: METADATA_SCHEMA, ...state, fetchedAt: new Date().toISOString(),
      collections: previous.collections, items: previous.items };
  }
  const rawItems = await pages(request, base, "items/top", {
    itemType: ["-note", "-annotation"], includeTrashed: 0
  }, state);
  const rawAttachments = await pages(request, base, "items", {
    itemType: "attachment", includeTrashed: 0
  }, state);
  await probeVersion(request, base, state);

  const attached = new Map();
  for (const row of rawAttachments) {
    const data = row.data;
    if (data.itemType !== "attachment" || deleted(data) || !data.parentItem) continue;
    if (!attached.has(data.parentItem)) attached.set(data.parentItem, []);
    attached.get(data.parentItem).push(attachment(row));
  }
  // Zotero's filtered /top search may re-include children. Keep only actual
  // top-level entries, including standalone attachments such as image files.
  const items = rawItems.filter(row => !row.data.parentItem && !deleted(row.data)
    && !["note", "annotation"].includes(row.data.itemType)).map(row => item(row, attached));
  const collections = rawCollections.filter(row => !deleted(row.data)).map(row => {
    const count = Number(row.meta?.numItems);
    const key = row.key || row.data.key;
    return {
      key,
      name: text(row.data.name),
      parentKey: text(row.data.parentCollection) || null,
      itemCount: Number.isSafeInteger(count) && count >= 0 ? count : items.filter(value => value.collections.includes(key)).length
    };
  });
  return { schema: 1, metadataSchema: METADATA_SCHEMA, ...state, fetchedAt: new Date().toISOString(), collections, items };
}

/** The caller must select a PDF attachment from snapshot metadata first. */
async function resolvePdfPath({ request, attachmentKey, baseUrl = DEFAULT_BASE_URL } = {}) {
  const base = localBase(baseUrl);
  if (!KEY.test(attachmentKey || "")) throw new Error("A valid Zotero attachment key is required.");
  const response = await get(request, `${base}/users/0/items/${attachmentKey}/file/view/url`);
  const path = pdfPath((await readText(response)).trim());
  if (!path) throw new Error("Zotero did not return an absolute local PDF file URL.");
  return path;
}

module.exports = { BASE_URL: DEFAULT_BASE_URL, PAGE_SIZE, loadLibrary, resolvePdfPath };
