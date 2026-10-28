---
record_id: 2026-10-28-validation-boundaries
date: 2026-10-28
entries: []
retracts: []
---

# Validation boundaries

## Request

> 请你查看tools和noema的内容，减少无用和rebundant的防御性编程和冗余校验，保持clean和concise

## Outcome

Against base HEAD `33ed4efd910208ad6733a1e9667e5e5fbe80e3fc`, Noema now inspects sources once per request and reuses the same checked bytes for context, startup, continuation, and Hook budget retries. Shared aliases are counted once per selection.

Removed repeated file/type/path checks, stored-cache field revalidation, and separate private metadata size limits. Review state and session bindings share the bounded JSON reader. Unknown cached work IDs are ignored through the checked work-ID set. Source/write ownership, optimistic version checks, dependencies, locking, and publication recovery remain.

Structural errors still fail validation; entries whose own evidence or premises fail remain excluded.

## Verification

`cargo test --workspace --locked`: 61 passed. Strict workspace Clippy and formatting passed. Regressions cover checked bytes after source edits, unknown cached work IDs, and configured paths remaining inside the vault.

Before this checkpoint, identical queries selected the same nine live Noema entries; context shrank from 4,068 to 3,320 Unicode characters. This measures output length, not model tokens, latency, or retrieval quality. No native app behavior is inferred from process tests.

## Handoff

State: Validation responsibilities are concentrated at input and write boundaries; checked sources are reused. Memory-page format and original evidence remain unchanged. These refinements are uncommitted.
Next: Review the diff and verify native Hook behavior when continuing integration work.
