---
record_id: 2026-10-29-workspace
date: 2026-10-29
entries:
- work.noema#unified-workspace
retracts: []
---

# Local workspace

## Request

> 我未来会直接在Noema repo中开启会话并进入各个project/artifact等完成工作，也就是说我为了除非需要独立memory的情况不会单独进入project进行开发，这是为了持续生成开发project和做research的records和noema memory，持续赋能未来research paper write和个人context的invovle

## Design

Use `workspace/<name>/` for local checkouts, datasets, and raw runs. Noema ignores its contents except the workspace README. Checkouts retain independent Git history; existing Corpus submodules remain in place.

Keep project entry points and experiment evidence under `corpus/projects/<name>/`; link reading notes and concepts in their research fields. Work memory uses names, aliases, and scopes for both project and workspace paths. Preserve source revisions, local changes, environment, commands, results, limitations, and continuation in Corpus before deriving memory. Local output paths alone are insufficient evidence.

Sessions remain rooted in Noema. Agents read checkout instructions, recall the target explicitly with `context --cwd`, and run scoped commands there. Hooks receive the session directory; shell working directories do not automatically change memory bindings. No hook or CLI code changed.

## Verification

Git ignore checks keep workspace checkouts and raw results ignored while the workspace README and Corpus records remain trackable. Independent CLI processes in a temporary fixture passed scoped recall, record dry-run/publication, correction and continuation, and check. No memory was written inside the fixture checkout. This does not establish native hook activation or any actual paper reproduction.

## Handoff

State: The local workspace convention and navigation are implemented on base `d5326b9`; this addition is uncommitted. Existing source repositories and independent XMFS work are unchanged. The preceding memory cleanup is committed.
Next: For a selected project or paper artifact, create its local workspace and Corpus entry, then save supported experiment outcomes and work memory at milestones.
