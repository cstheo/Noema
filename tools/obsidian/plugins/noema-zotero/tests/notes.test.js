"use strict";

const assert = require("node:assert/strict");
const notes = require("../notes.js");
const id = { serverId: "pGYjCHtUq0Ui", key: "ABCDEFGH", parentKey: "KJXDWGZF", version: 12,
  fileId: "8c487c7c-54f2-4bee-afd4-f970fed7acec" };
let assertions = 0;
function check(fn) { fn(); assertions++; }

const original = notes.makeMarkdown({ ...id, title: "Research / α : \"paper\"", body: "# Notes\n\nA thought.\n" });
const parsed = notes.parseMarkdown(original, id);
check(() => assert.deepEqual([parsed.serverId, parsed.key, parsed.parentKey, parsed.version, parsed.body],
  [id.serverId, id.key, id.parentKey, 12, "# Notes\n\nA thought.\n"]));
check(() => assert.equal(parsed.title, 'Research / α : "paper"'));
check(() => assert.equal(parsed.fileId, id.fileId));
check(() => assert.equal(parsed.legacy, false));
check(() => assert.equal(notes.parseMarkdown(original.replace(/\n/g, "\r\n"), id).body, parsed.body));
check(() => assert.equal(notes.parseMarkdown(`\uFEFF${original}`, id).body, parsed.body));
check(() => assert(!/^zotero-[A-Za-z0-9_-]+:/m.test(original)));
check(() => assert(!/^aliases:/m.test(original)));
check(() => assert.equal(notes.parseMarkdown(notes.makeMarkdown({ ...id, serverId: "local-library_1" }), { ...id, serverId: "local-library_1" }).serverId, "local-library_1"));
check(() => assert.throws(() => notes.parseMarkdown("Plain local note"), /frontmatter/));
check(() => assert.throws(() => notes.makeMarkdown({ ...id, key: "OTHERKEY", body: "x", existing: original, registered: id }), /different/));
const extra = original.replace("\n---\n\n<!--", "\nreading: active\ncustom:\n  folder: ../../outside\n  preferences:\n    priority: 2\n    done: false\n  sources:\n    - \"research\"\n    - \"two: fields\"\naliases:\n  - My reading note\n---\n\n<!--");
const updated = notes.makeMarkdown({ ...id, version: 13, body: "New body", existing: extra, registered: id });
check(() => assert(updated.includes("reading: active\ncustom:\n  folder: ../../outside")));
check(() => assert(updated.includes("  preferences:\n    priority: 2\n    done: false\n  sources:\n    - \"research\"\n    - \"two: fields\"")));
check(() => assert(updated.includes("aliases:\n  - My reading note")));
check(() => assert.equal(notes.parseMarkdown(updated, { ...id, version: 13 }).body, "New body"));
check(() => assert.equal(notes.parseMarkdown(updated, { ...id, version: 13 }).version, 13));

// Legacy notes keep strict identity/version validation during migration. Clean
// notes receive those fields from the private registry rather than frontmatter.
const legacy = `---\ntitle: ${JSON.stringify(parsed.title)}\naliases: [${JSON.stringify(parsed.title)}]\nzotero-server-id: ${JSON.stringify(id.serverId)}\nzotero-key: ${JSON.stringify(id.key)}\nzotero-parent-key: ${JSON.stringify(id.parentKey)}\nzotero-version: 12\n---\n\n${parsed.body}`;
const parsedLegacy = notes.parseMarkdown(legacy, id);
check(() => assert.equal(parsedLegacy.legacy, true));
check(() => assert.equal(parsedLegacy.fileId, undefined));
check(() => assert.deepEqual([parsedLegacy.serverId, parsedLegacy.key, parsedLegacy.parentKey, parsedLegacy.version, parsedLegacy.body],
  [id.serverId, id.key, id.parentKey, 12, parsed.body]));
check(() => assert.throws(() => notes.parseMarkdown(legacy.replace('"pGYjCHtUq0Ui"', '"../../outside"')), /identity/));
check(() => assert.throws(() => notes.parseMarkdown(legacy.replace("zotero-version: 12", "zotero-version: 12\nzotero-version: 13")), /Duplicate/));
check(() => assert.throws(() => notes.parseMarkdown(legacy.replace("zotero-version: 12", "zotero-version: -1")), /version/));
check(() => assert.throws(() => notes.parseMarkdown(legacy.replace("zotero-version: 12", "zotero-version: 999999999999999999")), /identity/));
check(() => assert.throws(() => notes.parseMarkdown(legacy, { ...id, key: "OTHERKEY" }), /different/));
const migrated = notes.makeMarkdown({ ...id, existing: legacy, body: parsed.body, registered: id });
check(() => assert.equal(notes.parseMarkdown(migrated, id).legacy, false));
check(() => assert.equal(notes.parseMarkdown(migrated, id).body, parsed.body));
check(() => assert(!/^zotero-/m.test(migrated)));
check(() => assert(!/^aliases:/m.test(migrated)));

const marker = `<!-- noema-shared-note:${id.fileId} -->`;
const otherFileId = "dd7d9948-44f7-40e7-bb8f-1d9aa34df011";
check(() => assert.equal(original.split(marker).length - 1, 1));
check(() => assert(!parsed.body.includes("noema-shared-note:")));
check(() => assert.equal(notes.parseMarkdown(original).serverId, undefined));
check(() => assert.equal(notes.parseMarkdown(original).fileId, id.fileId));
check(() => assert.throws(() => notes.parseMarkdown(original.replace(`${marker}\n\n`, ""), id), /marker|identity/));
check(() => assert.throws(() => notes.parseMarkdown(original.replace(id.fileId, otherFileId), id), /marker|identity/));
check(() => assert.throws(() => notes.parseMarkdown(original, { ...id, fileId: otherFileId }), /marker|identity/));
check(() => assert.throws(() => notes.parseMarkdown(original, { ...id, fileId: undefined }), /marker|identity/));
check(() => assert.throws(() => notes.parseMarkdown(original.replace(id.fileId, "1234-abcd"), id), /identity/));
check(() => assert.throws(() => notes.parseMarkdown(original.replace(id.fileId, "invalid-uuid"), id), /marker|identity/));
check(() => assert.throws(() => notes.parseMarkdown(original.replace(marker, `${marker}\n\n${marker}`), id), /marker|identity|Duplicate/i));
check(() => assert.throws(() => notes.parseMarkdown(`${original}\n${marker}\n`, id), /marker|identity|Duplicate/i));
check(() => assert.throws(() => notes.makeMarkdown({ ...id, fileId: undefined }), /registry.*identity/));
check(() => assert.throws(() => notes.makeMarkdown({ ...id, fileId: "../../outside" }), /registry.*identity/));
check(() => assert.equal(notes.parseMarkdown(notes.makeMarkdown({ ...id, body: "" }), id).body, ""));

const paper = { title: '  A "quoted": finding\nTwo lines  ', authors: [" Ada Example ", "", null, 42, "René Example"],
  itemType: "conferencePaper", conference: "ASPLOS", proceedings: "ASPLOS 2026", journal: 'Systems "Review"',
  year: "2026", doi: " 10.1/example ", url: "https://example.org/paper?q=a:b#result" };
const properties = notes.paperProperties(paper);
check(() => assert.deepEqual(properties, [
  `paper: ${JSON.stringify('A "quoted": finding\nTwo lines')}`,
  'authors: ["Ada Example","René Example"]', 'conference: "ASPLOS"', 'proceedings: "ASPLOS 2026"',
  'journal: "Systems \\"Review\\""', 'year: 2026', 'doi: "10.1/example"', 'url: "https://example.org/paper?q=a:b#result"'
]));
const bibliographic = notes.makeMarkdown({ ...id, title: "Reading note", paper, body: "A thought." });
check(() => assert(properties.every(line => bibliographic.includes(`\n${line}\n`))));
check(() => assert.equal(notes.parseMarkdown(bibliographic, id).title, "Reading note"));
check(() => assert.equal(notes.parseMarkdown(bibliographic, id).body, "A thought."));
check(() => assert.deepEqual(notes.paperProperties({ title: " ", authors: ["", " ", null], conference: "", proceedings: "", journal: " ", year: "unknown", doi: "", url: " " }), []));
check(() => assert.deepEqual(notes.paperProperties(undefined), []));
const rawTags = ["disaggregate memory", "Unikernel", "unikernel", 'quoted: "tag"', "  spaced tag  ", "研究", "Unikernel", "", " ", null, 12, "bad\nname", "x".repeat(1025)];
const expectedTags = ["disaggregate memory", "Unikernel", "unikernel", 'quoted: "tag"', "  spaced tag  ", "研究"];
check(() => assert.deepEqual(notes.paperProperties({ tags: rawTags }), [`paper-tags: ${JSON.stringify(expectedTags)}`]));
const taggedSource = notes.makeMarkdown({ ...id, paper: { tags: rawTags }, body: "Exact note text\n" });
check(() => assert(taggedSource.includes(`\npaper-tags: ${JSON.stringify(expectedTags)}\n`)));
check(() => assert.equal(notes.parseMarkdown(taggedSource, id).body, "Exact note text\n"));
const oldTaggedSource = original.replace("\n---\n\n", '\npaper-tags:\n  - Old tag\ntags:\n  - personal-reading\n---\n\n');
const tagsRefreshed = notes.makeMarkdown({ ...id, paper: { tags: ["Unikernel"] }, existing: oldTaggedSource, body: parsed.body });
check(() => assert(tagsRefreshed.includes('\npaper-tags: ["Unikernel"]\n') && !tagsRefreshed.includes("Old tag")));
check(() => assert(tagsRefreshed.includes("\ntags:\n  - personal-reading\n")));
const tagsRemoved = notes.makeMarkdown({ ...id, paper: { tags: [] }, existing: oldTaggedSource, body: parsed.body });
check(() => assert(!tagsRemoved.includes("paper-tags:") && tagsRemoved.includes("\ntags:\n  - personal-reading\n")));
const tagsUnknown = notes.makeMarkdown({ ...id, paper: {}, existing: oldTaggedSource, body: parsed.body });
check(() => assert(tagsUnknown.includes("\npaper-tags:\n  - Old tag\n")));
check(() => assert.equal(notes.parseMarkdown(tagsRefreshed, id).body, parsed.body));
check(() => assert.deepEqual(notes.paperProperties({ itemType: "conferencePaper", proceedings: "ASPLOS 2026" }), [
  'conference: "ASPLOS 2026"', 'proceedings: "ASPLOS 2026"'
]));
check(() => assert.deepEqual(notes.paperProperties({ conference: "ASPLOS", proceedings: "ASPLOS", year: 2026 }), ['conference: "ASPLOS"', 'year: 2026']));
const previousPaper = extra.replace("\n---\n\n<!--", "\npaper: \"Old title\"\nauthors:\n  - Old author\nzotero-draft: true\nzotero-conflict:\n  path: private/conflict.md\nzotero-private-extra:\n  token: obsolete\n---\n\n<!--");
const refreshedPaper = notes.makeMarkdown({ ...id, paper, existing: previousPaper, body: "New body", registered: id });
check(() => assert(!refreshedPaper.includes("Old title")));
check(() => assert(!refreshedPaper.includes("Old author")));
check(() => assert(!/^zotero-/m.test(refreshedPaper)));
check(() => assert(!refreshedPaper.includes("private/conflict.md") && !refreshedPaper.includes("token: obsolete")));
check(() => assert(refreshedPaper.includes("custom:\n  folder: ../../outside\n  preferences:\n    priority: 2\n    done: false")));
check(() => assert(refreshedPaper.includes("aliases:\n  - My reading note")));
check(() => assert.equal(notes.parseMarkdown(refreshedPaper, id).fileId, id.fileId));
check(() => assert.equal(notes.noteFilename("../../A/B: C"), "A B C.md"));
check(() => assert.equal(notes.noteFilename(""), "Paper note.md"));
check(() => assert.equal(notes.noteFilename("Title", 2), "Title (2).md"));
check(() => assert.equal(notes.noteFilename("Title", 10000), "Title (10000).md"));
check(() => assert.equal(notes.noteFilename(" Ａ\t  B\n C... "), "A B C.md"));
const longTitle = "研究".repeat(90);
const longFilename = notes.noteFilename(longTitle);
check(() => assert(Buffer.byteLength(longFilename.slice(0, -3), "utf8") <= 220));
check(() => assert.equal(longFilename, `${longTitle.slice(0, 73)}.md`));
check(() => assert(!longFilename.includes("\ufffd")));
check(() => assert.equal(notes.noteFilename(longTitle, 2), `${longTitle.slice(0, 73)} (2).md`));
for (const index of [0, -1, 1.5, 10001, "../bad", id.key, NaN, Infinity]) {
  check(() => assert.throws(() => notes.noteFilename("Title", index), /index/));
}


const remote = { ...id, html: '<div data-schema-version="9"><p>A thought.</p></div>' };
const base = notes.createBaseline({ ...id, localBody: parsed.body, remoteHTML: remote.html });
const decide = (local = parsed, value = remote, snapshot = base) => notes.decideSync({ base: snapshot, local, remote: value });
check(() => assert.equal(decide().action, "unchanged"));
check(() => assert.equal(decide({ ...parsed, body: "Local edit" }).action, "push"));
check(() => assert.equal(decide(parsed, { ...remote, version: 13, html: "<p>Remote edit</p>" }).action, "pull"));
check(() => assert.equal(decide({ ...parsed, body: "Local edit" }, { ...remote, version: 13, html: "<p>Remote edit</p>" }).action, "conflict"));
check(() => assert.equal(decide({ ...parsed, body: "Local edit" }, { ...remote, version: 13 }).action, "conflict"));
check(() => assert.equal(decide(parsed, { ...remote, version: 13 }).action, "unchanged"));
check(() => assert.equal(decide(parsed, { ...remote, version: 11 }).action, "conflict"));
check(() => assert.equal(decide({ ...parsed, version: 14 }).action, "conflict"));
check(() => assert.equal(decide(null).action, "pull"));
check(() => assert.equal(decide(parsed, null).action, "conflict"));
check(() => assert.equal(decide(parsed, remote, null).action, "conflict"));
check(() => assert.equal(decide(parsed, remote, { ...base, remoteHTML: null }).action, "conflict"));
check(() => assert.equal(decide(parsed, remote, { ...base, canPush: undefined }).action, "conflict"));
check(() => assert.equal(decide(parsed, { ...remote, serverId: "OtherServer1" }).action, "conflict"));
check(() => assert.equal(decide(parsed, { ...remote, parentKey: "OTHERKEY" }).action, "conflict"));
check(() => assert.equal(decide(parsed, remote, { ...base, key: "OTHERKEY" }).action, "conflict"));
check(() => assert.equal(decide({ ...parsed, body: "Edit" }, remote, { ...base, canPush: false }).action, "conflict"));
check(() => assert.deepEqual(base, notes.createBaseline({ ...id, localBody: parsed.body, remoteHTML: remote.html })));

async function run() {
  await assert.rejects(() => notes.markdownToZotero("- [ ] Never lose this task", { markdownToHTML: () => "" }), /checkboxes/); assertions++;
  await assert.rejects(() => notes.markdownToZotero("```dataviewjs\napp.vault.delete(file)\n```", { markdownToHTML: () => "" }), /queries/); assertions++;
  await assert.rejects(() => notes.markdownToZotero("![[diagram.png]]", { markdownToHTML: () => "" }), /embeds/); assertions++;
  await assert.rejects(() => notes.markdownToZotero("Plain"), /renderer/); assertions++;
  const unsupported = notes.remoteToMarkdown("<script>alert(1)</script>");
  check(() => assert.equal(unsupported.canPush, false));
  check(() => assert(unsupported.body.startsWith("```html\n")));
  console.log(`${assertions} focused note helper assertions passed.`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
