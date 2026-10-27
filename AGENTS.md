# Noema

An AI-native personal system for knowledge, memory, and action.

## Design

- **Corpus (`corpus/`)** preserves sources and personal records.
- **Tools (`tools/`)** provide shared capabilities for humans and agents.
- **Noema (`noema/`)** is reserved for evidence-linked knowledge, memory, and insights.

Corpus and Noema supply task context. Agents invoke Tools, record outcomes in Corpus, and refine Noema. See [README.md](README.md) for the architecture.

## Principles

- Keep changes clean, concise, and organized. Reuse existing structures.
- Follow [Asterinas commit conventions](https://asterinas.github.io/book/to-contribute/coding-guidelines/for-maintainability/process.html): imperative subjects up to 72 characters, backticks for identifiers, and one logical change per commit. Amend local review fixes.
- Keep agent instructions here. Use directory READMEs for purpose, navigation, and local conventions.
- Start with the nearest README. Use `rg` in relevant directories; exclude `**/sources/**` unless implementation evidence is needed.
- Inspect current files and behavior. Distinguish plans, implementation, and verified outcomes.
- Record revisions, environment, commands, and outcomes for experiments. Distinguish published claims, static checks, and runtime proof.
- Preserve sources and ownership. Link derived claims to evidence; distinguish explicit statements, observations, and inferences.
- Track time and uncertainty. File activity alone does not prove progress or mastery.
- Propagate user corrections. Preserve history and mark superseded claims.
- Select context for the task. Verify precise claims against original sources.
- Write system and agent content in English. Preserve source languages.
- Keep private state and credentials out of tracked source.
