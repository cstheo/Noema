//! Direct EventKit access to the pinned, personal Noema list.

use anyhow::{Context, Result, bail, ensure};
use block2::RcBlock;
use chrono::{Datelike, NaiveDate};
use objc2::{
    rc::{Retained, autoreleasepool},
    runtime::{AnyObject, Bool, ProtocolObject},
};
use objc2_event_kit::*;
use objc2_foundation::{
    NSArray, NSCopying, NSDateComponents, NSError, NSNotification, NSNotificationCenter,
    NSObjectProtocol, NSString,
};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Sender},
    },
    time::Duration,
};

static STOPPING: AtomicBool = AtomicBool::new(false);
const MAX_BODY: usize = 1024 * 1024;
const EDITABLE: [&str; 7] = [
    "name",
    "body",
    "completed",
    "priority",
    "due_date",
    "due_time",
    "due_timezone",
];

pub fn cancel_running() {
    STOPPING.store(true, Ordering::SeqCst);
}
fn active() -> Result<()> {
    ensure!(
        !STOPPING.load(Ordering::SeqCst),
        "Reminders CANCELLED: service is stopping"
    );
    Ok(())
}
fn authorized() -> bool {
    unsafe {
        EKEventStore::authorizationStatusForEntityType(EKEntityType::Reminder)
            == EKAuthorizationStatus::FullAccess
    }
}
fn require_access() -> Result<()> {
    ensure!(
        authorized(),
        "Reminders AUTHORIZATION_REQUIRED: grant Noema access in System Settings > Privacy & Security > Reminders, or run init-reminders"
    );
    active()
}
fn string<'a>(value: &'a Value, key: &str, max: usize, empty: bool) -> Result<&'a str> {
    let text = value[key]
        .as_str()
        .with_context(|| format!("Invalid {key}"))?;
    ensure!(
        (empty || !text.is_empty()) && text.chars().count() <= max && !text.contains('\0'),
        "Invalid {key}"
    );
    Ok(text)
}
fn day(value: &Value) -> Result<NaiveDate> {
    let text = value.as_str().context("Invalid due date")?;
    let date = NaiveDate::parse_from_str(text, "%Y-%m-%d")?;
    ensure!(
        date.year() > 0 && text.len() == 10 && date.to_string() == text,
        "Invalid due date"
    );
    Ok(date)
}
fn same(left: &Value, right: &Value) -> bool {
    EDITABLE.iter().all(|key| left[*key] == right[*key])
}

fn authorize() -> Result<Value> {
    active()?;
    if !authorized() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let completion = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let detail = unsafe { error.as_ref() }.map(|e| e.to_string());
            let _ = sender.send((granted.as_bool(), detail));
        });
        unsafe {
            let store = EKEventStore::new();
            store.requestFullAccessToRemindersWithCompletion(RcBlock::as_ptr(&completion));
            let (granted, error) = receiver.recv_timeout(Duration::from_secs(45)).context(
                "Respond to the Noema Reminders permission prompt, then retry init-reminders",
            )?;
            ensure!(
                granted && authorized(),
                "Reminders access was not granted: {}",
                error.unwrap_or_default()
            );
        }
    }
    Ok(json!({"ok":true,"authorized":true}))
}

struct Marker {
    kind: String,
    id: String,
    start: usize,
    end: usize,
}
fn marker(body: &str) -> Result<Option<Marker>> {
    let pattern = Regex::new(r"(?m)^\[Noema (task ([0-9a-f]{12})|todo ([0-9a-f]{32}))\]\r?$")?;
    let ending = Regex::new(r"(?m)^\[/Noema\]\r?$")?;
    let starts = pattern.captures_iter(body).collect::<Vec<_>>();
    let ends = ending.find_iter(body).collect::<Vec<_>>();
    if starts.is_empty() && ends.is_empty() {
        ensure!(
            !body.contains("[Noema ") && !body.contains("[/Noema]"),
            "invalid_marker"
        );
        return Ok(None);
    }
    ensure!(starts.len() == 1 && ends.len() == 1, "invalid_marker");
    let found = starts[0].get(0).context("Invalid marker")?;
    ensure!(found.start() < ends[0].start(), "invalid_marker");
    let outside = format!("{}{}", &body[..found.start()], &body[ends[0].end()..]);
    ensure!(
        !outside.contains("[Noema ") && !outside.contains("[/Noema]"),
        "invalid_marker"
    );
    let (kind, id) = if let Some(id) = starts[0].get(2) {
        ("task", id.as_str())
    } else {
        (
            "todo",
            starts[0].get(3).context("Invalid todo marker")?.as_str(),
        )
    };
    Ok(Some(Marker {
        kind: kind.into(),
        id: id.into(),
        start: found.start(),
        end: ends[0].end(),
    }))
}

fn snapshot(reminder: &EKReminder) -> Value {
    // All values are copied before leaving the EventKit callback's thread.
    unsafe {
        let mut value = json!({"id":reminder.calendarItemIdentifier().to_string(),"name":reminder.title().to_string(),
            "completed":reminder.isCompleted(),"priority":reminder.priority(),"kind":null,"task_id":null,"todo_id":null,
            "due_date":null,"due_time":null,"due_timezone":null,"modified_at":reminder.lastModifiedDate().and_then(|d|chrono::DateTime::from_timestamp_millis((d.timeIntervalSince1970()*1000.0) as i64)).map(|date|date.to_rfc3339())});
        let title = value["name"].as_str().unwrap_or_default();
        if title.chars().count() > 4096 || title.contains('\0') {
            value["blocked"] = "invalid_title".into();
            return value;
        }
        if let Some(parts) = reminder.dueDateComponents() {
            let date = format!(
                "{:04}-{:02}-{:02}",
                parts.year(),
                parts.month(),
                parts.day()
            );
            if day(&json!(date)).is_err() {
                value["blocked"] = "invalid_due_date".into();
            } else {
                value["due_date"] = date.into();
            }
            if (0..24).contains(&parts.hour()) && (0..60).contains(&parts.minute()) {
                value["due_time"] = format!(
                    "{:02}:{:02}:{:02}",
                    parts.hour(),
                    parts.minute(),
                    if (0..60).contains(&parts.second()) {
                        parts.second()
                    } else {
                        0
                    }
                )
                .into();
            }
            value["due_timezone"] = json!(parts.timeZone().map(|zone| zone.name().to_string()));
        }
        let body = reminder.notes().map(|s| s.to_string()).unwrap_or_default();
        if body.chars().count() > MAX_BODY || body.contains('\0') {
            value["blocked"] = "invalid_body".into();
            return value;
        }
        value["body"] = body.clone().into();
        match marker(&body) {
            Err(_) => value["blocked"] = "invalid_marker".into(),
            Ok(None) => value["user_body"] = body.into(),
            Ok(Some(block)) => {
                value["kind"] = block.kind.clone().into();
                value[format!("{}_id", block.kind)] = block.id.into();
                value["user_body"] =
                    format!("{}{}", &body[..block.start], &body[block.end..]).into();
            }
        }
        value
    }
}

fn fetch(store: &EKEventStore, list: &EKCalendar) -> Result<Vec<Value>> {
    require_access()?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let completion = RcBlock::new(move |items: *mut NSArray<EKReminder>| {
        let result = autoreleasepool(|_| unsafe {
            items
                .as_ref()
                .map(|items| items.iter().map(|item| snapshot(&item)).collect::<Vec<_>>())
        });
        let _ = sender.send(result);
    });
    let request = unsafe {
        let calendars = NSArray::from_slice(&[list]);
        let predicate = store.predicateForRemindersInCalendars(Some(&calendars));
        store.fetchRemindersMatchingPredicate_completion(&predicate, &completion)
    };
    // Bounded active operation only; the idle worker waits on notifications.
    let deadline = std::time::Instant::now() + Duration::from_secs(12);
    let mut values = loop {
        if let Err(error) = active() {
            unsafe {
                store.cancelFetchRequest(&request);
            }
            return Err(error);
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(values) => break values.context("Reminders FETCH_FAILED: no snapshot returned")?,
            Err(mpsc::RecvTimeoutError::Timeout) if std::time::Instant::now() < deadline => (),
            _ => {
                unsafe {
                    store.cancelFetchRequest(&request);
                }
                bail!("Reminders FETCH_TIMEOUT");
            }
        }
    };
    ensure!(values.len() <= 10_000, "Reminders LIST_TOO_LARGE");
    let mut counts = HashMap::new();
    for value in &values {
        if !value["kind"].is_null() {
            *counts
                .entry((
                    value["kind"].clone().to_string(),
                    value["todo_id"].clone().to_string(),
                    value["task_id"].clone().to_string(),
                ))
                .or_insert(0) += 1;
        }
    }
    for value in &mut values {
        if counts
            .get(&(
                value["kind"].to_string(),
                value["todo_id"].to_string(),
                value["task_id"].to_string(),
            ))
            .is_some_and(|count| *count > 1)
        {
            value["blocked"] = "duplicate_marker".into();
        }
    }
    Ok(values)
}

fn calendar(store: &EKEventStore, input: &Value, create: bool) -> Result<Retained<EKCalendar>> {
    let id = string(input, "account_id", 2048, false)?;
    unsafe {
        let accounts = store
            .sources()
            .iter()
            .filter(|source| source.sourceIdentifier().to_string() == id)
            .collect::<Vec<_>>();
        ensure!(accounts.len() == 1, "Reminders ACCOUNT_NOT_FOUND");
        let account = &accounts[0];
        ensure!(
            account.title().to_string() == "iCloud"
                && [EKSourceType::CalDAV, EKSourceType::MobileMe].contains(&account.sourceType())
                && !account.isDelegate(),
            "Reminders UNSUPPORTED_ACCOUNT: select personal iCloud"
        );
        let lists = store
            .calendarsForEntityType(EKEntityType::Reminder)
            .iter()
            .filter(|list| {
                list.source()
                    .is_some_and(|source| source.sourceIdentifier().to_string() == id)
            })
            .collect::<Vec<_>>();
        let matches = lists
            .into_iter()
            .filter(|list| {
                input["list_id"].as_str().map_or(
                    list.title().to_string() == noema_config::get().mobile.reminders_list,
                    |pinned| list.calendarIdentifier().to_string() == pinned,
                )
            })
            .collect::<Vec<_>>();
        ensure!(matches.len() <= 1, "Reminders AMBIGUOUS_LIST");
        if let Some(list) = matches.into_iter().next() {
            ensure!(
                list.title().to_string() == noema_config::get().mobile.reminders_list
                    && list.allowedEntityTypes().contains(EKEntityMask::Reminder),
                "Reminders LIST_CHANGED"
            );
            ensure!(
                list.allowsContentModifications() && !list.isSubscribed(),
                "Reminders READ_ONLY_LIST"
            );
            return Ok(list);
        }
        ensure!(
            create && input["list_id"].is_null(),
            "Reminders LIST_NOT_FOUND: preserve the pinned list and account"
        );
        let list = EKCalendar::calendarForEntityType_eventStore(EKEntityType::Reminder, store);
        list.setTitle(&NSString::from_str(
            &noema_config::get().mobile.reminders_list,
        ));
        list.setSource(Some(account));
        store
            .saveCalendar_commit_error(&list, true)
            .map_err(|e| anyhow::anyhow!("Reminders SAVE_FAILED: {e}"))?;
        Ok(list)
    }
}

fn sync_todo(store: &EKEventStore, list: &EKCalendar, input: &Value) -> Result<Value> {
    let id = string(input, "todo_id", 32, false)?;
    ensure!(
        id.len() == 32
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid todo identity"
    );
    if input.get("title").is_some() {
        let title = string(input, "title", 4096, false)?;
        ensure!(!title.chars().any(char::is_control), "Invalid todo title");
    }
    if let Some(completed) = input.get("completed") {
        ensure!(completed.is_boolean(), "Invalid completion");
    }
    if let Some(priority) = input.get("priority") {
        ensure!(
            priority.as_u64().is_some_and(|p| p <= 9),
            "Invalid priority"
        );
    }
    if !input["due_date"].is_null() {
        day(&input["due_date"])?;
    }
    if input.get("user_body").is_some() {
        let body = string(input, "user_body", MAX_BODY - 64 * 1024, true)?;
        ensure!(
            !body.contains("[Noema ") && !body.contains("[/Noema]"),
            "Invalid user body"
        );
    }
    let entries = fetch(store, list)?;
    let marked = entries
        .iter()
        .filter(|v| v["todo_id"] == id)
        .collect::<Vec<_>>();
    ensure!(
        marked.len() <= 1
            && !entries.iter().any(|v| v["blocked"] == "invalid_marker"
                && v["body"]
                    .as_str()
                    .is_some_and(|b| b.contains(&format!("[Noema todo {id}")))),
        "Reminders AMBIGUOUS_REMINDER"
    );
    let selected = if let Some(pinned) = input["reminder_id"].as_str() {
        let found = entries
            .iter()
            .find(|v| v["id"] == pinned)
            .context("Reminders REMINDER_NOT_FOUND")?;
        ensure!(
            marked.first().is_none_or(|v| v["id"] == pinned),
            "Reminders AMBIGUOUS_REMINDER"
        );
        Some(found)
    } else {
        marked.first().copied()
    };
    let block = format!("[Noema todo {id}]\n[/Noema]");
    let created = selected.is_none();
    unsafe {
        let reminder = if let Some(before) = selected {
            ensure!(before["blocked"].is_null(), "Reminders BLOCKED_REMINDER");
            ensure!(
                before["kind"].is_null() || (before["kind"] == "todo" && before["todo_id"] == id),
                "Reminders REMINDER_CLAIMED"
            );
            let item = store
                .calendarItemWithIdentifier(&NSString::from_str(
                    before["id"].as_str().context("Missing reminder id")?,
                ))
                .context("Reminders REMINDER_NOT_FOUND")?;
            item.downcast::<EKReminder>()
                .map_err(|_| anyhow::anyhow!("Reminders REMINDER_NOT_FOUND"))?
        } else {
            ensure!(input["expected"].is_null(), "Reminders REMINDER_NOT_FOUND");
            string(input, "title", 4096, false)?;
            ensure!(
                !entries.iter().any(|v| ["invalid_body", "invalid_title"]
                    .iter()
                    .any(|blocked| v["blocked"] == *blocked)),
                "Reminders BLOCKED_LIST"
            );
            let reminder = EKReminder::reminderWithEventStore(store);
            reminder.setCalendar(Some(list));
            reminder
        };
        let before = selected.cloned().unwrap_or_else(
            || json!({"body":"","name":null,"completed":false,"priority":0,"due_date":null}),
        );
        let old_body = before["body"].as_str().unwrap_or_default();
        let body = if let Some(user) = input["user_body"].as_str() {
            format!(
                "{user}{}{block}",
                if user.is_empty() || user.ends_with('\n') {
                    ""
                } else {
                    "\n\n"
                }
            )
        } else if before["todo_id"] == id {
            old_body.to_owned()
        } else {
            format!(
                "{old_body}{}{block}",
                if old_body.is_empty() { "" } else { "\n\n" }
            )
        };
        ensure!(
            body.chars().count() <= MAX_BODY,
            "Updated reminder body is too large"
        );
        let changed = created
            || body != old_body
            || [
                ("title", "name"),
                ("completed", "completed"),
                ("priority", "priority"),
                ("due_date", "due_date"),
            ]
            .iter()
            .any(|(from, to)| input.get(*from).is_some_and(|v| v != &before[*to]));
        if changed && !created {
            let expected = input
                .get("expected")
                .context("Reminders CONFLICT: previous snapshot required")?;
            ensure!(same(&before, expected), "Reminders CONFLICT: todo changed");
            ensure!(
                reminder.refresh()
                    && reminder
                        .calendar()
                        .is_some_and(|c| c.calendarIdentifier() == list.calendarIdentifier()),
                "Reminders REMINDER_NOT_FOUND"
            );
            let refreshed = snapshot(&reminder);
            ensure!(
                refreshed["blocked"].is_null() && same(&refreshed, expected),
                "Reminders CONFLICT: todo changed before update"
            );
        }
        if changed {
            active()?;
            if body != old_body || created {
                reminder.setNotes(Some(&NSString::from_str(&body)));
            }
            if let Some(title) = input["title"].as_str()
                && (created || input["title"] != before["name"])
            {
                reminder.setTitle(Some(&NSString::from_str(title)));
            }
            if let Some(completed) = input["completed"].as_bool()
                && (created || input["completed"] != before["completed"])
            {
                reminder.setCompleted(completed);
            }
            if let Some(priority) = input["priority"].as_u64()
                && (created || input["priority"] != before["priority"])
            {
                reminder.setPriority(priority as usize);
            }
            if let Some(due) = input.get("due_date")
                && due != &before["due_date"]
            {
                if due.is_null() {
                    reminder.setDueDateComponents(None);
                } else {
                    let date = day(due)?;
                    let parts = reminder
                        .dueDateComponents()
                        .map(|parts| parts.copy())
                        .unwrap_or_else(NSDateComponents::new);
                    parts.setYear(date.year() as isize);
                    parts.setMonth(date.month() as isize);
                    parts.setDay(date.day() as isize);
                    reminder.setDueDateComponents(Some(&parts));
                }
            }
            store
                .saveReminder_commit_error(&reminder, true)
                .map_err(|e| anyhow::anyhow!("Reminders SAVE_FAILED: {e}"))?;
        }
        let result = if created {
            let matches = fetch(store, list)?
                .into_iter()
                .filter(|v| v["todo_id"] == id)
                .collect::<Vec<_>>();
            ensure!(matches.len() == 1, "Reminders CREATE_UNCERTAIN");
            matches[0].clone()
        } else {
            snapshot(&reminder)
        };
        Ok(json!({"ok":true,"todo_id":id,"created":created,"changed":changed,"reminder":result}))
    }
}

pub fn call(op: &str, input: Value) -> Result<Value> {
    autoreleasepool(|_| {
        active()?;
        if op == "authorize" {
            return authorize();
        }
        if op == "probe" && !authorized() {
            return Ok(json!({"ok":true,"authorized":false,"accounts":[]}));
        }
        require_access()?;
        unsafe {
            let store = EKEventStore::new();
            if op == "probe" {
                let accounts=store.sources().iter().map(|source|json!({"id":source.sourceIdentifier().to_string(),"name":source.title().to_string(),"source_type":source.sourceType().0,"delegated":source.isDelegate()})).collect::<Vec<_>>();
                return Ok(json!({"ok":true,"authorized":true,"accounts":accounts}));
            }
            ensure!(
                op == "setup" || input["list_id"].is_string(),
                "A pinned list_id is required"
            );
            let list = calendar(&store, &input, op == "setup")?;
            let base = json!({"ok":true,"account_id":input["account_id"],"list_id":list.calendarIdentifier().to_string(),"sharing_checked":false});
            match op {
                "setup" => Ok(base),
                "list" => {
                    let mut result = base;
                    result["reminders"] = json!(fetch(&store, &list)?);
                    Ok(result)
                }
                "sync_todo" => sync_todo(&store, &list, &input),
                "sync_todos" => {
                    let updates = input["todos"].as_array().context("Expected todo updates")?;
                    ensure!(updates.len() <= 200, "Too many todo updates");
                    let results=updates.iter().map(|todo|sync_todo(&store,&list,todo).unwrap_or_else(|error|json!({"ok":false,"todo_id":todo["todo_id"],"error":{"code":"REMINDERS_ERROR","message":error.to_string()}}))).collect::<Vec<_>>();
                    Ok(json!({"ok":true,"results":results}))
                }
                _ => bail!("Unknown Reminders operation"),
            }
        }
    })
}

pub struct Observer {
    _store: Retained<EKEventStore>,
    token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    center: Retained<NSNotificationCenter>,
}
impl Observer {
    pub fn error(&self) -> Option<String> {
        (!authorized()).then(|| "Reminders authorization was revoked".into())
    }
}
impl Drop for Observer {
    fn drop(&mut self) {
        unsafe {
            self.center
                .removeObserver(AsRef::<AnyObject>::as_ref(&*self.token));
        }
    }
}

pub fn observe(sender: Sender<crate::Event>) -> Result<Observer> {
    // Request from the background application's own macOS privacy identity.
    // A terminal's permission does not automatically authorize a LaunchAgent.
    authorize()?;
    unsafe {
        let store = EKEventStore::new();
        let center = NSNotificationCenter::defaultCenter();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            let _ = sender.send(crate::Event::Todos);
        });
        let token = center.addObserverForName_object_queue_usingBlock(
            Some(EKEventStoreChangedNotification),
            Some(&store),
            None,
            &block,
        );
        store.calendarsForEntityType(EKEntityType::Reminder);
        Ok(Observer {
            _store: store,
            token,
            center,
        })
    }
}
