use anyhow::{Result, ensure};
use noema_memory::model::{Basis, Entry, Meta, Page, Status, render_page};
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
use tempfile::TempDir;

fn fixture() -> Result<TempDir> {
    let root = tempfile::tempdir()?;
    for area in ["profile", "work", "insights"] {
        fs::create_dir_all(root.path().join("noema").join(area))?;
    }
    let mut work = page(
        "work.alpha",
        "Alpha storage mapping decisions.",
        "Alpha uses mmap.",
    );
    work.meta.aliases = vec!["Alpha".into()];
    work.meta.handoff = Some("Next: validate mmap visibility.".into());
    save(root.path(), &work)?;
    save(
        root.path(),
        &page(
            "profile.preferences",
            "Writing preferences.",
            "Keep explanations concise.",
        ),
    )?;
    Ok(root)
}

fn page(id: &str, summary: &str, text: &str) -> Page {
    let (area, name) = id.split_once('.').expect("fixture ID");
    Page {
        path: format!("noema/{area}/{name}.md"),
        meta: Meta {
            id: id.into(),
            summary: summary.into(),
            updated: "2026-10-31".into(),
            aliases: vec![],
            scope: vec![],
            handoff: None,
        },
        entries: vec![Entry {
            id: "decision".into(),
            basis: Basis::Explicit,
            status: Status::Active,
            as_of: "2026-10-31".into(),
            text: text.into(),
            review_after: None,
        }],
    }
}

fn save(root: &Path, page: &Page) -> Result<()> {
    fs::write(root.join(&page.path), render_page(page)?)?;
    Ok(())
}

fn run(root: &Path, args: &[&str]) -> Result<Output> {
    Ok(Command::new(env!("CARGO_BIN_EXE_noema"))
        .arg("--root")
        .arg(root)
        .args(args)
        .current_dir(root)
        .output()?)
}

fn cli(root: &Path, args: &[&str]) -> Result<Value> {
    let output = run(root, args)?;
    ensure!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[test]
fn standalone_memory_is_recalled_without_corpus_or_private_state() -> Result<()> {
    let root = fixture()?;
    let path = root.path().join("noema/work/alpha.md");
    let original = fs::read(&path)?;
    let modified = fs::metadata(&path)?.modified()?;
    assert_eq!(
        cli(root.path(), &["check", "--json"])?["errors"],
        serde_json::json!([])
    );
    let context = cli(
        root.path(),
        &["context", "--query", "research Alpha", "--json"],
    )?;
    assert!(
        context["text"]
            .as_str()
            .expect("JSON output field")
            .contains("Alpha uses mmap.")
    );
    assert!(
        context["text"]
            .as_str()
            .expect("JSON output field")
            .contains("Next: validate mmap visibility.")
    );
    assert_eq!(context["selected"][0], "work.alpha#decision");
    assert!(!root.path().join("corpus").exists());
    assert!(!root.path().join(".local").exists());
    assert_eq!(fs::read(&path)?, original);
    assert_eq!(fs::metadata(path)?.modified()?, modified);
    Ok(())
}

#[test]
fn a_direct_correction_is_visible_in_a_new_process() -> Result<()> {
    let root = fixture()?;
    let before = cli(root.path(), &["context", "--work", "work.alpha", "--json"])?;
    assert!(
        before["text"]
            .as_str()
            .expect("JSON output field")
            .contains("Alpha uses mmap.")
    );
    let mut corrected = page(
        "work.alpha",
        "Alpha storage mapping decisions.",
        "Alpha uses explicit reads.",
    );
    corrected.meta.handoff = Some("Next: measure explicit reads.".into());
    save(root.path(), &corrected)?;
    let after = cli(root.path(), &["context", "--work", "work.alpha", "--json"])?;
    let text = after["text"].as_str().expect("JSON output field");
    assert!(text.contains("Alpha uses explicit reads."));
    assert!(text.contains("Next: measure explicit reads."));
    assert!(!text.contains("Alpha uses mmap."));
    assert!(!text.contains("validate mmap visibility"));
    Ok(())
}

#[test]
fn inactive_and_expired_entries_are_not_loaded() -> Result<()> {
    let root = fixture()?;
    let mut work = page("work.alpha", "Alpha decisions.", "CURRENT_FINDING");
    for (id, status, deadline) in [
        ("withdrawn", Status::Retracted, None),
        ("old", Status::Superseded, None),
        ("review", Status::Review, None),
        ("expired", Status::Active, Some("2020-02-01")),
    ] {
        work.entries.push(Entry {
            id: id.into(),
            basis: Basis::Observed,
            status,
            as_of: "2020-01-01".into(),
            text: format!("DO_NOT_LOAD_{id}"),
            review_after: deadline.map(str::to_owned),
        });
    }
    save(root.path(), &work)?;
    let output = cli(root.path(), &["context", "--work", "work.alpha", "--json"])?;
    let text = output["text"].as_str().expect("JSON output field");
    assert!(text.contains("CURRENT_FINDING"));
    assert!(!text.contains("DO_NOT_LOAD"));
    assert_eq!(
        output["selected"]
            .as_array()
            .expect("JSON output field")
            .len(),
        1
    );
    assert!(
        !output["warnings"]
            .as_array()
            .expect("JSON output field")
            .is_empty()
    );
    assert!(!run(root.path(), &["check"])?.status.success());
    Ok(())
}

#[test]
fn handoff_only_pages_and_inferred_statements_need_no_source_wrappers() -> Result<()> {
    let root = fixture()?;
    let mut work = page("work.alpha", "Alpha continuation.", "unused");
    work.entries.clear();
    work.meta.handoff = Some("Next: inspect the allocator.".into());
    save(root.path(), &work)?;
    let mut insight = page(
        "insights.mapping",
        "Mapping hypothesis.",
        "The allocation pattern may explain overhead.",
    );
    insight.entries[0].basis = Basis::Inferred;
    save(root.path(), &insight)?;
    cli(root.path(), &["check", "--json"])?;
    let output = cli(root.path(), &["context", "--work", "work.alpha", "--json"])?;
    assert!(
        output["text"]
            .as_str()
            .expect("JSON output field")
            .contains("Next: inspect the allocator.")
    );
    assert!(
        output["selected"]
            .as_array()
            .expect("JSON output field")
            .is_empty()
    );
    Ok(())
}

#[test]
fn bootstrap_loads_profile_and_bounded_context_keeps_statements_whole() -> Result<()> {
    let root = fixture()?;
    let bootstrap = cli(root.path(), &["context", "--bootstrap", "--json"])?;
    let text = bootstrap["text"].as_str().expect("JSON output field");
    assert!(text.contains("Keep explanations concise."));
    assert!(!text.contains("Alpha uses mmap."));
    let mut work = page(
        "work.alpha",
        "Alpha mapping.",
        &format!("LONG_BLOCK_START{}LONG_BLOCK_END", "中".repeat(600)),
    );
    work.entries.push(Entry {
        id: "short".into(),
        text: "A short complete statement.".into(),
        ..work.entries[0].clone()
    });
    save(root.path(), &work)?;
    let bounded = cli(
        root.path(),
        &[
            "context",
            "--work",
            "work.alpha",
            "--max-chars",
            "256",
            "--json",
        ],
    )?;
    let text = bounded["text"].as_str().expect("JSON output field");
    assert!(text.chars().count() <= 256);
    assert!(!text.contains("LONG_BLOCK_START"));
    assert!(text.contains("A short complete statement."));
    Ok(())
}

#[test]
fn malformed_memory_is_reported_and_record_command_is_removed() -> Result<()> {
    let root = fixture()?;
    let path = root.path().join("noema/work/alpha.md");
    let text = fs::read_to_string(&path)?.replace("- Basis: explicit", "- Unknown: explicit");
    fs::write(path, text)?;
    let checked = run(root.path(), &["check"])?;
    assert!(!checked.status.success());
    assert!(String::from_utf8_lossy(&checked.stderr).contains("unknown entry field"));
    assert!(
        !run(root.path(), &["context", "--work", "work.alpha"])?
            .status
            .success()
    );
    let removed = run(root.path(), &["record", "change.json"])?;
    assert!(!removed.status.success());
    assert!(String::from_utf8_lossy(&removed.stderr).contains("unrecognized subcommand"));
    Ok(())
}

#[test]
fn root_discovery_ignores_the_tools_noema_crate() -> Result<()> {
    let root = fixture()?;
    let tools = root.path().join("tools");
    fs::create_dir_all(tools.join("noema"))?;
    let output = Command::new(env!("CARGO_BIN_EXE_noema"))
        .args(["context", "--work", "work.alpha", "--json"])
        .current_dir(tools)
        .output()?;
    ensure!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout)?;
    assert!(
        result["text"]
            .as_str()
            .expect("JSON output field")
            .contains("Alpha uses mmap.")
    );
    Ok(())
}
