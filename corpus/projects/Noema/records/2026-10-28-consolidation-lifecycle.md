---
record_id: 2026-10-28-consolidation-lifecycle
date: 2026-10-28
request_sha256: c6077434eb0dc51f1ec83373216d315d0cc65364800b2a3eaa5fa575da876594
entries:
- work.noema#recall-consolidate-loop
- work.noema#consolidation-lifecycle
- insight.agent-lifecycle#live-review-deferred-close
retracts: []
---

# Recall and consolidation lifecycle

## Request

> 添加一个session结束时主动沉淀noema的选项，两个skill形成配合，一个主动加载，一个主动沉淀，并配合hooks实现noema的自动/主动匹配加载，自动/主动沉淀insights/context的Noema system

## Design

Recall selects missing task context; Consolidate preserves useful outcomes, corrections, supported insights, and continuation. The existing Agent performs semantic decisions. The CLI validates and publishes source records and memory changes.

Current Codex event contracts distinguish turn end from session end. Stop can request a bounded continuation; SessionEnd is synchronous and advisory and cannot continue the Agent. Therefore Stop requests one consolidation review; SessionEnd retains unfinished source pointers for later review. Context remains transient; work.resume points to a concise source handoff.

Primary references, inspected 2026-10-28:

- [Official Hook contracts](https://learn.chatgpt.com/docs/hooks): SessionStart, UserPromptSubmit, Stop, SessionEnd, stop_hook_active, and trust review.
- [Official skill structure](https://learn.chatgpt.com/docs/build-skills): instruction-only skills, progressive loading, project discovery, and optional UI metadata.

Default mode is auto; manual disables unsolicited reviews while preserving explicit skill use. Opaque review tokens distinguish successful saves, no-value skips, and unresolved reviews. Failed checks or unavailable evidence remain pending. Private state stores hashed identifiers, source pointers, and outcomes; hooks do not cache dialogue text or publish Corpus/Noema files.

Pending reviews survive new turns and sessions. Same-session resume may also expose unacknowledged requests without inferring that another session ended. Completed receipts are reclaimed at capacity. A separate private-state lock keeps SessionEnd independent of memory publication. Atomic writes stage outside the request index so an interrupted write cannot poison discovery.

## Verification

Environment: macOS, base HEAD 6808abd256004f966c62714e46f933c05b8494e6, existing uncommitted backbone work. Installed CLI 0.164.0 schemas were inspected; no native model session was launched for lifecycle testing.

Commands in tools/: cargo test -p Noema-memory --locked; cargo clippy -p Noema-memory --all-targets --locked -- -D warnings; cargo fmt --all -- --check; cargo build --release -p Noema-memory --locked.

All 53 Noema tests passed: 14 unit, 21 hook integration, 16 record/context lifecycle, and 2 safety tests. Format and strict Clippy checks passed; release binaries were rebuilt. Tests cover manual/auto, proactive acknowledgements, replay and loop guards, cross-turn/session isolation, delayed review, source-free skips, invalid saves, locks, metadata bounds, capacity reclamation, and interrupted staging.

Independent agents evaluated the skill with synthetic fixtures under /private/tmp/noema-consolidate-eval-vmwj9l9b, without expected answers:

| Request | Verified outcome |
| --- | --- |
| Close out adapter work using supplied reports | Saved an inferred insight with both premises and refreshed the existing work handoff; no preference or native-runtime claim added |
| Close out with no new information | Acknowledged skipped; no Corpus or memory bytes changed |
| Process a deferred session with missing original evidence | Left token pending; no invented record or acknowledgement |

Independent hash comparisons confirmed original Corpus sources were preserved. Fresh-process check returned no errors, warnings, or invalid entries. Independent code review reproduced and verified fixes for completed-receipt exhaustion, closing during publication, and SIGKILL staging orphans; no actionable findings remained.

Both project skill aliases and the four-event .codex/hooks.json definition are installed. Hook SHA256: 4ae1c4c8a5dd2e6f84edeb1fa76475225bf185d84d8665ca2b56bf19e07ca954.
Release noema SHA256: 16405f63dc80457fdba0fb2055bf9db96fab99d3676262196b724cb9a34d08e7.
Release noema-hook SHA256: 8963c95fb78352b33ea00e4d76bf3daeaf7eb5acd33d0a1538177b3c2fd98c98.

These are process and synthetic behavioral checks. Native hook trust/activation, real session closure, and automatic skill selection are not established by these tests. A deferred pointer permits recovery only while its original source remains available. No Git commit was created.

## Handoff

State: Recall and Consolidate are implemented as cooperating project skills. Hooks load context, register review tokens, request bounded Stop review, and defer unfinished SessionEnd reviews. Auto/manual controls and source-preserving record/check publication are tested.
Next: Review the changed hook definition with /hooks and verify startup, a substantive task, no-value closure, and resume in a native Codex session. Preserve the distinction between process tests and native proof.
