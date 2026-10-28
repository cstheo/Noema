use crate::{
    model::{Basis, Entry, Evidence, Page, Status, digest, entry_ref, valid_date, valid_id},
    store::{Overlay, has_anchor, load_pages, read_text, safe_path},
};
use anyhow::Result;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub invalid: BTreeSet<String>,
}

impl Report {
    pub fn is_clean(&self) -> bool {
        self.errors.is_empty() && self.warnings.is_empty()
    }

    fn error(&mut self, reference: &str, message: impl AsRef<str>) {
        self.errors
            .push(format!("{reference}: {}", message.as_ref()));
        self.invalid.insert(reference.to_owned());
    }

    fn warning(&mut self, reference: &str, message: impl AsRef<str>) {
        self.warnings
            .push(format!("{reference}: {}", message.as_ref()));
        self.invalid.insert(reference.to_owned());
    }
}

fn evidence(
    root: &Path,
    source: &Evidence,
    overlay: &Overlay,
    reference: &str,
    report: &mut Report,
) {
    if !source.path.starts_with("corpus/") {
        report.error(reference, "evidence must be under corpus/");
        return;
    }
    if source.sha256.len() != 64
        || !source
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        report.error(reference, "invalid SHA256 snapshot");
        return;
    }
    match read_text(root, &source.path, overlay) {
        Ok(text) => {
            if let Some(anchor) = &source.anchor
                && !has_anchor(&text, anchor)
            {
                report.error(
                    reference,
                    format!("missing source anchor {}#{anchor}", source.path),
                );
            }
            if digest(text.as_bytes()) != source.sha256 {
                report.warning(reference, format!("source changed; review {}", source.path));
            }
        }
        Err(error) => report.error(
            reference,
            format!("invalid source {}: {error:#}", source.path),
        ),
    }
}

fn validate_entry(root: &Path, page: &Page, entry: &Entry, overlay: &Overlay, report: &mut Report) {
    let reference = entry_ref(page, entry);
    if !valid_id(&entry.id) {
        report.error(&reference, "invalid entry ID");
    }
    if !valid_date(&entry.as_of) || entry.as_of > page.meta.updated {
        report.error(
            &reference,
            "as_of must be a canonical date no later than page updated",
        );
    }
    if entry.text.trim().is_empty() {
        report.error(&reference, "empty statement");
    }
    if entry.evidence.is_empty() {
        report.error(&reference, "evidence is required");
    }
    if let Some(date) = &entry.review_after {
        if !valid_date(date) || date <= &entry.as_of {
            report.error(&reference, "review_after must follow as_of");
        } else if entry.status == Status::Active
            && date.as_str() <= chrono::Utc::now().format("%Y-%m-%d").to_string().as_str()
        {
            report.warning(&reference, "review deadline reached");
        }
    }
    if entry.basis == Basis::Inferred && entry.depends_on.is_empty() {
        report.error(&reference, "inferred memory requires depends_on");
    }
    for source in &entry.evidence {
        evidence(root, source, overlay, &reference, report);
    }
    for (label, references) in [
        ("depends_on", &entry.depends_on),
        ("supersedes", &entry.supersedes),
    ] {
        let mut seen = BTreeSet::new();
        for target in references {
            if !seen.insert(target) {
                report.error(&reference, format!("duplicate {label} reference {target}"));
            }
            if target
                .split_once('#')
                .is_none_or(|(page, entry)| !valid_id(page) || !valid_id(entry))
            {
                report.error(&reference, format!("invalid {label} reference {target}"));
            }
        }
    }
}

fn detect_cycles(graph: &BTreeMap<String, Vec<String>>, label: &str, report: &mut Report) {
    let mut pending = BTreeMap::<String, usize>::new();
    let mut dependents = BTreeMap::<String, Vec<String>>::new();
    for (reference, targets) in graph {
        let known: Vec<_> = targets
            .iter()
            .filter(|target| graph.contains_key(*target))
            .collect();
        pending.insert(reference.clone(), known.len());
        for target in known {
            dependents
                .entry(target.clone())
                .or_default()
                .push(reference.clone());
        }
    }
    let mut ready: Vec<_> = pending
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(reference, _)| reference.clone())
        .collect();
    while let Some(reference) = ready.pop() {
        if let Some(next) = dependents.get(&reference) {
            for dependent in next {
                if let Some(count) = pending.get_mut(dependent) {
                    *count -= 1;
                    if *count == 0 {
                        ready.push(dependent.clone());
                    }
                }
            }
        }
    }
    for (reference, count) in pending {
        if count > 0 {
            report.error(&reference, format!("cyclic {label} graph"));
        }
    }
}

pub fn inspect(root: &Path, overlay: &Overlay) -> Result<(Vec<Page>, Report)> {
    let pages = load_pages(root, overlay)?;
    let mut report = Report::default();
    let mut page_ids = BTreeSet::new();
    let mut entries = BTreeMap::<String, (&Page, &Entry)>::new();
    for page in &pages {
        let id = &page.meta.id;
        if !page_ids.insert(id) {
            report.error(id, "duplicate page ID");
        }
        if !valid_id(id) {
            report.error(id, "invalid page ID");
        }
        if page.meta.summary.trim().is_empty() || page.meta.summary.chars().count() > 500 {
            report.error(id, "summary must contain 1-500 characters");
        }
        if !valid_date(&page.meta.updated) {
            report.error(id, "invalid updated date");
        }
        if page.entries.is_empty() {
            report.error(id, "memory page requires at least one entry");
        }
        let mut aliases = BTreeSet::new();
        for alias in &page.meta.aliases {
            if alias.trim().is_empty()
                || alias.chars().any(char::is_control)
                || !aliases.insert(alias.to_lowercase())
            {
                report.error(id, "aliases must be nonempty, unique text");
            }
        }
        for scope in &page.meta.scope {
            if let Err(error) = safe_path(root, scope) {
                report.error(id, format!("invalid scope: {error:#}"));
            }
        }
        if let Some(resume) = &page.meta.resume {
            if resume
                .anchor
                .as_ref()
                .is_none_or(|anchor| anchor.is_empty())
            {
                report.error(id, "resume requires an exact source anchor");
            }
            evidence(root, resume, overlay, id, &mut report);
        }
        for entry in &page.entries {
            let reference = entry_ref(page, entry);
            if entries.insert(reference.clone(), (page, entry)).is_some() {
                report.error(&reference, "duplicate entry ID");
            }
            validate_entry(root, page, entry, overlay, &mut report);
        }
    }
    let mut dependencies = BTreeMap::new();
    let mut replacements = BTreeMap::new();
    let mut active_replacements = BTreeMap::<&str, Vec<String>>::new();
    for (reference, (_, entry)) in &entries {
        dependencies.insert(reference.clone(), entry.depends_on.clone());
        replacements.insert(reference.clone(), entry.supersedes.clone());
        for target in &entry.depends_on {
            if !entries.contains_key(target) {
                report.error(reference, format!("unknown dependency {target}"));
            }
        }
        for target in &entry.supersedes {
            match entries.get(target) {
                None => report.error(reference, format!("unknown superseded entry {target}")),
                Some((_, old)) => {
                    if old.status != Status::Superseded {
                        report.error(
                            reference,
                            format!("superseded target is not marked superseded: {target}"),
                        );
                    }
                    if entry.status == Status::Active {
                        active_replacements
                            .entry(target)
                            .or_default()
                            .push(reference.clone());
                    }
                }
            }
        }
    }
    for (target, replacements) in active_replacements {
        if replacements.len() > 1 {
            for reference in replacements {
                report.error(
                    &reference,
                    format!("multiple active replacements for {target}"),
                );
            }
        }
    }
    detect_cycles(&dependencies, "derivation", &mut report);
    detect_cycles(&replacements, "supersession", &mut report);
    loop {
        let mut added = false;
        for (reference, (page, entry)) in &entries {
            if entry.status != Status::Active || report.invalid.contains(reference) {
                continue;
            }
            if report.invalid.contains(&page.meta.id) {
                report.invalid.insert(reference.clone());
                added = true;
                continue;
            }
            let invalid = entry.depends_on.iter().find(|target| {
                entries.get(*target).is_none_or(|(page, dependency)| {
                    dependency.status != Status::Active
                        || report.invalid.contains(*target)
                        || report.invalid.contains(&page.meta.id)
                })
            });
            if let Some(target) = invalid {
                report.warning(reference, format!("dependency requires review: {target}"));
                added = true;
            }
        }
        if !added {
            break;
        }
    }
    Ok((pages, report))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Meta, render_page};
    use anyhow::Context;
    use std::fs;

    fn fixture() -> Result<(tempfile::TempDir, Page)> {
        let directory = tempfile::tempdir()?;
        fs::create_dir_all(directory.path().join("corpus/records"))?;
        fs::create_dir_all(directory.path().join("noema/work"))?;
        let source = "# Record\n\n## Request\nKeep concise notes.\n";
        fs::write(directory.path().join("corpus/records/source.md"), source)?;
        let page = Page {
            path: "noema/work/example.md".into(),
            meta: Meta {
                id: "work.example".into(),
                summary: "Example decisions.".into(),
                updated: "2026-10-28".into(),
                aliases: vec![],
                scope: vec![],
                resume: None,
            },
            entries: vec![Entry {
                id: "concise".into(),
                basis: Basis::Explicit,
                status: Status::Active,
                as_of: "2026-10-28".into(),
                text: "Keep notes concise.".into(),
                evidence: vec![Evidence {
                    path: "corpus/records/source.md".into(),
                    anchor: Some("request".into()),
                    sha256: digest(source.as_bytes()),
                }],
                depends_on: vec![],
                supersedes: vec![],
                review_after: None,
            }],
        };
        Ok((directory, page))
    }

    #[test]
    fn changed_evidence_invalidates_dependents_without_rehashing() -> Result<()> {
        let (directory, mut page) = fixture()?;
        let mut derived = page.entries[0].clone();
        derived.id = "derived".into();
        derived.basis = Basis::Inferred;
        derived.depends_on = vec!["work.example#concise".into()];
        page.entries.push(derived);
        fs::write(directory.path().join(&page.path), render_page(&page)?)?;
        assert!(inspect(directory.path(), &Overlay::new())?.1.is_clean());
        fs::write(
            directory.path().join("corpus/records/source.md"),
            "# Record\n\n## Request\nChanged.\n",
        )?;
        let (_, report) = inspect(directory.path(), &Overlay::new())?;
        assert!(report.invalid.contains("work.example#concise"));
        assert!(report.invalid.contains("work.example#derived"));
        assert_eq!(
            page.entries[0].evidence[0].sha256,
            digest(b"# Record\n\n## Request\nKeep concise notes.\n")
        );
        Ok(())
    }

    #[test]
    fn review_state_is_valid_but_active_expiry_requires_review() -> Result<()> {
        let (directory, mut page) = fixture()?;
        page.entries[0].as_of = "2020-01-01".into();
        page.entries[0].review_after = Some("2020-02-01".into());
        let overlay = Overlay::from([(page.path.clone(), render_page(&page)?)]);
        let (_, report) = inspect(directory.path(), &overlay)?;
        assert!(report.errors.is_empty());
        assert!(report.invalid.contains("work.example#concise"));
        page.entries[0].status = Status::Review;
        let overlay = Overlay::from([(page.path.clone(), render_page(&page)?)]);
        assert!(inspect(directory.path(), &overlay)?.1.is_clean());
        Ok(())
    }

    #[test]
    fn stale_handoff_invalidates_page_and_its_derived_users() -> Result<()> {
        let (directory, mut page) = fixture()?;
        page.meta.resume = Some(Evidence {
            path: "corpus/records/source.md".into(),
            anchor: Some("request".into()),
            sha256: digest(b"old record bytes"),
        });
        let overlay = Overlay::from([(page.path.clone(), render_page(&page)?)]);
        let (_, report) = inspect(directory.path(), &overlay)?;
        assert!(report.invalid.contains("work.example"));
        assert!(report.invalid.contains("work.example#concise"));
        page.meta.resume.as_mut().context("resume")?.anchor = None;
        let overlay = Overlay::from([(page.path.clone(), render_page(&page)?)]);
        let (_, report) = inspect(directory.path(), &overlay)?;
        assert!(
            report
                .errors
                .iter()
                .any(|error| error.contains("resume requires an exact source anchor"))
        );
        Ok(())
    }

    #[test]
    fn a_correction_cannot_have_two_active_replacements() -> Result<()> {
        let (directory, mut page) = fixture()?;
        page.entries[0].status = Status::Superseded;
        let mut first = page.entries[0].clone();
        first.id = "replacement-one".into();
        first.status = Status::Active;
        first.supersedes = vec!["work.example#concise".into()];
        let mut second = first.clone();
        second.id = "replacement-two".into();
        page.entries.extend([first, second]);
        let overlay = Overlay::from([(page.path.clone(), render_page(&page)?)]);
        let (_, report) = inspect(directory.path(), &overlay)?;
        assert!(report.invalid.contains("work.example#replacement-one"));
        assert!(report.invalid.contains("work.example#replacement-two"));
        assert!(
            report
                .errors
                .iter()
                .any(|error| error.contains("multiple active replacements"))
        );
        Ok(())
    }

    #[test]
    fn cycles_and_missing_anchors_are_errors() -> Result<()> {
        let (directory, mut page) = fixture()?;
        page.entries[0].basis = Basis::Inferred;
        page.entries[0].depends_on = vec!["work.example#concise".into()];
        page.entries[0].evidence[0].anchor = Some("missing".into());
        let overlay = Overlay::from([(page.path.clone(), render_page(&page)?)]);
        let (_, report) = inspect(directory.path(), &overlay)?;
        assert!(
            report
                .errors
                .iter()
                .any(|message| message.contains("missing source anchor"))
        );
        assert!(
            report
                .errors
                .iter()
                .any(|message| message.contains("cyclic derivation"))
        );
        Ok(())
    }
}
