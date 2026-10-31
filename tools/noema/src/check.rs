use crate::{
    model::{Entry, Page, Status, entry_ref, valid_date, valid_id},
    store::{load_pages, safe_path},
};
use anyhow::Result;
use serde::Serialize;
use std::{collections::BTreeSet, path::Path};

#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub invalid: BTreeSet<String>,
}

pub struct Inspection {
    pub pages: Vec<Page>,
    pub report: Report,
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

fn validate_entry(page: &Page, entry: &Entry, report: &mut Report) {
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
    if let Some(date) = &entry.review_after {
        if !valid_date(date) || date <= &entry.as_of {
            report.error(&reference, "review_after must follow as_of");
        } else if entry.status == Status::Active
            && date.as_str() <= chrono::Utc::now().format("%Y-%m-%d").to_string().as_str()
        {
            report.warning(&reference, "review deadline reached");
        }
    }
}

pub fn inspect(root: &Path) -> Result<Inspection> {
    let pages = load_pages(root)?;
    let mut report = Report::default();
    let mut page_ids = BTreeSet::new();
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
        let work_handoff = page.path.starts_with("noema/work/")
            && page
                .meta
                .handoff
                .as_ref()
                .is_some_and(|text| !text.trim().is_empty());
        if page.meta.handoff.is_some() && !work_handoff {
            report.error(id, "handoff requires a work page and nonempty text");
        }
        if page.entries.is_empty() && !work_handoff {
            report.error(id, "memory page requires an entry or work handoff");
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
        let mut entry_ids = BTreeSet::new();
        for entry in &page.entries {
            if !entry_ids.insert(&entry.id) {
                report.error(&entry_ref(page, entry), "duplicate entry ID");
            }
            validate_entry(page, entry, &mut report);
        }
    }
    Ok(Inspection { pages, report })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Basis, Meta, render_page};
    use std::fs;

    fn fixture() -> Result<(tempfile::TempDir, Page)> {
        let root = tempfile::tempdir()?;
        fs::create_dir_all(root.path().join("noema/work"))?;
        let page = Page {
            path: "noema/work/example.md".into(),
            meta: Meta {
                id: "work.example".into(),
                summary: "Example decisions.".into(),
                updated: "2026-10-28".into(),
                aliases: vec![],
                scope: vec![],
                handoff: None,
            },
            entries: vec![Entry {
                id: "concise".into(),
                basis: Basis::Inferred,
                status: Status::Active,
                as_of: "2026-10-28".into(),
                text: "Keep notes concise.".into(),
                review_after: None,
            }],
        };
        Ok((root, page))
    }

    fn save(root: &Path, page: &Page) -> Result<()> {
        fs::write(root.join(&page.path), render_page(page)?)?;
        Ok(())
    }

    #[test]
    fn memory_needs_no_corpus_or_provenance() -> Result<()> {
        let (root, page) = fixture()?;
        save(root.path(), &page)?;
        assert!(inspect(root.path())?.report.is_clean());
        assert!(!root.path().join("corpus").exists());
        Ok(())
    }

    #[test]
    fn review_state_is_valid_but_active_expiry_requires_review() -> Result<()> {
        let (root, mut page) = fixture()?;
        page.entries[0].as_of = "2020-01-01".into();
        page.entries[0].review_after = Some("2020-02-01".into());
        save(root.path(), &page)?;
        let report = inspect(root.path())?.report;
        assert!(report.errors.is_empty());
        assert!(report.invalid.contains("work.example#concise"));
        page.entries[0].status = Status::Review;
        save(root.path(), &page)?;
        assert!(inspect(root.path())?.report.is_clean());
        Ok(())
    }

    #[test]
    fn duplicate_ids_and_invalid_dates_are_reported() -> Result<()> {
        let (root, mut page) = fixture()?;
        page.entries.push(page.entries[0].clone());
        page.entries[0].as_of = "2026-2-30".into();
        save(root.path(), &page)?;
        let mut duplicate = page.clone();
        duplicate.path = "noema/work/duplicate.md".into();
        save(root.path(), &duplicate)?;
        let errors = inspect(root.path())?.report.errors;
        for expected in [
            "duplicate page ID",
            "duplicate entry ID",
            "as_of must be a canonical date",
        ] {
            assert!(
                errors.iter().any(|error| error.contains(expected)),
                "{expected}"
            );
        }
        Ok(())
    }

    #[test]
    fn continuation_only_work_is_valid() -> Result<()> {
        let (root, mut page) = fixture()?;
        page.entries.clear();
        page.meta.handoff = Some("Next: test the mapping.".into());
        save(root.path(), &page)?;
        assert!(inspect(root.path())?.report.is_clean());
        page.meta.handoff = None;
        save(root.path(), &page)?;
        assert!(!inspect(root.path())?.report.errors.is_empty());
        Ok(())
    }
}
