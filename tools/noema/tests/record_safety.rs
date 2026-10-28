use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
use tempfile::TempDir;

fn command(root: &Path, args: &[&str]) -> Result<Output> {
    Ok(Command::new(env!("CARGO_BIN_EXE_noema"))
        .arg("--root")
        .arg(root)
        .args(args)
        .output()?)
}

fn request(
    root: &Path,
    input: &Path,
    id: &str,
    text: &str,
    expected: Option<String>,
) -> Result<Value> {
    let source = format!("corpus/records/{id}.md");
    let value = json!({
        "id": id,
        "date": "2026-10-28",
        "path": source,
        "body": "# Source\n\n## Request\nPreserve the original statement.\n",
        "pages": [{
            "path": "noema/work/example.md",
            "expected": expected,
            "id": "work.example",
            "summary": "Example memory.",
            "entries": [{
                "id": id,
                "basis": "explicit",
                "as_of": "2026-10-28",
                "text": text,
                "evidence": [{"path": source, "anchor": "request"}]
            }]
        }]
    });
    fs::write(input, serde_json::to_vec(&value)?)?;
    ensure!(root.join("noema/work").is_dir());
    Ok(value)
}

fn vault() -> Result<TempDir> {
    let root = tempfile::tempdir()?;
    fs::create_dir_all(root.path().join("noema/work"))?;
    fs::create_dir_all(root.path().join("corpus/records"))?;
    Ok(root)
}

#[test]
fn oversized_journal_is_rejected_before_publication() -> Result<()> {
    let root = vault()?;
    let inputs = tempfile::tempdir()?;
    let seed = inputs.path().join("seed.json");
    request(root.path(), &seed, "seed", &"x".repeat(600_000), None)?;
    let first = command(
        root.path(),
        &["record", seed.to_str().context("input path")?],
    )?;
    ensure!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let page = root.path().join("noema/work/example.md");
    let before = fs::read(&page)?;
    let old_source = fs::read(root.path().join("corpus/records/seed.md"))?;
    let update = inputs.path().join("update.json");
    request(
        root.path(),
        &update,
        "update",
        "One additional statement.",
        Some(format!("{:x}", Sha256::digest(&before))),
    )?;
    let result = command(
        root.path(),
        &["record", update.to_str().context("input path")?],
    )?;
    assert!(!result.status.success());
    assert!(
        String::from_utf8_lossy(&result.stderr)
            .to_lowercase()
            .contains("journal")
    );
    assert_eq!(fs::read(&page)?, before);
    assert_eq!(
        fs::read(root.path().join("corpus/records/seed.md"))?,
        old_source
    );
    assert!(!root.path().join("corpus/records/update.md").exists());
    assert!(!root.path().join(".local/noema/pending.json").exists());
    let check = command(root.path(), &["check"])?;
    assert!(
        check.status.success(),
        "{}",
        String::from_utf8_lossy(&check.stderr)
    );
    Ok(())
}

#[test]
fn canonical_statement_whitespace_is_idempotent() -> Result<()> {
    let root = vault()?;
    let inputs = tempfile::tempdir()?;
    let input = inputs.path().join("seed.json");
    request(
        root.path(),
        &input,
        "seed",
        "  Keep concise notes.\n\n",
        None,
    )?;
    let args = ["record", input.to_str().context("input path")?, "--json"];
    let first = command(root.path(), &args)?;
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let page = root.path().join("noema/work/example.md");
    let before = fs::read(&page)?;
    let second = command(root.path(), &args)?;
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    let output: Value = serde_json::from_slice(&second.stdout)?;
    assert_eq!(output["already_recorded"], true);
    assert_eq!(fs::read(&page)?, before);
    Ok(())
}
