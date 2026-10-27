"use strict";

function paths(root) {
  if (typeof root !== "string" || !root.startsWith("corpus/") || /[\\\x00-\x1f]/.test(root)
    || root.split("/").some(part => ["", ".", ".."].includes(part))) throw new Error("Configure a safe Zotero research_folder under corpus/.");
  const unfiled = `${root}/papers`;
  return Object.freeze({ root, catalog: `${root}/fields.json`, unfiled,
    legacy: Object.freeze([`${unfiled}/notes`, `${unfiled}/unfiled`]) });
}
const ID = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/;
const KEY = /^[A-Z0-9]{8}$/;
const normalized = value => String(value || "").trim().toLowerCase();

function createCatalog(value, root) {
  const layout = paths(root);
  if (value?.schema !== 1 || !Array.isArray(value.fields) || !value.fields.length || value.fields.length > 128) {
    throw new Error("Research fields.json must contain a version 1 field catalog.");
  }
  const seen = new Set();
  const fields = value.fields.map(field => {
    if (!ID.test(field?.id || "") || ["papers", "unfiled"].includes(field.id.split("/")[0]) || seen.has(field.id)
      || typeof field.name !== "string" || !field.name.trim()
      || !Array.isArray(field.tags) || field.tags.some(tag => typeof tag !== "string" || !tag.trim() || /[\x00-\x1f\x7f]/.test(tag))
      || (field.collections !== undefined && (!Array.isArray(field.collections) || field.collections.some(key => !KEY.test(key))))) {
      throw new Error("Research fields must have unique safe IDs, names, tags and optional collection keys.");
    }
    seen.add(field.id);
    return Object.freeze({ ...field, tags: Object.freeze(field.tags.map(normalized)), collections: Object.freeze(field.collections || []) });
  });
  function get(id) { return fields.find(field => field.id === id); }
  function directory(id) {
    if (id === null || id === "") return layout.unfiled;
    if (!get(id)) throw new Error("Choose a field from the configured fields.json.");
    return `${root}/${id}/papers`;
  }
  function fieldForPath(value) {
    return fields.find(field => typeof value === "string" && value.startsWith(`${directory(field.id)}/`))?.id || null;
  }
  function validPath(value) {
    if (typeof value !== "string" || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) || !value.endsWith(".md")) return false;
    const parent = value.slice(0, value.lastIndexOf("/"));
    const filename = value.slice(value.lastIndexOf("/") + 1);
    return filename.toLowerCase() !== "readme.md" && ![".", ".."].includes(filename)
      && [...layout.legacy, layout.unfiled, ...fields.map(field => directory(field.id))].includes(parent);
  }
  function classify(paper, override) {
    if (override !== undefined) return { field: get(override)?.id || null, reason: "Selected field", candidates: [] };
    const tags = (paper?.tags || []).filter(tag => typeof tag === "string").map(normalized);
    const explicit = [...new Set(tags.filter(tag => tag.startsWith("field:")).map(tag => tag.slice(6)))];
    if (explicit.length) {
      return explicit.length === 1 && get(explicit[0])
        ? { field: explicit[0], reason: "Zotero field tag", candidates: explicit }
        : { field: null, reason: "Review Zotero field tags", candidates: explicit.filter(id => get(id)) };
    }
    const candidates = fields.filter(field => field.tags.some(tag => tags.includes(tag))
      || field.collections.some(key => (paper?.collections || []).includes(key))).map(field => field.id);
    return { field: candidates.length === 1 ? candidates[0] : null,
      reason: candidates.length > 1 ? "Multiple fields match" : candidates.length ? "Zotero topic mapping" : "No field mapping", candidates };
  }
  return Object.freeze({ fields: Object.freeze(fields), get, directory, fieldForPath, validPath, classify });
}

module.exports = { paths, createCatalog };
