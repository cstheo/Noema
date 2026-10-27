const test = require("node:test");
const assert = require("node:assert/strict");
const fields = require("../fields");
const root = "corpus/research";
const { unfiled: UNFILED } = fields.paths(root);
const createCatalog = value => fields.createCatalog(value, root);
const config = require("../../../../../corpus/research/fields.json");

test("routing uses an explicit field, then one topic match, otherwise Unfiled", () => {
  const catalog = createCatalog(config);
  const route = tags => catalog.classify({ tags });
  assert.equal(route(["kernel-architecture", "libos"]).field, "system/os");
  assert.equal(route(["field:system/mlsys", "libos"]).field, "system/mlsys");
  for (const tags of [[], ["unknown"], ["rust"], ["field:programming/rust"], ["libos", "raft"], ["field:unknown"], ["field:system/os", "field:ai"]]) {
    assert.equal(route(tags).field, null);
  }
  assert.equal(catalog.classify({ tags: ["libos"] }, "ai").field, "ai");
  assert.equal(catalog.classify({ tags: ["libos"] }, "").field, null);
  assert.equal(catalog.directory(null), UNFILED);
});

test("configured collection keys can supply a default field", () => {
  const catalog = createCatalog({ schema: 1, fields: [{ id: "ai", name: "AI", tags: [], collections: ["ABCDEFGH"] }] });
  assert.equal(catalog.classify({ collections: ["ABCDEFGH"] }).field, "ai");
});

test("managed paths refuse traversal, README files and arbitrary directories", () => {
  const catalog = createCatalog(config);
  for (const path of ["corpus/research/system/os/papers/paper.md", `${UNFILED}/paper.md`, "corpus/research/papers/notes/old.md", "corpus/research/papers/unfiled/old.md"]) assert(catalog.validPath(path));
  for (const path of ["corpus/research/system/os/papers/../paper.md", "corpus/research/system/os/papers/README.md", "corpus/research/papers/README.md", "/tmp/paper.md", "corpus/research/system/os/techniques/paper.md", "corpus/research/programming/rust/papers/paper.md", "corpus/research/unknown/papers/paper.md", "corpus\\research\\paper.md"]) assert(!catalog.validPath(path), path);
  for (const id of ["../ai", "system/../ai", "papers", "AI", "system/os/deep"]) assert.throws(() => createCatalog({ schema: 1, fields: [{ id, name: "Invalid", tags: [] }] }));
  assert.throws(() => createCatalog({ ...config, fields: [config.fields[0], config.fields[0]] }));
});

// This root is a fixture input, independent of the user's actual config.toml.
test("routing honors the configured research folder", () => {
  const catalog = fields.createCatalog(config, "corpus/library");
  assert.equal(catalog.directory(null), "corpus/library/papers");
  assert(catalog.validPath("corpus/library/papers/paper.md"));
  assert(!catalog.validPath("corpus/research/papers/paper.md"));
  for (const root of [undefined, "../corpus/research", "corpus/../private", "corpus//research"]) assert.throws(() => fields.paths(root));
});
