# Noema

Memory and context that improve future work.

- [Profile](profile/README.md): personal background and lasting preferences.
- [Work](work/README.md): current goals, decisions, constraints, and continuation.
- [Insights](insights/README.md): conclusions connecting tasks or research.

Keep useful state, not activity logs. Edit memory directly; no source archive or evidence link is required. Corpus holds research notes and materials. Links to related Corpus fields or projects are optional navigation.

## Pages

YAML frontmatter contains stable `id`, topic-only `summary`, and `updated`. Optional fields are `aliases`, repository-relative `scope`, and a concise `handoff`. A work page can contain only a handoff.

Each `## entry-id` contains one revisable statement:

```markdown
- Basis: explicit
- Status: active
- As of: YYYY-MM-DD

One useful statement.
```

Basis is `explicit`, `observed`, or `inferred`. Status is `active`, `review`, `superseded`, or `retracted`. Optional `Review after` sets a review date. `As of` dates a claim; `updated` dates an edit.

Revise current entries and remove obsolete detail. Git retains history. Update affected conclusions and handoffs when a premise changes.

[Recall](../tools/noema/skills/noema-recall/SKILL.md) selects relevant context. [Consolidate](../tools/noema/skills/noema-consolidate/SKILL.md) saves lasting changes. The [CLI](../tools/noema/README.md) checks page structure and loads context; it does not establish truth, progress, or mastery.
