# Tools

Shared capabilities for humans and agents, built as a Rust workspace for macOS 14 or later.

| Component | Purpose |
| --- | --- |
| [Mobile](mobile/README.md) | Daily tasks through Reminders; AI requests through Notes. |
| [Memory](noema/README.md) | Retrieve context, record outcomes, and check evidence. |
| [Obsidian](obsidian/README.md) | Dashboard, templates, and Zotero integration. |
| [Configuration](config/README.md) | Shared settings and validation. |

## Commands

Install Rust through rustup and Apple's Command Line Tools. From the repository root:

```sh
make -C tools build
make -C tools check
make -C tools mobile ARGS=status
make -C tools noema ARGS=check
make -C tools obsidian ARGS='deploy --check'
make -C tools deploy
```

Close Obsidian before deployment. Complete [mobile setup](mobile/README.md#setup) before the first install. Edit [config.toml](config.toml), then follow the [configuration lifecycle](config/README.md#apply-changes).

Run `make -C tools` for targets. `ARGS` forwards CLI arguments; `CARGO_FLAGS='--locked --offline'` enables offline builds. `clean` removes Cargo output and preserves private state.

## Development

Run Cargo from `tools/` to select the pinned toolchain. Keep `Cargo.lock` tracked and inherit workspace dependencies and lints. Keep Apple APIs in `mobile/src/macos/`; extract shared code only for real shared consumers.

Run `cargo test --workspace --locked` and checks for affected components. [Zotero tests](obsidian/plugins/noema-zotero/README.md#development) run separately. Distinguish automated tests from live app validation.
