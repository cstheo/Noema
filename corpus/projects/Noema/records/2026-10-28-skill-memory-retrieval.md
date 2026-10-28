---
record_id: 2026-10-28-skill-memory-retrieval
date: 2026-10-28
request_sha256: c5ad38a6c2f44b78c04ad2087f281a350a856640805811d833f91b6a2e87fee0
entries:
- work.noema#skill-assisted-retrieval
- work.noema#retrieval-reference-review
retracts: []
---

# Skill-guided memory retrieval references

## Request

The user requested:

> 应当支持skill和大模型辅助memory搜索，搜索相关系统实现提供参考

## Findings

These are agent-authored findings from primary documentation and source inspection. No external system was installed, and no performance benchmark was reproduced.

- QMD at commit `86d2365d17fc682e491c2c53d1e4a884aee8682a`: its retrieval skill asks the current Agent to formulate intent and lexical/semantic queries, search candidates, then fetch line-numbered originals before answering. Structured queries bypass built-in expansion; the backend can combine BM25/vector results and rerank. The skill recommends structured input, while current MCP code permits either plain query or structured searches.
  - https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/skills/qmd/SKILL.md
  - https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/store.ts#L6644-L6792
  - https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/mcp/server.ts#L397-L472
- Letta Code at `5dea67021b99810707ff753db35e4534f70ff1fd`: directory indexes and child descriptions support progressive memory discovery; Skill loads procedures separately. Recall instructions ask the model to search, then expand around useful message IDs. Noema can retain README navigation rather than adopting Letta's MEMORY.md filename or its log-retention policy.
  - https://github.com/letta-ai/letta-code/blob/5dea67021b99810707ff753db35e4534f70ff1fd/src/tools/impl/memory.ts
  - https://github.com/letta-ai/letta-code/blob/5dea67021b99810707ff753db35e4534f70ff1fd/src/skills/builtin/maintaining-deferred-memory/SKILL.md
  - https://github.com/letta-ai/letta-code/blob/5dea67021b99810707ff753db35e4534f70ff1fd/src/agent/prompts/recall_subagent.md
- Hermes: the current session-search tool offers lexical discovery, anchored message windows, full-session reads, and browsing. Its inspected file explicitly performs no internal LLM calls; the caller model drives the loop. The inspected session-search blob SHA is `4cd76bae45c9b2f122eacb4c7cddef3e6bcf7526` (a file blob, not a commit). Procedures belong in skills; stable cross-task facts belong in lightweight memory.
  - https://github.com/NousResearch/hermes-agent/blob/main/tools/session_search_tool.py
  - https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_builder.py
  - https://github.com/NousResearch/hermes-agent/blob/main/skills/research/llm-wiki/SKILL.md
- OpenViking at `6afd9ba300848cd302cd00bc944b4f1d02e28476`: IntentAnalyzer uses conversation context and a configured LLM to generate typed memory/resource/skill queries. Current retrieval code performs global vector/keyword recall within filters plus optional reranking; it does not implement the recursive directory descent suggested by some older descriptions. Abstract/overview/detail are loading levels, not epistemic memory types.
  - https://github.com/volcengine/OpenViking/blob/6afd9ba300848cd302cd00bc944b4f1d02e28476/openviking/retrieve/intent_analyzer.py
  - https://github.com/volcengine/OpenViking/blob/6afd9ba300848cd302cd00bc944b4f1d02e28476/openviking/retrieve/hierarchical_retriever.py
- jyy GenSE Labs 1 and 2 are design/evaluation references, not evidence of a deployed memory engine. They emphasize evolving personal sources, locating originals, reusable procedures/corrections, and bounded explore/evaluate/refine loops with fixed-input effort comparisons.
  - https://jyywiki.cn/GSE/2026/lab1.md
  - https://jyywiki.cn/GSE/2026/lab2.md

## Proposal

Use one recall skill and the already-running Agent model to interpret the task, choose Memory/Corpus scopes, formulate several queries, inspect candidates, read original evidence, and refine queries under a budget. Expose small scoped search and bounded read primitives; assemble context from selected evidence. Keep lightweight lexical matching as a fast path. QMD-style hybrid retrieval is an optional later backend, not a required first dependency.

Preserve Noema's deterministic evidence/status/dependency gates. Index eligible memory entries or filter results by entry ID before context assembly; raw Markdown search can otherwise surface superseded history. Hypothetical query expansion text is a search hint, never source evidence or proof of user knowledge.

For `research about CXL`, the Agent should discover the existing Corpus Memory Systems entry even when work.cxl does not exist. Candidate query reformulations require relevance checks before use. Evaluate against literal-only retrieval on first-time topics, indirect cross-session references, and corrections; measure source coverage, citation accuracy, stale-memory exclusion, latency, and tokens.

## Handoff

State: Primary-source comparison is complete. The user requests skill and LLM-assisted memory search; the current CLI still uses deterministic literal matching and does not search the whole Corpus.
Blocker: The skill-driven search/read interface and optional backend remain design proposals, not implemented features.
Next action: Add one recall skill plus scoped candidate search and original-source reads. Reuse the current Agent for query planning first, preserve record/check, and test the CXL and correction cases before adding a separate retrieval-model service.
