# Noema

Evidence-linked memory for personal context, work continuity, and reusable insights.

- [Profile](profile/README.md): background, preferences, and long-term goals.
- [Work](work/README.md): decisions, findings, and continuation.
- [Insights](insights/README.md): conclusions connecting tasks and sources.

Corpus preserves original evidence. Each memory has one home; context is assembled per task.

## Pages

YAML frontmatter contains stable `id`, topic-only `summary`, and `updated`. Optional fields are `aliases`, repository-relative `scope`, and `resume` evidence. README files provide navigation only.

Each `## entry-id` contains one independently revisable statement:

```markdown
- Basis: explicit
- Status: active
- As of: YYYY-MM-DD
- Evidence: [source](<relative/path/to/record.md#request>)

One supported statement.
```

Repeat Evidence links for multiple sources. Optional fields are `Depends on`, `Supersedes`, and `Review after`; references use `page.id#entry-id`. Reserve `##` for entries.

- Basis: `explicit` user statement, `observed` result, or `inferred` conclusion with dependencies.
- Status: `active`, `review`, `superseded`, or `retracted`.
- `As of` dates the claim; `updated` dates the edit. Review deadlines use UTC dates.

Evidence stores a repository-relative path and optional anchor. Git tracks revisions; source edits alone do not change claim status. Binary sources need a text evidence record. Corrections preserve history and suspend dependent claims. Validation checks links and consistency, not truth or mastery.

A handoff requires valid active premises. Context reuses checked source text.

## Lifecycle

[Recall](../tools/noema/skills/noema-recall/SKILL.md) selects task context. [Consolidate](../tools/noema/skills/noema-consolidate/SKILL.md) preserves durable changes and work handoffs through `resume`.

See the [CLI and record protocol](../tools/noema/README.md), [Hook lifecycle](../tools/noema/README.md#automatic-loading), and [automatic/manual controls](../tools/noema/README.md#consolidation).
