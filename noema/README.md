# Noema

Evidence-linked memory that improves future work.

- [Profile](profile/README.md): personal background and lasting preferences.
- [Work](work/README.md): current goals, decisions, constraints, and continuation.
- [Insights](insights/README.md): supported conclusions connecting tasks or research.

Corpus owns original evidence and technical notes. Keep one primary home; link rather than duplicate. Routine activity and implementation history stay out of memory.

## Pages

YAML frontmatter contains stable `id`, topic-only `summary`, and `updated`. Optional fields are `aliases`, repository-relative `scope`, and a concise `handoff` string. A work page can contain only a handoff. `resume` may instead point to a Corpus path and section.

Each `## entry-id` contains one revisable statement:

```markdown
- Basis: explicit
- Status: active
- As of: YYYY-MM-DD
- Evidence: [source](<relative/path/to/evidence.md#section>)

One supported statement.
```

Basis is `explicit`, `observed`, or `inferred`. Inferences require `Depends on` references; optional fields are `Supersedes` and `Review after`. Entry references use `page.id#entry-id`.

Status is `active`, `review`, `superseded`, or `retracted`. `As of` dates a claim; `updated` dates an edit. Revise current entries and remove obsolete detail; Git retains history. Corrections suspend dependent conclusions until reviewed.

Evidence links to Corpus text through a path and optional anchor. Validation checks structure, links, and dependencies. It does not establish truth, progress, or mastery.

[Recall](../tools/noema/skills/noema-recall/SKILL.md) selects relevant context. [Consolidate](../tools/noema/skills/noema-consolidate/SKILL.md) decides whether any new information deserves saving. Records, memory, and handoffs can be updated independently through the [write protocol](../tools/noema/README.md#change-sets).
