---
record_id: 2026-10-29-linked-evidence
date: 2026-10-29
request_sha256: a2f2d83c17165975d79ba00439dddb93d8f09c66213fe73af0c2309dfd6eedb4
entries: []
retracts: []
---

# Linked evidence

## Request

> noema中的snapshot依然没有被删除

## Outcome

Removed source fingerprints from the memory data model, Markdown parser/writer, resume metadata, and source checking. Evidence retains only a Corpus path and optional anchor. Git retains revision history; source text edits alone no longer change claim status. Explicit corrections, source/anchor checks, dependency status, write preconditions, and publication recovery remain.

Migrated all four existing memory pages: removed 20 per-entry fields and two resume hashes. Original page bytes were backed up before migration. Claim text, IDs, basis, status, dependencies, and source links were preserved. Only page edit dates changed to reflect migration.

## Verification

60 workspace tests passed, including link-only page/resume roundtrips, writing and replay, correction propagation, source-anchor availability, and cross-session hooks. Strict workspace Clippy, formatting, release build, and the migrated vault check passed. Obsolete source-digest assertions were replaced with the new link-based contract.

## Handoff

State: Memory pages use linked evidence and contain no source hash fields. Source files and their historical records remain unchanged. This format migration and the preceding validation cleanup are uncommitted.
Next: Review the diff before committing the refinements.
