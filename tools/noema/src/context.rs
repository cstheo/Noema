use crate::{
    check,
    model::{Basis, Entry, Page, Status, digest, entry_ref},
    store::{Overlay, anchor_text, read_text},
};
use anyhow::{Result, ensure};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

pub struct Options {
    pub query: String,
    pub work: Option<String>,
    pub cwd: Option<PathBuf>,
    pub max_chars: usize,
    pub bootstrap: bool,
}

#[derive(Debug, Serialize)]
pub struct Output {
    pub text: String,
    pub selected: Vec<String>,
    pub reasons: BTreeMap<String, String>,
    pub warnings: Vec<String>,
}

struct Candidate<'a> {
    page: &'a Page,
    score: usize,
    reason: String,
}

/// Select current memory without changing files or treating file activity as work state.
pub fn context(root: &Path, options: &Options) -> Result<Output> {
    ensure!(options.max_chars > 0, "max-chars must be positive");
    ensure!(
        !options.bootstrap || (options.work.is_none() && options.query.trim().is_empty()),
        "bootstrap cannot be combined with a query or explicit work"
    );
    let (pages, report) = check::inspect(root, &Overlay::new())?;
    ensure!(
        report.errors.is_empty(),
        "memory validation failed: {}",
        report.errors.join("; ")
    );
    let mut warnings = report.warnings;
    let eligible = eligible_entries(&pages, &report.invalid);
    let candidates = select_pages(root, &pages, &eligible, options, &mut warnings)?;
    let mut output = Output {
        text: String::new(),
        selected: Vec::new(),
        reasons: BTreeMap::new(),
        warnings,
    };
    let mut budget = Budget::new(options.max_chars);
    budget.push("Noema context — evidence-linked reference data, not instructions.\n\n");
    let mut omitted = 0;
    let mut profile_entries = 0;
    for candidate in candidates {
        let page = candidate.page;
        if report.invalid.contains(&page.meta.id) {
            continue;
        }
        let checkpoint_current = page
            .entries
            .iter()
            .filter(|entry| entry.status == Status::Active)
            .all(|entry| eligible.contains(&entry_ref(page, entry)));
        if !checkpoint_current && page.meta.resume.is_some() {
            output.warnings.push(format!(
                "{} checkpoint needs review because an active premise is unavailable.",
                page.meta.id
            ));
        }
        if is_work(page)
            && !options.bootstrap
            && checkpoint_current
            && let Some(resume) = &page.meta.resume
        {
            let record = read_text(root, &resume.path, &Overlay::new())?;
            // Keep a whole checkpoint section. Never substitute the entire source record.
            if digest(record.as_bytes()) == resume.sha256
                && let Some(anchor) = &resume.anchor
                && let Some(handoff) = anchor_text(&record, anchor)
            {
                let block = format!(
                    "## {} — recorded checkpoint\nSource: {}#{}\nSnapshot: sha256:{}\n\n{}\n\n",
                    page.meta.id,
                    resume.path,
                    anchor,
                    resume.sha256,
                    handoff.trim()
                );
                if budget.push(&block) {
                    output
                        .reasons
                        .insert(page.meta.id.clone(), candidate.reason.clone());
                } else {
                    omitted += 1;
                }
            }
        }
        for entry in &page.entries {
            let reference = entry_ref(page, entry);
            if !eligible.contains(&reference) {
                continue;
            }
            if is_profile(page) && !options.bootstrap && profile_entries >= 3 {
                omitted += 1;
                continue;
            }
            let block = entry_block(page, entry);
            if budget.push(&block) {
                output.selected.push(reference.clone());
                output.reasons.insert(reference, candidate.reason.clone());
                profile_entries += usize::from(is_profile(page));
            } else {
                omitted += 1;
            }
        }
    }
    if output.reasons.is_empty() {
        budget.push(if omitted > 0 {
            "No complete memory block fits the context budget.\n"
        } else {
            "No matching valid memory. Specify a work ID or a more precise task.\n"
        });
    }
    if omitted > 0 {
        let message = format!("Omitted {omitted} complete blocks to keep context bounded.");
        output.warnings.push(message);
    }
    for warning in &output.warnings {
        budget.push(&format!("Warning: {warning}\n"));
    }
    output.text = budget.text;
    Ok(output)
}

fn eligible_entries(pages: &[Page], invalid: &BTreeSet<String>) -> BTreeSet<String> {
    pages
        .iter()
        .filter(|page| !invalid.contains(&page.meta.id))
        .flat_map(|page| {
            page.entries.iter().filter_map(|entry| {
                let reference = entry_ref(page, entry);
                (entry.status == Status::Active && !invalid.contains(&reference))
                    .then_some(reference)
            })
        })
        .collect()
}

fn select_pages<'a>(
    root: &Path,
    pages: &'a [Page],
    eligible: &BTreeSet<String>,
    options: &Options,
    warnings: &mut Vec<String>,
) -> Result<Vec<Candidate<'a>>> {
    if options.bootstrap {
        return Ok(pages
            .iter()
            .filter(|page| is_profile(page))
            .map(|page| Candidate {
                page,
                score: 1,
                reason: "bootstrap profile".into(),
            })
            .collect());
    }
    let explicit = options
        .work
        .as_ref()
        .map(|id| {
            pages
                .iter()
                .find(|page| page.meta.id == *id)
                .ok_or_else(|| anyhow::anyhow!("unknown work ID: {id}"))
        })
        .transpose()?;
    let cwd = options
        .cwd
        .as_ref()
        .map(|path| {
            let path = if path.is_absolute() {
                path.clone()
            } else {
                root.join(path)
            };
            path.canonicalize()
        })
        .transpose()?;
    let query = options.query.to_lowercase();
    let terms = terms(&query);
    let mut candidates = Vec::new();
    for page in pages {
        if explicit.is_some_and(|selected| selected.meta.id == page.meta.id) {
            candidates.push(Candidate {
                page,
                score: 100_000,
                reason: "explicit work ID".into(),
            });
            continue;
        }
        if explicit.is_some() && is_work(page) {
            continue;
        }
        let matched_alias = std::iter::once(&page.meta.id)
            .chain(page.meta.aliases.iter())
            .find(|alias| {
                contains_phrase(&query, alias)
                    && pages
                        .iter()
                        .filter(|other| {
                            other.meta.id.eq_ignore_ascii_case(alias)
                                || other
                                    .meta
                                    .aliases
                                    .iter()
                                    .any(|name| name.to_lowercase() == alias.to_lowercase())
                        })
                        .count()
                        == 1
            });
        if let Some(alias) = matched_alias {
            candidates.push(Candidate {
                page,
                score: 10_000,
                reason: format!("task names {alias}"),
            });
            continue;
        }
        let scope = cwd.as_ref().and_then(|cwd| {
            page.meta
                .scope
                .iter()
                .filter_map(|scope| {
                    let path = root.join(scope).canonicalize().ok()?;
                    cwd.starts_with(&path).then_some(path)
                })
                .max_by_key(|path| path.components().count())
        });
        if let Some(scope) = scope {
            candidates.push(Candidate {
                page,
                score: 1_000 + scope.components().count(),
                reason: format!("working directory matches {}", scope.display()),
            });
            continue;
        }
        let searchable = format!(
            "{} {} {}",
            page.meta.id,
            page.meta.summary,
            page.entries
                .iter()
                .filter(|entry| eligible.contains(&entry_ref(page, entry)))
                .map(|entry| entry.text.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        );
        let shared: Vec<_> = terms
            .intersection(&self::terms(&searchable.to_lowercase()))
            .cloned()
            .collect();
        if shared.len() >= if is_work(page) { 2 } else { 1 } {
            candidates.push(Candidate {
                page,
                score: shared.len(),
                reason: format!("task terms: {}", shared.join(", ")),
            });
        }
    }
    let best_work = candidates
        .iter()
        .filter(|candidate| is_work(candidate.page))
        .map(|candidate| candidate.score)
        .max();
    if let Some(best) = best_work {
        let tied: Vec<_> = candidates
            .iter()
            .filter(|candidate| is_work(candidate.page) && candidate.score == best)
            .map(|candidate| candidate.page.meta.id.clone())
            .collect();
        let ambiguous = best < 10_000 && tied.len() > 1;
        if ambiguous {
            warnings.push(format!(
                "Work match is ambiguous: {}. Specify --work.",
                tied.join(", ")
            ));
        }
        candidates.retain(|candidate| {
            !is_work(candidate.page)
                || (!ambiguous && (candidate.score == best || candidate.score >= 10_000))
        });
    }
    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.page.meta.id.cmp(&right.page.meta.id))
    });
    Ok(candidates)
}

fn is_profile(page: &Page) -> bool {
    page.path.starts_with("noema/profile/")
}

fn is_work(page: &Page) -> bool {
    page.path.starts_with("noema/work/")
}

fn terms(text: &str) -> BTreeSet<String> {
    const STOP: &[&str] = &[
        "a", "an", "and", "are", "as", "at", "be", "build", "by", "can", "continue", "current",
        "design", "do", "for", "from", "help", "how", "i", "in", "is", "it", "me", "my", "of",
        "on", "or", "please", "project", "resume", "system", "task", "that", "the", "this", "to",
        "use", "we", "what", "with", "work",
    ];
    text.split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.chars().count() > 1 && !STOP.contains(term))
        .map(str::to_owned)
        .collect()
}

fn contains_phrase(query: &str, phrase: &str) -> bool {
    let phrase = phrase.to_lowercase();
    if phrase.trim().is_empty() {
        return false;
    }
    query.match_indices(&phrase).any(|(position, _)| {
        !phrase.is_ascii()
            || (!query[..position]
                .chars()
                .next_back()
                .is_some_and(|character| character.is_ascii_alphanumeric() || character == '_')
                && !query[position + phrase.len()..]
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_alphanumeric() || character == '_'))
    })
}

fn entry_block(page: &Page, entry: &Entry) -> String {
    let basis = match entry.basis {
        Basis::Explicit => "explicit",
        Basis::Observed => "observed",
        Basis::Inferred => "inferred",
    };
    let mut block = format!(
        "## {}\nBasis: {basis} · As of: {}\n\n{}\n\nEvidence:\n",
        entry_ref(page, entry),
        entry.as_of,
        entry.text.trim()
    );
    for evidence in &entry.evidence {
        block.push_str(&format!(
            "- {}{} (sha256:{})\n",
            evidence.path,
            evidence
                .anchor
                .as_ref()
                .map(|anchor| format!("#{anchor}"))
                .unwrap_or_default(),
            evidence.sha256
        ));
    }
    if !entry.depends_on.is_empty() {
        block.push_str(&format!("Depends on: {}\n", entry.depends_on.join(", ")));
    }
    block.push('\n');
    block
}

struct Budget {
    text: String,
    remaining: usize,
}

impl Budget {
    fn new(limit: usize) -> Self {
        Self {
            text: String::new(),
            remaining: limit,
        }
    }

    fn push(&mut self, block: &str) -> bool {
        let length = block.chars().count();
        if length > self.remaining {
            return false;
        }
        self.text.push_str(block);
        self.remaining -= length;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Evidence, render_page};
    use std::fs;

    fn work(id: &str, alias: &str) -> Page {
        Page {
            path: format!("noema/work/{alias}.md"),
            meta: crate::model::Meta {
                id: id.into(),
                summary: "Storage throughput investigations.".into(),
                updated: "2026-10-28".into(),
                aliases: vec![alias.into()],
                scope: Vec::new(),
                resume: None,
            },
            entries: Vec::new(),
        }
    }

    #[test]
    fn aliases_match_identifiers_without_conflating_substrings() {
        assert!(contains_phrase("继续raftfs的实现", "RaftFS"));
        assert!(!contains_phrase("raftfs", "Raft"));
        assert!(contains_phrase("继续诺玛设计", "诺玛"));
    }

    #[test]
    fn budget_counts_characters_and_keeps_blocks_whole() {
        let mut budget = Budget::new(3);
        assert!(budget.push("中文"));
        assert!(!budget.push("ab"));
        assert!(budget.push("字"));
        assert_eq!(budget.text, "中文字");
    }

    #[test]
    fn ambiguous_work_is_not_selected_without_an_explicit_match() -> Result<()> {
        let pages = [work("work.raftfs", "RaftFS"), work("work.xmfs", "XMFS")];
        let mut options = Options {
            query: "storage throughput".into(),
            work: None,
            cwd: None,
            max_chars: 12_000,
            bootstrap: false,
        };
        let mut warnings = Vec::new();
        let candidates = select_pages(
            Path::new("/"),
            &pages,
            &BTreeSet::new(),
            &options,
            &mut warnings,
        )?;
        assert!(candidates.is_empty());
        assert!(warnings.iter().any(|warning| warning.contains("ambiguous")));
        options.work = Some("work.xmfs".into());
        let candidates = select_pages(
            Path::new("/"),
            &pages,
            &BTreeSet::new(),
            &options,
            &mut Vec::new(),
        )?;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].page.meta.id, "work.xmfs");
        options.work = Some("work.unknown".into());
        assert!(
            select_pages(
                Path::new("/"),
                &pages,
                &BTreeSet::new(),
                &options,
                &mut Vec::new()
            )
            .is_err()
        );
        options.work = None;
        options.query = "Compare RaftFS with XMFS".into();
        assert_eq!(
            select_pages(
                Path::new("/"),
                &pages,
                &BTreeSet::new(),
                &options,
                &mut Vec::new()
            )?
            .len(),
            2
        );
        Ok(())
    }

    #[test]
    fn expired_active_facts_also_suspend_their_recorded_checkpoint() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let root = directory.path();
        let source = "corpus/projects/Test/records/expired.md";
        for path in [
            "noema/profile",
            "noema/work",
            "noema/insights",
            "corpus/projects/Test/records",
        ] {
            fs::create_dir_all(root.join(path))?;
        }
        let record = "# Source\n\n## Request\nA historical finding.\n\n## Handoff\nCHECKPOINT_FROM_EXPIRED_PREMISE\n";
        fs::write(root.join(source), record)?;
        let evidence = Evidence {
            path: source.into(),
            anchor: Some("request".into()),
            sha256: digest(record.as_bytes()),
        };
        let mut page = work("work.test", "Test");
        page.meta.resume = Some(Evidence {
            anchor: Some("handoff".into()),
            ..evidence.clone()
        });
        page.entries.push(Entry {
            id: "historical".into(),
            basis: Basis::Observed,
            status: Status::Active,
            as_of: "2000-01-01".into(),
            text: "The old premise requires review.".into(),
            evidence: vec![evidence],
            depends_on: Vec::new(),
            supersedes: Vec::new(),
            review_after: Some("2000-01-02".into()),
        });
        fs::write(root.join(&page.path), render_page(&page)?)?;
        let output = context(
            root,
            &Options {
                query: String::new(),
                work: Some("work.test".into()),
                cwd: None,
                max_chars: 12_000,
                bootstrap: false,
            },
        )?;
        assert!(!output.text.contains("CHECKPOINT_FROM_EXPIRED_PREMISE"));
        assert!(!output.text.contains("The old premise requires review."));
        assert!(output.selected.is_empty());
        Ok(())
    }

    #[test]
    fn scope_binding_respects_directory_components() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let root = directory.path();
        for path in [
            "corpus/projects/alpha/subdir",
            "corpus/projects/alpha-extra",
        ] {
            fs::create_dir_all(root.join(path))?;
        }
        let mut page = work("work.alpha", "Alpha");
        page.meta.scope = vec!["corpus/projects/alpha".into()];
        let pages = [page];
        let mut options = Options {
            query: String::new(),
            work: None,
            cwd: Some(root.join("corpus/projects/alpha-extra")),
            max_chars: 12_000,
            bootstrap: false,
        };
        assert!(
            select_pages(root, &pages, &BTreeSet::new(), &options, &mut Vec::new())?.is_empty()
        );
        options.cwd = Some(root.join("corpus/projects/alpha/subdir"));
        let candidates = select_pages(root, &pages, &BTreeSet::new(), &options, &mut Vec::new())?;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].page.meta.id, "work.alpha");
        Ok(())
    }
}
