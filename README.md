# Noema

An AI-native personal system for knowledge, memory, and action.

## Design

| Component | Purpose |
| --- | --- |
| [Corpus](corpus/README.md) | Sources and personal records. |
| [Tools](tools/README.md) | Shared capabilities for humans and agents. |
| [Noema](noema/README.md) | Evidence-linked memory, insights, and task context. |

Agents [recall](tools/noema/skills/noema-recall/SKILL.md) task context and [consolidate](tools/noema/skills/noema-consolidate/SKILL.md) durable outcomes through `context`, `record`, and `check`.

Initialize source checkouts with `git submodule update --init`; initialize nested submodules when needed.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontFamily": "Inter, system-ui, sans-serif", "fontSize": "16px", "lineColor": "#94a3b8", "edgeLabelBackground": "#ffffff"}, "flowchart": {"curve": "basis", "nodeSpacing": 40, "rankSpacing": 44, "padding": 20}}}%%
flowchart LR

    C("<b>Corpus</b><br/>Sources & records")
    N("<b>Noema</b><br/>Knowledge, memory & insights")
    X("<b>Task context</b><br/>Selected evidence & memory")
    A("<b>Agent</b><br/>Reason & act")
    T("<b>Tools</b><br/>Retrieve · act · verify")

    C -->|Synthesize & refine| N
    C --> X
    N --> X
    X --> A
    A -->|Invoke| T
    T -.->|Record actual outcomes| C
    T -.->|Update & validate| N

    classDef corpus fill:#eff6ff,stroke:#93c5fd,color:#1e3a5f,stroke-width:1.5px,rx:14,ry:14
    classDef memory fill:#f5f3ff,stroke:#c4b5fd,color:#4c1d95,stroke-width:1.5px,rx:14,ry:14
    classDef context fill:#f8fafc,stroke:#cbd5e1,color:#334155,stroke-width:1.5px,rx:14,ry:14
    classDef agent fill:#ecfdf5,stroke:#6ee7b7,color:#065f46,stroke-width:1.5px,rx:14,ry:14
    classDef tools fill:#fffbeb,stroke:#fcd34d,color:#78350f,stroke-width:1.5px,rx:14,ry:14

    class C corpus
    class N memory
    class X context
    class A agent
    class T tools

    linkStyle 0 stroke:#a78bfa,stroke-width:1.8px
    linkStyle 1,2,3,4 stroke:#94a3b8,stroke-width:1.6px
    linkStyle 5,6 stroke:#c0a16b,stroke-width:1.4px
```

[Agent instructions](AGENTS.md)
