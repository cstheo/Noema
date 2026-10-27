"use strict";

const KEY = /^[A-Z0-9]{8}$/;
const MAX_TAGS = 64;
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const SORT_OPTIONS = Object.freeze([
  { value: "title", label: "Title", direction: "asc" },
  { value: "year", label: "Year", direction: "desc" },
  { value: "author", label: "Author", direction: "asc" },
  { value: "venue", label: "Venue", direction: "asc" },
  { value: "added", label: "Added", direction: "desc" },
  { value: "modified", label: "Modified", direction: "desc" }
].map(Object.freeze));

function validTag(value) {
  return typeof value === "string" && value.length <= 1024 && !!value.trim()
    && !/[\x00-\x1f\x7f]/.test(value);
}

function uniqueTags(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(validTag))];
}

function itemTags(item) {
  return uniqueTags(item?.tags);
}

function normalizeState(value) {
  const state = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const option = SORT_OPTIONS.find(option => option.value === state.sort) || SORT_OPTIONS[0];
  return {
    collection: typeof state.collection === "string" && KEY.test(state.collection) ? state.collection : "",
    query: typeof state.query === "string" ? state.query.slice(0, 4096) : "",
    tags: uniqueTags(Array.isArray(state.tags) ? state.tags : [state.tag]).slice(0, MAX_TAGS),
    tagMode: state.tagMode === "any" ? "any" : "all",
    pdfOnly: state.pdfOnly === true,
    descendants: state.descendants !== false,
    sort: option.value,
    direction: state.direction === "asc" || state.direction === "desc" ? state.direction : option.direction
  };
}

function matchesTags(item, tags, tagMode = "all") {
  const selected = uniqueTags(tags);
  if (!selected.length) return true;
  const present = new Set(itemTags(item));
  return tagMode === "any" ? selected.some(tag => present.has(tag)) : selected.every(tag => present.has(tag));
}

function compareNames(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function tagFacets(items, selectedTags = []) {
  const counts = new Map(uniqueTags(selectedTags).map(tag => [tag, 0]));
  for (const item of Array.isArray(items) ? items : []) {
    for (const tag of itemTags(item)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts].sort(([a], [b]) => compareNames(a, b)).map(([tag, count]) => ({ tag, count }));
}

function text(value) {
  return typeof value === "string" && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
}

function year(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d{1,4}$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 9999 ? parsed : null;
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, min, sec, , zone] = match;
  const fullYear = Number(y), month = Number(m), day = Number(d);
  const leap = fullYear % 4 === 0 && (fullYear % 100 !== 0 || fullYear % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (fullYear < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  if (h !== undefined && (Number(h) > 23 || Number(min) > 59 || Number(sec) > 59)) return null;
  if (zone && zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sortValue(item, sort) {
  switch (sort) {
    case "year": return year(item?.year);
    case "author": return text(Array.isArray(item?.authors) ? item.authors[0] : null)
      || text(typeof item?.creators === "string" ? item.creators.split(";")[0] : null);
    case "venue": return text(item?.venue);
    case "added": return timestamp(item?.dateAdded);
    case "modified": return timestamp(item?.dateModified);
    default: return text(item?.title);
  }
}

function compareValues(a, b, direction = 1) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return direction * (typeof a === "number" ? a - b : collator.compare(a, b));
}

function sortItems(items, sort = "title", direction) {
  const option = SORT_OPTIONS.find(option => option.value === sort) || SORT_OPTIONS[0];
  const order = (direction === "asc" || direction === "desc" ? direction : option.direction) === "desc" ? -1 : 1;
  return (Array.isArray(items) ? items : []).map((item, index) => ({ item, index, value: sortValue(item, option.value) }))
    .sort((a, b) => compareValues(a.value, b.value, order)
      || compareValues(text(a.item?.title), text(b.item?.title))
      || compareValues(text(a.item?.key), text(b.item?.key))
      || a.index - b.index)
    .map(entry => entry.item);
}

module.exports = { SORT_OPTIONS, itemTags, normalizeState, sortItems, matchesTags, tagFacets };
