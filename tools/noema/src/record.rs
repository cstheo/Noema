use crate::{
    PENDING, check,
    model::{self, Basis, Entry, Evidence, Meta, Page, Status},
    require_complete,
    store::{self, Overlay},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Write,
    path::Path,
};
use tempfile::NamedTempFile;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: String,
    pub date: String,
    pub path: Option<String>,
    pub body: Option<String>,
    #[serde(default)]
    pub pages: Vec<Update>,
    #[serde(default)]
    pub retracts: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub path: String,
    pub id: String,
    pub summary: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub scope: Option<Vec<String>>,
    pub resume: Option<String>,
    pub handoff: Option<String>,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub entries: Vec<NewEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NewEntry {
    pub id: String,
    pub basis: Basis,
    pub as_of: String,
    pub text: String,
    pub evidence: Vec<Source>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub supersedes: Vec<String>,
    pub review_after: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub path: String,
    pub anchor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Output {
    pub id: String,
    pub changed: Vec<String>,
    pub already_recorded: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Header {
    record_id: String,
    date: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    id: String,
    changes: Vec<Change>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Change {
    path: String,
    before: Option<String>,
    after: String,
}

pub fn apply(root: &Path, request: &Request, dry_run: bool) -> Result<Output> {
    require_complete(root)?;
    ensure!(model::valid_id(&request.id), "Invalid record id");
    ensure!(model::valid_date(&request.date), "Invalid record date");
    let source = source_record(root, request)?;
    let mut overlay = Overlay::new();
    if let Some((path, text)) = &source {
        if let Some(existing) = current(root, path)? {
            ensure!(
                existing == *text,
                "Record already exists with different content: {path}"
            );
            if !request.pages.is_empty() || !request.retracts.is_empty() {
                verify_replay(request, &store::load_pages(root, &Overlay::new())?)?;
            }
            return Ok(output(request, Vec::new()));
        }
        overlay.insert(path.clone(), text.clone());
    }
    if request.pages.is_empty() && request.retracts.is_empty() {
        let changes = source
            .into_iter()
            .map(|(path, after)| Change {
                path,
                before: None,
                after,
            })
            .collect();
        return finish(root, request, changes, dry_run);
    }
    let originals = store::load_texts(root, &Overlay::new())?;
    let mut pages = originals
        .iter()
        .map(|(path, text)| model::parse_page(path, text).with_context(|| format!("parse {path}")))
        .collect::<Result<Vec<_>>>()?;
    let mut changed = BTreeSet::new();
    let mut refreshed = BTreeSet::new();
    let mut revised = BTreeSet::new();
    let mut supplied = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for update in &request.pages {
        ensure!(
            seen.insert(update.path.clone()),
            "Duplicate page update: {}",
            update.path
        );
        ensure!(
            store::memory_path(&update.path),
            "Not a memory page: {}",
            update.path
        );
        store::writable_path(root, &update.path)?;
        let index = pages.iter().position(|page| page.path == update.path);
        let mut page = match index {
            Some(index) => {
                ensure!(
                    pages[index].meta.id == update.id,
                    "A page's stable id cannot change"
                );
                pages[index].clone()
            }
            None => Page {
                path: update.path.clone(),
                meta: Meta {
                    id: update.id.clone(),
                    summary: update
                        .summary
                        .clone()
                        .context("New pages require a summary")?,
                    updated: request.date.clone(),
                    aliases: Vec::new(),
                    scope: Vec::new(),
                    resume: None,
                    handoff: None,
                },
                entries: Vec::new(),
            },
        };
        let previous = page.clone();
        if let Some(summary) = &update.summary {
            page.meta.summary.clone_from(summary);
        }
        if let Some(aliases) = &update.aliases {
            page.meta.aliases.clone_from(aliases);
        }
        if let Some(scope) = &update.scope {
            page.meta.scope.clone_from(scope);
        }
        let mut entry_ids = BTreeSet::new();
        for entry in &update.entries {
            ensure!(
                entry_ids.insert(&entry.id),
                "Duplicate entry update: {}",
                entry.id
            );
            ensure!(
                !update.remove.contains(&entry.id),
                "Entry cannot be updated and removed: {}",
                entry.id
            );
            supplied.insert(format!("{}#{}", page.meta.id, entry.id));
            let candidate = Entry {
                id: entry.id.clone(),
                basis: entry.basis,
                status: Status::Active,
                as_of: entry.as_of.clone(),
                text: entry.text.trim().to_owned(),
                evidence: entry
                    .evidence
                    .iter()
                    .map(|source| evidence(root, source, &overlay))
                    .collect::<Result<_>>()?,
                depends_on: entry.depends_on.clone(),
                supersedes: entry.supersedes.clone(),
                review_after: entry.review_after.clone(),
            };
            if let Some(old) = page.entries.iter_mut().find(|old| old.id == entry.id) {
                if *old != candidate {
                    revised.insert(format!("{}#{}", page.meta.id, entry.id));
                    *old = candidate;
                }
            } else {
                page.entries.push(candidate);
            }
        }
        for id in &update.remove {
            ensure!(model::valid_id(id), "Invalid removed entry ID: {id}");
            if page.entries.iter().any(|entry| entry.id == *id) {
                revised.insert(format!("{}#{id}", page.meta.id));
                page.entries.retain(|entry| entry.id != *id);
            }
        }
        if revised
            .iter()
            .any(|reference| reference.starts_with(&format!("{}#", page.meta.id)))
        {
            page.meta.resume = None;
            page.meta.handoff = None;
        }
        ensure!(
            update.resume.is_none() || update.handoff.is_none(),
            "Choose resume or handoff, not both"
        );
        if let Some(resume) = &update.resume {
            page.meta.resume = if resume.trim().is_empty() {
                None
            } else {
                let (path, anchor) = split_link(resume)?;
                Some(evidence(root, &Source { path, anchor }, &overlay)?)
            };
            page.meta.handoff = None;
            refreshed.insert(page.path.clone());
        }
        if let Some(handoff) = &update.handoff {
            page.meta.handoff = (!handoff.trim().is_empty()).then(|| handoff.trim().to_owned());
            page.meta.resume = None;
            refreshed.insert(page.path.clone());
        }
        if page != previous || index.is_none() {
            page.meta.updated.clone_from(&request.date);
            changed.insert(page.path.clone());
        }
        if let Some(index) = index {
            pages[index] = page;
        } else {
            pages.push(page);
        }
    }
    // In-place corrections retire conclusions built on the prior version.
    let dependents: Vec<_> = pages
        .iter()
        .flat_map(|page| {
            page.entries
                .iter()
                .filter(|entry| {
                    entry.status == Status::Active
                        && !supplied.contains(&model::entry_ref(page, entry))
                        && entry
                            .depends_on
                            .iter()
                            .any(|target| revised.contains(target))
                })
                .map(|entry| model::entry_ref(page, entry))
        })
        .collect();
    for reference in dependents {
        set_status(
            &mut pages,
            &reference,
            Status::Review,
            &request.date,
            &mut changed,
            &refreshed,
        )?;
    }
    let replacements = request
        .pages
        .iter()
        .flat_map(|page| page.entries.iter())
        .flat_map(|entry| &entry.supersedes)
        .map(|target| (target, Status::Superseded));
    let retractions = request
        .retracts
        .iter()
        .map(|target| (target, Status::Retracted));
    for (target, status) in replacements.chain(retractions) {
        set_status(
            &mut pages,
            target,
            status,
            &request.date,
            &mut changed,
            &refreshed,
        )?;
    }
    loop {
        for page in &pages {
            if changed.contains(&page.path) {
                overlay.insert(page.path.clone(), model::render_page(page)?);
            }
        }
        let report = check::inspect(root, &overlay)?.report;
        ensure!(
            report.errors.is_empty(),
            "Memory validation failed:\n{}",
            report.errors.join("\n")
        );
        let review: Vec<_> = pages
            .iter()
            .flat_map(|page| {
                page.entries
                    .iter()
                    .filter(|entry| {
                        entry.status == Status::Active
                            && (report.invalid.contains(&model::entry_ref(page, entry))
                                || report.invalid.contains(&page.meta.id))
                    })
                    .map(|entry| model::entry_ref(page, entry))
            })
            .collect();
        if review.is_empty() {
            break;
        }
        for reference in review {
            set_status(
                &mut pages,
                &reference,
                Status::Review,
                &request.date,
                &mut changed,
                &refreshed,
            )?;
        }
    }
    let mut changes = Vec::new();
    for path in source.iter().map(|(path, _)| path).chain(changed.iter()) {
        let after = overlay
            .get(path)
            .context("Missing candidate content")?
            .clone();
        let before = originals.get(path).cloned();
        ensure!(
            current(root, path)? == before,
            "File changed while preparing record: {path}"
        );
        if before.as_ref() != Some(&after) {
            changes.push(Change {
                path: path.clone(),
                before,
                after,
            });
        }
    }
    finish(root, request, changes, dry_run)
}

fn source_record(root: &Path, request: &Request) -> Result<Option<(String, String)>> {
    let (path, body) = match (&request.path, &request.body) {
        (None, None) => return Ok(None),
        (Some(path), Some(body)) => (path, body),
        _ => anyhow::bail!("Source path and body must be provided together"),
    };
    ensure!(
        store::record_path(path),
        "Records must be Markdown files under corpus/.../records/"
    );
    let file = store::writable_path(root, path)?;
    ensure!(
        file.file_stem().and_then(|name| name.to_str()) == Some(request.id.as_str()),
        "Record filename must match its id"
    );
    ensure!(!body.trim().is_empty(), "Record body is empty");
    let header = Header {
        record_id: request.id.clone(),
        date: request.date.clone(),
    };
    let text = format!(
        "---\n{}---\n\n{}\n",
        serde_yaml_ng::to_string(&header)?,
        body.trim_end()
    );
    ensure!(
        text.len() <= store::MAX_FILE_BYTES,
        "Source record exceeds 1 MiB"
    );
    Ok(Some((path.clone(), text)))
}

fn output(request: &Request, changes: Vec<String>) -> Output {
    Output {
        id: request.id.clone(),
        already_recorded: changes.is_empty(),
        changed: changes,
    }
}

fn finish(root: &Path, request: &Request, changes: Vec<Change>, dry_run: bool) -> Result<Output> {
    let output = output(
        request,
        changes.iter().map(|change| change.path.clone()).collect(),
    );
    if !dry_run && !changes.is_empty() {
        publish(
            root,
            &Journal {
                id: request.id.clone(),
                changes,
            },
        )?;
    }
    Ok(output)
}

fn verify_replay(request: &Request, pages: &[Page]) -> Result<()> {
    let changed = "Source replay differs from current memory; use a memory-only request";
    for update in &request.pages {
        let page = pages
            .iter()
            .find(|page| page.path == update.path && page.meta.id == update.id)
            .context(changed)?;
        ensure!(
            update
                .summary
                .as_ref()
                .is_none_or(|summary| *summary == page.meta.summary)
                && update
                    .aliases
                    .as_ref()
                    .is_none_or(|aliases| *aliases == page.meta.aliases)
                && update
                    .scope
                    .as_ref()
                    .is_none_or(|scope| *scope == page.meta.scope)
                && update
                    .remove
                    .iter()
                    .all(|id| !page.entries.iter().any(|entry| entry.id == *id)),
            "{changed}"
        );
        ensure!(
            update.resume.is_none() || update.handoff.is_none(),
            "Choose resume or handoff, not both"
        );
        if let Some(resume) = &update.resume {
            let expected = if resume.trim().is_empty() {
                None
            } else {
                let (path, anchor) = split_link(resume)?;
                Some(Evidence { path, anchor })
            };
            ensure!(
                page.meta.resume == expected && page.meta.handoff.is_none(),
                "{changed}"
            );
        }
        if let Some(handoff) = &update.handoff {
            let expected = (!handoff.trim().is_empty()).then_some(handoff.trim());
            ensure!(
                page.meta.handoff.as_deref() == expected && page.meta.resume.is_none(),
                "{changed}"
            );
        }
        for expected in &update.entries {
            let entry = page
                .entries
                .iter()
                .find(|entry| entry.id == expected.id)
                .context(changed)?;
            ensure!(
                entry.text == expected.text.trim()
                    && entry.basis == expected.basis
                    && entry.as_of == expected.as_of
                    && entry.review_after == expected.review_after
                    && entry.depends_on == expected.depends_on
                    && entry.supersedes == expected.supersedes
                    && entry.evidence.len() == expected.evidence.len()
                    && entry
                        .evidence
                        .iter()
                        .zip(&expected.evidence)
                        .all(|(actual, source)| {
                            actual.path == source.path && actual.anchor == source.anchor
                        }),
                "{changed}"
            );
        }
    }
    for target in &request.retracts {
        let retracted = pages.iter().any(|page| {
            page.entries.iter().any(|entry| {
                model::entry_ref(page, entry) == *target && entry.status == Status::Retracted
            })
        });
        ensure!(retracted, "{changed}");
    }
    Ok(())
}

fn evidence(root: &Path, source: &Source, overlay: &Overlay) -> Result<Evidence> {
    ensure!(
        source.path.starts_with("corpus/"),
        "Evidence must reference Corpus"
    );
    let body = store::read_text(root, &source.path, overlay)?;
    if let Some(anchor) = &source.anchor {
        ensure!(
            store::has_anchor(&body, anchor),
            "Missing evidence anchor: {}#{anchor}",
            source.path
        );
    }
    Ok(Evidence {
        path: source.path.clone(),
        anchor: source.anchor.clone(),
    })
}

fn split_link(link: &str) -> Result<(String, Option<String>)> {
    let (path, anchor) = link.split_once('#').map_or((link, None), |(path, anchor)| {
        (path, Some(anchor.to_owned()))
    });
    ensure!(
        !path.is_empty() && anchor.as_ref().is_none_or(|anchor| !anchor.is_empty()),
        "Invalid handoff link"
    );
    Ok((path.to_owned(), anchor))
}

fn set_status(
    pages: &mut [Page],
    reference: &str,
    status: Status,
    date: &str,
    changed: &mut BTreeSet<String>,
    refreshed: &BTreeSet<String>,
) -> Result<()> {
    let (page_id, entry_id) = reference
        .split_once('#')
        .context("Expected page.id#entry reference")?;
    let page = pages
        .iter_mut()
        .find(|page| page.meta.id == page_id)
        .with_context(|| format!("Unknown page in {reference}"))?;
    let entry = page
        .entries
        .iter_mut()
        .find(|entry| entry.id == entry_id)
        .with_context(|| format!("Unknown entry {reference}"))?;
    if entry.status != status {
        entry.status = status;
        page.meta.updated = date.to_owned();
        if !refreshed.contains(&page.path) {
            page.meta.resume = None;
            page.meta.handoff = None;
        }
        changed.insert(page.path.clone());
    }
    Ok(())
}

fn publish(root: &Path, journal: &Journal) -> Result<()> {
    let pending = store::safe_path(root, PENDING)?;
    ensure!(!pending.exists(), "A record is already pending");
    for change in &journal.changes {
        ensure!(
            current(root, &change.path)? == change.before,
            "File changed before publication: {}",
            change.path
        );
    }
    let bytes = serde_json::to_vec_pretty(journal)?;
    ensure!(
        bytes.len() <= store::MAX_FILE_BYTES,
        "Recovery journal exceeds 1 MiB; split the change set before recording"
    );
    atomic_write(&pending, &bytes)?;
    for change in &journal.changes {
        let file = store::writable_path(root, &change.path)?;
        ensure!(
            current(root, &change.path)? == change.before,
            "File changed during publication: {}; recover the pending record",
            change.path
        );
        atomic_write(&file, change.after.as_bytes())?;
    }
    fs::remove_file(&pending)?;
    sync_parent(&pending)?;
    Ok(())
}

/// Roll back a partial record; refuse to overwrite external edits.
pub fn recover(root: &Path) -> Result<Output> {
    let pending = store::safe_path(root, PENDING)?;
    ensure!(pending.is_file(), "No interrupted record to recover");
    let journal: Journal = serde_json::from_str(&store::read_text(root, PENDING, &Overlay::new())?)
        .context("Parse pending record")?;
    ensure!(
        model::valid_id(&journal.id) && !journal.changes.is_empty(),
        "Invalid pending record"
    );
    let mut seen = BTreeSet::new();
    // Check every path before restoring even the first file.
    for change in &journal.changes {
        ensure!(
            seen.insert(&change.path),
            "Duplicate path in pending record"
        );
        let value = current(root, &change.path)?;
        ensure!(
            value == change.before || value.as_deref() == Some(change.after.as_str()),
            "Recovery conflict: {} has external edits; pending record preserved",
            change.path
        );
    }
    for change in journal.changes.iter().rev() {
        let file = store::writable_path(root, &change.path)?;
        let value = current(root, &change.path)?;
        ensure!(
            value == change.before || value.as_deref() == Some(change.after.as_str()),
            "Recovery conflict: {} changed during recovery",
            change.path
        );
        match &change.before {
            Some(before) => atomic_write(&file, before.as_bytes())?,
            None if file.exists() => {
                fs::remove_file(&file)?;
                sync_parent(&file)?;
            }
            None => {}
        }
    }
    fs::remove_file(&pending)?;
    sync_parent(&pending)?;
    Ok(Output {
        id: journal.id,
        changed: journal
            .changes
            .into_iter()
            .map(|change| change.path)
            .collect(),
        already_recorded: false,
    })
}

fn current(root: &Path, path: &str) -> Result<Option<String>> {
    if store::writable_path(root, path)?.exists() {
        Ok(Some(store::read_text(root, path, &BTreeMap::new())?))
    } else {
        Ok(None)
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("File has no parent")?;
    fs::create_dir_all(parent)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("Publish {}", path.display()))?;
    sync_parent(path)
}

fn sync_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}
