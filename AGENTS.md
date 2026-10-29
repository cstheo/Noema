# Noema

An AI-native personal system for knowledge, memory, and action.

## Design

- **Corpus (`corpus/`)** preserves sources and personal records.
- **Tools (`tools/`)** provide shared capabilities for humans and agents.
- **Noema (`noema/`)** holds evidence-linked knowledge, memory, and insights.

Corpus and Noema supply task context. Agents invoke Tools, record outcomes in Corpus, and refine Noema. See [README.md](README.md) for the architecture.

## Principles

- Keep changes clean, concise, and organized. Reuse existing structures.
- Do not add application-level hashing, fingerprints, or checksum metadata. Use stable IDs, direct comparisons, and only necessary validation.
- Follow [Asterinas commit conventions](https://asterinas.github.io/book/to-contribute/coding-guidelines/for-maintainability/process.html): imperative subjects up to 72 characters, backticks for identifiers, and one logical change per commit. Amend local review fixes.
- Keep agent instructions here. Use directory READMEs for purpose, navigation, and local conventions.
- Start with the nearest README. Use `rg` in relevant directories; exclude `**/sources/**` unless implementation evidence is needed.
- Keep sessions rooted in Noema. For [workspace](workspace/README.md) tasks, recall with `context --cwd PATH` and follow checkout instructions.
- Inspect current files and behavior. Distinguish plans, implementation, and verified outcomes.
- Record revisions, environment, commands, and outcomes for experiments. Distinguish published claims, static checks, and runtime proof.
- Preserve sources and ownership. Link derived claims to evidence; distinguish explicit statements, observations, and inferences.
- Track time and uncertainty. File activity alone does not prove progress or mastery.
- Propagate user corrections. Preserve history and mark superseded claims.
- Select context for the task. Verify precise claims against original sources.
- Proactively use [Noema Recall](tools/noema/skills/noema-recall/SKILL.md) when local context matters. Reuse checked context; refresh after task changes or context loss.
- Use [Noema Consolidate](tools/noema/skills/noema-consolidate/SKILL.md) only for significant evidence, lasting corrections or decisions, and essential continuation. Update existing artifacts; routine answers, checks, commits, and session closure need no record.
- Write system and agent content in English. Preserve source languages.
- Keep private state and credentials out of tracked source.
