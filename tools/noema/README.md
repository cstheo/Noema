# Memory

Recalls relevant context and saves evidence, memory, or continuation independently.

Run `make -C tools noema ARGS='<command>'`, or use `tools/target/release/noema` after building. `--root PATH` selects another Noema repository; `--json` returns structured output.

| Command | Purpose |
| --- | --- |
| `context --query TEXT` | Recall by names, aliases, scope, and task terms |
| `context --work ID` | Select current work |
| `context --bootstrap` | Load a bounded profile |
| `check` | Validate memory, evidence links, and dependencies |
| `record INPUT.json --dry-run` | Validate a change without publishing |
| `record INPUT.json` | Save a record, memory, handoff, or combination |
| `record --recover` | Roll back interrupted publication |

`context --cwd PATH` supplies a scope hint. `--max-chars N` limits output while retaining complete blocks. Sources are read once per inspection and reused during selection.

Automatic selection shows up to three active entries per page, ranked by task terms and recency; `--work` shows the full current view. Inline handoff takes precedence over `resume`.

## Change sets

Every request has an `id` and `date`. Source `path` and `body` are optional; provide both to create an immutable Corpus record. Its filename must match `id`. Omit `pages` for a record-only save.

Memory can reference existing evidence without creating a record:

```json
{
  "id": "example-state",
  "date": "YYYY-MM-DD",
  "pages": [{
    "path": "noema/work/example.md",
    "id": "work.example",
    "summary": "Example work.",
    "handoff": "Next: validate the remaining configuration.",
    "entries": [{
      "id": "constraint",
      "basis": "explicit",
      "as_of": "YYYY-MM-DD",
      "text": "<one supported constraint>",
      "evidence": [{"path": "corpus/projects/Example/records/decision.md", "anchor": "request"}]
    }]
  }]
}
```

Existing pages need only their `path`, stable `id`, and changed fields; new pages also require `summary`. Entries update by ID; `remove: ["entry-id"]` prunes stale entries. Corrected premises suspend dependent conclusions. Optional entry fields are `depends_on`, `supersedes`, and `review_after`; top-level `retracts` withdraws claims.

Set `handoff` to refresh continuation, or to an empty string to clear it. A work page may contain only a handoff. `resume` can instead link to an existing Corpus section; an empty string clears it. Neither operation requires a new record. See the [page format](../../noema/README.md#pages).

Writes use a lock and compare current content. Identical updates write nothing. Requests, sources, pages, and recovery data share a 1 MiB limit. Writes reject symlinks, `sources/`, and nested repositories. Git commits are separate.

## Skills and hooks

[Recall](skills/noema-recall/SKILL.md) is proactive when local context matters. [Consolidate](skills/noema-consolidate/SKILL.md) saves only new information that changes future work. `.agents/skills/` links to these canonical sources.

[Project hooks](../../.codex/hooks.json) load profile and bound work at `SessionStart`, then select relevant memory at `UserPromptSubmit`. Private session bindings stay under `.local/noema/`. Consolidation is an Agent decision; hooks do not require a save at turn or session boundaries.

Review changed definitions with [`/hooks`](https://learn.chatgpt.com/docs/hooks). Process tests do not establish native hook activation.

## Recovery and validation

Interrupted publication keeps before/after content in ignored `.local/noema/pending.json`. Reads are blocked until recovery; `record --recover` refuses to overwrite external edits.

From `tools/`, run `cargo test -p Noema-memory --locked` and `cargo clippy -p Noema-memory --all-targets --locked -- -D warnings`. Tests cover independent writes, continuation, corrections, conflicts, and recovery.
