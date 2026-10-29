use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use tempfile::TempDir;

const PAGE: &str = "noema/work/test.md";
const SOURCE: &str = "corpus/projects/Test/records/seed.md";
const OLD: &str = "The current mode is alpha.";
const NEW: &str = "The current mode is beta.";
const DEPENDENT: &str = "Use the alpha-specific recovery path.";
const TRANSITIVE: &str = "Keep the alpha-dependent continuation assumption.";

struct Fixture {
    directory: TempDir,
}

impl Fixture {
    fn new() -> Result<Self> {
        let directory = tempfile::tempdir()?;
        for path in [
            "noema/profile",
            "noema/work",
            "noema/insights",
            "corpus/projects/Test/records",
            "tools",
        ] {
            fs::create_dir_all(directory.path().join(path))?;
        }
        fs::write(directory.path().join("tools/Cargo.toml"), "[workspace]\n")?;
        Ok(Self { directory })
    }

    fn root(&self) -> &Path {
        self.directory.path()
    }

    fn run(&self, args: &[&str]) -> Result<Output> {
        Command::new(env!("CARGO_BIN_EXE_noema"))
            .current_dir(self.root())
            .arg("--root")
            .arg(self.root())
            .args(args)
            .output()
            .context("run the Noema CLI in an independent process")
    }

    fn json(&self, args: &[&str]) -> Result<Value> {
        let output = self.run(args)?;
        ensure!(
            output.status.success(),
            "CLI failed: {:?}\nstdout: {}\nstderr: {}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).context("decode CLI JSON output")
    }

    fn input(&self, request: &Value) -> Result<PathBuf> {
        let path = self.root().join("input.json");
        fs::write(&path, serde_json::to_vec_pretty(request)?)?;
        Ok(path)
    }

    fn record(&self, request: &Value) -> Result<Value> {
        let path = self.input(request)?;
        let input = path
            .to_str()
            .context("temporary input path must be UTF-8")?;
        self.json(&["record", input, "--json"])
    }

    fn reject_record(&self, request: &Value) -> Result<Output> {
        let path = self.input(request)?;
        let input = path
            .to_str()
            .context("temporary input path must be UTF-8")?;
        let before = memory_and_sources(self.root())?;
        let output = self.run(&["record", input, "--json"])?;
        ensure!(
            !output.status.success(),
            "record unexpectedly succeeded: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(before, memory_and_sources(self.root())?);
        Ok(output)
    }

    fn seed(&self) -> Result<Value> {
        let request = seed_request();
        self.record(&request)?;
        Ok(request)
    }

    fn context(&self) -> Result<Value> {
        self.json(&["context", "--work", "work.test", "--json"])
    }
}

fn entry(id: &str, basis: &str, text: &str, source: &str) -> Value {
    json!({
        "id": id,
        "basis": basis,
        "as_of": "2026-10-28",
        "text": text,
        "evidence": [{"path": source, "anchor": "request"}],
        "depends_on": [],
        "supersedes": []
    })
}

fn seed_request() -> Value {
    let mut dependent = entry("dependent", "inferred", DEPENDENT, SOURCE);
    dependent["depends_on"] = json!(["work.test#mode"]);
    let mut transitive = entry("transitive", "inferred", TRANSITIVE, SOURCE);
    transitive["depends_on"] = json!(["work.test#dependent"]);
    json!({
        "id": "seed",
        "date": "2026-10-28",
        "path": SOURCE,
        "body": "# Test evidence\n\n## Request\nThe current mode is alpha. Prefer brief explanations.\n\n## Handoff\nNext: implement the reader.\n",
        "pages": [{
            "path": PAGE,
            "id": "work.test",
            "summary": "Decisions and continuation for Test Work.",
            "aliases": ["Test Work", "测试工作"],
            "scope": ["corpus/projects/Test"],
            "resume": format!("{SOURCE}#handoff"),
            "entries": [entry("mode", "observed", OLD, SOURCE), dependent, transitive]
        }, {
            "path": "noema/profile/preferences.md",
            "id": "profile.preferences",
            "summary": "Writing preferences.",
            "entries": [entry("brevity", "explicit", "Prefer brief explanations.", SOURCE)]
        }],
        "retracts": []
    })
}

fn correction_request(_fixture: &Fixture) -> Result<Value> {
    let source = "corpus/projects/Test/records/correction.md";
    let mut replacement = entry("mode-v2", "explicit", NEW, source);
    replacement["supersedes"] = json!(["work.test#mode"]);
    Ok(json!({
        "id": "correction",
        "date": "2026-10-28",
        "path": source,
        "body": "# Correction evidence\n\n## Request\nThe current mode is beta.\n\n## Handoff\nNext: validate beta recovery.\n",
        "pages": [{
            "path": PAGE,
            "id": "work.test",
            "summary": "Decisions and continuation for Test Work.",
            "resume": format!("{source}#handoff"),
            "entries": [replacement]
        }],
        "retracts": []
    }))
}

fn snapshot(root: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    fn visit(root: &Path, directory: &Path, found: &mut BTreeMap<String, Vec<u8>>) -> Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let key = path.strip_prefix(root)?.to_string_lossy().into_owned();
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                found.insert(
                    key,
                    fs::read_link(path)?.to_string_lossy().as_bytes().to_vec(),
                );
            } else if kind.is_dir() {
                visit(root, &path, found)?;
            } else if kind.is_file() {
                found.insert(key, fs::read(path)?);
            }
        }
        Ok(())
    }
    let mut found = BTreeMap::new();
    visit(root, root, &mut found)?;
    Ok(found)
}

fn memory_and_sources(root: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    Ok(snapshot(root)?
        .into_iter()
        .filter(|(path, _)| path.starts_with("noema/") || path.starts_with("corpus/"))
        .collect())
}

fn text(output: &Value) -> Result<&str> {
    output["text"].as_str().context("context output needs text")
}

fn simulate_interrupted_publication(fixture: &Fixture) -> Result<()> {
    let before = fs::read_to_string(fixture.root().join(PAGE))?;
    let after = before.replace(OLD, "Incomplete candidate text.");
    ensure!(
        before != after,
        "the simulated transaction must change the page"
    );
    let source = "corpus/projects/Test/records/interrupted.md";
    let source_text = "# Interrupted evidence\n\n## Request\nA candidate update.\n";
    let pending = json!({
        "id": "interrupted",
        "changes": [{
            "path": source,
            "before": null,
            "after": source_text
        }, {
            "path": PAGE,
            "before": before,
            "after": after
        }]
    });
    let path = fixture.root().join(".local/noema/pending.json");
    fs::create_dir_all(path.parent().context("pending parent")?)?;
    fs::write(path, serde_json::to_vec_pretty(&pending)?)?;
    fs::write(fixture.root().join(source), source_text)?;
    fs::write(fixture.root().join(PAGE), after)?;
    Ok(())
}

#[test]
fn independent_sessions_resume_then_propagate_corrections() -> Result<()> {
    let fixture = Fixture::new()?;
    let seed = fixture.seed()?;
    let first = fixture.context()?;
    assert!(text(&first)?.contains(OLD));
    assert!(text(&first)?.contains(DEPENDENT));
    assert!(text(&first)?.contains("Next: implement the reader."));
    assert!(
        first["selected"]
            .as_array()
            .context("selected refs")?
            .contains(&json!("work.test#mode"))
    );

    let correction = correction_request(&fixture)?;
    fixture.record(&correction)?;
    let second = fixture.context()?;
    assert!(text(&second)?.contains(NEW));
    assert!(text(&second)?.contains("Next: validate beta recovery."));
    for obsolete in [OLD, DEPENDENT, TRANSITIVE] {
        assert!(
            !text(&second)?.contains(obsolete),
            "obsolete context: {obsolete}"
        );
    }
    let page = fs::read_to_string(fixture.root().join(PAGE))?;
    assert!(page.contains(OLD), "history must remain available on disk");
    assert!(page.contains("- Status: superseded"));
    assert_eq!(page.matches("- Status: review").count(), 2);
    let check = fixture.run(&["check", "--json"])?;
    let check: Value = serde_json::from_slice(&check.stdout)?;
    assert_eq!(check["errors"], json!([]));

    let before = memory_and_sources(fixture.root())?;
    fixture.reject_record(&seed)?;
    assert_eq!(before, memory_and_sources(fixture.root())?);
    assert!(text(&fixture.context()?)?.contains(NEW));
    Ok(())
}

#[test]
fn retry_and_dry_run_do_not_duplicate_or_publish_data() -> Result<()> {
    let fixture = Fixture::new()?;
    let request = seed_request();
    let input = fixture.input(&request)?;
    let before = memory_and_sources(fixture.root())?;
    fixture.json(&[
        "record",
        input.to_str().context("input path")?,
        "--dry-run",
        "--json",
    ])?;
    assert_eq!(before, memory_and_sources(fixture.root())?);
    assert!(!fixture.root().join(".local").exists());

    let first = fixture.record(&request)?;
    assert_eq!(first["already_recorded"], json!(false));
    let before_retry = memory_and_sources(fixture.root())?;
    let replay = fixture.record(&request)?;
    assert_eq!(replay["already_recorded"], json!(true));
    assert_eq!(before_retry, memory_and_sources(fixture.root())?);
    let mut collision = request;
    collision["body"] = json!("# Different evidence\n\n## Request\nChanged.\n");
    fixture.reject_record(&collision)?;
    Ok(())
}

#[test]
fn replay_rejects_modified_deadlines_and_evidence_pointers() -> Result<()> {
    for edit in ["deadline", "evidence"] {
        let fixture = Fixture::new()?;
        let seed = fixture.seed()?;
        let path = fixture.root().join(PAGE);
        let original = fs::read_to_string(&path)?;
        let changed = if edit == "deadline" {
            original.replacen(
                "- As of: 2026-10-28",
                "- As of: 2026-10-28\n- Review after: 2099-01-01",
                1,
            )
        } else {
            original.replacen("#request>", "#handoff>", 1)
        };
        assert_ne!(original, changed);
        fs::write(path, changed)?;
        fixture.reject_record(&seed)?;
    }
    Ok(())
}

#[test]
fn source_replay_rejects_new_retractions_without_page_updates() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    let mut request = json!({
        "id": "observation", "date": "2026-10-28",
        "path": "corpus/projects/Test/records/observation.md",
        "body": "An independent observation."
    });
    fixture.record(&request)?;
    request["retracts"] = json!(["work.test#mode"]);
    let output = fixture.reject_record(&request)?;
    assert!(String::from_utf8_lossy(&output.stderr).contains("memory-only request"));
    Ok(())
}

#[test]
fn source_replay_rejects_changed_page_intent() -> Result<()> {
    for field in ["summary", "aliases", "scope", "resume", "handoff", "remove"] {
        let fixture = Fixture::new()?;
        let mut request = fixture.seed()?;
        request["pages"][0][field] = match field {
            "summary" => json!("A changed summary."),
            "aliases" => json!(["Changed alias"]),
            "scope" => json!([]),
            "resume" => json!(format!("{SOURCE}#request")),
            "handoff" => {
                request["pages"][0]
                    .as_object_mut()
                    .context("page update")?
                    .remove("resume");
                json!("Next: a different continuation.")
            }
            "remove" => json!(["transitive"]),
            _ => unreachable!(),
        };
        let output = fixture.reject_record(&request)?;
        assert!(String::from_utf8_lossy(&output.stderr).contains("memory-only request"));
    }
    Ok(())
}

#[test]
fn source_replay_accepts_already_applied_retractions_and_page_updates() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    let request = json!({
        "id": "checkpoint", "date": "2026-10-29",
        "path": "corpus/projects/Test/records/checkpoint.md",
        "body": "A significant checkpoint.",
        "pages": [{
            "path": PAGE, "id": "work.test",
            "summary": "Current Test Work decisions.",
            "aliases": ["Current Test"], "scope": [],
            "handoff": "Next: validate the reader.", "remove": ["transitive"]
        }],
        "retracts": ["profile.preferences#brevity"]
    });
    fixture.record(&request)?;
    let before = memory_and_sources(fixture.root())?;
    let replay = fixture.record(&request)?;
    assert_eq!(replay["already_recorded"], json!(true));
    assert_eq!(replay["changed"], json!([]));
    assert_eq!(before, memory_and_sources(fixture.root())?);
    assert!(!fixture.root().join(".local/noema/pending.json").exists());
    Ok(())
}

#[test]
fn bad_references_preserve_every_published_file() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    let mut request = correction_request(&fixture)?;
    request["pages"][0]["entries"][0]["depends_on"] = json!(["work.missing#entry"]);
    fixture.reject_record(&request)?;

    request = correction_request(&fixture)?;
    request["pages"][0]["entries"][0]["evidence"][0]["anchor"] = json!("missing-anchor");
    fixture.reject_record(&request)?;
    assert!(text(&fixture.context()?)?.contains("Next: implement the reader."));
    Ok(())
}

#[test]
fn cycles_duplicate_ids_and_untyped_inferences_are_rejected() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut request = seed_request();
    request["pages"][0]["entries"][0]["depends_on"] = json!(["work.test#transitive"]);
    fixture.reject_record(&request)?;

    request = seed_request();
    request["pages"][1]["id"] = json!("work.test");
    fixture.reject_record(&request)?;

    request = seed_request();
    request["pages"][0]["entries"][1]["id"] = json!("mode");
    fixture.reject_record(&request)?;

    request = seed_request();
    request["pages"][0]["entries"][1]["depends_on"] = json!([]);
    fixture.reject_record(&request)?;

    request = seed_request();
    request["pages"][0]["entries"][0]["evidence"] = json!([]);
    fixture.reject_record(&request)?;
    Ok(())
}

#[test]
fn retracting_a_premise_preserves_history_and_suspends_derived_memories() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    let request = json!({
        "id": "retraction",
        "date": "2026-10-28",
        "path": "corpus/projects/Test/records/retraction.md",
        "body": "# Retraction\n\n## Request\nWithdraw work.test#mode; it was not established.\n",
        "pages": [],
        "retracts": ["work.test#mode"]
    });
    fixture.record(&request)?;
    let page = fs::read_to_string(fixture.root().join(PAGE))?;
    assert!(page.contains(OLD));
    assert!(page.contains("- Status: retracted"));
    assert_eq!(page.matches("- Status: review").count(), 2);
    let context = fixture.context()?;
    for obsolete in [OLD, DEPENDENT, TRANSITIVE] {
        assert!(!text(&context)?.contains(obsolete));
    }
    Ok(())
}

#[test]
fn competing_replacements_for_the_same_memory_are_rejected() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    let mut request = correction_request(&fixture)?;
    let entries = request["pages"][0]["entries"]
        .as_array_mut()
        .context("replacement entries")?;
    let mut rival = entries[0].clone();
    rival["id"] = json!("mode-v3");
    rival["text"] = json!("The current mode is gamma.");
    entries.push(rival);
    fixture.reject_record(&request)?;
    Ok(())
}

#[test]
fn concurrent_updates_do_not_lose_the_winning_revision() -> Result<()> {
    use std::process::Stdio;

    let fixture = Fixture::new()?;
    fixture.seed()?;
    let first_request = correction_request(&fixture)?;
    let mut second_request = first_request.clone();
    second_request["id"] = json!("rival");
    second_request["path"] = json!("corpus/projects/Test/records/rival.md");
    second_request["pages"][0]["resume"] = json!("corpus/projects/Test/records/rival.md#handoff");
    second_request["pages"][0]["entries"][0]["id"] = json!("mode-rival");
    second_request["pages"][0]["entries"][0]["evidence"][0]["path"] =
        json!("corpus/projects/Test/records/rival.md");
    second_request["pages"][0]["entries"][0]["text"] = json!("The current mode is gamma.");
    second_request["body"] = json!(
        "# Rival evidence\n\n## Request\nThe current mode is gamma.\n\n## Handoff\nNext: validate gamma recovery.\n"
    );
    let paths = [
        fixture.root().join("first.json"),
        fixture.root().join("second.json"),
    ];
    fs::write(&paths[0], serde_json::to_vec(&first_request)?)?;
    fs::write(&paths[1], serde_json::to_vec(&second_request)?)?;
    let mut children = Vec::new();
    for path in paths {
        children.push(
            Command::new(env!("CARGO_BIN_EXE_noema"))
                .current_dir(fixture.root())
                .arg("--root")
                .arg(fixture.root())
                .arg("record")
                .arg(path)
                .arg("--json")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?,
        );
    }
    let mut outcomes = Vec::new();
    for child in children {
        outcomes.push(child.wait_with_output()?);
    }
    assert_eq!(
        outcomes
            .iter()
            .filter(|output| output.status.success())
            .count(),
        1
    );
    let context = fixture.context()?;
    let beta = text(&context)?.contains(NEW);
    let gamma = text(&context)?.contains("The current mode is gamma.");
    assert_ne!(beta, gamma);
    assert!(!text(&context)?.contains(OLD));
    assert_ne!(
        fixture
            .root()
            .join("corpus/projects/Test/records/correction.md")
            .exists(),
        fixture
            .root()
            .join("corpus/projects/Test/records/rival.md")
            .exists()
    );
    Ok(())
}

#[test]
fn source_text_changes_require_explicit_corrections_but_links_must_resolve() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    fs::write(
        fixture.root().join(SOURCE),
        "# Changed evidence\n\n## Request\nOther text.\n\n## Handoff\nOther next action.\n",
    )?;
    let before = snapshot(fixture.root())?;
    assert!(fixture.run(&["check", "--json"])?.status.success());
    let context = fixture.context()?;
    assert!(
        context["text"]
            .as_str()
            .context("context text")?
            .contains(OLD)
    );
    assert!(
        context["text"]
            .as_str()
            .context("context text")?
            .contains("Other next action.")
    );
    assert_eq!(before, snapshot(fixture.root())?);

    fs::remove_file(fixture.root().join(SOURCE))?;
    assert!(!fixture.run(&["check", "--json"])?.status.success());
    let context = fixture.run(&["context", "--work", "work.test", "--json"])?;
    assert!(!String::from_utf8_lossy(&context.stdout).contains(OLD));
    Ok(())
}

#[test]
fn expired_premises_do_not_leave_their_inferences_in_current_context() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    let path = fixture.root().join(PAGE);
    let page = fs::read_to_string(&path)?;
    fs::write(
        path,
        page.replacen(
            "- As of: 2026-10-28",
            "- As of: 2000-01-01\n- Review after: 2000-01-02",
            1,
        ),
    )?;
    let context = fixture.run(&["context", "--work", "work.test", "--json"])?;
    let rendered = String::from_utf8_lossy(&context.stdout);
    for obsolete in [OLD, DEPENDENT, TRANSITIVE] {
        assert!(!rendered.contains(obsolete));
    }
    Ok(())
}

#[test]
fn interrupted_publication_blocks_readers_without_touching_recovery_state() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    let pending = fixture.root().join(".local/noema/pending.json");
    fs::create_dir_all(pending.parent().context("pending parent")?)?;
    fs::write(&pending, "incomplete transaction journal")?;
    let before = snapshot(fixture.root())?;
    for args in [
        vec!["check", "--json"],
        vec!["context", "--work", "work.test", "--json"],
    ] {
        let output = fixture.run(&args)?;
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains(OLD));
    }
    assert_eq!(before, snapshot(fixture.root())?);
    Ok(())
}

#[test]
fn interrupted_publication_rolls_back_pages_and_only_its_new_source() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    let original = memory_and_sources(fixture.root())?;
    simulate_interrupted_publication(&fixture)?;
    assert!(!fixture.run(&["check", "--json"])?.status.success());
    fixture.json(&["record", "--recover", "--json"])?;
    assert!(!fixture.root().join(".local/noema/pending.json").exists());
    assert_eq!(original, memory_and_sources(fixture.root())?);
    assert!(text(&fixture.context()?)?.contains(OLD));
    assert!(text(&fixture.context()?)?.contains("Next: implement the reader."));
    Ok(())
}

#[test]
fn recovery_refuses_to_overwrite_edits_made_after_interruption() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    simulate_interrupted_publication(&fixture)?;
    fs::write(
        fixture.root().join(PAGE),
        "# A later manual edit\nPreserve this.\n",
    )?;
    let before = snapshot(fixture.root())?;
    let output = fixture.run(&["record", "--recover", "--json"])?;
    assert!(!output.status.success());
    assert_eq!(before, snapshot(fixture.root())?);
    assert!(fixture.root().join(".local/noema/pending.json").exists());
    Ok(())
}

#[test]
fn context_and_check_are_read_only_with_explicit_query_scope_and_bootstrap() -> Result<()> {
    let fixture = Fixture::new()?;
    let empty_before = snapshot(fixture.root())?;
    fixture.json(&["check", "--json"])?;
    fixture.json(&["context", "--bootstrap", "--json"])?;
    assert_eq!(empty_before, snapshot(fixture.root())?);

    fixture.seed()?;
    let before = snapshot(fixture.root())?;
    let alias = fixture.json(&["context", "--query", "继续测试工作", "--json"])?;
    assert!(text(&alias)?.contains(OLD));
    let scope = fixture.root().join("corpus/projects/Test/records");
    let scoped = fixture.json(&[
        "context",
        "--cwd",
        scope.to_str().context("scope")?,
        "--json",
    ])?;
    assert!(text(&scoped)?.contains(OLD));
    let bootstrap = fixture.json(&["context", "--bootstrap", "--json"])?;
    assert!(text(&bootstrap)?.contains("Prefer brief explanations."));
    assert!(!text(&bootstrap)?.contains(OLD));
    let unrelated = fixture.json(&["context", "--query", "unmatched-zzzz-topic", "--json"])?;
    assert!(!text(&unrelated)?.contains(OLD));
    let no_task = fixture.json(&["context", "--json"])?;
    assert!(!text(&no_task)?.contains(OLD));
    let unknown = fixture.run(&["context", "--work", "work.absent", "--json"])?;
    assert!(!unknown.status.success());
    assert_eq!(before, snapshot(fixture.root())?);
    Ok(())
}

#[test]
fn output_budget_is_unicode_aware_and_omits_whole_claims() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut request = seed_request();
    let long = "可追溯的长期记忆。".repeat(120);
    request["pages"][0]["entries"][0]["text"] = json!(long);
    fixture.record(&request)?;
    let bounded = fixture.json(&[
        "context",
        "--work",
        "work.test",
        "--max-chars",
        "500",
        "--json",
    ])?;
    assert!(text(&bounded)?.chars().count() <= 500);
    assert!(!text(&bounded)?.contains("可追溯的长期记忆。"));
    assert!(
        !bounded["selected"]
            .as_array()
            .context("selected")?
            .contains(&json!("work.test#mode"))
    );
    Ok(())
}

#[test]
fn unsafe_paths_and_source_checkouts_are_never_written() -> Result<()> {
    let fixture = Fixture::new()?;
    for unsafe_path in [
        "../escaped.md",
        "/tmp/noema-escaped.md",
        "corpus/projects/Test/sources/records/unsafe.md",
        "noema/../corpus/projects/Test/records/unsafe.md",
    ] {
        let mut request = seed_request();
        request["path"] = json!(unsafe_path);
        fixture.reject_record(&request)?;
    }
    let nested = fixture.root().join("corpus/projects/Test/checkout");
    fs::create_dir_all(nested.join("records"))?;
    fs::write(nested.join(".git"), "gitdir: /irrelevant\n")?;
    let mut request = seed_request();
    request["path"] = json!("corpus/projects/Test/checkout/records/seed.md");
    fixture.reject_record(&request)?;
    assert!(!nested.join("records/seed.md").exists());
    Ok(())
}

#[cfg(unix)]
#[test]
fn symlinked_records_and_memory_paths_are_rejected() -> Result<()> {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new()?;
    let outside = tempfile::tempdir()?;
    fs::remove_dir(fixture.root().join("corpus/projects/Test/records"))?;
    symlink(
        outside.path(),
        fixture.root().join("corpus/projects/Test/records"),
    )?;
    fixture.reject_record(&seed_request())?;
    assert_eq!(fs::read_dir(outside.path())?.count(), 0);

    let fixture = Fixture::new()?;
    fs::remove_dir(fixture.root().join("noema/work"))?;
    symlink(outside.path(), fixture.root().join("noema/work"))?;
    fixture.reject_record(&seed_request())?;
    assert_eq!(fs::read_dir(outside.path())?.count(), 0);
    Ok(())
}

#[test]
fn independent_appends_preserve_current_entries() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    for id in ["first-append", "second-append"] {
        let source = format!("corpus/projects/Test/records/{id}.md");
        let request = json!({
            "id": id, "date": "2026-10-29", "path": source,
            "body": "# Evidence\n\n## Request\nAn independent observation.\n",
            "pages": [{"path": PAGE, "id": "work.test", "summary": "Test work.",
                "entries": [entry(id, "observed", "An independent observation.", &source)]}]
        });
        fixture.record(&request)?;
    }
    let context = fixture.context()?;
    let selected = context["selected"].as_array().context("selected entries")?;
    for id in [
        "mode",
        "dependent",
        "transitive",
        "first-append",
        "second-append",
    ] {
        assert!(selected.contains(&json!(format!("work.test#{id}"))), "{id}");
    }
    Ok(())
}

#[test]
fn a_source_record_does_not_require_memory() -> Result<()> {
    let fixture = Fixture::new()?;
    let request = json!({
        "id": "experiment", "date": "2026-10-29",
        "path": "corpus/projects/Test/records/experiment.md",
        "body": "# Experiment\n\n## Result\nThe run exposed a failure.\n"
    });
    let output = fixture.record(&request)?;
    assert_eq!(
        output["changed"],
        json!(["corpus/projects/Test/records/experiment.md"])
    );
    assert!(!fixture.root().join(PAGE).exists());
    assert_eq!(fixture.record(&request)?["already_recorded"], true);
    Ok(())
}

#[test]
fn memory_and_handoff_use_existing_evidence_without_new_records() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.record(&json!({
        "id": "original", "date": "2026-10-29",
        "path": "corpus/projects/Test/records/original.md",
        "body": "# User statement\n\n## Request\nKeep one current decision.\n\n## Handoff\nNext: inspect the reader.\n"
    }))?;
    let sources = fs::read(
        fixture
            .root()
            .join("corpus/projects/Test/records/original.md"),
    )?;
    let update = json!({
        "id": "remember", "date": "2026-10-29",
        "pages": [{"path": PAGE, "id": "work.test", "summary": "Current Test work.",
            "entries": [entry("decision", "explicit", "Keep one current decision.", "corpus/projects/Test/records/original.md")]}]
    });
    fixture.record(&update)?;
    fixture.record(&json!({
        "id": "handoff", "date": "2026-10-29",
        "pages": [{"path": PAGE, "id": "work.test", "resume": "corpus/projects/Test/records/original.md#handoff"}]
    }))?;
    assert!(text(&fixture.context()?)?.contains("Next: inspect the reader."));
    fixture.record(&json!({
        "id": "next", "date": "2026-10-29",
        "pages": [{"path": PAGE, "id": "work.test", "handoff": "Next: run the focused reproduction."}]
    }))?;
    let page = fs::read_to_string(fixture.root().join(PAGE))?;
    assert!(page.contains("Keep one current decision."));
    assert!(!page.contains("resume:"));
    fixture.record(&json!({
        "id": "clear-next", "date": "2026-10-29",
        "pages": [{"path": PAGE, "id": "work.test", "handoff": ""}]
    }))?;
    assert!(!fs::read_to_string(fixture.root().join(PAGE))?.contains("handoff:"));
    assert_eq!(
        fs::read_dir(fixture.root().join("corpus/projects/Test/records"))?.count(),
        1
    );
    assert_eq!(
        fs::read(
            fixture
                .root()
                .join("corpus/projects/Test/records/original.md")
        )?,
        sources
    );
    Ok(())
}

#[test]
fn a_handoff_can_start_work_without_inventing_a_memory_claim() -> Result<()> {
    let fixture = Fixture::new()?;
    let update = json!({
        "id": "continue", "date": "2026-10-29",
        "pages": [{"path": PAGE, "id": "work.test", "summary": "Current Test work.",
            "handoff": "Next: inspect the existing experiment output."}]
    });
    fixture.record(&update)?;
    let page = fs::read_to_string(fixture.root().join(PAGE))?;
    assert!(!page.contains("- Basis:"));
    assert_eq!(
        fs::read_dir(fixture.root().join("corpus/projects/Test/records"))?.count(),
        0
    );
    assert!(fixture.run(&["check", "--json"])?.status.success());
    Ok(())
}

#[test]
fn revising_current_memory_suspends_derived_claims_without_a_history_chain() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    let old_source = fs::read(fixture.root().join(SOURCE))?;
    fixture.record(&json!({
        "id": "correction", "date": "2026-10-29",
        "path": "corpus/projects/Test/records/correction.md",
        "body": "# User correction\n\n## Request\nThe current mode is beta.\n"
    }))?;
    fixture.record(&json!({
        "id": "refresh", "date": "2026-10-29",
        "pages": [{"path": PAGE, "id": "work.test",
            "entries": [entry("mode", "explicit", NEW, "corpus/projects/Test/records/correction.md")]}]
    }))?;
    let page = fs::read_to_string(fixture.root().join(PAGE))?;
    assert!(!page.contains(OLD));
    assert!(!page.contains("- Supersedes:"));
    assert!(!page.contains("resume:"));
    assert_eq!(page.matches("- Status: review").count(), 2);
    assert!(text(&fixture.context()?)?.contains(NEW));
    assert!(!text(&fixture.context()?)?.contains(DEPENDENT));
    assert_eq!(fs::read(fixture.root().join(SOURCE))?, old_source);
    fixture.record(&json!({
        "id": "prune", "date": "2026-10-29",
        "pages": [{"path": PAGE, "id": "work.test", "remove": ["dependent", "transitive"]}]
    }))?;
    assert_eq!(
        fs::read_to_string(fixture.root().join(PAGE))?
            .matches("## ")
            .count(),
        1
    );
    assert!(fixture.run(&["check", "--json"])?.status.success());
    Ok(())
}

#[test]
fn unchanged_memory_does_not_refresh_dates_or_publish_a_journal() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    let before = memory_and_sources(fixture.root())?;
    let modified = fs::metadata(fixture.root().join(PAGE))?.modified()?;
    let output = fixture.record(&json!({
        "id": "no-change", "date": "2026-10-29",
        "pages": [{"path": PAGE, "id": "work.test", "entries": [entry("mode", "observed", OLD, SOURCE)]}]
    }))?;
    assert_eq!(output["changed"], json!([]));
    assert_eq!(output["already_recorded"], true);
    assert_eq!(memory_and_sources(fixture.root())?, before);
    assert_eq!(
        fs::metadata(fixture.root().join(PAGE))?.modified()?,
        modified
    );
    assert!(!fixture.root().join(".local/noema/pending.json").exists());
    Ok(())
}

#[test]
fn a_new_experiment_record_is_independent_of_invalid_memory() -> Result<()> {
    let fixture = Fixture::new()?;
    fs::write(
        fixture.root().join(PAGE),
        "An unrelated unfinished memory edit.",
    )?;
    let request = json!({
        "id": "experiment", "date": "2026-10-29",
        "path": "corpus/projects/Test/records/experiment.md",
        "body": "# Experiment\n\n## Result\nThe run exposed a failure.\n"
    });
    fixture.record(&request)?;
    assert_eq!(fixture.record(&request)?["already_recorded"], true);
    assert_eq!(
        fs::read_to_string(fixture.root().join(PAGE))?,
        "An unrelated unfinished memory edit."
    );
    Ok(())
}

#[test]
fn a_premise_and_its_reviewed_derivation_can_be_refreshed_together() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.seed()?;
    let source = "corpus/projects/Test/records/beta.md";
    fixture.record(&json!({
        "id": "beta", "date": "2026-10-29", "path": source,
        "body": "# User correction\n\n## Request\nThe current mode is beta.\n"
    }))?;
    let mut derived = entry(
        "dependent",
        "inferred",
        "Use the beta-specific recovery path.",
        source,
    );
    derived["depends_on"] = json!(["work.test#mode"]);
    fixture.record(&json!({
        "id": "refresh-beta", "date": "2026-10-29",
        "pages": [{"path": PAGE, "id": "work.test", "entries": [entry("mode", "explicit", NEW, source), derived]}]
    }))?;
    let context = fixture.context()?;
    assert!(text(&context)?.contains(NEW));
    assert!(text(&context)?.contains("Use the beta-specific recovery path."));
    assert!(!text(&context)?.contains(TRANSITIVE));
    assert_eq!(
        fs::read_to_string(fixture.root().join(PAGE))?
            .matches("- Status: review")
            .count(),
        1
    );
    Ok(())
}
