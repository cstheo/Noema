"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const template = require("../paper-note-template.js");

const expected = ["1. Problem", "2. Contribution", "3. Insights", "4. Design", "5. Evaluation", "6. Limitation"];
const h2 = body => [...body.matchAll(/^## (.+)$/gm)].map(match => match[1]);

test("a blank new note has exactly six ordered dimensions and no extra title", () => {
  assert.deepEqual(template.headings, expected);
  assert.deepEqual(h2(template.initialize()), expected);
  assert.equal(template.initialize(""), template.markdown);
  assert.equal(template.initialize(template.markdown), template.markdown);
  assert.doesNotMatch(template.markdown, /^# /m);
  assert.equal(template.html, expected.map(heading => `<h2>${heading}</h2><p></p>`).join(""));
  assert.doesNotMatch(template.html, /<(?:h1|script|div)\b/i);
});

test("authored observations, quotes, citations and line endings are preserved", () => {
  const body = "# My observations\r\n\r\nA finding about α and β.  \r\n\r\n> ## Problem\r\n> A quoted claim.\r\n\r\n[Paper · p. 4](zotero://open-pdf/library/items/ABCDEFGH?page=4)\r\n";
  const result = template.initialize(body);
  assert.equal(result.slice(0, body.length), body);
  assert.deepEqual(h2(result.slice(body.length)), expected);
  assert.equal(template.initialize(result), result);
});

test("only missing dimensions are appended, preserving existing named or numbered headings", () => {
  const body = "## Problem\n\nAn important constraint.\n\n### 2. Contribution ##\n\nNew mechanism.\n\n# 3) Insights\n\nA changed assumption.\n\n## **Design**\n\nKeep these details.\n";
  const result = template.initialize(body);
  assert.equal(result.slice(0, body.length), body);
  assert.deepEqual(h2(result.slice(body.length)), ["5. Evaluation", "6. Limitation"]);
  assert.equal(template.initialize(result), result);
});

test("existing dimensions can use setext headings and case differences", () => {
  const body = "EVALUATION\n---\n\nMeasured only on one server.\n\n6. Limitation\n===\n\nNeeds another test.\n";
  const result = template.initialize(body);
  assert.equal(result.slice(0, body.length), body);
  assert.deepEqual(h2(result.slice(body.length)), expected.slice(0, 4));
  assert.equal(template.initialize(result), result);
});

test("fenced examples cannot satisfy dimensions or close a longer fence prematurely", () => {
  const body = "````markdown\n## 1. Problem\n```\n## Contribution\n````\n\n~~~example\n## Insights\n## Design\n~~~\n\n    ## Evaluation\n\t## Limitation\n";
  const result = template.initialize(body);
  assert.equal(result.slice(0, body.length), body);
  assert.deepEqual(h2(result.slice(body.length)), expected);
  assert.equal(template.initialize(result), result);
});

test("quoted headings and quoted fences do not hide a genuine note heading", () => {
  const body = "> ```markdown\n> ## Problem\n> ```\n> Contribution\n> ---\n\n## Insights\n\nThe actual insight.\n";
  const result = template.initialize(body);
  assert.equal(result.slice(0, body.length), body);
  assert.deepEqual(h2(result.slice(body.length)), expected.filter(heading => heading !== "3. Insights"));
  assert.equal(template.initialize(result), result);
});

test("an unfinished fence is closed without rewriting the draft or duplicating sections", () => {
  const body = "My example:\n\n```markdown\n## Problem\nStill writing code.";
  const result = template.initialize(body);
  assert.equal(result.slice(0, body.length), body);
  assert.ok(result.slice(body.length).startsWith("\n\n```\n\n## 1. Problem"));
  assert.deepEqual(h2(result.slice(body.length)), expected);
  assert.equal(template.initialize(result), result);
});

test("already complete notes retain their ordering, numbering and trailing content", () => {
  const body = "## 6. Limitation\n\n## Evaluation\n\n## 4) Design\n\n## INSIGHTS\n\n## Contribution:\n\n## Problem\n\nAdditional observations.  \n";
  assert.equal(template.initialize(body), body);
});

test("whitespace drafts are retained and ordinary text is not mistaken for a heading", () => {
  const whitespace = " \r\n\t";
  const retained = template.initialize(whitespace);
  assert.equal(retained.slice(0, whitespace.length), whitespace);
  assert.deepEqual(h2(retained.slice(whitespace.length)), expected);
  const body = "Problem\nContribution\n## Problem statement\n##Design\n";
  assert.deepEqual(h2(template.initialize(body).slice(body.length)), expected);
  assert.throws(() => template.initialize({ body: "A draft" }), TypeError);
  assert.throws(() => template.initialize(null), TypeError);
});

test("the dependency-free helper also loads into a Zotero-style script scope", () => {
  const source = fs.readFileSync(path.join(__dirname, "../paper-note-template.js"), "utf8");
  const scope = { require() { throw new Error("The helper must not import a dependency."); } };
  vm.runInNewContext(source, scope);
  assert.ok(scope.NoemaPaperNoteTemplate);
  assert.deepEqual(Array.from(scope.NoemaPaperNoteTemplate.headings), expected);
  assert.equal(scope.NoemaPaperNoteTemplate.markdown, template.markdown);
  assert.equal(scope.NoemaPaperNoteTemplate.html, template.html);
  const body = "> Keep this passage.\n\n## Problem\nAn authored question.\n";
  assert.equal(scope.NoemaPaperNoteTemplate.initialize(body), template.initialize(body));
});
