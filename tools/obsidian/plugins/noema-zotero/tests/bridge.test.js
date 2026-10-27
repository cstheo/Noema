"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLibrary } = require("../bridge.js");

const KEY = "PAPERAAA";
const SERVER = "test-server";
const VERSION = 12;
const METADATA_SCHEMA = 3;
const METADATA_STRINGS = ["conference", "proceedings", "journal", "publication", "venue", "date", "publisher",
  "dateAdded", "dateModified"];

function row(data = {}, key = KEY) {
  return { key, data: { key, itemType: "conferencePaper", title: "A paper", creators: [], date: "2026-10-06", ...data } };
}

function api({ items = [row()], attachments = [], collections = [], serverId = SERVER, version = VERSION,
  responseVersion = () => version } = {}) {
  const requests = [];
  async function request(value, ...options) {
    assert.equal(options.length, 0, "The library bridge uses read-only GET requests");
    const url = new URL(value);
    requests.push(url);
    let values;
    if (url.pathname.endsWith("/collections")) values = collections;
    else if (url.pathname.endsWith("/items/top") && url.searchParams.get("format") === "versions") values = [];
    else if (url.pathname.endsWith("/items/top")) values = items;
    else if (url.pathname.endsWith("/items")) values = attachments;
    else throw new Error(`Unexpected endpoint: ${url.pathname}`);
    const start = Number(url.searchParams.get("start")), limit = Number(url.searchParams.get("limit"));
    return { status: 200, headers: { "Zotero-Server-ID": serverId,
      "Last-Modified-Version": String(responseVersion(url)), "Total-Results": String(values.length) },
      json: values.slice(start, start + limit) };
  }
  return { request, requests,
    itemReads: () => requests.filter(url => url.pathname.endsWith("/items/top") && url.searchParams.get("format") === "json").length,
    attachmentReads: () => requests.filter(url => url.pathname.endsWith("/items")).length,
    probes: () => requests.filter(url => url.searchParams.get("format") === "versions").length };
}

async function normalized(data) {
  return (await loadLibrary(api({ items: [row(data)] }))).items[0];
}

function freeze(value) {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

test("conference metadata keeps author order and corporate names while retaining the creator display", async () => {
  const paper = await normalized({
    creators: [
      { creatorType: "author", firstName: " Ada ", lastName: " Lovelace " },
      { creatorType: "editor", firstName: "Grace", lastName: "Hopper" },
      { creatorType: "author", name: " Example Research & Development Group ", firstName: "Ignore", lastName: "These" },
      { creatorType: "author", firstName: " 李 ", lastName: " 华 " },
      { creatorType: "translator", name: "Translation Team" },
      { creatorType: "author", name: " " }, null, "invalid"
    ],
    conferenceName: " USENIX Annual Technical Conference ",
    proceedingsTitle: " Proceedings of USENIX ATC 2026 ",
    publisher: " USENIX Association ", date: " October 6, 2026 "
  });
  assert.deepEqual(paper.authors, ["Ada Lovelace", "Example Research & Development Group", "李 华"]);
  assert.equal(paper.creators, "Ada Lovelace; Grace Hopper; Example Research & Development Group; 李 华; Translation Team");
  assert.equal(paper.conference, "USENIX Annual Technical Conference");
  assert.equal(paper.proceedings, "Proceedings of USENIX ATC 2026");
  assert.equal(paper.journal, "");
  assert.equal(paper.publication, paper.proceedings);
  assert.equal(paper.venue, paper.conference);
  assert.equal(paper.date, "October 6, 2026");
  assert.equal(paper.year, "2026");
  assert.equal(paper.publisher, "USENIX Association");
});

test("journal metadata supplies publication and venue without inventing a conference", async () => {
  const paper = await normalized({ itemType: "journalArticle", publicationTitle: " ACM Transactions on Storage ",
    creators: [{ creatorType: "author", lastName: "Chen" }], date: "2025-04", publisher: "ACM" });
  assert.deepEqual(paper.authors, ["Chen"]);
  assert.equal(paper.journal, "ACM Transactions on Storage");
  assert.equal(paper.publication, paper.journal);
  assert.equal(paper.venue, paper.journal);
  assert.equal(paper.conference, "");
  assert.equal(paper.proceedings, "");
  assert.equal(paper.date, "2025-04");
  assert.equal(paper.year, "2025");
});

test("proceedings provide a useful venue when a conference name is absent", async () => {
  const paper = await normalized({ proceedingsTitle: "Proceedings of the 31st Symposium", publicationTitle: "Imported publication" });
  assert.equal(paper.proceedings, "Proceedings of the 31st Symposium");
  assert.equal(paper.journal, "Imported publication");
  assert.equal(paper.publication, paper.proceedings);
  assert.equal(paper.venue, paper.proceedings);
  assert.equal(paper.conference, "");
});

test("book sections use their enclosing book as publication and retain the supplied publisher", async () => {
  const paper = await normalized({ itemType: "bookSection", title: "A chapter", bookTitle: " Storage Systems ",
    publisher: " Example Press ", creators: [{ creatorType: "editor", name: "Editorial Board" }], date: "n.d." });
  assert.deepEqual(paper.authors, []);
  assert.equal(paper.creators, "Editorial Board");
  assert.equal(paper.publication, "Storage Systems");
  assert.equal(paper.venue, "Storage Systems");
  assert.equal(paper.publisher, "Example Press");
  assert.equal(paper.date, "n.d.");
  assert.equal(paper.year, "");
});

test("absent or malformed metadata has a complete empty shape and does not promote nonauthors", async () => {
  const paper = await normalized({ creators: [{ creatorType: "editor", name: "Editors" }, { name: "Unknown role" },
    { creatorType: "author", firstName: 123, lastName: null }], conferenceName: 5, proceedingsTitle: {},
    publicationTitle: null, bookTitle: [], date: 2026, publisher: false });
  assert.deepEqual(paper.authors, []);
  assert.equal(paper.creators, "Editors; Unknown role");
  for (const field of METADATA_STRINGS) assert.equal(paper[field], "", field);
  assert.equal(paper.year, "");
});

test("standalone attachments still receive metadata fields without losing the PDF attachment", async () => {
  const data = row({ itemType: "attachment", title: "", filename: "article.pdf", contentType: "application/pdf",
    linkMode: "linked_file", creators: null, date: "" });
  data.links = { enclosure: { href: "file:///tmp/article.pdf" } };
  const paper = (await loadLibrary(api({ items: [data] }))).items[0];
  assert.equal(paper.title, "article.pdf");
  assert.deepEqual(paper.authors, []);
  for (const field of METADATA_STRINGS) assert.equal(paper[field], "", field);
  assert.equal(paper.attachments.length, 1);
  assert.equal(paper.attachments[0].key, KEY);
  assert.equal(paper.attachments[0].path, "/tmp/article.pdf");
});

test("library timestamps preserve Zotero's raw dates independently of publication date", async () => {
  const paper = await normalized({ date: "1995", dateAdded: "2026-10-07T05:30:36Z",
    dateModified: "2026-10-15T14:03:33.123456+08:00" });
  assert.equal(paper.dateAdded, "2026-10-07T05:30:36Z");
  assert.equal(paper.dateModified, "2026-10-15T14:03:33.123456+08:00");
  assert.equal(paper.year, "1995");
  assert.equal(paper.date, "1995");
});

test("absent and malformed library timestamps remain unknown instead of receiving synthetic dates", async () => {
  for (const value of [undefined, null, 2026, false, {}, [], "", "   ", "2026-10-07",
    "2026-10-07T05:30:36", "2026-10-07 05:30:36", " 2026-10-07T05:30:36Z ", "not a date",
    "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-01T00:00:00Z",
    "2026-10-00T00:00:00Z", "2026-10-07T24:00:00Z", "2026-10-07T00:60:00Z", "2026-10-07T00:00:60Z",
    "2026-10-07T00:00:00+24:00", "2026-10-07T00:00:00+08:60"]) {
    const paper = await normalized({ dateAdded: value, dateModified: value });
    assert.equal(paper.dateAdded, "", `dateAdded: ${JSON.stringify(value)}`);
    assert.equal(paper.dateModified, "", `dateModified: ${JSON.stringify(value)}`);
  }
  const leapDay = await normalized({ dateAdded: "2024-02-29T00:00:00Z", dateModified: "2000-02-29T00:00:00Z" });
  assert.equal(leapDay.dateAdded, "2024-02-29T00:00:00Z");
  assert.equal(leapDay.dateModified, "2000-02-29T00:00:00Z");
});

test("valid and explicitly unknown library timestamps reuse the version-probe cache path", async () => {
  for (const data of [{ dateAdded: "2026-10-07T05:30:36Z", dateModified: "2026-10-15T14:03:33+08:00" }, {}]) {
    const previous = await loadLibrary(api({ items: [row(data)] }));
    freeze(previous);
    const source = api(), current = await loadLibrary({ ...source, previous });
    assert.strictEqual(current.items, previous.items);
    assert.equal(current.items[0].dateAdded, data.dateAdded || "");
    assert.equal(current.items[0].dateModified, data.dateModified || "");
    assert.equal(source.itemReads(), 0);
    assert.equal(source.attachmentReads(), 0);
    assert.equal(source.probes(), 1);
  }
});

test("a tag-aware cache predating library timestamps fetches the raw source dates", async () => {
  const previous = await loadLibrary(api());
  previous.metadataSchema = 2;
  delete previous.items[0].dateAdded;
  delete previous.items[0].dateModified;
  const before = structuredClone(previous);
  freeze(previous);
  const source = api({ items: [row({ dateAdded: "2026-10-07T05:30:36Z", dateModified: "2026-10-15T06:03:33Z" })] });
  const current = await loadLibrary({ ...source, previous });
  assert.equal(current.metadataSchema, METADATA_SCHEMA);
  assert.equal(current.items[0].dateAdded, "2026-10-07T05:30:36Z");
  assert.equal(current.items[0].dateModified, "2026-10-15T06:03:33Z");
  assert.equal(source.itemReads(), 1);
  assert.equal(source.attachmentReads(), 1);
  assert.deepEqual(previous, before);
});

test("invalid cached library timestamps force refresh even with the current metadata schema", async () => {
  const current = await loadLibrary(api());
  for (const field of ["dateAdded", "dateModified"]) {
    for (const invalid of [undefined, null, 0, {}, "not a date", "2026-02-29T00:00:00Z", "2026-10-07T05:30:36"]) {
      const previous = structuredClone(current);
      previous.items[0][field] = invalid;
      const source = api({ items: [row({ [field]: "2026-10-15T06:03:33Z" })] });
      const refreshed = await loadLibrary({ ...source, previous });
      assert.equal(source.itemReads(), 1);
      assert.equal(refreshed.items[0][field], "2026-10-15T06:03:33Z");
    }
  }
});

test("a pre-metadata snapshot fetches fresh metadata even when the library version is unchanged", async () => {
  const initial = await loadLibrary(api({ items: [row({ title: "Old title" })] }));
  const legacy = structuredClone(initial);
  delete legacy.metadataSchema;
  delete legacy.items[0].authors;
  for (const field of METADATA_STRINGS) delete legacy.items[0][field];
  const before = structuredClone(legacy);
  freeze(legacy);
  const source = api({ items: [row({ title: "Current title", creators: [{ creatorType: "author", name: "Current author" }],
    conferenceName: "Current conference" })] });
  const current = await loadLibrary({ ...source, previous: legacy });
  assert.equal(current.schema, 1);
  assert.equal(current.metadataSchema, METADATA_SCHEMA);
  assert.equal(current.libraryVersion, legacy.libraryVersion);
  assert.equal(current.items[0].title, "Current title");
  assert.deepEqual(current.items[0].authors, ["Current author"]);
  assert.equal(current.items[0].conference, "Current conference");
  assert.equal(source.itemReads(), 1);
  assert.equal(source.attachmentReads(), 1);
  assert.equal(source.probes(), 1);
  assert.deepEqual(legacy, before);
});

test("valid current metadata snapshots retain the read-only version-probe reuse path", async () => {
  const previous = await loadLibrary(api({ items: [row({ publicationTitle: "A journal",
    creators: [{ creatorType: "author", name: "An author" }] })] }));
  const before = structuredClone(previous);
  freeze(previous);
  const source = api();
  const current = await loadLibrary({ ...source, previous });
  assert.equal(source.itemReads(), 0);
  assert.equal(source.attachmentReads(), 0);
  assert.equal(source.probes(), 1);
  assert.strictEqual(current.items, previous.items);
  assert.strictEqual(current.collections, previous.collections);
  assert.deepEqual(current.items[0].authors, ["An author"]);
  assert.equal(current.items[0].venue, "A journal");
  assert.deepEqual(previous, before);
});

for (const field of ["authors", "tags", ...METADATA_STRINGS]) {
  test(`a snapshot missing ${field} cannot bypass metadata refresh with a current marker`, async () => {
    const previous = await loadLibrary(api());
    delete previous.items[0][field];
    const source = api({ items: [row({ conferenceName: "Fresh venue", creators: [{ creatorType: "author", name: "Fresh author" }] })] });
    const current = await loadLibrary({ ...source, previous });
    assert.equal(source.itemReads(), 1);
    assert.deepEqual(current.items[0].authors, ["Fresh author"]);
    assert.equal(current.items[0].venue, "Fresh venue");
  });
}

test("malformed author lists and unsupported metadata schemas force a full refresh", async () => {
  const current = await loadLibrary(api());
  for (const invalid of [undefined, null, "An author", [""], ["   "], [{ name: "An author" }], [123]]) {
    const previous = structuredClone(current);
    previous.items[0].authors = invalid;
    const source = api();
    await loadLibrary({ ...source, previous });
    assert.equal(source.itemReads(), 1);
  }
  for (const metadataSchema of [undefined, 0, 1, 2, 4, "3"]) {
    const previous = { ...current, metadataSchema }, source = api();
    await loadLibrary({ ...source, previous });
    assert.equal(source.itemReads(), 1);
  }
});

test("an old empty snapshot also refreshes once before current empty snapshots can reuse", async () => {
  const legacy = { schema: 1, serverId: SERVER, libraryVersion: VERSION, collections: [], items: [] };
  const source = api({ items: [] });
  const current = await loadLibrary({ ...source, previous: legacy });
  assert.equal(source.itemReads(), 1);
  assert.equal(source.attachmentReads(), 1);
  assert.equal(current.metadataSchema, METADATA_SCHEMA);
  assert.deepEqual(current.items, []);
  const next = api({ items: [] });
  await loadLibrary({ ...next, previous: current });
  assert.equal(next.itemReads(), 0);
  assert.equal(next.probes(), 1);
});

test("changed library versions and server identities refresh current-schema metadata", async () => {
  const previous = await loadLibrary(api());
  for (const identity of [{ version: VERSION + 1 }, { serverId: "another-server" }]) {
    const source = api({ ...identity, items: [row({ conferenceName: "Fresh conference" })] });
    const current = await loadLibrary({ ...source, previous });
    assert.equal(source.itemReads(), 1);
    assert.equal(current.items[0].venue, "Fresh conference");
  }
});

test("metadata refresh preserves the consistency check instead of mixing library versions", async () => {
  const source = api({ items: [row({ conferenceName: "A conference" })],
    responseVersion: url => url.searchParams.get("format") === "versions" ? VERSION + 1 : VERSION });
  await assert.rejects(loadLibrary(source), { code: "LIBRARY_CHANGED" });
  assert.equal(source.itemReads(), 1);
  assert.equal(source.probes(), 1);
});

test("Zotero tags retain raw spelling, case, Unicode and order while rejecting malformed names", async () => {
  const names = ["Storage", "storage", "Distributed Systems", "研究/存储", "123", "<img src=x onerror=alert(1)>", " spaced "];
  const paper = await normalized({ tags: [
    ...names.map(tag => ({ tag, type: 0 })), { tag: "Storage", type: 1 },
    null, "Raw string", {}, { tag: 123 }, { tag: "" }, { tag: "   " }, { tag: "line\nbreak" },
    { tag: "nul\0byte" }, { tag: "x".repeat(1025) }
  ] });
  assert.deepEqual(paper.tags, names);
  for (const tags of [undefined, null, {}, "Storage"]) assert.deepEqual((await normalized({ tags })).tags, []);
});

test("valid tags remain in a reused snapshot and do not issue library writes", async () => {
  const previous = await loadLibrary(api({ items: [row({ tags: [{ tag: "Storage" }] })] }));
  freeze(previous);
  const source = api(), current = await loadLibrary({ ...source, previous });
  assert.strictEqual(current.items, previous.items);
  assert.deepEqual(current.items[0].tags, ["Storage"]);
  assert.equal(source.itemReads(), 0);
  assert.equal(source.probes(), 1);
});

test("a bibliography cache from before tag projection refetches even with the same Zotero version", async () => {
  const previous = await loadLibrary(api());
  previous.metadataSchema = 1;
  delete previous.items[0].tags;
  const source = api({ items: [row({ tags: [{ tag: "Fresh tag" }] })] });
  const current = await loadLibrary({ ...source, previous });
  assert.equal(current.metadataSchema, METADATA_SCHEMA);
  assert.deepEqual(current.items[0].tags, ["Fresh tag"]);
  assert.equal(source.itemReads(), 1);
  assert.equal(source.attachmentReads(), 1);
});

test("invalid or duplicate cached tags cannot bypass library refresh", async () => {
  const current = await loadLibrary(api());
  for (const invalid of [undefined, null, "Storage", [""], [" "], [123], [{}], ["line\nbreak"], ["Storage", "Storage"], ["x".repeat(1025)]]) {
    const previous = structuredClone(current);
    previous.items[0].tags = invalid;
    const source = api({ items: [row({ tags: [{ tag: "Valid" }] })] });
    const refreshed = await loadLibrary({ ...source, previous });
    assert.equal(source.itemReads(), 1);
    assert.deepEqual(refreshed.items[0].tags, ["Valid"]);
  }
});
