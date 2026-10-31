# Noema

An AI-native personal system for knowledge, memory, and action.

## Design

- **Corpus (`corpus/`)** holds sources and personal notes.
- **Tools (`tools/`)** provide shared capabilities for humans and agents.
- **Noema (`noema/`)** holds knowledge, memory, and insights.

Corpus and Noema supply task context. Agents invoke Tools, develop notes, and refine memory. See [README.md](README.md) for the architecture.

## Principles

- Keep changes clean, concise, and organized. Reuse existing structures.
- Do not add application-level hashing, fingerprints, or checksum metadata. Use stable IDs, direct comparisons, and only necessary validation.
- Follow [Asterinas commit conventions](https://asterinas.github.io/book/to-contribute/coding-guidelines/for-maintainability/process.html): imperative subjects up to 72 characters, backticks for identifiers, and one logical change per commit. Amend local review fixes.
- Keep agent instructions here. Use directory READMEs for purpose, navigation, and local conventions.
- Start with the nearest README. Use `rg` in relevant directories; exclude `**/sources/**` unless implementation evidence is needed.
- Keep sessions rooted in Noema. For [workspace](workspace/README.md) tasks, recall with `context --cwd PATH` and follow checkout instructions.
- Inspect current files and behavior. Distinguish plans, implementation, and verified outcomes.
- Keep useful experiment results and essential reproduction details in project notes. Distinguish published claims, static checks, and runtime proof.
- Preserve sources and ownership. Distinguish user statements, observations, and inferences.
- Track time and uncertainty. File activity alone does not prove progress or mastery.
- Apply user corrections to current memory and review affected conclusions. Git retains edit history.
- Select context for the task. Verify precise technical claims against original sources.
- Proactively use [Noema Recall](tools/noema/skills/noema-recall/SKILL.md) when local context matters. Reuse checked context; refresh after task changes or context loss.
- Use [Noema Consolidate](tools/noema/skills/noema-consolidate/SKILL.md) for lasting corrections, decisions, insights, or essential continuation. Edit memory directly; routine answers, checks, commits, and session closure need no write.
- Write system and agent content in English. Preserve source languages.
- Keep private state and credentials out of tracked source.
