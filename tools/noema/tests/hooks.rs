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
        serde_json::to_vec(&json!({"hook_event_name":"Stop","session_id":"one"}))?,
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
    let folder = root.path().join(".local/noema/sessions");
    let files = fs::read_dir(folder)?.collect::<std::io::Result<Vec<_>>>()?;
    assert_eq!(files.len(), 1);
    let file = files[0].path();
    let binding: Value = serde_json::from_slice(&fs::read(&file)?)?;
    assert_eq!(binding, json!({"work":"work.alpha"}));
    assert_eq!(fs::metadata(file)?.permissions().mode() & 0o777, 0o600);
    Ok(())
}

#[test]
fn adapter_refuses_symlinked_private_state_without_external_writes() -> Result<()> {
    use std::os::unix::fs::symlink;
    let root = fixture()?;
    let outside = tempfile::tempdir()?;
    fs::create_dir_all(root.path().join(".local/noema"))?;
    symlink(outside.path(), root.path().join(".local/noema/sessions"))?;
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

fn control(root: &Path, args: &[&str]) -> Result<Value> {
    let output = Command::new(env!("CARGO_BIN_EXE_noema"))
        .arg("--root")
        .arg(root)
        .arg("consolidation")
        .args(args)
        .arg("--json")
        .output()?;
    ensure!(
        output.status.success(),
        "control failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn review_prompt(root: &Path, session: &str, turn: &str, text: &str) -> Value {
    json!({"hook_event_name":"UserPromptSubmit","session_id":session,"turn_id":turn,"cwd":root,"prompt":text,"transcript_path":root.join("rollout.jsonl")})
}

fn stop_event(session: &str, turn: &str, active: bool) -> Value {
    json!({"hook_event_name":"Stop","session_id":session,"turn_id":turn,"stop_hook_active":active})
}

fn pending_count(root: &Path) -> Result<usize> {
    Ok(control(root, &[])?["pending"]
        .as_array()
        .context("pending reviews")?
        .len())
}

fn pending_token(status: &Value, index: usize) -> Result<String> {
    status["pending"][index]["token"]
        .as_str()
        .map(str::to_owned)
        .context("pending token")
}

#[test]
fn automatic_review_is_once_per_turn_and_acknowledgement_prevents_reentry() -> Result<()> {
    let root = fixture()?;
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "first", "Alpha"),
    )?;
    let token = pending_token(&control(root.path(), &[])?, 0)?;
    let first = hook_json(root.path(), stop_event("one", "first", false))?;
    assert_eq!(first["decision"], "block");
    assert!(
        first["reason"]
            .as_str()
            .is_some_and(|text| text.contains(&token))
    );
    assert_eq!(
        hook_json(root.path(), stop_event("one", "first", false))?,
        json!({})
    );
    assert_eq!(
        hook_json(root.path(), stop_event("one", "first", true))?,
        json!({})
    );
    control(root.path(), &["--complete", &token, "--outcome", "skipped"])?;
    assert_eq!(pending_count(root.path())?, 0);
    assert_eq!(
        hook_json(root.path(), stop_event("one", "first", false))?,
        json!({})
    );
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "first", "Alpha"),
    )?;
    assert_eq!(
        hook_json(root.path(), stop_event("one", "first", false))?,
        json!({})
    );
    Ok(())
}

#[test]
fn proactive_completion_and_manual_mode_skip_automatic_review() -> Result<()> {
    let root = fixture()?;
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "first", "Alpha"),
    )?;
    let token = pending_token(&control(root.path(), &[])?, 0)?;
    control(root.path(), &["--complete", &token, "--outcome", "saved"])?;
    assert_eq!(
        hook_json(root.path(), stop_event("one", "first", false))?,
        json!({})
    );
    assert_eq!(
        control(root.path(), &["--mode", "manual"])?["mode"],
        "manual"
    );
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "second", "Alpha"),
    )?;
    assert_eq!(
        hook_json(root.path(), stop_event("one", "second", false))?,
        json!({})
    );
    assert_eq!(pending_count(root.path())?, 0);
    hook_json(
        root.path(),
        json!({"hook_event_name":"SessionEnd","session_id":"one","transcript_path":root.path().join("rollout.jsonl")}),
    )?;
    assert_eq!(pending_count(root.path())?, 0);
    Ok(())
}

#[test]
fn in_flight_reviews_survive_new_turns_and_other_sessions() -> Result<()> {
    let root = fixture()?;
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "first", "Alpha"),
    )?;
    let token = pending_token(&control(root.path(), &[])?, 0)?;
    hook_json(root.path(), stop_event("one", "first", false))?;
    hook_json(
        root.path(),
        review_prompt(
            root.path(),
            "one",
            "continued",
            "automatic review continuation",
        ),
    )?;
    hook_json(
        root.path(),
        review_prompt(root.path(), "two", "first", "Beta"),
    )?;
    assert_eq!(pending_count(root.path())?, 3);
    control(root.path(), &["--complete", &token, "--outcome", "skipped"])?;
    assert_eq!(pending_count(root.path())?, 2);
    assert_eq!(
        hook_json(root.path(), stop_event("one", "continued", true))?,
        json!({})
    );
    assert_eq!(
        hook_json(root.path(), stop_event("two", "first", false))?["decision"],
        "block"
    );
    Ok(())
}

#[test]
fn closing_defers_unfinished_reviews_and_startup_surfaces_original_pointers() -> Result<()> {
    let root = fixture()?;
    hook_json(
        root.path(),
        review_prompt(root.path(), "closed", "unfinished", "Alpha"),
    )?;
    let token = pending_token(&control(root.path(), &[])?, 0)?;
    let transcript = root.path().join("finished-rollout.jsonl");
    assert_eq!(
        hook_json(
            root.path(),
            json!({"hook_event_name":"SessionEnd","session_id":"closed","transcript_path":transcript,"reason":"other"})
        )?,
        json!({})
    );
    let status = control(root.path(), &[])?;
    assert_eq!(status["pending"][0]["deferred"], true);
    assert_eq!(status["pending"][0]["transcript_path"], json!(transcript));
    let startup = hook_json(
        root.path(),
        json!({"hook_event_name":"SessionStart","session_id":"new","source":"startup"}),
    )?;
    let text = startup["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .context("startup context")?;
    assert!(text.contains(&token));
    assert!(text.contains("finished-rollout.jsonl"));
    assert!(text.chars().count() <= 12_000);
    control(root.path(), &["--complete", &token, "--outcome", "skipped"])?;
    hook_json(
        root.path(),
        json!({"hook_event_name":"SessionEnd","session_id":"closed"}),
    )?;
    assert_eq!(pending_count(root.path())?, 0);
    Ok(())
}

#[test]
fn lifecycle_metadata_never_publishes_memory_or_caches_conversation_text() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let root = fixture()?;
    let page = root.path().join("noema/work/alpha.md");
    let record = root.path().join("corpus/records/seed.md");
    let before_page = fs::read(&page)?;
    let before_record = fs::read(&record)?;
    let secret = "private prompt never cache this value";
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "first", secret),
    )?;
    hook_json(root.path(), stop_event("one", "first", false))?;
    let token = pending_token(&control(root.path(), &[])?, 0)?;
    control(root.path(), &["--complete", &token, "--outcome", "skipped"])?;
    assert_eq!(fs::read(page)?, before_page);
    assert_eq!(fs::read(record)?, before_record);
    for file in fs::read_dir(root.path().join(".local/noema/consolidation/requests"))? {
        let path = file?.path();
        assert!(!fs::read_to_string(&path)?.contains(secret));
        assert_eq!(fs::metadata(path)?.permissions().mode() & 0o777, 0o600);
    }
    Ok(())
}

#[test]
fn failed_saved_checks_and_invalid_completions_leave_pending() -> Result<()> {
    let root = fixture()?;
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "first", "Alpha"),
    )?;
    let token = pending_token(&control(root.path(), &[])?, 0)?;
    fs::write(
        root.path().join("noema/work/broken.md"),
        "not a memory page",
    )?;
    for candidate in [
        token.as_str(),
        "../../outside",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_noema"))
            .arg("--root")
            .arg(root.path())
            .args([
                "consolidation",
                "--complete",
                candidate,
                "--outcome",
                "saved",
                "--json",
            ])
            .output()?;
        assert!(!output.status.success());
    }
    assert_eq!(pending_count(root.path())?, 1);
    Ok(())
}

#[test]
fn consolidation_state_refuses_symlinks_and_oversized_settings() -> Result<()> {
    use std::os::unix::fs::symlink;
    let root = fixture()?;
    let outside = tempfile::tempdir()?;
    fs::create_dir_all(root.path().join(".local/noema"))?;
    symlink(
        outside.path(),
        root.path().join(".local/noema/consolidation"),
    )?;
    let output = run(
        root.path(),
        &serde_json::to_vec(&review_prompt(root.path(), "one", "first", "Alpha"))?,
    )?;
    assert!(!output.status.success());
    assert_eq!(fs::read_dir(outside.path())?.count(), 0);
    fs::remove_file(root.path().join(".local/noema/consolidation"))?;
    fs::create_dir_all(root.path().join(".local/noema/consolidation"))?;
    fs::write(
        root.path().join(".local/noema/consolidation/settings.json"),
        vec![b' '; 8193],
    )?;
    assert!(
        !run(
            root.path(),
            &serde_json::to_vec(&review_prompt(root.path(), "one", "first", "Alpha"))?
        )?
        .status
        .success()
    );
    Ok(())
}

#[test]
fn lifecycle_writes_are_serialized_with_memory_operations() -> Result<()> {
    use fs2::FileExt;
    let root = fixture()?;
    let guard = fs::File::open(root.path().join("noema"))?;
    FileExt::lock_shared(&guard)?;
    assert_eq!(
        hook_json(root.path(), stop_event("one", "first", true))?,
        json!({})
    );
    let output = run(
        root.path(),
        &serde_json::to_vec(&review_prompt(root.path(), "one", "first", "Alpha"))?,
    )?;
    assert!(!output.status.success());
    assert!(!root.path().join(".local/noema/consolidation").exists());
    FileExt::unlock(&guard)?;
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "first", "Alpha"),
    )?;
    let token = pending_token(&control(root.path(), &[])?, 0)?;
    FileExt::lock_shared(&guard)?;
    let output = Command::new(env!("CARGO_BIN_EXE_noema"))
        .arg("--root")
        .arg(root.path())
        .args([
            "consolidation",
            "--complete",
            &token,
            "--outcome",
            "skipped",
        ])
        .output()?;
    assert!(!output.status.success());
    FileExt::unlock(&guard)?;
    assert_eq!(pending_count(root.path())?, 1);
    Ok(())
}

#[test]
fn deferred_pointer_details_remain_bounded_and_are_never_read_as_transcripts() -> Result<()> {
    let root = fixture()?;
    let transcript = format!("/{}", "\"".repeat(2000));
    for turn in ["one", "two", "three", "four"] {
        let mut event = review_prompt(root.path(), "closed", turn, "Alpha");
        event["transcript_path"] = json!(transcript);
        hook_json(root.path(), event)?;
    }
    hook_json(
        root.path(),
        json!({"hook_event_name":"SessionEnd","session_id":"closed"}),
    )?;
    let output = hook_json(
        root.path(),
        json!({"hook_event_name":"SessionStart","session_id":"new","source":"startup"}),
    )?;
    let text = output["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .context("startup context")?;
    assert!(text.chars().count() <= 12_000);
    assert_eq!(pending_count(root.path())?, 4);
    Ok(())
}

#[test]
fn read_only_consolidation_status_creates_no_private_state() -> Result<()> {
    let root = fixture()?;
    assert!(!root.path().join(".local/noema/consolidation").exists());
    assert_eq!(control(root.path(), &[])?["mode"], "auto");
    assert!(!root.path().join(".local/noema/consolidation").exists());
    Ok(())
}

#[test]
fn capacity_reclaims_completed_receipts_without_discarding_in_flight_reviews() -> Result<()> {
    use noema_memory::model::digest;
    for preserve_pending in [false, true] {
        let root = fixture()?;
        if preserve_pending {
            hook_json(
                root.path(),
                review_prompt(root.path(), "active", "first", "Alpha"),
            )?;
        }
        let directory = root.path().join(".local/noema/consolidation/requests");
        fs::create_dir_all(&directory)?;
        let session = digest(b"completed-session");
        for index in 0..(4096 - usize::from(preserve_pending)) {
            let turn = digest(index.to_string().as_bytes());
            let token = digest(format!("{session}:{turn}").as_bytes());
            let review = json!({"token":token,"session":session,"turn":turn,"transcript_path":null,"work":null,"requested":true,"deferred":false,"outcome":"skipped"});
            fs::write(
                directory.join(format!("{token}.json")),
                serde_json::to_vec(&review)?,
            )?;
        }
        assert_eq!(pending_count(root.path())?, usize::from(preserve_pending));
        hook_json(
            root.path(),
            review_prompt(root.path(), "new", "first", "Beta"),
        )?;
        assert_eq!(
            pending_count(root.path())?,
            1 + usize::from(preserve_pending)
        );
        assert_eq!(
            fs::read_dir(directory)?.count(),
            1 + usize::from(preserve_pending)
        );
    }
    Ok(())
}

#[test]
fn session_end_does_not_wait_for_a_memory_publication_lock() -> Result<()> {
    use fs2::FileExt;
    let root = fixture()?;
    hook_json(
        root.path(),
        review_prompt(root.path(), "closed", "first", "Alpha"),
    )?;
    let guard = fs::File::open(root.path().join("noema"))?;
    FileExt::lock_exclusive(&guard)?;
    assert_eq!(
        hook_json(
            root.path(),
            json!({"hook_event_name":"SessionEnd","session_id":"closed"})
        )?,
        json!({})
    );
    FileExt::unlock(&guard)?;
    assert_eq!(control(root.path(), &[])?["pending"][0]["deferred"], true);
    Ok(())
}

#[test]
fn lifecycle_private_lock_retries_short_contention() -> Result<()> {
    use fs2::FileExt;
    use std::{thread, time::Duration};
    let root = fixture()?;
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "first", "Alpha"),
    )?;
    let guard = fs::File::open(root.path().join(".local/noema/consolidation"))?;
    FileExt::lock_exclusive(&guard)?;
    let release = thread::spawn(move || {
        thread::sleep(Duration::from_millis(150));
        drop(guard);
    });
    let output = hook_json(root.path(), stop_event("one", "first", false))?;
    release
        .join()
        .map_err(|_| anyhow::anyhow!("lock release thread failed"))?;
    assert_eq!(output["decision"], "block");
    Ok(())
}

#[test]
fn resume_recovers_unacknowledged_work_without_taking_over_other_live_sessions() -> Result<()> {
    let root = fixture()?;
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "first", "Alpha"),
    )?;
    let token = pending_token(&control(root.path(), &[])?, 0)?;
    for (session, source, included) in [
        ("one", "resume", true),
        ("one", "compact", false),
        ("another", "startup", false),
    ] {
        let output = hook_json(
            root.path(),
            json!({"hook_event_name":"SessionStart","session_id":session,"source":source}),
        )?;
        let text = output["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .context("startup context")?;
        assert_eq!(text.contains(&token), included);
    }
    Ok(())
}

#[test]
fn interrupted_staging_files_do_not_poison_requests_but_invalid_requests_are_rejected() -> Result<()>
{
    let root = fixture()?;
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "first", "Alpha"),
    )?;
    let directory = root.path().join(".local/noema/consolidation");
    let orphan = directory.join(".tmp-interrupted");
    fs::write(&orphan, "{partial write")?;
    assert_eq!(pending_count(root.path())?, 1);
    hook_json(
        root.path(),
        review_prompt(root.path(), "one", "second", "Alpha"),
    )?;
    assert_eq!(pending_count(root.path())?, 2);
    assert_eq!(fs::read_to_string(orphan)?, "{partial write");

    fs::write(directory.join("requests/.tmp-invalid"), "{partial write")?;
    let output = Command::new(env!("CARGO_BIN_EXE_noema"))
        .arg("--root")
        .arg(root.path())
        .args(["consolidation", "--json"])
        .output()?;
    assert!(!output.status.success());
    let output = run(
        root.path(),
        &serde_json::to_vec(&review_prompt(root.path(), "one", "third", "Alpha"))?,
    )?;
    assert!(!output.status.success());
    Ok(())
}
