# Configuration

Validates [config.toml](../config.toml) for both Rust applications and generates Obsidian's shared settings.

| Section | Controls |
| --- | --- |
| Root | Timezone and display locale |
| `journal` | Daily Note folder, filename format, and template |
| `mobile` | Notes/Reminders names and synchronization timing |
| `agent` | Executable, answer timeout, optional model, and additional instructions |
| `obsidian` | Vault configuration directory, CSS, and add-on output |
| `obsidian.zotero` | Research folder and library refresh interval |

Paths are relative to the repository, except the agent executable and optional absolute add-on output. Record folders must stay under `corpus/`. Unknown keys, invalid types, unsafe paths, and invalid intervals fail before writes.

Journal formats require numeric year, month, and day tokens: `YYYY`/`YY`, `MM`/`M`, `DD`/`D`. Use `[literal]` escapes. Locale affects display labels; filenames remain ASCII. Additional agent instructions extend the read-only policy without changing its sandbox.

## Apply changes

Edit TOML, close Obsidian, run `make -C tools deploy` from the repository root, then reopen Obsidian. Mobile reads configuration at startup. Deployment applies Daily Notes settings and generates `<config_dir>/noema.json`; do not edit that JSON.

Before changing paths or Apple folder/list names, stop mobile with `make -C tools mobile ARGS=uninstall`. Move existing resources while preserving identities, update configuration, and redeploy. Editing settings alone does not migrate data. A custom `config_dir` must match Obsidian's actual directory and be ignored by Git.

Mobile uses its selected `--repo`; Obsidian deployment uses the source checkout's configuration. Account/list bindings stay in ignored `mobile/.local/bindings.json`. Keep credentials out of TOML.
