"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { passageMarkdown } = require("../paper-view.js");
const item = { title: "A *finding* [draft]" };

test("selected passage has an escaped quote and a Zotero page source", () => {
  const text = passageMarkdown(item, { attachmentKey: "PDF22222", text: "A **claim**\n<iframe> [link](javascript:bad)", pageIndex: 3, pageLabel: "iv" });
  assert(text.startsWith("> A \\*\\*claim\\*\\*\n> \\<iframe\\> \\[link\\]\\(javascript:bad\\)"));
  assert(text.includes("[A \\*finding\\* \\[draft\\] · p. iv](zotero://open-pdf/library/items/PDF22222?page=4)"));
});

test("native annotation source retains its key and comment without executable Markdown", () => {
  const text = passageMarkdown(item, { attachmentKey: "PDF22222", annotationKey: "MARK2222", text: "Quoted text", pageIndex: 1, pageLabel: "1223", comment: "[[concept]]\n<script>bad</script>" });
  assert(text.includes("zotero://open-pdf/library/items/PDF22222?annotation=MARK2222"));
  assert(text.includes("\\[\\[concept\\]\\]\n\\<script\\>bad\\</script\\>"));
  assert(!text.includes("?page="));
});

test("unavailable identities and empty passages cannot generate a source", () => {
  for (const source of [{}, { attachmentKey: "../bad", text: "x" }, { attachmentKey: "PDF22222", text: " " }, { attachmentKey: "PDF22222", annotationKey: "bad?url", text: "x" }]) {
    assert.throws(() => passageMarkdown(item, source));
  }
});

test("missing page index has a safe first-page fallback", () => {
  assert(passageMarkdown(item, { attachmentKey: "PDF22222", text: "Quote", pageIndex: NaN }).includes("?page=1)"));
});
