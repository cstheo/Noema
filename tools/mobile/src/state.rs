use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

use crate::util;

pub const BINDINGS_FILE: &str = "bindings.json";

#[derive(Clone)]
pub struct Paths {
    pub repo: PathBuf,
    pub local: PathBuf,
}

impl Paths {
    pub fn new(repo: &Path) -> Result<Self> {
        let repo = repo.canonicalize()?;
        let source = repo.join(noema_config::MOBILE_DIR);
        ensure!(
            source.join("Cargo.toml").is_file() && repo.join("corpus").is_dir(),
            "Select a Noema repository with --repo"
        );
        let local = source.join(".local");
        util::no_symlinks(&local)?;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&local)?;
        fs::set_permissions(&local, fs::Permissions::from_mode(0o700))?;
        Ok(Self { repo, local })
    }

    pub fn bindings(&self) -> Result<Bindings> {
        let path = self.local.join(BINDINGS_FILE);
        util::no_symlinks(&path)?;
        let bindings: Bindings =
            serde_json::from_slice(&fs::read(path).context("Run noema-mobile init first")?)?;
        bindings.validate()?;
        Ok(bindings)
    }

    pub fn save_bindings(&self, bindings: &Bindings) -> Result<()> {
        bindings.validate()?;
        util::private_write(
            &self.local.join(BINDINGS_FILE),
            &serde_json::to_vec_pretty(bindings)?,
        )
    }

    pub fn database(&self) -> Result<Connection> {
        let path = self.local.join("tasks.sqlite3");
        util::no_symlinks(&path)?;
        let db = Connection::open(&path)?;
        db.busy_timeout(Duration::from_secs(10))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS requests (
                note_id TEXT PRIMARY KEY, request TEXT NOT NULL, version TEXT NOT NULL,
                observed_at REAL NOT NULL, status TEXT NOT NULL, answer TEXT,
                delivery TEXT, error TEXT, updated TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS todo_links (id TEXT PRIMARY KEY,source TEXT NOT NULL,remote TEXT,issue TEXT);",
        )?;
        let columns = db
            .prepare("PRAGMA table_info(requests)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for column in ["checkpoint", "delivery"] {
            if !columns.iter().any(|name| name == column) {
                db.execute(
                    &format!("ALTER TABLE requests ADD COLUMN {column} TEXT"),
                    [],
                )?;
            }
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(db)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Bindings {
    pub account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminders: Option<Value>,
}

impl Bindings {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.account_id.is_empty(),
            "The selected Notes account is missing"
        );
        if let Some(selected) = &self.reminders {
            let values = selected
                .as_object()
                .context("Invalid Reminders selection")?;
            ensure!(
                values.len() == 2
                    && ["account_id", "list_id"].iter().all(|key| values
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|v| !v.is_empty() && v.len() <= 2048)),
                "The selected Reminders account or list is invalid"
            );
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct Request {
    pub note_id: String,
    pub request: String,
    pub version: String,
    pub observed_at: f64,
    pub status: String,
    pub answer: Option<String>,
    pub delivery: Option<String>,
    pub error: Option<String>,
    pub updated: String,
    pub checkpoint: Option<Checkpoint>,
}

/// The answered prefix distinguishes follow-ups from edits.
#[derive(Debug, Serialize, Deserialize)]
pub struct Checkpoint {
    text: String,
}

impl Checkpoint {
    pub fn new(text: &str) -> Self {
        Self {
            text: normalize(text),
        }
    }

    pub fn followup(&self, text: &str) -> Option<String> {
        let text = normalize(text);
        let suffix = text.strip_prefix(&self.text)?;
        (suffix.is_empty() || suffix.starts_with(' ')).then(|| suffix.trim().to_owned())
    }
}

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl Request {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            note_id: row.get("note_id")?,
            request: row.get("request")?,
            version: row.get("version")?,
            observed_at: row.get("observed_at")?,
            status: row.get("status")?,
            answer: row.get("answer")?,
            delivery: row.get("delivery")?,
            error: row.get("error")?,
            updated: row.get("updated")?,
            checkpoint: row
                .get::<_, Option<String>>("checkpoint")?
                .map(|value| {
                    serde_json::from_str(&value).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            9,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .transpose()?,
        })
    }
}

pub fn requests(db: &Connection) -> Result<Vec<Request>> {
    Ok(db
        .prepare("SELECT * FROM requests ORDER BY observed_at")?
        .query_map([], Request::from_row)?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn request(db: &Connection, note_id: &str) -> Result<Option<Request>> {
    Ok(db
        .query_row(
            "SELECT * FROM requests WHERE note_id=?",
            [note_id],
            Request::from_row,
        )
        .optional()?)
}

pub fn observe(db: &Connection, note_id: &str, request: &str, version: &str) -> Result<()> {
    db.execute("INSERT INTO requests (note_id,request,version,observed_at,status,updated)
        VALUES (?1,?2,?3,?4,'pending',?5) ON CONFLICT(note_id) DO UPDATE SET
        request=?2,version=?3,observed_at=?4,status='pending',answer=NULL,delivery=NULL,error=NULL,updated=?5",
        rusqlite::params![note_id,request,version,epoch(),util::now()])?;
    Ok(())
}

pub fn meta(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT value FROM meta WHERE key=?", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

pub fn set_meta(db: &Connection, key: &str, value: &str) -> Result<()> {
    db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", [key, value])?;
    Ok(())
}

pub fn clear_meta(db: &Connection, key: &str) -> Result<()> {
    db.execute("DELETE FROM meta WHERE key=?", [key])?;
    Ok(())
}

pub fn metadata(db: &Connection, keys: &[&str]) -> Result<Value> {
    let mut result = serde_json::Map::new();
    for key in keys {
        if let Some(value) = meta(db, key)? {
            result.insert((*key).into(), json!(value));
        }
    }
    Ok(Value::Object(result))
}

pub fn epoch() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64 / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn followup_ignores_whitespace_and_requires_the_answered_prefix() {
        let checkpoint = Checkpoint::new("问题\nNoema\n我的回答");
        assert_eq!(
            checkpoint.followup("问题\n\nNoema  我的回答\n"),
            Some(String::new())
        );
        assert_eq!(
            checkpoint.followup("问题\nNoema\n我的回答\n为什么？\n请举例。"),
            Some("为什么？ 请举例。".into())
        );
        assert!(checkpoint.followup("问题\nNoema\n修改了回答").is_none());
        assert!(checkpoint.followup("问题\nNoema\n我的回答有误").is_none());
    }
}
