---
record_id: 2026-10-29-linked-evidence
date: 2026-10-29
entries: []
retracts: []
---

# Linked evidence

## Request

> noema中的snapshot依然没有被删除

## Outcome

Simplified the memory data model, Markdown parser/writer, resume metadata, and source checking. Evidence retains only a Corpus path and optional anchor. Git retains revision history; source text edits alone no longer change claim status. Explicit corrections, source/anchor checks, dependency status, write preconditions, and publication recovery remain.

Migrated all four existing memory pages: removed redundant entry and resume metadata. Original page bytes were backed up before migration. Claim text, IDs, basis, status, dependencies, and source links were preserved. Only page edit dates changed to reflect migration.

## Verification

60 workspace tests passed, including link-only page/resume roundtrips, writing and replay, correction propagation, source-anchor availability, and cross-session hooks. Strict workspace Clippy, formatting, release build, and the migrated vault check passed. Tests follow the link-based contract.

## Handoff

State: Memory pages use linked evidence and retain source paths and anchors. Source files and their historical records remain unchanged. This format migration and the preceding validation cleanup are uncommitted.
Next: Review the diff before committing the refinements.
