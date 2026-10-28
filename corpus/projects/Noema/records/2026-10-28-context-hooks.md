---
record_id: 2026-10-28-context-hooks
date: 2026-10-28
entries:
- work.noema#context-hook-config
retracts: []
---

# Noema context hook installation

## Authorization

The user explicitly approved the question asking to install the tested project hook configuration:

> 允许安装项目级 hook 配置

The approval covers the reviewed project configuration, not automatic approval of future hook changes or native hook trust.

## Installation

The reviewed configuration was installed as `.codex/hooks.json`. It declares SessionStart and UserPromptSubmit calls to the local release `noema-hook` adapter. The source configuration has one home at that standard project path.

The adapter's six process tests passed, and the release workspace build passed. Only private session work bindings are writable by the adapter; user prompts are not cached. Native hook trust settings were unchanged.

## Handoff

State: Memory pages, check/context/record, the tested event adapter, and the project hook declaration are available. The workspace test run passed 42 tests.
Blocker: The host must review and trust the new hook definition; native execution has not been verified.
Next action: Review the hook in Codex, then verify startup, a named Noema task, continuation, task switching, resume, and compaction in real chats. Manual retrieval remains available through `make -C tools noema ARGS='context --work work.noema'`.
