# Workspace

Local checkouts, paper artifacts, datasets, and experiment output.

Only this README is tracked by Noema. Each checkout keeps its own Git history. Create directories as needed:

```text
workspace/<name>/
  repo/                 # Cloned repository.
  runs/                 # Raw logs and results.
  data/                 # Datasets and downloaded inputs.
```

Keep durable content outside Workspace, using the same project name:

| Location | Content |
| --- | --- |
| `corpus/projects/<name>/README.md` | Objective, paper/source links, and workspace path |
| `corpus/projects/<name>/records/` | Significant experiment and decision evidence |
| `noema/work/<name>.md` | Supported memory and continuation |

Link reading notes and reusable concepts in their [research fields](../corpus/research/README.md).

## Workflow

Open chats in Noema. Read the project's Corpus entry and checkout instructions, then recall the target:

```sh
tools/target/release/noema context --query '<name>' --cwd 'workspace/<name>'
```

Set work memory aliases and `scope` paths for `workspace/<name>` and `corpus/projects/<name>`. Hooks see the session directory, so recall explicitly when targets change.

Scope commands to the checkout: `git -C workspace/<name>/repo status` or `rg --no-ignore PATTERN workspace/<name>/repo`.

For significant experiments, preserve the result, necessary environment and commands, limitations, and reproducible artifacts in Corpus. Keep bulk output local. Use [Consolidate](../tools/noema/skills/noema-consolidate/SKILL.md) only when new evidence or continuation changes future work; memory and handoffs can be updated independently.

[Noema](../README.md)
