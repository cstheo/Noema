# Memory retrieval references

## Findings

Primary documentation and source inspected on 2026-10-28. No integration or performance comparison was reproduced.

- QMD at commit `86d2365d17fc682e491c2c53d1e4a884aee8682a`: its retrieval skill asks the current Agent to formulate intent and lexical/semantic queries, search candidates, then fetch line-numbered originals before answering. Structured queries bypass built-in expansion; the backend can combine BM25/vector results and rerank. The skill recommends structured input, while current MCP code permits either plain query or structured searches.
  - https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/skills/qmd/SKILL.md
  - https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/store.ts#L6644-L6792
  - https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/mcp/server.ts#L397-L472
- Letta Code at `5dea67021b99810707ff753db35e4534f70ff1fd`: directory indexes and child descriptions support progressive memory discovery; Skill loads procedures separately. Recall instructions ask the model to search, then expand around useful message IDs. Noema can retain README navigation rather than adopting Letta's MEMORY.md filename or its log-retention policy.
  - https://github.com/letta-ai/letta-code/blob/5dea67021b99810707ff753db35e4534f70ff1fd/src/tools/impl/memory.ts
  - https://github.com/letta-ai/letta-code/blob/5dea67021b99810707ff753db35e4534f70ff1fd/src/skills/builtin/maintaining-deferred-memory/SKILL.md
  - https://github.com/letta-ai/letta-code/blob/5dea67021b99810707ff753db35e4534f70ff1fd/src/agent/prompts/recall_subagent.md
- Hermes: the current session-search tool offers lexical discovery, anchored message windows, full-session reads, and browsing. Its inspected file explicitly performs no internal LLM calls; the caller model drives the loop. Procedures belong in skills; stable cross-task facts belong in lightweight memory.
  - https://github.com/NousResearch/hermes-agent/blob/main/tools/session_search_tool.py
  - https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_builder.py
  - https://github.com/NousResearch/hermes-agent/blob/main/skills/research/llm-wiki/SKILL.md
- OpenViking at `6afd9ba300848cd302cd00bc944b4f1d02e28476`: IntentAnalyzer uses conversation context and a configured LLM to generate typed memory/resource/skill queries. Current retrieval code performs global vector/keyword recall within filters plus optional reranking; it does not implement the recursive directory descent suggested by some older descriptions. Abstract/overview/detail are loading levels, not epistemic memory types.
  - https://github.com/volcengine/OpenViking/blob/6afd9ba300848cd302cd00bc944b4f1d02e28476/openviking/retrieve/intent_analyzer.py
  - https://github.com/volcengine/OpenViking/blob/6afd9ba300848cd302cd00bc944b4f1d02e28476/openviking/retrieve/hierarchical_retriever.py
- jyy GenSE Labs 1 and 2 are design/evaluation references, not evidence of a deployed memory engine. They emphasize evolving personal sources, locating originals, reusable procedures/corrections, and bounded explore/evaluate/refine loops with fixed-input effort comparisons.
  - https://jyywiki.cn/GSE/2026/lab1.md
  - https://jyywiki.cn/GSE/2026/lab2.md

## Design implications

Use the current Agent to choose scopes, reformulate queries, inspect candidates, and read original evidence. README navigation and lexical search provide a small first implementation. Add another backend only for a demonstrated retrieval gap. Hypothetical query expansions remain search hints, not personal facts.

[Noema project](README.md)
