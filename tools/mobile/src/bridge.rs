//! Notes hold conversations; daily tasks sync independently.

use crate::macos::{events, notes, reminders};
use crate::{Event, agent, state, tasks, util};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use state::{Bindings, Paths};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

fn shortened(value: impl AsRef<str>) -> String {
    value.as_ref().chars().take(1000).collect()
}

fn receipt(body: &str) -> String {
    util::digest(
        notes::plain(body)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
    )
}
struct Running {
    note_id: String,
    version: String,
    thread: JoinHandle<()>,
}

pub struct Bridge {
    paths: Paths,
    bindings: Bindings,
    db: Connection,
    sender: Sender<Event>,
    receiver: Receiver<Event>,
    running: Option<Running>,
    stopping: Arc<AtomicBool>,
}

impl Bridge {
    pub fn new(paths: Paths, bindings: Bindings, db: Connection) -> Result<Self> {
        bindings.validate()?;
        let (sender, receiver) = mpsc::channel();
        Ok(Self {
            paths,
            bindings,
            db,
            sender,
            receiver,
            running: None,
            stopping: Arc::new(AtomicBool::new(false)),
        })
    }

    fn problem(&self, key: &str, error: impl AsRef<str>) -> Result<()> {
        let message = shortened(error);
        if state::meta(&self.db, key)?.as_deref() != Some(&message) {
            eprintln!("{} {key}: {message}", util::now());
        }
        state::set_meta(&self.db, key, &message)
    }

    fn finish(&self, row: &state::Request, transcript: &str) -> Result<()> {
        self.db.execute(
            "UPDATE requests SET status=?,request='',answer=NULL,delivery_hash=NULL,checkpoint=?,updated=? WHERE note_id=? AND version=?",
            params![
                if row.error.is_some() {
                    "failed"
                } else {
                    "answered"
                },
                serde_json::to_string(&state::Checkpoint::new(transcript))?,
                util::now(),
                row.note_id,
                row.version
            ],
        )?;
        Ok(())
    }

    fn sync_notes(&mut self) -> Result<Option<Duration>> {
        let listing = notes::call("list", Some(&self.bindings.account_id), json!({}))?;
        state::set_meta(&self.db, "last_contact", &util::now())?;
        let mut available = Vec::new();
        for note in listing["notes"].as_array().context("Missing Noema notes")? {
            if !note["blocked"].is_null() {
                continue;
            }
            let id = note["id"].as_str().context("Missing Notes identity")?;
            let body = note["body"].as_str().context("Missing Notes body")?;
            let request = notes::plain(body);
            let mut row = state::request(&self.db, id)?;
            if let Some(previous) = &row
                && let Some(hash) = &previous.delivery_hash
                && let Some(answer) = &previous.answer
            {
                let delivered =
                    notes::with_answer(&notes::html_note("", &previous.request), answer);
                let transcript = notes::plain(&delivered);
                if hash == &receipt(&delivered)
                    && state::Checkpoint::new(&transcript)
                        .followup(&request)
                        .is_some()
                {
                    // Recover an uncertain write even if a follow-up has already arrived.
                    self.finish(previous, &transcript)?;
                    row = state::request(&self.db, id)?;
                }
            }
            // Upgrade existing single-answer notes without replaying their old question.
            if let Some(row) = &row
                && matches!(row.status.as_str(), "answered" | "failed")
                && row.checkpoint.is_none()
            {
                self.finish(row, &request)?;
                continue;
            }
            if row.as_ref().is_some_and(|row| {
                matches!(row.status.as_str(), "answered" | "failed") && row.delivery_hash.is_some()
            }) {
                continue;
            }
            let latest = match row.as_ref().and_then(|row| row.checkpoint.as_ref()) {
                Some(checkpoint) => checkpoint.followup(&request),
                None => Some(request.clone()),
            };
            let version = util::digest(&request);
            if latest.as_deref().is_none_or(|text| text.trim().is_empty()) {
                if let Some(row) = &row
                    && !matches!(row.status.as_str(), "answered" | "failed")
                    && row.version != version
                {
                    if self.running.as_ref().is_some_and(|run| run.note_id == id) {
                        agent::cancel_running();
                    }
                    self.db.execute("UPDATE requests SET status='answered',request='',answer=NULL,delivery_hash=NULL,error=NULL,updated=? WHERE note_id=?",params![util::now(),id])?;
                }
                continue;
            }
            if row.as_ref().is_none_or(|row| {
                row.version != version || matches!(row.status.as_str(), "answered" | "failed")
            }) {
                // An uncertain write may have succeeded. Preserve subsequent edits rather than append twice.
                if row.as_ref().is_some_and(|row| row.delivery_hash.is_some()) {
                    self.db.execute("UPDATE requests SET status='failed',error='The note changed during answer delivery; its contents were preserved.',updated=? WHERE note_id=?", params![util::now(),id])?;
                    continue;
                }
                state::observe(&self.db, id, &request, &version)?;
                if self.running.as_ref().is_some_and(|run| run.note_id == id) {
                    agent::cancel_running();
                }
            }
            let row = state::request(&self.db, id)?.context("Missing request")?;
            if row.status == "ready" {
                let answer = row.answer.as_deref().context("Missing answer")?;
                let delivered = notes::with_answer(body, answer);
                self.db.execute(
                    "UPDATE requests SET delivery_hash=? WHERE note_id=?",
                    params![receipt(&delivered), id],
                )?;
                match notes::call(
                    "answer",
                    Some(&self.bindings.account_id),
                    json!({"note_id":id,"expected_body":body,"answer":answer}),
                ) {
                    Ok(_) => self.finish(&row, &notes::plain(&delivered))?,
                    Err(error) => {
                        if error.to_string().contains("Notes CONFLICT") {
                            self.db.execute(
                                "UPDATE requests SET delivery_hash=NULL WHERE note_id=?",
                                [id],
                            )?;
                        }
                        return Err(error);
                    }
                }
            } else if row.status == "pending" {
                available.push(row);
            }
        }
        let wait = available
            .iter()
            .map(|row| {
                Duration::from_secs_f64(
                    (row.observed_at + noema_config::get().mobile.settle_seconds as f64
                        - state::epoch())
                    .max(1.0),
                )
            })
            .min();
        if self.running.is_none()
            && !self.stopping.load(Ordering::SeqCst)
            && let Some(row) = available.into_iter().find(|row| {
                state::epoch() - row.observed_at >= noema_config::get().mobile.settle_seconds as f64
            })
        {
            let note_id = row.note_id;
            let version = row.version;
            let latest = row
                .checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.followup(&row.request))
                .unwrap_or_else(|| Some(row.request.clone()))
                .context("The pending question no longer follows the answered conversation")?;
            let repo = self.paths.repo.clone();
            let sender = self.sender.clone();
            let id = note_id.clone();
            let revision = version.clone();
            self.db.execute(
                "UPDATE requests SET status='running',updated=? WHERE note_id=?",
                params![util::now(), note_id],
            )?;
            match thread::Builder::new()
                .name("personal-agent".into())
                .spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        agent::answer(&row.request, &latest, &repo)
                    }))
                    .map_err(|_| "The personal agent stopped unexpectedly".to_owned())
                    .and_then(|result| result.map_err(|error| shortened(error.to_string())));
                    let _ = sender.send(Event::Completed {
                        note_id: id,
                        version: revision,
                        result,
                    });
                }) {
                Ok(thread) => {
                    self.running = Some(Running {
                        note_id,
                        version,
                        thread,
                    })
                }
                Err(error) => {
                    self.db.execute(
                        "UPDATE requests SET status='pending' WHERE note_id=?",
                        [&note_id],
                    )?;
                    return Err(error.into());
                }
            }
        }
        Ok(if self.running.is_none() { wait } else { None })
    }

    fn sync_tasks(&self) -> Result<()> {
        let Some(bindings) = &self.bindings.reminders else {
            return Ok(());
        };
        let result = match reminders::call("list", bindings.clone()) {
            Ok(result) => {
                state::clear_meta(&self.db, "reminders_error")?;
                result
            }
            Err(error) => return self.problem("reminders_error", error.to_string()),
        };
        state::set_meta(&self.db, "reminders_last_contact", &util::now())?;
        let mut call = |op: &str, payload: Value| {
            ensure!(
                !self.stopping.load(Ordering::SeqCst),
                "The bridge is stopping"
            );
            reminders::call(op, payload)
        };
        let issues = tasks::sync_with_reminders(
            &self.db,
            &self.paths.repo,
            bindings,
            &mut call,
            result["reminders"]
                .as_array()
                .context("Invalid Reminders list")?,
        )?;
        state::set_meta(&self.db, "todos_last_contact", &util::now())?;
        if issues.is_empty() {
            state::clear_meta(&self.db, "todos_error")
        } else {
            self.problem("todos_error", issues.join(" "))
        }
    }

    fn receive(&mut self, event: Event, notes_due: &mut bool, tasks_due: &mut bool) -> Result<()> {
        match event {
            Event::Todos => *tasks_due = true,
            Event::Stop => self.stopping.store(true, Ordering::SeqCst),
            Event::Completed {
                note_id,
                version,
                result,
            } => {
                if self
                    .running
                    .as_ref()
                    .is_some_and(|run| run.note_id == note_id && run.version == version)
                    && let Some(run) = self.running.take()
                {
                    let _ = run.thread.join();
                }
                let (answer, error) = match result {
                    Ok(answer) => (answer, None),
                    Err(error) => (
                        format!(
                            "Unable to answer: {error}\n\nAppend your question again to retry."
                        ),
                        Some(error),
                    ),
                };
                self.db.execute("UPDATE requests SET status='ready',answer=?,error=?,updated=? WHERE note_id=? AND version=? AND status='running'", params![answer,error,util::now(),note_id,version])?;
                *notes_due = true;
            }
        }
        Ok(())
    }

    fn run_loop(&mut self) -> Result<()> {
        let journal = match events::watch(&self.paths.repo, self.sender.clone()) {
            Ok(watch) => {
                state::set_meta(&self.db, "journal_events", "active")?;
                Some(watch)
            }
            Err(error) => {
                self.problem("journal_events", error.to_string())?;
                None
            }
        };
        let reminders = if self.bindings.reminders.is_some() {
            match reminders::observe(self.sender.clone()) {
                Ok(watch) => {
                    state::set_meta(&self.db, "reminders_events", "active")?;
                    Some(watch)
                }
                Err(error) => {
                    self.problem("reminders_events", error.to_string())?;
                    None
                }
            }
        } else {
            None
        };
        let mut next_notes = Instant::now();
        let mut next_tasks = Instant::now();
        let (mut notes_due, mut tasks_due) = (false, false);
        while !self.stopping.load(Ordering::SeqCst) {
            while let Ok(event) = self.receiver.try_recv() {
                self.receive(event, &mut notes_due, &mut tasks_due)?;
            }
            if self.stopping.load(Ordering::SeqCst) {
                break;
            }
            if let Some(error) = journal.as_ref().and_then(events::Watcher::error) {
                self.problem("journal_events", error)?;
            }
            if let Some(error) = reminders.as_ref().and_then(reminders::Observer::error) {
                self.problem("reminders_events", error)?;
            }
            let now = Instant::now();
            if tasks_due || now >= next_tasks {
                tasks_due = false;
                next_tasks =
                    now + Duration::from_secs(noema_config::get().mobile.reconcile_seconds);
                if let Err(error) = self.sync_tasks() {
                    self.problem("todos_error", error.to_string())?;
                }
            }
            if self.stopping.load(Ordering::SeqCst) {
                break;
            }
            if notes_due || now >= next_notes {
                notes_due = false;
                next_notes = Instant::now()
                    + Duration::from_secs(noema_config::get().mobile.notes_poll_seconds);
                match self.sync_notes() {
                    Ok(wait) => {
                        state::clear_meta(&self.db, "notes_error")?;
                        if let Some(wait) = wait {
                            next_notes = next_notes.min(Instant::now() + wait);
                        }
                    }
                    Err(error) => self.problem("notes_error", error.to_string())?,
                }
            }
            let wait = next_notes
                .min(next_tasks)
                .saturating_duration_since(Instant::now());
            match self.receiver.recv_timeout(wait) {
                Ok(event) => self.receive(event, &mut notes_due, &mut tasks_due)?,
                Err(mpsc::RecvTimeoutError::Timeout) => (),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        Ok(())
    }

    pub fn run(&mut self) -> Result<()> {
        self.db.execute(
            "UPDATE requests SET status='pending' WHERE status='running'",
            [],
        )?;
        let mut signals = signal_hook::iterator::Signals::new([libc::SIGTERM, libc::SIGINT])?;
        let handle = signals.handle();
        let sender = self.sender.clone();
        let stopping = Arc::clone(&self.stopping);
        let listener = thread::spawn(move || {
            if signals.forever().next().is_some() {
                stopping.store(true, Ordering::SeqCst);
                agent::shutdown();
                notes::cancel_running();
                reminders::cancel_running();
                util::cancel_running();
                let _ = sender.send(Event::Stop);
            }
        });
        let result = self.run_loop();
        self.stopping.store(true, Ordering::SeqCst);
        handle.close();
        let _ = listener.join();
        agent::shutdown();
        notes::cancel_running();
        reminders::cancel_running();
        util::cancel_running();
        if let Some(run) = self.running.take() {
            let _ = run.thread.join();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Result<(tempfile::TempDir, Bridge)> {
        let root = tempfile::tempdir()?;
        std::fs::create_dir_all(root.path().join("tools/mobile"))?;
        std::fs::create_dir(root.path().join("corpus"))?;
        std::fs::write(root.path().join("tools/mobile/Cargo.toml"), "")?;
        let paths = Paths::new(root.path())?;
        let db = paths.database()?;
        let bridge = Bridge::new(
            paths,
            Bindings {
                account_id: "fixture".into(),
                reminders: None,
            },
            db,
        )?;
        Ok((root, bridge))
    }

    #[test]
    fn stale_answer_cannot_replace_an_edited_request() -> Result<()> {
        let (_root, mut bridge) = fixture()?;
        state::observe(&bridge.db, "note", "first question", "old")?;
        bridge
            .db
            .execute("UPDATE requests SET status='running'", [])?;
        state::observe(&bridge.db, "note", "edited question", "new")?;
        bridge.receive(
            Event::Completed {
                note_id: "note".into(),
                version: "old".into(),
                result: Ok("outdated answer".into()),
            },
            &mut false,
            &mut false,
        )?;
        let row = state::request(&bridge.db, "note")?.context("request")?;
        assert_eq!(row.request, "edited question");
        assert_eq!(row.status, "pending");
        assert!(row.answer.is_none());
        Ok(())
    }

    #[test]
    fn conversation_continues_without_storing_duplicate_history() -> Result<()> {
        let (_root, bridge) = fixture()?;
        state::observe(&bridge.db, "note", "question", "version")?;
        bridge.db.execute(
            "UPDATE requests SET status='ready',answer='answer',delivery_hash='receipt'",
            [],
        )?;
        let row = state::request(&bridge.db, "note")?.context("request")?;
        bridge.finish(&row, "question\nNoema\nanswer")?;
        let row = state::request(&bridge.db, "note")?.context("request")?;
        assert_eq!(row.status, "answered");
        assert!(row.request.is_empty() && row.answer.is_none() && row.delivery_hash.is_none());
        let checkpoint = row.checkpoint.context("answered checkpoint")?;
        assert_eq!(
            checkpoint.followup("question\nNoema\nanswer"),
            Some(String::new())
        );
        assert_eq!(
            checkpoint.followup("question\nNoema\nanswer\nWhy?"),
            Some("Why?".into())
        );
        let conversation = "question\nNoema\nanswer\nWhy?";
        state::observe(&bridge.db, "note", conversation, "second turn")?;
        // The same note can continue after restarting the worker.
        let reopened = bridge.paths.database()?;
        let second = state::request(&reopened, "note")?.context("follow-up")?;
        assert_eq!(second.request, conversation);
        assert_eq!(
            second
                .checkpoint
                .context("preserved checkpoint")?
                .followup(conversation),
            Some("Why?".into())
        );
        bridge
            .db
            .execute("UPDATE requests SET status='ready',answer='because'", [])?;
        let second = state::request(&bridge.db, "note")?.context("second answer")?;
        let completed = format!("{conversation}\nNoema\nbecause");
        bridge.finish(&second, &completed)?;
        let second = state::request(&reopened, "note")?.context("completed turn")?;
        assert_eq!(
            second
                .checkpoint
                .context("second checkpoint")?
                .followup(&completed),
            Some(String::new())
        );
        assert!(second.request.is_empty() && second.answer.is_none());
        assert_eq!(state::requests(&bridge.db)?.len(), 1);
        Ok(())
    }
}
