---
record_id: 2026-10-28-memory-backbone
date: 2026-10-28
request_sha256: 032cd2d0451fa71d1226cf169fffb7ae12f31e6fe9ecdddb47f382a806580867
entries:
- profile.preferences#concise-docs
- profile.preferences#root-agent-instructions
- profile.preferences#course-ownership
- work.noema#memory-backbone
retracts: []
---

# Noema memory backbone

## Scope

User request:

> 接下来开始设计 noema 部分，结合之前的讨论，先明确目录骨架、记忆页格式，以及 context、record、check 的最小闭环。

After the staged build plan, the user authorized implementation:

> 请你开始搭建

## Documentation

User preference:

> make the AGENTS and README more clean and concise, prefer short and targeted sentences

## Agent instructions

User constraint:

> 不要在子文件夹创建AGENTS，只使用README

## Source ownership

User correction:

> 请你不要提交CS229的内容，resotre

This limits Noema work: preserve course notes and their owning Git history separately.

## Handoff

State: Build the memory backbone with evidence-linked pages and the check/context/record lifecycle.
Blocker: Native host hook trust and live startup/compaction verification remain separate from CLI tests.
Next action: Run the memory checks and targeted context command, then review the local Codex hook before native activation.

The handoff is an agent-authored checkpoint and plan, not proof of user mastery or native hook activation.
