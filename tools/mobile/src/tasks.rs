//! Three-way synchronization between daily-note tasks and one Reminders list.

use crate::journal;
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::{Duration, Instant},
};
use uuid::Uuid;

const FIELDS: [&str; 4] = ["title", "completed", "due_date", "priority"];
type Call<'a> = &'a mut dyn FnMut(&str, Value) -> Result<Value>;
type Key = (String, u64, String);
type Link = (String, Value, Option<Value>);

pub fn initialize(
    call: Call<'_>,
    current: Option<&Value>,
    account_id: Option<&str>,
) -> Result<Value> {
    if let Some(current) =
        current.filter(|value| value.as_object().is_some_and(|value| !value.is_empty()))
    {
        if let Some(account_id) = account_id {
            ensure!(
                current["account_id"] == account_id,
                "Preserve task identities before changing Reminders accounts."
            );
        }
        return call("setup", current.clone());
    }
    let probe = call("probe", json!({}))?;
    let candidates: Vec<_> = probe["accounts"]
        .as_array()
        .context("Invalid Reminders accounts")?
        .iter()
        .filter(|account| {
            account_id
                .map(|id| account["id"] == id)
                .unwrap_or(account["name"] == "iCloud")
        })
        .collect();
    ensure!(
        candidates.len() == 1,
        "Select the iCloud Reminders account with --account-id."
    );
    call("setup", json!({"account_id":candidates[0]["id"]}))
}

fn fields(item: &Value, remote: bool) -> Value {
    if !remote {
        return Value::Object(
            FIELDS
                .into_iter()
                .map(|name| (name.into(), item[name].clone()))
                .collect(),
        );
    }
    let priority = item["priority"].as_i64().unwrap_or(0);
    json!({"title":item["name"].as_str().unwrap_or_default().trim(),"completed":item["completed"],
        "due_date":item["due_date"],"priority":if (1..=4).contains(&priority) {1} else if priority >= 6 {9} else {0}})
}

pub fn merge(
    local: &Value,
    remote: &Value,
    before_local: &Value,
    before_remote: &Value,
) -> (Value, Vec<String>) {
    let mut combined = json!({});
    let mut conflicts = Vec::new();
    for name in FIELDS {
        let (left, right) = (&local[name], &remote[name]);
        let (left_changed, right_changed) =
            (left != &before_local[name], right != &before_remote[name]);
        if left != right
            && (before_local[name] != before_remote[name] || (left_changed && right_changed))
        {
            conflicts.push(name.into());
        }
        combined[name] = if right_changed {
            right.clone()
        } else {
            left.clone()
        };
    }
    (combined, conflicts)
}

fn string<'a>(item: &'a Value, name: &str) -> &'a str {
    item[name].as_str().unwrap_or_default()
}
fn block(item: &Value) -> &str {
    string(item, "block_id")
}
fn key(task: &Value) -> Key {
    (
        string(task, "path").into(),
        task["line"].as_u64().unwrap_or_default(),
        string(task, "raw").into(),
    )
}
fn managed_id(block: &str) -> Option<&str> {
    block.strip_prefix("noema-").filter(|id| {
        id.len() == 32
            && id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

/// Python SequenceMatcher's longest-contiguous-block algorithm, without junk.
/// Keeping its matching rule avoids guessing identity from ambiguous duplicate lines.
fn matching_blocks(old: &[&str], new: &[&str]) -> Vec<(usize, usize, usize)> {
    let mut positions: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, raw) in new.iter().enumerate() {
        positions.entry(raw).or_default().push(index);
    }
    let mut pending = vec![(0, old.len(), 0, new.len())];
    let mut blocks = Vec::new();
    while let Some((a, b, c, d)) = pending.pop() {
        let (mut best_a, mut best_c, mut best_size) = (a, c, 0);
        let mut lengths: HashMap<usize, usize> = HashMap::new();
        for (index, value) in old.iter().enumerate().take(b).skip(a) {
            let mut next = HashMap::new();
            for &other in positions.get(value).into_iter().flatten() {
                if other < c {
                    continue;
                }
                if other >= d {
                    break;
                }
                let size = if other == 0 {
                    1
                } else {
                    lengths.get(&(other - 1)).copied().unwrap_or(0) + 1
                };
                next.insert(other, size);
                if size > best_size {
                    (best_a, best_c, best_size) = (index + 1 - size, other + 1 - size, size);
                }
            }
            lengths = next;
        }
        if best_size > 0 {
            blocks.push((best_a, best_c, best_size));
            if a < best_a && c < best_c {
                pending.push((a, best_a, c, best_c));
            }
            if best_a + best_size < b && best_c + best_size < d {
                pending.push((best_a + best_size, b, best_c + best_size, d));
            }
        }
    }
    blocks.sort_unstable();
    let mut merged: Vec<(usize, usize, usize)> = Vec::new();
    for (a, c, size) in blocks {
        if let Some(last) = merged
            .last_mut()
            .filter(|last| last.0 + last.2 == a && last.1 + last.2 == c)
        {
            last.2 += size;
        } else {
            merged.push((a, c, size));
        }
    }
    merged.push((old.len(), new.len(), 0));
    merged
}

pub fn matches(previous: &[Value], current: &[Value]) -> HashMap<Key, Value> {
    let mut found = HashMap::new();
    let mut by_block: HashMap<&str, Vec<&Value>> = HashMap::new();
    let mut old_blocks: HashMap<(&str, &str), usize> = HashMap::new();
    let mut old_global: HashMap<&str, usize> = HashMap::new();
    for task in previous.iter().filter(|task| !block(task).is_empty()) {
        *old_blocks
            .entry((string(task, "path"), block(task)))
            .or_default() += 1;
        *old_global.entry(block(task)).or_default() += 1;
    }
    for task in current.iter().filter(|task| !block(task).is_empty()) {
        by_block.entry(block(task)).or_default().push(task);
    }
    for task in previous {
        let managed = managed_id(block(task)).is_some();
        let candidates: Vec<_> = by_block
            .get(block(task))
            .into_iter()
            .flatten()
            .copied()
            .filter(|item| managed || item["path"] == task["path"])
            .collect();
        let unique = if managed {
            old_global.get(block(task)) == Some(&1)
        } else {
            old_blocks.get(&(string(task, "path"), block(task))) == Some(&1)
        };
        if !block(task).is_empty() && candidates.len() == 1 && unique {
            found.insert(key(task), candidates[0].clone());
        }
    }
    let mut old_files: HashMap<&str, Vec<&Value>> = HashMap::new();
    let mut new_files: HashMap<&str, Vec<&Value>> = HashMap::new();
    for task in previous {
        old_files
            .entry(string(task, "path"))
            .or_default()
            .push(task);
    }
    for task in current {
        new_files
            .entry(string(task, "path"))
            .or_default()
            .push(task);
    }
    for (path, mut old) in old_files {
        let mut new = new_files.remove(path).unwrap_or_default();
        old.sort_by_key(|task| task["line"].as_u64());
        new.sort_by_key(|task| task["line"].as_u64());
        let old_raw: Vec<_> = old.iter().map(|task| string(task, "raw")).collect();
        let new_raw: Vec<_> = new.iter().map(|task| string(task, "raw")).collect();
        let mut old_counts = HashMap::new();
        let mut new_counts = HashMap::new();
        for value in &old_raw {
            *old_counts.entry(*value).or_insert(0) += 1;
        }
        for value in &new_raw {
            *new_counts.entry(*value).or_insert(0) += 1;
        }
        let (mut before_a, mut before_c) = (0, 0);
        for (a, c, size) in matching_blocks(&old_raw, &new_raw) {
            if a - before_a == 1 && c - before_c == 1 {
                let (left, right) = (old[before_a], new[before_c]);
                if block(left).is_empty()
                    && block(right).is_empty()
                    && left["recurring"] != true
                    && right["recurring"] != true
                    && left["line"] == right["line"]
                    && (before_a > 0 || a < old.len())
                {
                    found.insert(key(left), right.clone());
                }
            }
            for offset in 0..size {
                let (left, right) = (old[a + offset], new[c + offset]);
                if !block(left).is_empty() {
                    continue;
                }
                if old_raw == new_raw
                    || (old_counts.get(string(left, "raw")) == Some(&1)
                        && new_counts.get(string(right, "raw")) == Some(&1))
                {
                    found.insert(key(left), right.clone());
                }
            }
            (before_a, before_c) = (a + size, c + size);
        }
    }
    found
}

fn save(
    db: &Connection,
    id: &str,
    source: &Value,
    remote: Option<&Value>,
    issue: Option<&str>,
) -> Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO todo_links VALUES (?, ?, ?, ?)",
        params![
            id,
            serde_json::to_string(source)?,
            remote.map(serde_json::to_string).transpose()?,
            issue
        ],
    )?;
    Ok(())
}

fn read_links(db: &Connection) -> Result<Vec<Link>> {
    let mut statement = db.prepare("SELECT id,source,remote FROM todo_links ORDER BY rowid")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    rows.map(|row| {
        let (id, source, remote) = row?;
        Ok((
            id,
            serde_json::from_str(&source)?,
            remote
                .map(|value| serde_json::from_str(&value))
                .transpose()?,
        ))
    })
    .collect()
}

fn settings_payload(settings: &Value, extra: Value) -> Result<Value> {
    let mut payload = settings
        .as_object()
        .context("Invalid Reminders settings")?
        .clone();
    payload.extend(
        extra
            .as_object()
            .context("Invalid Reminders request")?
            .clone(),
    );
    Ok(Value::Object(payload))
}

fn task_array(snapshot: Value) -> Result<Vec<Value>> {
    Ok(snapshot["tasks"]
        .as_array()
        .context("Invalid journal snapshot")?
        .clone())
}

fn candidate(
    identity: &str,
    baseline: &Value,
    tasks: &[Value],
    mapping: &HashMap<Key, Value>,
) -> Option<Value> {
    let generated = format!("noema-{identity}");
    let anchor = if block(baseline).is_empty() {
        generated.as_str()
    } else {
        block(baseline)
    };
    let anchored: Vec<_> = tasks
        .iter()
        .filter(|task| {
            block(task) == anchor && (anchor == generated || task["path"] == baseline["path"])
        })
        .collect();
    if anchored.is_empty() {
        mapping
            .get(&key(baseline))
            .cloned()
            .or_else(|| matches(std::slice::from_ref(baseline), tasks).remove(&key(baseline)))
    } else if anchored.len() == 1 {
        Some(anchored[0].clone())
    } else {
        None
    }
}

#[derive(Debug)]
struct RemoteFailure(anyhow::Error);
impl std::fmt::Display for RemoteFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for RemoteFailure {}

pub fn sync_with_reminders(
    db: &Connection,
    root: &Path,
    settings: &Value,
    call: Call<'_>,
    reminders: &[Value],
) -> Result<Vec<String>> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS todo_links (id TEXT PRIMARY KEY,source TEXT NOT NULL,remote TEXT,issue TEXT);
        UPDATE OR IGNORE meta SET key='journal_snapshot' WHERE key='dashboard_snapshot';DELETE FROM meta WHERE key='dashboard_snapshot';")?;
    let mut tasks = task_array(journal::dispatch(root, "list", json!({}))?)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let saved: Option<String> = db
        .query_row(
            "SELECT value FROM meta WHERE key='journal_snapshot'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let previous: Vec<Value> = if let Some(saved) = saved {
        serde_json::from_str(&saved)?
    } else {
        db.execute(
            "INSERT INTO meta VALUES ('journal_snapshot', ?)",
            [serde_json::to_string(&tasks)?],
        )?;
        tasks.clone()
    };
    let mut issues: Vec<_> = reminders
        .iter()
        .filter(|item| {
            !item["blocked"].is_null() && item["blocked"] != false && item["blocked"] != ""
        })
        .map(|item| {
            format!(
                "Reminder requires review: {}.",
                item["blocked"].as_str().unwrap_or("blocked")
            )
        })
        .collect();
    let mut by_id: HashMap<String, Value> = reminders
        .iter()
        .map(|item| (string(item, "id").into(), item.clone()))
        .collect();
    let mut by_todo: HashMap<String, Value> = reminders
        .iter()
        .filter(|item| !string(item, "todo_id").is_empty() && !blocked(item))
        .map(|item| (string(item, "todo_id").into(), item.clone()))
        .collect();
    let links = read_links(db)?;
    let mut known: HashSet<_> = links.iter().map(|row| row.0.clone()).collect();
    for original in reminders {
        if Instant::now() >= deadline {
            return Ok(issues);
        }
        let mut item = original.clone();
        let mut identity = string(&item, "todo_id").to_owned();
        if blocked(&item) || item["kind"] == "task" || known.contains(&identity) {
            continue;
        }
        if identity.is_empty() && item["completed"] == true {
            continue;
        }
        if identity.is_empty() {
            if links.iter().any(|row| {
                row.2
                    .as_ref()
                    .is_some_and(|remote| remote["id"] == item["id"])
            }) {
                continue;
            }
            identity = Uuid::new_v4().simple().to_string();
            item = call(
                "sync_todo",
                settings_payload(
                    settings,
                    json!({"todo_id":identity,"reminder_id":item["id"],"expected":item}),
                )?,
            )?["reminder"]
                .clone();
            by_id.insert(string(&item, "id").into(), item.clone());
            by_todo.insert(identity.clone(), item.clone());
        }
        let anchor = format!("noema-{identity}");
        if !tasks.iter().any(|task| block(task) == anchor) {
            let mut payload = fields(&item, true);
            payload["todo_id"] = identity.clone().into();
            tasks = task_array(journal::dispatch(root, "capture", payload)?)?;
        }
        let candidates: Vec<_> = tasks.iter().filter(|task| block(task) == anchor).collect();
        if candidates.len() != 1 {
            issues.push(format!(
                "Todo {} has an ambiguous source block.",
                identity.chars().take(8).collect::<String>()
            ));
            continue;
        }
        save(db, &identity, candidates[0], Some(&item), None)?;
        known.insert(identity);
    }

    let links = read_links(db)?;
    let mut pending = Vec::new();
    let mut claimed_sources = HashSet::new();
    let initial_mapping = matches(&previous, &tasks);
    let mut owners = HashMap::new();
    for (identity, baseline, _) in &links {
        if let Some(task) = candidate(identity, baseline, &tasks, &initial_mapping) {
            *owners
                .entry((
                    string(&task, "path").to_owned(),
                    task["line"].as_u64().unwrap_or_default(),
                ))
                .or_insert(0) += 1;
        }
    }
    for (identity, baseline, old_remote) in links {
        if Instant::now() >= deadline {
            return Ok(issues);
        }
        let mapping = matches(&previous, &tasks);
        let local = candidate(&identity, &baseline, &tasks, &mapping);
        let remote = by_todo.get(&identity).cloned().or_else(|| {
            old_remote
                .as_ref()
                .and_then(|old| by_id.get(string(old, "id")))
                .cloned()
        });
        let mut issue = if local.is_none() {
            Some("Source missing or ambiguous; both copies were preserved.")
        } else if old_remote.is_some() && remote.is_none() {
            Some("Reminder deleted or moved; the Markdown task was preserved.")
        } else if remote.as_ref().is_some_and(|remote| {
            blocked(remote)
                || (!remote["kind"].is_null() && remote["kind"] != "todo")
                || (!string(remote, "todo_id").is_empty() && remote["todo_id"] != identity)
        }) {
            Some("Reminder identity requires review; both copies were preserved.")
        } else {
            None
        };
        if let Some(local) = &local {
            let path = string(local, "path");
            let line = local["line"].as_u64().unwrap_or_default();
            let mut identities = vec![(path.to_owned(), "line".to_owned(), line.to_string())];
            if !block(local).is_empty() {
                identities.push((path.to_owned(), "block".into(), block(local).into()));
            }
            if owners
                .get(&(path.to_owned(), line))
                .copied()
                .unwrap_or_default()
                > 1
                || identities.iter().any(|key| claimed_sources.contains(key))
            {
                issue =
                    Some("Multiple reminders claim the same source; both copies were preserved.");
            }
            claimed_sources.extend(identities);
        }
        let location = format!(
            "{}:{}",
            string(&baseline, "path"),
            baseline["line"].as_u64().unwrap_or_default() + 1
        );
        if let Some(issue) = issue {
            save(db, &identity, &baseline, old_remote.as_ref(), Some(issue))?;
            issues.push(format!("{location}: {issue}"));
            continue;
        }
        let result = (|| -> Result<()> {
            let mut local = local.context("Source missing")?;
            let mut canonical = fields(&local, false);
            let Some(mut remote) = remote else {
                save(db, &identity, &local, None, None)?;
                canonical["todo_id"] = identity.clone().into();
                pending.push(canonical);
                return Ok(());
            };
            let (combined, conflicts) = merge(
                &canonical,
                &fields(&remote, true),
                &fields(&baseline, false),
                &old_remote
                    .as_ref()
                    .map(|old| fields(old, true))
                    .unwrap_or_else(|| fields(&baseline, false)),
            );
            ensure!(
                conflicts.is_empty(),
                "Conflicting edits to {}; both copies were preserved.",
                conflicts.join(", ")
            );
            let changes: serde_json::Map<_, _> = FIELDS
                .into_iter()
                .filter(|name| canonical[*name] != combined[*name])
                .map(|name| (name.to_owned(), combined[name].clone()))
                .collect();
            if !changes.is_empty() {
                tasks = task_array(journal::dispatch(
                    root,
                    "update",
                    json!({"todo_id":identity,"task":local,"changes":changes}),
                )?)?;
                let generated = format!("noema-{identity}");
                let anchor = if block(&local).is_empty() {
                    generated.as_str()
                } else {
                    block(&local)
                };
                let edited: Vec<_> = tasks
                    .iter()
                    .filter(|task| {
                        block(task) == anchor
                            && (anchor == generated || task["path"] == local["path"])
                    })
                    .collect();
                ensure!(edited.len() == 1, "The edited task identity is ambiguous.");
                local = edited[0].clone();
                canonical = fields(&local, false);
            }
            let remote_fields = fields(&remote, true);
            let changes: serde_json::Map<_, _> = FIELDS
                .into_iter()
                .filter(|name| canonical[*name] != remote_fields[*name])
                .map(|name| (name.to_owned(), canonical[name].clone()))
                .collect();
            if !changes.is_empty() || remote["todo_id"] != identity {
                let mut payload = Value::Object(changes);
                payload["todo_id"] = identity.clone().into();
                payload["reminder_id"] = remote["id"].clone();
                payload["expected"] = remote.clone();
                remote = call("sync_todo", settings_payload(settings, payload)?)
                    .map_err(RemoteFailure)?["reminder"]
                    .clone();
                by_id.insert(string(&remote, "id").into(), remote.clone());
                by_todo.insert(identity.clone(), remote.clone());
            }
            save(db, &identity, &local, Some(&remote), None)
        })();
        if let Err(error) = result {
            let issue: String = error.to_string().chars().take(400).collect();
            save(db, &identity, &baseline, old_remote.as_ref(), Some(&issue))?;
            issues.push(format!("{location}: {issue}"));
            let fatal_remote = error.downcast_ref::<RemoteFailure>().is_some()
                && ![
                    "CONFLICT",
                    "REMINDER_NOT_FOUND",
                    "AMBIGUOUS_REMINDER",
                    "BLOCKED_REMINDER",
                ]
                .iter()
                .any(|code| issue.contains(code));
            if error.downcast_ref::<std::io::Error>().is_some()
                || error.downcast_ref::<rusqlite::Error>().is_some()
                || fatal_remote
            {
                return Err(error);
            }
        }
    }

    let links = read_links(db)?;
    let baselines: Vec<_> = links.iter().map(|row| row.1.clone()).collect();
    let mapping = matches(&baselines, &tasks);
    let claimed: HashSet<_> = mapping.values().map(key).collect();
    let held: Vec<_> = links
        .iter()
        .filter(|row| !mapping.contains_key(&key(&row.1)))
        .map(|row| &row.1)
        .collect();
    let held_paths: HashSet<_> = held.iter().map(|task| string(task, "path")).collect();
    for task in &tasks {
        if task["completed"] == true
            || claimed.contains(&key(task))
            || held_paths.contains(string(task, "path"))
        {
            continue;
        }
        let block_id = block(task);
        if held.iter().any(|old| {
            task["raw"] == old["raw"] || (!block_id.is_empty() && block_id == block(old))
        }) {
            issues.push(format!(
                "{}: Possible moved task requires review before creating another reminder.",
                string(task, "path")
            ));
            continue;
        }
        if !block_id.is_empty()
            && tasks
                .iter()
                .filter(|item| block(item) == block_id && item["path"] == task["path"])
                .count()
                > 1
        {
            issues.push(format!(
                "{}: Duplicate task block requires review.",
                string(task, "path")
            ));
            continue;
        }
        let identity = managed_id(block_id)
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().simple().to_string());
        if links.iter().any(|row| row.0 == identity) {
            issues.push(format!(
                "{}: Task identity is already linked elsewhere.",
                string(task, "path")
            ));
            continue;
        }
        save(db, &identity, task, None, None)?;
        let mut payload = fields(task, false);
        payload["todo_id"] = identity.into();
        pending.push(payload);
    }
    db.execute(
        "INSERT OR REPLACE INTO meta VALUES ('journal_snapshot', ?)",
        [serde_json::to_string(&tasks)?],
    )?;
    for batch in pending.chunks(15) {
        if Instant::now() >= deadline {
            return Ok(issues);
        }
        let response = call(
            "sync_todos",
            settings_payload(settings, json!({"todos":batch}))?,
        )?;
        let originals: HashMap<_, _> = read_links(db)?
            .into_iter()
            .map(|row| (row.0, row.1))
            .collect();
        for result in response["results"]
            .as_array()
            .context("Invalid reminder export result")?
        {
            let identity = string(result, "todo_id");
            let original = originals
                .get(identity)
                .context("Unexpected reminder export identity")?;
            if result["ok"] == true {
                save(db, identity, original, Some(&result["reminder"]), None)?;
            } else {
                let message = result["error"]["message"]
                    .as_str()
                    .unwrap_or("Reminder export failed.");
                save(db, identity, original, None, Some(message))?;
                issues.push(message.into());
            }
        }
    }
    Ok(issues)
}

fn blocked(item: &Value) -> bool {
    match &item["blocked"] {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
