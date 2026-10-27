# iPad and Mac

One Mac LaunchAgent connects Apple Notes to a personal agent and synchronizes Daily Note tasks with iCloud Reminders.

## Setup

Enable iCloud Notes and Reminders on both devices with the same Apple Account. Sign in to the Codex CLI for personal answers. From the repository root:

```sh
make -C tools mobile ARGS=init
make -C tools mobile ARGS=init-reminders
make -C tools mobile ARGS=install
make -C tools mobile ARGS=status
```

Allow Notes automation and Reminders access. Use private Notes folders and a private Reminders list. The Mac must stay awake, logged in, and online; iCloud delivery can lag. Names below use [configuration defaults](../config.toml).

## Daily tasks

Create tasks under `## Tasks` in a Daily Note, through the dashboard, or in **Reminders → Noema**. Title, completion, due date (`📅 YYYY-MM-DD`), and priority sync both ways without a model call. New reminders enter today's Daily Note; later due-date changes keep the original capture date and task identity.

Keep generated IDs intact. Recurring tasks and custom completion states require review. Deletion or moving one copy does not delete the other. Conflicting edits wait for matching values; inspect `status`.

## AI requests

Create a plain-text note directly in **Notes → Noema** on the iPad or Mac. The agent reads relevant personal memory from `noema/` and sources from `corpus/`, then appends its answer under **Noema** in that same note.

Each note is one conversation. Append a follow-up on a new line below the latest answer; no command or special heading is required. Each turn starts a fresh, read-only agent session with the complete note and the latest question, and can retrieve relevant repository context again. Separate notes have separate conversations. You can also start one from the Mac with `make -C tools mobile ARGS='submit "Your question"'`.

Keep earlier questions and answers intact: changes to the answered prefix do not trigger a reply. Whitespace and formatting changes are ignored. New text settles before generation; edits made before delivery are checked again. The agent's own answers do not trigger another turn. Conversations over 128 KiB require a new note. Existing single-answer notes become conversation baselines on the first check after upgrading.

The answer is the result: there are no status/draft folders, approval commands, automatic archives, or automatic memory writes. Existing records are preserved. Personal memory stays in the repository; the agent selects relevant context for each request.

Codex runs in a read-only sandbox. Requests and retrieved excerpts reach the signed-in model service. Repository-only access is an instruction, not a filesystem read restriction. Shared, locked, or attachment-bearing Notes are unsupported. Progress and errors are available through the CLI's `status` command.

## Operation

Reminders and journal events wake the worker; configured polling checks Notes and reconciles missed events. Obsidian can stay closed. Observer failures appear in `status`.

Use `make -C tools mobile ARGS=<command>`. `run` starts a foreground worker; `uninstall` removes the LaunchAgent and preserves records, even with invalid configuration. Stop the service before a foreground run or moving the repository. Reinstall after code changes; forward `--repo /absolute/path` when needed.

Follow the [configuration lifecycle](../config/README.md#apply-changes) before changing paths or names. Back up ignored `.local/` identities, bindings, and logs with the corpus and Notes. It also holds the signed app; rebuilding may require Apple permissions again.
