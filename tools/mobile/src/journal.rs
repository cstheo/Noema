//! Daily-note tasks, read and written independently of Obsidian.

use anyhow::{Context, Result, bail, ensure};
use chrono::{Datelike, NaiveDate, Timelike, Utc};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ffi::CString,
    fs::{self, File},
    io::{Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::MetadataExt,
        io::{AsRawFd, FromRawFd},
    },
    path::{Path, PathBuf},
    sync::LazyLock,
};
use uuid::Uuid;

const DAY: &str = r"\d{4}-\d{2}-\d{2}";
use noema_config::date::{DATE_TOKENS, format_parts, literal};
static FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:>\s*)*(`{3,}|~{3,})").expect("valid regex"));
static CHECKBOX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)(\]\s+)(.*?)(\r?)$").expect("valid regex")
});
static BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+\^([A-Za-z0-9-]+)\s*$").expect("valid regex"));
static DATE_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"\s*(?:📅|⏳|🛫|➕|✅|❌)\s*{DAY}")).expect("valid regex")
});
static PRIORITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[🔺⏫🔼🔽⏬]").expect("valid regex"));
static FIELDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?:📅|⏳|🛫|➕|✅|❌)\s*{DAY}|[🔺⏫🔼🔽⏬]|🔁[^📅⏳🛫➕✅❌🔺⏫🔼🔽⏬🆔⛔]*|🆔\s*[A-Za-z0-9]+|⛔\s*[A-Za-z0-9]+(?:\s*,\s*[A-Za-z0-9]+)*")).expect("valid regex")
});
static HEADER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#{1,2}\s+").expect("valid regex"));
static TASK_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^##\s+Tasks\s*$").expect("valid regex"));
static DATES: LazyLock<[(&str, Regex); 3]> = LazyLock::new(|| {
    [
        ("due_date", "📅"),
        ("scheduled_date", "⏳"),
        ("start_date", "🛫"),
    ]
    .map(|(name, symbol)| {
        (
            name,
            Regex::new(&format!(r"{symbol}\s*({DAY})")).expect("valid regex"),
        )
    })
});

fn today() -> NaiveDate {
    Utc::now()
        .with_timezone(&noema_config::timezone())
        .date_naive()
}

fn valid_day(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 10
            && NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .is_ok_and(|day| day.to_string() == value)
    })
}

fn relative(value: &str, empty: bool) -> Result<String> {
    ensure!(
        !value.contains('\\') && !value.chars().any(|c| c.is_control()),
        "Daily note paths must be relative to the vault."
    );
    if value.is_empty() && empty {
        return Ok(String::new());
    }
    ensure!(
        !value.starts_with('/')
            && value
                .split('/')
                .all(|part| !matches!(part, "" | "." | "..")),
        "Daily note paths must stay inside the vault."
    );
    Ok(value.into())
}

fn formatted(day: NaiveDate, time: Option<chrono::NaiveTime>, parts: &[String]) -> String {
    parts
        .iter()
        .map(|part| match part.as_str() {
            "YYYY" => format!("{:04}", day.year()),
            "YY" => format!("{:02}", day.year().rem_euclid(100)),
            "MM" => format!("{:02}", day.month()),
            "M" => day.month().to_string(),
            "DD" => format!("{:02}", day.day()),
            "D" => day.day().to_string(),
            token if time.is_some() => {
                let time = time.expect("time is present in this branch");
                let hour = if time.hour().is_multiple_of(12) {
                    12
                } else {
                    time.hour() % 12
                };
                match token {
                    "HH" => format!("{:02}", time.hour()),
                    "H" => time.hour().to_string(),
                    "hh" => format!("{hour:02}"),
                    "h" => hour.to_string(),
                    "mm" => format!("{:02}", time.minute()),
                    "m" => time.minute().to_string(),
                    "ss" => format!("{:02}", time.second()),
                    "s" => time.second().to_string(),
                    "A" => if time.hour() < 12 { "AM" } else { "PM" }.into(),
                    "a" => if time.hour() < 12 { "am" } else { "pm" }.into(),
                    _ => literal(part).into(),
                }
            }
            _ => literal(part).into(),
        })
        .collect()
}

fn label(text: &str) -> String {
    static REPEAT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\s*🔁[^📅⏳🛫➕✅❌]*").expect("valid regex"));
    static LINK: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\[\[([^|\]]+)(?:\|([^\]]+))?\]\]").expect("valid regex"));
    let text = BLOCK.replace(text, "");
    let text = DATE_FIELD.replace_all(&text, "");
    let text = REPEAT.replace_all(&text, "");
    let text = PRIORITY.replace_all(&text, "");
    LINK.replace_all(&text, |capture: &regex::Captures<'_>| {
        capture
            .get(2)
            .unwrap_or_else(|| capture.get(1).expect("link capture"))
            .as_str()
            .to_owned()
    })
    .trim()
    .into()
}

fn sections(content: &str) -> Result<Vec<(usize, &str)>> {
    let mut lines = Vec::new();
    let mut fence = String::new();
    for (index, raw) in content.split('\n').enumerate() {
        if let Some(marker) = FENCE.captures(raw) {
            let value = &marker[1];
            if fence.is_empty() {
                fence = value.into();
            } else if value.as_bytes()[0] == fence.as_bytes()[0] && value.len() >= fence.len() {
                fence.clear();
            }
        } else if fence.is_empty() {
            lines.push((index, raw));
        }
    }
    ensure!(
        fence.is_empty(),
        "Close the Markdown code fence before synchronizing tasks."
    );
    Ok(lines)
}

pub fn parse(path: &str, content: &str, include_cancelled: bool) -> Result<Vec<Value>> {
    let mut tasks = Vec::new();
    let mut active = false;
    for (index, raw) in sections(content)? {
        if HEADER.is_match(raw) {
            active = TASK_HEADER.is_match(raw);
            continue;
        }
        let Some(capture) = active.then(|| CHECKBOX.captures(raw)).flatten() else {
            continue;
        };
        if &capture[2] == "-" && !include_cancelled {
            continue;
        }
        let text = &capture[4];
        let mut task = json!({"path": path, "line": index, "raw": raw,
            "block_id": BLOCK.captures(text).map(|m| m[1].to_owned()),
            "title": label(text), "completed": capture[2].eq_ignore_ascii_case("x"), "status": &capture[2],
            "priority": if text.contains(['🔺','⏫','🔼']) {1} else if text.contains(['🔽','⏬']) {9} else {0},
            "recurring": text.contains('🔁')});
        for (name, re) in DATES.iter() {
            let date = re
                .captures(text)
                .map(|found| Value::String(found[1].into()))
                .filter(valid_day)
                .unwrap_or(Value::Null);
            task[*name] = date;
        }
        tasks.push(task);
    }
    Ok(tasks)
}

fn title(value: &Value) -> Result<&str> {
    let value = value.as_str().context("Enter a task title on one line.")?;
    ensure!(
        !value.trim().is_empty()
            && value.chars().count() <= 2000
            && !value.chars().any(|c| c.is_control()),
        "Enter a task title on one line."
    );
    Ok(value.trim())
}

fn validate(changes: &Value) -> Result<()> {
    let values = changes.as_object().context("Unsupported task changes.")?;
    ensure!(
        values
            .keys()
            .all(|key| ["title", "completed", "due_date", "priority"].contains(&key.as_str())),
        "Unsupported task changes."
    );
    if let Some(value) = values.get("title") {
        title(value)?;
    }
    if let Some(value) = values.get("completed") {
        ensure!(value.is_boolean(), "Invalid completion state.");
    }
    if let Some(value) = values.get("due_date") {
        ensure!(value.is_null() || valid_day(value), "Invalid due date.");
    }
    if let Some(value) = values.get("priority") {
        ensure!(
            matches!(value.as_i64(), Some(0 | 1 | 9)),
            "Invalid priority."
        );
    }
    Ok(())
}

fn append_field(text: &str, field: &str) -> String {
    let block = BLOCK.find(text);
    let (body, suffix) = block
        .map(|m| (&text[..m.start()], m.as_str()))
        .unwrap_or((text, ""));
    format!(
        "{}{}{suffix}",
        body.trim_end(),
        if field.is_empty() {
            String::new()
        } else {
            format!(" {field}")
        }
    )
}

pub fn edit_line(raw: &str, changes: &Value, identity: &str) -> Result<String> {
    let capture = CHECKBOX
        .captures(raw)
        .context("The task is no longer a Markdown checkbox.")?;
    let mut text = capture[4].to_owned();
    let mut status = capture[2].to_owned();
    let values = changes.as_object().context("Unsupported task changes.")?;
    if let Some(value) = values.get("title") {
        let block = BLOCK.find(&text);
        let (body, suffix) = block
            .map(|m| (&text[..m.start()], m.as_str()))
            .unwrap_or((&text, ""));
        let metadata: Vec<_> = FIELDS.find_iter(body).map(|m| m.as_str().trim()).collect();
        text = format!(
            "{}{}{suffix}",
            title(value)?,
            if metadata.is_empty() {
                String::new()
            } else {
                format!(" {}", metadata.join(" "))
            }
        );
    }
    if let Some(value) = values.get("due_date") {
        text = Regex::new(&format!(r"\s*📅\s*{DAY}"))?
            .replace_all(&text, "")
            .into_owned();
        text = append_field(
            &text,
            &value
                .as_str()
                .map(|date| format!("📅 {date}"))
                .unwrap_or_default(),
        );
    }
    if let Some(value) = values.get("priority") {
        text = Regex::new(r"\s*[🔺⏫🔼🔽⏬]")?
            .replace_all(&text, "")
            .into_owned();
        text = append_field(
            &text,
            match value.as_i64() {
                Some(1) => "⏫",
                Some(9) => "🔽",
                _ => "",
            },
        );
    }
    if let Some(value) = values.get("completed") {
        let completed = value.as_bool().context("Invalid completion state.")?;
        if completed != status.eq_ignore_ascii_case("x") {
            ensure!(
                !text.contains('🔁'),
                "Repeating task completion is not supported by background sync; original note preserved."
            );
            ensure!(
                matches!(status.as_str(), " " | "x" | "X"),
                "Custom task statuses require review; no task was changed."
            );
            status = if completed { "x" } else { " " }.into();
            text = Regex::new(&format!(r"\s*✅\s*{DAY}"))?
                .replace_all(&text, "")
                .into_owned();
            text = append_field(
                &text,
                &if completed {
                    format!("✅ {}", today())
                } else {
                    String::new()
                },
            );
        }
    }
    if !BLOCK.is_match(&text) {
        text = format!("{} ^{identity}", text.trim_end());
    }
    Ok(format!(
        "{}{status}{}{}{}",
        &capture[1], &capture[3], text, &capture[5]
    ))
}

fn append_task(content: &str, line: &str) -> Result<String> {
    let mut lines: Vec<_> = content.split('\n').map(str::to_owned).collect();
    let mut start = None;
    let mut end = lines.len();
    for (index, raw) in sections(content)? {
        if start.is_none() && TASK_HEADER.is_match(raw) {
            start = Some(index + 1);
        } else if start.is_some() && end == lines.len() && HEADER.is_match(raw) {
            end = index;
        }
    }
    let newline = if content.contains("\r\n") { "\r" } else { "" };
    let Some(start) = start else {
        return Ok(format!(
            "{}{newline}\n{newline}\n## Tasks{newline}\n{newline}\n{line}{newline}\n",
            content.trim_end()
        ));
    };
    while end > start && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    lines.splice(
        end..end,
        [newline.into(), format!("{line}{newline}"), newline.into()],
    );
    Ok(lines.join("\n"))
}

fn cstring(path: impl AsRef<std::ffi::OsStr>) -> Result<CString> {
    Ok(CString::new(path.as_ref().as_bytes())?)
}
fn openat(parent: i32, name: &CString, flags: i32, mode: u32) -> Result<File> {
    // Every component is opened relative to an already verified directory.
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            mode,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn check_call(value: i32) -> Result<()> {
    if value < 0 {
        Err(std::io::Error::last_os_error().into())
    } else {
        Ok(())
    }
}
fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}

struct Store {
    root: PathBuf,
    folder: String,
    template: String,
    parts: Vec<String>,
    date_regex: Regex,
}

impl Store {
    fn new(root: &Path) -> Result<Self> {
        let root = std::path::absolute(root)?;
        ensure!(
            root == root.canonicalize()?,
            "Refusing a vault path through a symbolic link."
        );
        let config = &noema_config::get().journal;
        let parts = config.parts()?;
        let expression: String = parts
            .iter()
            .map(|part| match part.as_str() {
                "YYYY" => r"(\d{4})".into(),
                "YY" | "MM" | "DD" => r"(\d{2})".into(),
                "M" | "D" => r"(\d{1,2})".into(),
                _ => regex::escape(literal(part)),
            })
            .collect();
        Ok(Self {
            root,
            folder: relative(&config.folder, false)?,
            template: relative(&config.template, true)?,
            parts,
            date_regex: Regex::new(&format!("^{expression}$"))?,
        })
    }

    fn parent(&self, path: &str, create: bool) -> Result<(File, CString)> {
        let path = relative(path, false)?;
        let mut parts: Vec<_> = path.split('/').collect();
        let name = cstring(parts.pop().context("Missing path name")?)?;
        let mut directory = openat(
            libc::AT_FDCWD,
            &cstring(&self.root)?,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        for part in parts {
            let part = cstring(part)?;
            if create {
                let result = unsafe { libc::mkdirat(directory.as_raw_fd(), part.as_ptr(), 0o755) };
                if result < 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
                {
                    check_call(result)?;
                }
            }
            directory = openat(
                directory.as_raw_fd(),
                &part,
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )?;
        }
        Ok((directory, name))
    }

    fn read(&self, path: &str) -> Result<Vec<u8>> {
        let (directory, name) = self.parent(path, false)?;
        let mut file = openat(directory.as_raw_fd(), &name, libc::O_RDONLY, 0)?;
        ensure!(
            file.metadata()?.is_file(),
            "Daily note sources must be regular files."
        );
        let mut content = Vec::new();
        file.read_to_end(&mut content)?;
        Ok(content)
    }

    fn day(&self, path: &str) -> Option<NaiveDate> {
        let prefix = format!("{}/", self.folder);
        let value = path.strip_prefix(&prefix)?.strip_suffix(".md")?;
        let capture = self.date_regex.captures(value)?;
        let mut values = HashMap::new();
        let mut index = 1;
        for part in &self.parts {
            if !DATE_TOKENS.contains(&part.as_str()) {
                continue;
            }
            let mut number: i32 = capture.get(index)?.as_str().parse().ok()?;
            index += 1;
            if part == "YY" {
                number += if number <= 68 { 2000 } else { 1900 };
            }
            let key = if part.starts_with('Y') {
                "year"
            } else if part.starts_with('M') {
                "month"
            } else {
                "day"
            };
            if values.insert(key, number).is_some_and(|old| old != number) {
                return None;
            }
        }
        let day = NaiveDate::from_ymd_opt(
            *values.get("year")?,
            *values.get("month")? as u32,
            *values.get("day")? as u32,
        )?;
        (formatted(day, None, &self.parts) == value).then_some(day)
    }

    fn path(&self, day: NaiveDate) -> Result<String> {
        relative(
            &format!("{}/{}.md", self.folder, formatted(day, None, &self.parts)),
            false,
        )
    }

    fn files(&self) -> Result<Vec<String>> {
        let scan = format!("{}/.scan", self.folder);
        match self.parent(&scan, false) {
            Err(error) if missing(&error) => return Ok(vec![]),
            Err(error) => return Err(error),
            Ok(_) => {}
        }
        fn walk(store: &Store, directory: &Path, result: &mut Vec<String>) -> Result<()> {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let metadata = fs::symlink_metadata(entry.path())?;
                ensure!(
                    !metadata.file_type().is_symlink(),
                    "Refusing a daily note path through a symbolic link."
                );
                if metadata.is_dir() {
                    walk(store, &entry.path(), result)?;
                } else {
                    let path = entry.path();
                    let relative = path
                        .strip_prefix(&store.root)?
                        .to_str()
                        .context("Daily note path is not UTF-8")?;
                    if store.day(relative).is_some() {
                        result.push(relative.into());
                    }
                }
            }
            Ok(())
        }
        let mut result = Vec::new();
        walk(self, &self.root.join(&self.folder), &mut result)?;
        result.sort();
        Ok(result)
    }

    fn snapshot(&self) -> Result<Value> {
        let mut tasks = Vec::new();
        for path in self.files()? {
            match self.read(&path) {
                Ok(data) => tasks.extend(parse(&path, std::str::from_utf8(&data)?, false)?),
                Err(error) if missing(&error) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(json!({"root":self.root,"tasks":tasks}))
    }

    fn lock(&self) -> Result<File> {
        let (directory, name) = self.parent("tools/mobile/.local/journal.lock", true)?;
        let file = openat(
            directory.as_raw_fd(),
            &name,
            libc::O_CREAT | libc::O_RDWR,
            0o600,
        )?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } < 0 {
            bail!("Daily-note synchronization is busy; retry on the next event.");
        }
        Ok(file)
    }

    fn write(&self, path: &str, before: Option<&[u8]>, after: &str) -> Result<()> {
        let (directory, name) = self.parent(path, before.is_none())?;
        let temporary = cstring(format!(".noema-{}.tmp", Uuid::new_v4().simple()))?;
        let mode = if before.is_some() {
            openat(directory.as_raw_fd(), &name, libc::O_RDONLY, 0)?
                .metadata()?
                .mode()
                & 0o7777
        } else {
            0o644
        };
        let mut file = openat(
            directory.as_raw_fd(),
            &temporary,
            libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY,
            mode,
        )?;
        let result = (|| -> Result<()> {
            file.write_all(after.as_bytes())?;
            check_call(unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) })?;
            file.sync_all()?;
            let (current, _) = self.parent(path, false)?;
            ensure!(
                current.metadata()?.ino() == directory.metadata()?.ino(),
                "Daily note parent changed during synchronization."
            );
            if let Some(before) = before {
                ensure!(
                    self.read(path)? == before,
                    "Task conflict: its source changed during synchronization."
                );
                check_call(unsafe {
                    libc::renameat(
                        directory.as_raw_fd(),
                        temporary.as_ptr(),
                        directory.as_raw_fd(),
                        name.as_ptr(),
                    )
                })?;
            } else {
                check_call(unsafe {
                    libc::linkat(
                        directory.as_raw_fd(),
                        temporary.as_ptr(),
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        0,
                    )
                })?;
            }
            directory.sync_all()?;
            Ok(())
        })();
        let cleanup = unsafe { libc::unlinkat(directory.as_raw_fd(), temporary.as_ptr(), 0) };
        if cleanup < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound {
            check_call(cleanup)?;
        }
        result
    }

    fn template_content(&self, day: NaiveDate, path: &str) -> Result<String> {
        if self.template.is_empty() {
            return Ok(format!("# {day}\n\n## Tasks\n\n## Notes\n\n## Review\n"));
        }
        let template = if self.template.to_lowercase().ends_with(".md") {
            self.template.clone()
        } else {
            format!("{}.md", self.template)
        };
        let content = String::from_utf8(self.read(&template)?)?;
        let now = Utc::now().with_timezone(&noema_config::timezone());
        let pattern = Regex::new(r"\{\{\s*(date|time|title)(?:\s*:\s*([^}]+))?\s*\}\}")?;
        let mut output = String::new();
        let mut previous = 0;
        for capture in pattern.captures_iter(&content) {
            let span = capture.get(0).context("Template span missing")?;
            output.push_str(&content[previous..span.start()]);
            let field = &capture[1];
            let value = if field == "title" {
                Path::new(path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .context("Invalid daily note title")?
                    .into()
            } else {
                let pattern = capture
                    .get(2)
                    .map(|m| m.as_str())
                    .unwrap_or(if field == "date" {
                        "YYYY-MM-DD"
                    } else {
                        "HH:mm"
                    })
                    .trim();
                formatted(
                    if field == "date" {
                        day
                    } else {
                        now.date_naive()
                    },
                    (field == "time").then_some(now.time()),
                    &format_parts(pattern, field == "time")?,
                )
            };
            output.push_str(&value);
            previous = span.end();
        }
        output.push_str(&content[previous..]);
        ensure!(
            !output.contains("{{") && !output.contains("}}"),
            "Unsupported placeholder in the Daily Notes template."
        );
        Ok(output)
    }

    fn update(&self, task: &Value, changes: &Value, todo_id: &Value) -> Result<bool> {
        let line = task["line"].as_u64().context("Invalid task snapshot.")? as usize;
        ensure!(task["raw"].is_string(), "Invalid task snapshot.");
        let path = relative(
            task["path"].as_str().context("Invalid task snapshot.")?,
            false,
        )?;
        ensure!(
            self.day(&path).is_some(),
            "This note is outside the configured daily notes."
        );
        let identity = match task["block_id"].as_str().filter(|s| !s.is_empty()) {
            Some(id) => id.to_owned(),
            None => identity_for(todo_id)?,
        };
        ensure!(
            !identity.is_empty()
                && identity
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "Invalid block identity."
        );
        let before = self.read(&path)?;
        let content = std::str::from_utf8(&before)?;
        let actual = parse(&path, content, false)?
            .into_iter()
            .find(|item| item["line"].as_u64() == Some(line as u64))
            .context("Task conflict: its source changed after the last sync.")?;
        ensure!(
            actual["raw"] == task["raw"] && actual["block_id"] == task["block_id"],
            "Task conflict: its source changed after the last sync."
        );
        let raw = actual["raw"].as_str().context("Invalid task snapshot")?;
        let replacement = edit_line(raw, changes, &identity)?;
        if replacement == raw {
            return Ok(false);
        }
        let mut lines: Vec<_> = content.split('\n').map(str::to_owned).collect();
        lines[line] = replacement;
        self.write(&path, Some(&before), &lines.join("\n"))?;
        Ok(true)
    }

    fn capture(&self, changes: &Value, todo_id: &Value) -> Result<bool> {
        let identity = identity_for(todo_id)?;
        let mut existing = 0;
        for path in self.files()? {
            existing += parse(&path, std::str::from_utf8(&self.read(&path)?)?, true)?
                .iter()
                .filter(|task| task["block_id"] == identity)
                .count();
        }
        ensure!(existing <= 1, "Duplicate task identity requires review.");
        if existing == 1 {
            return Ok(false);
        }
        let day = today();
        let path = self.path(day)?;
        let before = match self.read(&path) {
            Ok(data) => Some(data),
            Err(error) if missing(&error) => None,
            Err(error) => return Err(error),
        };
        let content = match &before {
            Some(data) => String::from_utf8(data.clone())?,
            None => self.template_content(day, &path)?,
        };
        let line = edit_line(
            &format!("- [ ] {} ^{identity}", title(&changes["title"])?),
            changes,
            &identity,
        )?;
        self.write(&path, before.as_deref(), &append_task(&content, &line)?)?;
        Ok(true)
    }
}

fn identity_for(value: &Value) -> Result<String> {
    let value = value.as_str().context("Invalid task identity.")?;
    ensure!(
        value.len() == 32
            && value
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "Invalid task identity."
    );
    Ok(format!("noema-{value}"))
}

pub fn dispatch(root: &Path, op: &str, payload: Value) -> Result<Value> {
    let store = Store::new(root)?;
    if op == "list" {
        return store.snapshot();
    }
    ensure!(
        ["update", "capture"].contains(&op),
        "Unknown daily-note task operation."
    );
    let changes = if op == "update" {
        payload["changes"].clone()
    } else {
        json!({"title":payload["title"],"completed":payload.get("completed").unwrap_or(&Value::Bool(false)),"due_date":payload["due_date"],"priority":payload.get("priority").unwrap_or(&json!(0))})
    };
    validate(&changes)?;
    let _lock = store.lock()?;
    let changed = if op == "update" {
        store.update(&payload["task"], &changes, &payload["todo_id"])?
    } else {
        store.capture(&changes, &payload["todo_id"])?
    };
    let mut snapshot = store.snapshot()?;
    snapshot["changed"] = changed.into();
    Ok(snapshot)
}

pub fn watch_paths(root: &Path) -> Result<Vec<PathBuf>> {
    Ok(vec![root.join(&noema_config::get().journal.folder)])
}
