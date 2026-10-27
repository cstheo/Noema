# Obsidian

Deploys the dashboard, templates, CSS, and Zotero integration; `.obsidian/` holds ignored local app state.

| Source | Purpose |
| --- | --- |
| [dashboard/](dashboard/) | Calendar and task views over Daily Notes |
| [templates/](templates/) | Daily journal and paper note templates |
| [snippets/](snippets/) | Noema CSS |
| [Zotero integration](plugins/noema-zotero/README.md) | Library, PDFs, annotations, and shared notes |
| [dependencies.json](dependencies.json) | Upstream plugin and theme versions |

## Setup

Install Dataview with JavaScript queries enabled, Tasks, Homepage, and Templater. Enable core Daily Notes and Templates. Install optional dependencies separately; Claudian uses ignored `.claudian/` state.

From the repository root, preview changes, close Obsidian, apply, then reopen:

```sh
make -C tools obsidian ARGS='deploy --check'
make -C tools obsidian ARGS='deploy --apply'
```

Append `--vault-root /absolute/path` to target another vault. Deployment merges managed settings, migrates legacy resources, and refuses conflicting task files or symlinked destinations. Backups go to `<config_dir>/noema-backups/<run>/`. Close Obsidian and reconcile newer edits before restoring files.

[Shared configuration](../config/README.md) controls journal paths, dates, and Zotero timing. Daily Note `## Tasks` sections are canonical; project checklists are excluded from task views.

Back up PDF caches, shared-note registries/baselines/recovery records, settings, and Claudian state privately. A fresh clone also needs upstream dependencies and original attachments; deployment backups alone are insufficient.
