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
    pub path: String,
    pub body: String,
    #[serde(default)]
    pub pages: Vec<Update>,
    #[serde(default)]
    pub retracts: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub path: String,
    pub expected: Option<String>,
    pub id: String,
    pub summary: String,
    pub aliases: Option<Vec<String>>,
    pub scope: Option<Vec<String>>,
    pub resume: Option<String>,
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
    request_sha256: String,
    entries: Vec<String>,
    retracts: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    id: String,
    request_sha256: String,
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
    ensure!(
        store::record_path(&request.path),
        "Records must be Markdown files under corpus/.../records/"
    );
    let record_path = store::writable_path(root, &request.path)?;
    ensure!(
        record_path.file_stem().and_then(|name| name.to_str()) == Some(request.id.as_str()),
        "Record filename must match its id"
    );
    ensure!(!request.body.trim().is_empty(), "Record body is empty");
    ensure!(
        !request.pages.is_empty() || !request.retracts.is_empty(),
        "Change set has no memory updates"
    );
    let request_sha256 = model::digest(&serde_json::to_vec(request)?);
    let header = Header {
        record_id: request.id.clone(),
        date: request.date.clone(),
        request_sha256: request_sha256.clone(),
        entries: request
            .pages
            .iter()
            .flat_map(|page| {
                page.entries
                    .iter()
                    .map(|entry| format!("{}#{}", page.id, entry.id))
            })
            .collect(),
        retracts: request.retracts.clone(),
    };
    let source = format!(
        "---\n{}---\n\n{}\n",
        serde_yaml_ng::to_string(&header)?,
        request.body.trim_end()
    );
    ensure!(source.len() <= 1_048_576, "Source record exceeds 1 MiB");
    // Build the candidate from one immutable snapshot of the original pages.
    let originals = store::load_texts(root, &Overlay::new())?;
    let mut pages = originals
        .iter()
        .map(|(path, text)| model::parse_page(path, text).with_context(|| format!("parse {path}")))
        .collect::<Result<Vec<_>>>()?;
    if record_path.exists() {
        let existing = store::read_text(root, &request.path, &Overlay::new())?;
        ensure!(
            existing == source,
            "Record already exists with different content: {}",
            request.path
        );
        verify_replay(request, &pages)?;
        return Ok(Output {
            id: request.id.clone(),
            changed: Vec::new(),
            already_recorded: true,
        });
    }
    let mut overlay = Overlay::from([(request.path.clone(), source)]);
    let mut changed = BTreeSet::new();
    let mut refreshed = BTreeSet::new();
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
        let file = store::writable_path(root, &update.path)?;
        let index = pages.iter().position(|page| page.path == update.path);
        let mut page = match index {
            Some(index) => {
                let original = originals
                    .get(&update.path)
                    .context("Missing original page snapshot")?;
                ensure!(
                    update.expected.as_deref() == Some(model::digest(original.as_bytes()).as_str()),
                    "Page changed or expected hash missing: {}",
                    update.path
                );
                ensure!(
                    pages[index].meta.id == update.id,
                    "A page's stable id cannot change"
                );
                pages[index].clone()
            }
            None => {
                ensure!(
                    !file.exists() && update.expected.is_none(),
                    "New page must not have an expected hash"
                );
                Page {
                    path: update.path.clone(),
                    meta: Meta {
                        id: update.id.clone(),
                        summary: update.summary.clone(),
                        updated: request.date.clone(),
                        aliases: Vec::new(),
                        scope: Vec::new(),
                        resume: None,
                    },
                    entries: Vec::new(),
                }
            }
        };
        page.meta.summary.clone_from(&update.summary);
        page.meta.updated.clone_from(&request.date);
        if let Some(aliases) = &update.aliases {
            page.meta.aliases.clone_from(aliases);
        }
        if let Some(scope) = &update.scope {
            page.meta.scope.clone_from(scope);
        }
        if !update.entries.is_empty() {
            page.meta.resume = None;
        }
        if let Some(resume) = &update.resume {
            let (path, anchor) = split_link(resume)?;
            ensure!(
                path == request.path,
                "A refreshed handoff must reference this new source record"
            );
            page.meta.resume = Some(evidence(root, &Source { path, anchor }, &overlay)?);
            refreshed.insert(page.path.clone());
        }
        for entry in &update.entries {
            ensure!(
                !page.entries.iter().any(|old| old.id == entry.id),
                "Existing entries cannot be rewritten: {}#{}",
                page.meta.id,
                entry.id
            );
            let evidence = entry
                .evidence
                .iter()
                .map(|source| evidence(root, source, &overlay))
                .collect::<Result<Vec<_>>>()?;
            page.entries.push(Entry {
                id: entry.id.clone(),
                basis: entry.basis,
                status: Status::Active,
                as_of: entry.as_of.clone(),
                text: entry.text.clone(),
                evidence,
                depends_on: entry.depends_on.clone(),
                supersedes: entry.supersedes.clone(),
                review_after: entry.review_after.clone(),
            });
        }
        changed.insert(page.path.clone());
        if let Some(index) = index {
            pages[index] = page;
        } else {
            pages.push(page);
        }
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
    // Each iteration retires at least one active dependent; propagation is finite.
    loop {
        for page in &pages {
            if changed.contains(&page.path) {
                overlay.insert(page.path.clone(), model::render_page(page)?);
            }
        }
        let (_, report) = check::inspect(root, &overlay)?;
        ensure!(
            report.errors.is_empty(),
            "Memory validation failed:\n{}",
            report.errors.join("\n")
        );
        let review: Vec<String> = pages
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
    // Publish sources before their pages; readers are excluded until completion.
    for path in std::iter::once(&request.path).chain(changed.iter()) {
        let after = overlay
            .get(path)
            .context("Missing candidate content")?
            .clone();
        store::writable_path(root, path)?;
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
    let output = Output {
        id: request.id.clone(),
        changed: changes.iter().map(|change| change.path.clone()).collect(),
        already_recorded: false,
    };
    if !dry_run {
        publish(
            root,
            &Journal {
                id: request.id.clone(),
                request_sha256,
                changes,
            },
        )?;
    }
    Ok(output)
}

fn verify_replay(request: &Request, pages: &[Page]) -> Result<()> {
    for update in &request.pages {
        let page = pages
            .iter()
            .find(|page| page.path == update.path && page.meta.id == update.id)
            .context("Recorded page is missing; inspect memory before retrying")?;
        for expected in &update.entries {
            let entry = page
                .entries
                .iter()
                .find(|entry| entry.id == expected.id)
                .context("Recorded entry is missing; inspect memory before retrying")?;
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
                "Recorded entry changed outside the record lifecycle"
            );
        }
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
        sha256: model::digest(body.as_bytes()),
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
        }
        changed.insert(page.path.clone());
    }
    Ok(())
}

fn publish(root: &Path, journal: &Journal) -> Result<()> {
    let pending = store::safe_path(root, PENDING)?;
    ensure!(!pending.exists(), "A record is already pending");
    for change in &journal.changes {
        store::writable_path(root, &change.path)?;
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
        store::writable_path(root, &change.path)?;
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
