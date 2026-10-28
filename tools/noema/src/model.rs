use anyhow::{Context, Result, bail, ensure};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Basis {
    Explicit,
    Observed,
    Inferred,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Active,
    Review,
    Superseded,
    Retracted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Meta {
    pub id: String,
    pub summary: String,
    pub updated: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scope: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub basis: Basis,
    pub status: Status,
    pub as_of: String,
    pub text: String,
    pub evidence: Vec<Evidence>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub supersedes: Vec<String>,
    #[serde(default)]
    pub review_after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub path: String,
    pub meta: Meta,
    pub entries: Vec<Entry>,
}

#[derive(Default)]
pub(crate) struct Fence(Option<(char, usize)>);

impl Fence {
    pub fn is_open(&self) -> bool {
        self.0.is_some()
    }

    pub fn advance(&mut self, line: &str) -> bool {
        let trimmed = line.trim_start();
        if line.len() - trimmed.len() > 3 {
            return false;
        }
        let Some(marker) = trimmed.chars().next().filter(|c| *c == '`' || *c == '~') else {
            return false;
        };
        let count = trimmed.chars().take_while(|c| *c == marker).count();
        if count < 3 {
            return false;
        }
        match self.0 {
            None => self.0 = Some((marker, count)),
            Some((old, length))
                if marker == old && count >= length && trimmed[count..].trim().is_empty() =>
            {
                self.0 = None
            }
            _ => {}
        }
        true
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.split(['.', '-']).all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

pub fn valid_date(date: &str) -> bool {
    date.len() == 10
        && NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .is_ok_and(|parsed| parsed.format("%Y-%m-%d").to_string() == date)
}

pub fn entry_ref(page: &Page, entry: &Entry) -> String {
    format!("{}#{}", page.meta.id, entry.id)
}

fn enum_text<T: Serialize>(value: T) -> Result<String> {
    let value = serde_json::to_value(value)?;
    Ok(value.as_str().context("expected string enum")?.to_owned())
}

fn relative_link(page: &str, evidence: &Evidence) -> Result<String> {
    let parent = Path::new(page)
        .parent()
        .context("memory page has no parent")?;
    let mut link = PathBuf::new();
    for _ in parent.components() {
        link.push("..");
    }
    link.push(&evidence.path);
    let mut result = link
        .to_str()
        .context("source path is not UTF-8")?
        .to_owned();
    if let Some(anchor) = &evidence.anchor {
        result.push('#');
        result.push_str(anchor);
    }
    // Angle-bracket Markdown destinations preserve spaces and parentheses.
    Ok(format!("[source](<{result}>)"))
}

fn parse_link(page: &str, value: &str) -> Result<(String, Option<String>)> {
    ensure!(
        value.starts_with('[') && value.ends_with(')'),
        "invalid evidence link"
    );
    let (_, destination) = value.split_once("](").context("invalid evidence link")?;
    let mut destination = &destination[..destination.len() - 1];
    if destination.starts_with('<') && destination.ends_with('>') {
        destination = &destination[1..destination.len() - 1];
    }
    let (path, anchor) = match destination.split_once('#') {
        Some((path, anchor)) => {
            ensure!(!anchor.is_empty(), "empty evidence anchor");
            (path, Some(anchor.to_owned()))
        }
        None => (destination, None),
    };
    ensure!(
        !path.is_empty() && !path.contains(['\\', '\n', '\r']),
        "invalid evidence path"
    );
    let mut parts = Path::new(page)
        .parent()
        .context("memory page has no parent")?
        .components()
        .map(|part| part.as_os_str().to_owned())
        .collect::<Vec<_>>();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(value) => parts.push(value.to_owned()),
            Component::ParentDir => {
                ensure!(parts.pop().is_some(), "evidence path leaves repository");
            }
            _ => bail!("evidence path must be relative"),
        }
    }
    let resolved: PathBuf = parts.into_iter().collect();
    Ok((
        resolved
            .to_str()
            .context("source path is not UTF-8")?
            .to_owned(),
        anchor,
    ))
}

fn validate_statement(text: &str) -> Result<()> {
    ensure!(!text.trim().is_empty(), "empty memory statement");
    let mut fence = Fence::default();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if line.len() - trimmed.len() > 3 {
            continue;
        }
        ensure!(
            fence.is_open() || !trimmed.starts_with("## "),
            "statement contains a reserved entry heading"
        );
        fence.advance(line);
    }
    ensure!(!fence.is_open(), "unclosed code fence in memory statement");
    Ok(())
}

pub fn render_page(page: &Page) -> Result<String> {
    let mut result = format!(
        "---\n{}---\n\n# {}\n",
        serde_yaml_ng::to_string(&page.meta)?,
        page.meta.id
    );
    for entry in &page.entries {
        validate_statement(&entry.text)?;
        result.push_str(&format!(
            "\n## {}\n\n- Basis: {}\n- Status: {}\n- As of: {}\n",
            entry.id,
            enum_text(entry.basis)?,
            enum_text(entry.status)?,
            entry.as_of
        ));
        for evidence in &entry.evidence {
            result.push_str(&format!(
                "- Evidence: {}\n",
                relative_link(&page.path, evidence)?
            ));
        }
        for (label, values) in [
            ("Depends on", &entry.depends_on),
            ("Supersedes", &entry.supersedes),
        ] {
            if !values.is_empty() {
                result.push_str(&format!("- {label}: {}\n", values.join(", ")));
            }
        }
        if let Some(date) = &entry.review_after {
            result.push_str(&format!("- Review after: {date}\n"));
        }
        result.push('\n');
        result.push_str(entry.text.trim());
        result.push('\n');
    }
    Ok(result)
}

pub fn parse_page(path: &str, text: &str) -> Result<Page> {
    let text = text
        .strip_prefix("---\n")
        .context("missing YAML frontmatter")?;
    let (header, body) = text
        .split_once("\n---\n")
        .context("unclosed YAML frontmatter")?;
    let meta: Meta = serde_yaml_ng::from_str(header).context("invalid memory metadata")?;
    let mut lines = body.lines().peekable();
    while lines.peek().is_some_and(|line| line.trim().is_empty()) {
        lines.next();
    }
    ensure!(
        lines.next() == Some(format!("# {}", meta.id).as_str()),
        "page title must match its id"
    );
    let mut entries = Vec::new();
    while lines.peek().is_some() {
        while lines.peek().is_some_and(|line| line.trim().is_empty()) {
            lines.next();
        }
        let Some(heading) = lines.next() else { break };
        let id = heading
            .strip_prefix("## ")
            .context("expected memory entry heading")?
            .to_owned();
        while lines.peek().is_some_and(|line| line.trim().is_empty()) {
            lines.next();
        }
        let mut fields = std::collections::BTreeMap::new();
        let mut evidence = Vec::<Evidence>::new();
        while lines.peek().is_some_and(|line| line.starts_with("- ")) {
            let line = lines.next().context("missing metadata line")?;
            let (key, value) = line[2..]
                .split_once(": ")
                .context("invalid entry metadata")?;
            match key {
                "Evidence" => {
                    let (path, anchor) = parse_link(path, value)?;
                    evidence.push(Evidence { path, anchor });
                }
                "Basis" | "Status" | "As of" | "Depends on" | "Supersedes" | "Review after" => {
                    ensure!(
                        fields.insert(key, value).is_none(),
                        "duplicate entry field {key}"
                    );
                }
                _ => bail!("unknown entry field {key}"),
            }
        }
        ensure!(
            lines.peek().is_none_or(|line| line.trim().is_empty()),
            "metadata must end with a blank line"
        );
        let mut content = Vec::new();
        let mut fence = Fence::default();
        while let Some(line) = lines.peek() {
            if !fence.is_open() && line.starts_with("## ") {
                break;
            }
            fence.advance(line);
            content.push(lines.next().context("missing body line")?);
        }
        ensure!(!fence.is_open(), "unclosed code fence in memory entry");
        let required = |name| {
            fields
                .get(name)
                .copied()
                .with_context(|| format!("missing {name}"))
        };
        let list = |name| {
            fields
                .get(name)
                .map(|value| value.split(',').map(str::trim).map(str::to_owned).collect())
                .unwrap_or_default()
        };
        let basis =
            serde_json::from_value(serde_json::Value::String(required("Basis")?.to_owned()))?;
        let status =
            serde_json::from_value(serde_json::Value::String(required("Status")?.to_owned()))?;
        let entry = Entry {
            id,
            basis,
            status,
            as_of: required("As of")?.to_owned(),
            text: content.join("\n").trim().to_owned(),
            evidence,
            depends_on: list("Depends on"),
            supersedes: list("Supersedes"),
            review_after: fields.get("Review after").map(|date| (*date).to_owned()),
        };
        validate_statement(&entry.text)?;
        entries.push(entry);
    }
    Ok(Page {
        path: path.to_owned(),
        meta,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_roundtrip_preserves_fences_and_source_paths() -> Result<()> {
        let mut page = Page {
            path: "noema/work/example.md".into(),
            meta: Meta {
                id: "work.example".into(),
                summary: "Example memory.".into(),
                updated: "2026-10-28".into(),
                aliases: vec!["示例".into()],
                scope: vec![],
                resume: None,
            },
            entries: vec![Entry {
                id: "decision".into(),
                basis: Basis::Explicit,
                status: Status::Active,
                as_of: "2026-10-28".into(),
                text: "Keep this.\n\n```md\n## not-an-entry\n```".into(),
                evidence: vec![Evidence {
                    path: "corpus/records/source (one).md".into(),
                    anchor: Some("request".into()),
                }],
                depends_on: vec![],
                supersedes: vec![],
                review_after: None,
            }],
        };
        page.meta.resume = Some(page.entries[0].evidence[0].clone());
        let rendered = render_page(&page)?;
        assert_eq!(parse_page(&page.path, &rendered)?, page);
        let mut indented = page.clone();
        indented.entries[0].text =
            "Indented code:\n\n    ```\n    example\n\nA following paragraph.".into();
        assert_eq!(
            parse_page(&indented.path, &render_page(&indented)?)?,
            indented
        );
        assert!(parse_page(&page.path, &rendered.replace("- Basis:", "- Unknown:")).is_err());
        let mut injected = page.clone();
        injected.entries[0].text = "Keep this.\n\n## hidden-entry\n\nInjected statement.".into();
        assert!(render_page(&injected).is_err());
        assert!(
            parse_page(
                &page.path,
                &rendered.replace("## decision", "preface\n\n## decision")
            )
            .is_err()
        );
        Ok(())
    }

    #[test]
    fn identifiers_and_dates_are_canonical() {
        assert!(valid_id("work.noema"));
        for value in ["", "Work.noema", "work..noema", "../noema", "noema-"] {
            assert!(!valid_id(value));
        }
        assert!(valid_date("2026-10-28"));
        assert!(!valid_date("2026-2-28"));
        assert!(!valid_date("2026-02-30"));
    }
}
