use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

fn run(root: &Path, bytes: &[u8]) -> Result<Output> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_noema-hook"))
        .arg("--root")
        .arg(root)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().context("hook stdin")?.write_all(bytes)?;
    Ok(child.wait_with_output()?)
}

fn hook(root: &Path, event: Value) -> Result<String> {
    let event_name = event["hook_event_name"].clone();
    let value = hook_json(root, event)?;
    assert_eq!(value["hookSpecificOutput"]["hookEventName"], event_name);
    Ok(value["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .context("hook context")?
        .to_owned())
}

fn fixture() -> Result<TempDir> {
    let root = tempfile::tempdir()?;
    for area in ["profile", "work", "insights"] {
        fs::create_dir_all(root.path().join("noema").join(area))?;
    }
    fs::create_dir_all(root.path().join("corpus/records"))?;
    let source = "corpus/records/seed.md";
    let make_entry = |id: &str, text: &str| json!({"id":id,"basis":"explicit","as_of":"2026-10-28","text":text,"evidence":[{"path":source,"anchor":"request"}]});
    let request = json!({
        "id":"seed", "date":"2026-10-28", "path":source,
        "body":"# Seed\n\n## Request\nKeep concise notes. Alpha and Beta are separate projects.\n\n## Handoff\nNext: finish the reader.\n",
        "pages":[
            {"path":"noema/profile/preferences.md","id":"profile.preferences","summary":"Writing preferences.","entries":[make_entry("concise","Keep concise notes.")]},
            {"path":"noema/work/alpha.md","id":"work.alpha","summary":"Alpha project decisions.","aliases":["Alpha"],"resume":format!("{source}#handoff"),"entries":[make_entry("phase","Alpha uses the first execution path.")]},
            {"path":"noema/work/beta.md","id":"work.beta","summary":"Beta project decisions.","aliases":["Beta"],"entries":[make_entry("phase","Beta uses the second execution path.")]}
        ]
    });
    let input = root.path().join("seed.json");
    fs::write(&input, serde_json::to_vec(&request)?)?;
    let output = Command::new(env!("CARGO_BIN_EXE_noema"))
        .arg("--root")
        .arg(root.path())
        .arg("record")
        .arg(input)
        .output()?;
    ensure!(
        output.status.success(),
        "seed failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(root)
}

fn prompt(root: &Path, session: &str, text: &str) -> Value {
    json!({"hook_event_name":"UserPromptSubmit","session_id":session,"cwd":root,"prompt":text,"turn_id":"turn","future_host_field":true})
}

#[test]
fn startup_prompt_continuation_and_compaction_use_session_scoped_work() -> Result<()> {
    let root = fixture()?;
    let bootstrap = hook(
        root.path(),
        json!({"hook_event_name":"SessionStart","session_id":"one","cwd":root.path(),"source":"startup"}),
    )?;
    assert!(bootstrap.contains("Keep concise notes."));
    assert!(!bootstrap.contains("Alpha uses"));
    let selected = hook(root.path(), prompt(root.path(), "one", "Continue Alpha"))?;
    assert!(selected.contains("Alpha uses"));
    assert!(!selected.contains("Beta uses"));
    let resumed = hook(root.path(), prompt(root.path(), "one", "继续"))?;
    assert!(resumed.contains("Alpha uses"));
    for source in ["resume", "compact", "fork"] {
        let output = hook(
            root.path(),
            json!({"hook_event_name":"SessionStart","session_id":"one","cwd":root.path(),"source":source}),
        )?;
        assert!(output.contains("Keep concise notes."));
        assert!(output.contains("Alpha uses"));
        assert!(output.chars().count() <= 12_000);
    }
    let other = hook(root.path(), prompt(root.path(), "another", "continue"))?;
    assert!(!other.contains("Alpha uses"));
    Ok(())
}

#[test]
fn explicit_task_switches_and_unmatched_tasks_do_not_reuse_old_work() -> Result<()> {
    let root = fixture()?;
    hook(root.path(), prompt(root.path(), "one", "Alpha"))?;
    let switched = hook(root.path(), prompt(root.path(), "one", "Beta"))?;
    assert!(switched.contains("Beta uses"));
    assert!(!switched.contains("Alpha uses"));
    let next = hook(root.path(), prompt(root.path(), "one", "continue"))?;
    assert!(next.contains("Beta uses"));
    hook(
        root.path(),
        prompt(
            root.path(),
            "one",
            "Describe an unrelated astronomy subject",
        ),
    )?;
    let unrelated = hook(root.path(), prompt(root.path(), "one", "continue"))?;
    assert!(!unrelated.contains("Beta uses"));
    hook(
        root.path(),
        prompt(root.path(), "one", "Compare Alpha and Beta"),
    )?;
    let comparison = hook(root.path(), prompt(root.path(), "one", "continue"))?;
    assert!(!comparison.contains("Alpha uses") && !comparison.contains("Beta uses"));
    Ok(())
}

#[test]
fn adapter_rejects_invalid_events_and_oversized_or_non_utf8_input() -> Result<()> {
    let root = fixture()?;
    for bytes in [
        vec![b'x'; 65_537],
        vec![0xff],
        serde_json::to_vec(&json!({"hook_event_name":"Unknown","session_id":"one"}))?,
    ] {
        let output = run(root.path(), &bytes)?;
        assert!(!output.status.success());
        let warning: Value = serde_json::from_slice(&output.stdout)?;
        assert!(
            warning["systemMessage"]
                .as_str()
                .is_some_and(|text| text.contains("Noema"))
        );
    }
    Ok(())
}

#[test]
fn binding_cache_contains_only_work_ids_with_private_permissions() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let root = fixture()?;
    hook(
        root.path(),
        prompt(root.path(), "../../escaped-session", "Alpha"),
    )?;
    let file = root.path().join(".local/noema/sessions.json");
    let binding: Value = serde_json::from_slice(&fs::read(&file)?)?;
    assert_eq!(binding, json!({"../../escaped-session":"work.alpha"}));
    assert_eq!(fs::metadata(&file)?.permissions().mode() & 0o777, 0o600);
    fs::write(&file, r#"{"../../escaped-session":"../obsolete-cache-id"}"#)?;
    let refreshed = hook(
        root.path(),
        prompt(root.path(), "../../escaped-session", "Alpha"),
    )?;
    assert!(refreshed.contains("Alpha uses"));
    Ok(())
}

#[test]
fn adapter_refuses_symlinked_private_state_without_external_writes() -> Result<()> {
    use std::os::unix::fs::symlink;
    let root = fixture()?;
    let outside = tempfile::tempdir()?;
    fs::create_dir_all(root.path().join(".local/noema"))?;
    symlink(
        outside.path(),
        root.path().join(".local/noema/sessions.json"),
    )?;
    let output = run(
        root.path(),
        &serde_json::to_vec(&prompt(root.path(), "one", "Alpha"))?,
    )?;
    assert!(!output.status.success());
    assert_eq!(fs::read_dir(outside.path())?.count(), 0);
    Ok(())
}

#[test]
fn quoted_context_stays_bounded_when_json_escaping_expands_memory() -> Result<()> {
    let root = fixture()?;
    let text = format!("Untrusted note: {}", "\u{0001}".repeat(3000));
    let page = root.path().join("noema/work/alpha.md");
    let original = fs::read_to_string(&page)?;
    let altered = original.replace("Alpha uses the first execution path.", &text);
    fs::write(page, altered)?;
    let output = run(
        root.path(),
        &serde_json::to_vec(&prompt(root.path(), "one", "Alpha"))?,
    )?;
    ensure!(
        output.status.success(),
        "hook failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout)?;
    let context = value["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .context("hook context")?;
    assert!(context.chars().count() <= 12_000);
    assert!(!context.contains('\u{0001}'));
    assert!(context.contains("memory_context"));
    Ok(())
}

fn hook_json(root: &Path, event: Value) -> Result<Value> {
    let output = run(root, &serde_json::to_vec(&event)?)?;
    ensure!(
        output.status.success(),
        "hook failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[test]
fn recall_creates_no_review_tasks_and_close_events_are_noops() -> Result<()> {
    let root = fixture()?;
    let page = root.path().join("noema/work/alpha.md");
    let source = root.path().join("corpus/records/seed.md");
    let before_page = fs::read(&page)?;
    let before_source = fs::read(&source)?;
    let prompt_text = "Alpha: a temporary question that must not be stored.";
    hook(root.path(), prompt(root.path(), "one", prompt_text))?;
    let bindings = root.path().join(".local/noema/sessions.json");
    let before_bindings = fs::read(&bindings)?;
    let modified = fs::metadata(&bindings)?.modified()?;
    hook(root.path(), prompt(root.path(), "one", "Alpha"))?;
    assert_eq!(fs::metadata(&bindings)?.modified()?, modified);
    for event in ["Stop", "SessionEnd"] {
        assert_eq!(
            hook_json(
                root.path(),
                json!({"hook_event_name":event,"session_id":"one"})
            )?,
            json!({})
        );
    }
    assert_eq!(fs::read(page)?, before_page);
    assert_eq!(fs::read(source)?, before_source);
    assert_eq!(fs::read(&bindings)?, before_bindings);
    assert!(!fs::read_to_string(bindings)?.contains(prompt_text));
    assert_eq!(fs::read_dir(root.path().join(".local/noema"))?.count(), 1);
    Ok(())
}
