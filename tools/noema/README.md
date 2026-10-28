# Memory

Retrieves task context, records evidence-linked memory, and checks consistency.

From the repository root, run `make -C tools noema ARGS='<command>'`. After building, use `tools/target/release/noema` directly. `--root PATH` selects another Noema repository; `--json` returns structured output.

| Command | Behavior |
| --- | --- |
| `context --query TEXT` | Match page names, aliases, scope, and task terms |
| `context --work ID` | Select a memory page |
| `context --bootstrap` | Load a bounded profile |
| `check` | Validate pages, sources, dependencies, and corrections |
| `record INPUT.json --dry-run` | Validate without publishing |
| `record INPUT.json` | Publish a checked source record and memory update |
| `record --recover` | Roll back interrupted publication |
| `consolidation --json` | Inspect review mode and pending tokens |

`context --max-chars N` keeps complete blocks within a Unicode character budget. `--cwd PATH` supplies a scope hint. No match returns an explanation; ambiguous work needs an explicit ID.

Each inspection reads a source once. Context and Hook selection reuse that text. A later request reads sources again.

## Change sets

Use a new immutable Corpus record for each update. Replace this example's evidence and dates:

```json
{
  "id": "example",
  "date": "YYYY-MM-DD",
  "path": "corpus/projects/Example/records/example.md",
  "body": "# Example\n\n## Request\n<original statement>\n\n## Handoff\n<state and next action>\n",
  "pages": [{
    "path": "noema/work/example.md",
    "id": "work.example",
    "summary": "Decisions and continuation for Example.",
    "resume": "corpus/projects/Example/records/example.md#handoff",
    "entries": [{
      "id": "scope",
      "basis": "explicit",
      "as_of": "YYYY-MM-DD",
      "text": "<one supported statement>",
      "evidence": [{
        "path": "corpus/projects/Example/records/example.md",
        "anchor": "request"
      }]
    }]
  }]
}
```

Updates append entries to current pages under a write lock; existing IDs cannot be rewritten. Evidence keeps paths and anchors; Git tracks revisions. Optional entry fields are `depends_on`, `supersedes`, and `review_after`; top-level `retracts` withdraws entry references. See the [page format](../../noema/README.md#pages).

New entries are active. Corrections suspend dependent memories. Entry changes clear affected handoffs unless refreshed. A refreshed `resume` must point to the new record. Existing handoffs can be refreshed with `entries: []`; new pages need a supported entry. Identical replay is a no-op; different content at an existing record path fails.

Requests, pages, UTF-8 sources, private JSON, and recovery journals share a 1 MiB limit. Writes reject symlinks, `sources/`, and nested Git checkouts. Git commits are separate.

## Recovery

Publication retains before/after bytes in ignored `.local/noema/pending.json`; readers refuse partial state. `record --recover` validates every file before rollback and refuses to overwrite external edits. Preserve conflicting journals for inspection.

## Skills

`.agents/skills/` links to the canonical [Recall](skills/noema-recall/SKILL.md) and [Consolidate](skills/noema-consolidate/SKILL.md) sources. Invoke `$noema-recall` or `$noema-consolidate`, or let the Agent select them.

## Automatic loading

Build with `make -C tools build`. The `noema-hook` adapter reads Codex event JSON from stdin.

| Event | Behavior |
| --- | --- |
| `SessionStart` | Load bounded profile, bound work, and pending review pointers |
| `UserPromptSubmit` | Match memory and register a review token |
| `Stop` | Request one consolidation pass unless acknowledged or already continued |
| `SessionEnd` | Defer unfinished reviews without running a model or writing memory |

`Stop` ends a turn. `SessionEnd` is advisory; switching chats does not immediately end a session. Deferred review needs the original transcript to remain available. Hooks retain private identifiers, pointers, and outcomes under `.local/noema/`, without caching dialogue text.

[.codex/hooks.json](../../.codex/hooks.json) defines project hooks. Review changed definitions with `/hooks`; see the [official event and trust contracts](https://learn.chatgpt.com/docs/hooks). This adapter covers Noema project chats. Process tests do not establish native activation.

## Consolidation

Default `auto` requests review, not a record for every turn. `manual` disables unsolicited consolidation while retaining explicit skill use:

```sh
make -C tools noema ARGS='consolidation --mode manual'
make -C tools noema ARGS='consolidation --mode auto'
make -C tools noema ARGS='consolidation --json'
```

The setting is private to this checkout. Status lists pending tokens and source pointers. Acknowledge the exact supplied token after a checked save, or skip it when nothing useful changed:

```sh
make -C tools noema ARGS='consolidation --complete TOKEN --outcome saved'
make -C tools noema ARGS='consolidation --complete TOKEN --outcome skipped'
```

Failed saves and unavailable evidence remain pending. Skipping creates no Corpus record or memory page. Context stays temporary; work handoffs persist through `resume`.

## Validation

From `tools/`, run `cargo test -p Noema-memory --locked` and `cargo clippy -p Noema-memory --all-targets --locked -- -D warnings`. Temporary-repository tests cover continuation, corrections, conflicts, locks, and interrupted writes.
