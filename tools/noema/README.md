# Memory

Selects relevant memory for task context and checks page format.

Run `make -C tools noema ARGS='<command>'`, or use `tools/target/release/noema` after building. `--root PATH` selects another Noema repository; `--json` returns structured output.

| Command | Purpose |
| --- | --- |
| `context --query TEXT` | Recall by names, aliases, scope, and task terms |
| `context --work ID` | Select current work |
| `context --bootstrap` | Load a bounded profile |
| `check` | Validate memory format, identifiers, and dates |

`context --cwd PATH` supplies a scope hint. `--max-chars N` limits output while retaining complete blocks. Automatic selection shows up to three active entries per page, ranked by task terms and recency; `--work` shows the full current view.

## Maintain memory

Edit [memory pages](../../noema/README.md#pages) directly, then run `check`. Keep lasting knowledge in entries and the next useful action in `handoff`. Links to related Corpus fields or projects are optional navigation. Update or remove stale content; Git retains history.

## Skills and hooks

[Recall](skills/noema-recall/SKILL.md) is proactive when local context matters. [Consolidate](skills/noema-consolidate/SKILL.md) saves information that changes future work. `.agents/skills/` links to these canonical sources.

[Project hooks](../../.codex/hooks.json) load profile and bound work at `SessionStart`, then select relevant memory at `UserPromptSubmit`. Private session bindings stay under `.local/noema/`. Saving memory remains an Agent decision; turn and session boundaries require no write.

Review changed definitions with [`/hooks`](https://learn.chatgpt.com/docs/hooks). Process tests do not establish native hook activation.

## Development

From `tools/`, run `cargo test -p Noema-memory --locked` and `cargo clippy -p Noema-memory --all-targets --locked -- -D warnings`.
