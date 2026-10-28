---
record_id: 2026-10-28-recall-skill
date: 2026-10-28
request_sha256: 6c37035693db937a87f40999c05f07f301b9cac07a74b0ff49ec8957e0d6368d
entries:
- work.noema#recall-skill
retracts: []
---

# Noema Recall skill

## Request

> 请你搜索如何实现一个好的/高效的skill，并参考相关AI-native系统的skill为Noema system设计skill

## Design

One project skill handles task-specific recall. Its description defines triggers; the short core guides decisions; command details load on demand. The current Agent plans queries and reads original sources using the existing CLI and filesystem tools. Checked context is reused. Retrieval stops at sufficient coverage, diminishing returns, or an access/effort limit.

Sources informed the design, rather than establishing Noema performance:

- [OpenAI Build skills](https://learn.chatgpt.com/docs/build-skills): one job, progressive disclosure, precise triggers, project discovery and symlink support.
- [OpenAI skill evaluations](https://developers.openai.com/blog/eval-skills): evaluate routing and observable tool behavior, including negative cases.
- [Anthropic authoring guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices): concise instructions, task-appropriate freedom, evaluation before expansion.
- [Agent Skills specification](https://agentskills.io/specification): portable metadata and resource structure.
- [QMD retrieval skill](https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/skills/qmd/SKILL.md): intent and query variants, candidate discovery, then original reads.
- [Letta deferred memory](https://github.com/letta-ai/letta-code/blob/5dea67021b99810707ff753db35e4534f70ff1fd/src/skills/builtin/maintaining-deferred-memory/SKILL.md): descriptions and navigation support selective loading; memory and procedures have different roles.
- [Hermes llm-wiki](https://github.com/NousResearch/hermes-agent/blob/main/skills/research/llm-wiki/SKILL.md): navigate, search, read, and synthesize with sources. The main-branch link can change.

Canonical files live in `tools/noema/skills/noema-recall/`. The project discovery symlink `.agents/skills/noema-recall` resolves there. Root AGENTS and memory/tool READMEs link to that single source. The skill retains deterministic memory validity gates and the existing record/check protocol. Raw history and hypothetical query expansions cannot establish current personal claims. No separate model service or search backend was added.

## Verification

Environment: macOS, repository base HEAD `6808abd256004f966c62714e46f933c05b8494e6`, with existing uncommitted backbone work. Tests used independent agents without conversation history and synthetic fixtures under `/private/tmp/noema-recall-eval-fjmvae2e`. They were given realistic tasks, the skill path/description, and fixture roots without expected answers.

| Trial | Observed behavior |
| --- | --- |
| First-time CXL research | Empty checked memory did not end recall. README navigation and query expansion found a note using Compute Express Link; the Agent read and cited original lines. Repeated after removing the topic-specific command example. |
| Continue corrected work | Checked context selected the revised direction and handoff; the superseded direction and review-only inference were not used as current instructions. |
| Translate hello | Returned the translation without skill, tool, or file access. |
| Explicit memory correction | Read the schema; ran record dry-run, record, check, and context. Added one source record, appended the current direction, superseded its predecessor, and preserved original evidence. |

Independent byte-hash comparison confirmed no changes to the two read-only fixtures. The correction changed only its work page and added one record; old source hashes were unchanged. A separate process returned only the two new active entries. Fixture `check --json` returned empty errors, warnings, and invalid lists.

The official `quick_validate.py` passed using a temporary PyYAML environment. UI metadata, relative prose links, the discovery symlink, and the root-only AGENTS layout passed static checks. Actual-vault `check --json` and `git diff --check` passed. No Git commit was created.

Tested SKILL SHA256: `7e0535425db13b518ae1ab6be1536c68352480ce78c4fbdaa352062ae487d5af`.
Command reference SHA256: `92d83fc4e088ed52463a4b50b6c7320119809702528e8da39a979ebf25953147`.
CLI SHA256: `97b095200212d24e66bc4f4739771f03c0a5368a3cb4870747443211ee662d38`.

These trials establish limited local behavior, not native host discovery, automatic skill selection, general recall quality, or token/latency gains. No controlled baseline benchmark was run.

## Handoff

State: Noema Recall is implemented as one project-scoped skill, linked from AGENTS and READMEs, with four synthetic forward scenarios verified. The current Agent performs query planning; the existing CLI validates memory and controlled writes.
Next: Verify discovery and implicit selection in a fresh native Codex chat. Compare representative tasks with and without the skill before adding a search backend or claiming efficiency gains.
