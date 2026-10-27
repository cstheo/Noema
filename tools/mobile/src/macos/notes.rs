//! Read request notes and append escaped answers without changing the question.

use anyhow::{Context, Result, bail, ensure};
use html5ever::tendril::StrTendril;
use html5ever::tokenizer::{
    BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
    states::RawKind,
};
use objc2::{
    msg_send,
    rc::{Retained, autoreleasepool},
    runtime::AnyObject,
};
use objc2_foundation::{NSDate, NSDictionary, NSNumber, NSString};
use objc2_scripting_bridge::{SBApplication, SBElementArray, SBObject};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
struct Text {
    parts: String,
    hidden: usize,
}

impl Text {
    fn newline(&mut self) {
        if !self.parts.is_empty() && !self.parts.ends_with('\n') {
            self.parts.push('\n');
        }
    }
}

struct Sink(Rc<RefCell<Text>>);

impl TokenSink for Sink {
    type Handle = ();

    fn process_token(&self, token: Token, _line_number: u64) -> TokenSinkResult<()> {
        let mut text = self.0.borrow_mut();
        match token {
            Token::TagToken(tag) => {
                let name = tag.name.as_ref();
                let block = matches!(
                    name,
                    "div" | "p" | "li" | "h1" | "h2" | "h3" | "pre" | "blockquote"
                );
                let hidden = matches!(name, "script" | "style");
                if tag.kind == TagKind::StartTag {
                    if hidden {
                        text.hidden += 1;
                    }
                    if name == "br" {
                        text.parts.push('\n');
                    } else if block {
                        text.newline();
                    }
                    if tag.self_closing && hidden {
                        text.hidden = text.hidden.saturating_sub(1);
                    } else if hidden {
                        return TokenSinkResult::RawData(RawKind::Rawtext);
                    }
                } else {
                    if hidden {
                        text.hidden = text.hidden.saturating_sub(1);
                    }
                    if block {
                        text.newline();
                    }
                }
            }
            Token::CharacterTokens(value) if text.hidden == 0 => text.parts.push_str(&value),
            Token::NullCharacterToken if text.hidden == 0 => text.parts.push('\0'),
            _ => (),
        }
        TokenSinkResult::Continue
    }
}

fn whitespace(value: char) -> bool {
    value.is_whitespace() || matches!(value, '\u{1c}'..='\u{1f}')
}

fn trim(value: &str) -> &str {
    value.trim_matches(whitespace)
}

/// Tokenize without a DOM, retaining Notes' block and line-break semantics.
pub fn plain(body: &str) -> String {
    let text = Rc::new(RefCell::new(Text::default()));
    let tokenizer = Tokenizer::new(
        Sink(Rc::clone(&text)),
        TokenizerOpts {
            discard_bom: false,
            ..Default::default()
        },
    );
    let input = BufferQueue::default();
    input.push_back(StrTendril::from(body));
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    trim(
        &text
            .borrow()
            .parts
            .replace("\r\n", "\n")
            .replace('\u{a0}', " "),
    )
    .to_string()
}

fn escape(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"),
            '\'' => result.push_str("&#x27;"),
            value => result.push(value),
        }
    }
    result
}

pub fn html_note(title: &str, text: &str) -> String {
    format!(
        "<div>{}</div><div>{}</div>",
        escape(title),
        escape(text).replace('\n', "<br>")
    )
}

static STOPPING: AtomicBool = AtomicBool::new(false);
pub fn cancel_running() {
    STOPPING.store(true, Ordering::SeqCst);
}
fn active() -> Result<()> {
    ensure!(
        !STOPPING.load(Ordering::SeqCst),
        "Notes operation cancelled; service is stopping"
    );
    Ok(())
}

const MAX_BODY: usize = 1024 * 1024;

// Use Notes.sdef's stable Apple-event codes, avoiding KVC's reserved `id` key.
fn code(key: &str) -> Result<u32> {
    Ok(u32::from_be_bytes(*match key {
        "id" => b"ID  ",
        "name" => b"pnam",
        "body" => b"body",
        "container" => b"cntr",
        "passwordProtected" => b"pwpr",
        "shared" => b"shrd",
        "upgraded" => b"upgr",
        "modificationDate" => b"asmo",
        "accounts" => b"acct",
        "folders" => b"cfol",
        "notes" => b"note",
        "attachments" => b"atts",
        _ => bail!("Unknown Notes property: {key}"),
    }))
}
fn reference(object: &SBObject, key: &str) -> Result<Retained<SBObject>> {
    active()?;
    Ok(unsafe { msg_send![object, propertyWithCode: code(key)?] })
}
fn property(object: &SBObject, key: &str) -> Result<Retained<AnyObject>> {
    let reference = reference(object, key)?;
    let result = unsafe { reference.get() };
    if let Some(error) = unsafe { reference.lastError() } {
        bail!("Notes {key}: {error}");
    }
    result.with_context(|| {
        format!("Notes property {key} is unavailable; check Automation permission")
    })
}
fn text(object: &SBObject, key: &str) -> Result<String> {
    property(object, key)?
        .downcast::<NSString>()
        .map(|value| value.to_string())
        .map_err(|value| anyhow::anyhow!("Notes {key} is not text ({})", value.class()))
}
fn flag(object: &SBObject, key: &str) -> Result<bool> {
    property(object, key)?
        .downcast::<NSNumber>()
        .map(|value| value.boolValue())
        .map_err(|_| anyhow::anyhow!("Notes {key} is not a flag"))
}
fn object(object: &SBObject, key: &str) -> Result<Retained<SBObject>> {
    property(object, key)?
        .downcast::<SBObject>()
        .map_err(|_| anyhow::anyhow!("Notes {key} is not a scripting object"))
}
fn elements(object: &SBObject, key: &str) -> Result<Retained<SBElementArray>> {
    active()?;
    Ok(unsafe { msg_send![object, elementArrayWithCode: code(key)?] })
}
fn items(object: &SBObject, key: &str) -> Result<Vec<Retained<SBObject>>> {
    let values = elements(object, key)?;
    ensure!(values.count() <= 10_000, "Notes collection is too large");
    values
        .iter()
        .map(|value| {
            value
                .downcast::<SBObject>()
                .map_err(|_| anyhow::anyhow!("Notes collection contains an invalid object"))
        })
        .collect()
}
fn direct_notes(folder: &SBObject) -> Result<Vec<Retained<SBObject>>> {
    let id = text(folder, "id")?;
    items(folder, "notes")?
        .into_iter()
        .filter_map(|note| {
            match object(&note, "container").and_then(|container| text(&container, "id")) {
                Ok(parent) if parent == id => Some(Ok(note)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            }
        })
        .collect()
}
fn one(values: Vec<Retained<SBObject>>, key: &str, expected: &str) -> Result<Retained<SBObject>> {
    let mut matches = Vec::new();
    for value in values {
        if text(&value, key)? == expected {
            matches.push(value);
        }
    }
    ensure!(
        matches.len() == 1,
        "Notes object missing or ambiguous: {key}={expected}"
    );
    matches.pop().context("Notes object missing")
}
fn set(object: &SBObject, key: &str, value: &str) -> Result<()> {
    let reference = reference(object, key)?;
    unsafe { reference.setTo(Some(&NSString::from_str(value))) };
    if let Some(error) = unsafe { reference.lastError() } {
        bail!("Notes update failed: {error}");
    }
    Ok(())
}
fn snapshot(note: &SBObject) -> Result<Value> {
    let mut result = json!({"id":text(note,"id")?,"name":text(note,"name")?});
    let blocked = if flag(note, "passwordProtected")? {
        Some("locked")
    } else if flag(note, "shared")? {
        Some("shared")
    } else if !items(note, "attachments")?.is_empty() {
        Some("attachments")
    } else {
        None
    };
    if let Some(blocked) = blocked {
        result["blocked"] = blocked.into();
        return Ok(result);
    }
    let body = text(note, "body")?;
    if body.chars().count() > MAX_BODY {
        result["blocked"] = "too_large".into();
        return Ok(result);
    }
    result["body"] = body.into();
    if let Ok(date) = property(note, "modificationDate")?.downcast::<NSDate>() {
        result["modified_at"] = json!(
            chrono::DateTime::from_timestamp_millis((date.timeIntervalSince1970() * 1000.0) as i64)
                .map(|date| date.to_rfc3339())
        );
    }
    Ok(result)
}
fn input_text<'a>(input: &'a Value, key: &str, max: usize, empty: bool) -> Result<&'a str> {
    let value = input[key]
        .as_str()
        .with_context(|| format!("Invalid Notes {key}"))?;
    ensure!(
        (empty || !value.is_empty()) && value.chars().count() <= max && !value.contains('\0'),
        "Invalid Notes {key}"
    );
    Ok(value)
}
pub fn with_answer(body: &str, answer: &str) -> String {
    format!(
        "{body}<div><br></div><h2>Noema</h2><div>{}</div>",
        escape(answer).replace('\n', "<br>")
    )
}

struct Notes {
    app: Retained<SBApplication>,
}
impl Notes {
    fn new() -> Result<Self> {
        let app = unsafe {
            SBApplication::applicationWithBundleIdentifier(&NSString::from_str("com.apple.Notes"))
        }
        .context("Notes is unavailable")?;
        unsafe {
            // Apple-event timeouts are ticks (60 per second).
            app.setTimeout(5 * 60);
        }
        Ok(Self { app })
    }
    fn create(
        &self,
        container: &SBObject,
        collection: &str,
        class: &str,
        properties: &[(&str, &str)],
    ) -> Result<()> {
        active()?;
        let keys = properties
            .iter()
            .map(|(key, _)| NSString::from_str(key))
            .collect::<Vec<_>>();
        let values = properties
            .iter()
            .map(|(_, value)| NSString::from_str(value))
            .collect::<Vec<_>>();
        let dictionary = NSDictionary::from_slices(
            &keys.iter().map(|key| &**key).collect::<Vec<_>>(),
            &values.iter().map(|value| &**value).collect::<Vec<_>>(),
        );
        unsafe {
            let class = self
                .app
                .classForScriptingClass(&NSString::from_str(class))
                .context("Notes scripting class unavailable")?;
            let allocated = msg_send![class, alloc];
            let created: Retained<SBObject> =
                msg_send![allocated, initWithProperties: &*dictionary];
            elements(container, collection)?.addObject(&created);
            if let Some(error) = self.app.lastError() {
                bail!("Notes create failed: {error}");
            }
        }
        Ok(())
    }
    fn folder(&self, container: &SBObject, name: &str, create: bool) -> Result<Retained<SBObject>> {
        let id = text(container, "id")?;
        let mut found = Vec::new();
        for folder in items(container, "folders")? {
            if text(&folder, "name")? == name && text(&*object(&folder, "container")?, "id")? == id
            {
                found.push(folder);
            }
        }
        ensure!(
            found.len() <= 1,
            "Duplicate managed Notes folders require review"
        );
        if found.is_empty() && create {
            self.create(container, "folders", "folder", &[("name", name)])?;
            return self.folder(container, name, false);
        }
        let folder = found
            .pop()
            .context("Run init to create Noema Notes folders")?;
        ensure!(
            !flag(&folder, "shared")?,
            "Shared Notes folders are unsupported"
        );
        Ok(folder)
    }
    fn execute(&self, op: &str, account: Option<&str>, input: &Value) -> Result<Value> {
        let accounts = items(&self.app, "accounts")?;
        if op == "probe" {
            let mut result = Vec::new();
            for account in accounts {
                result.push(json!({"id":text(&account,"id")?,"name":text(&account,"name")?,"upgraded":flag(&account,"upgraded")?}));
            }
            return Ok(json!({"ok":true,"accounts":result}));
        }
        let account = one(
            accounts,
            "id",
            account.context("Notes account is required")?,
        )?;
        let root = self.folder(
            &account,
            &noema_config::get().mobile.notes_folder,
            op == "setup",
        )?;
        if op == "setup" {
            return Ok(json!({"ok":true,"folder_id":text(&root,"id")?}));
        }
        if op == "list" {
            return Ok(
                json!({"ok":true,"notes":direct_notes(&root)?.iter().map(|note|snapshot(note)).collect::<Result<Vec<_>>>()?}),
            );
        }
        if op == "create" {
            let title = input_text(input, "title", 200, false)?;
            ensure!(!title.chars().any(char::is_control), "Invalid Notes title");
            let body = html_note(title, input_text(input, "text", 32_000, false)?);
            self.create(&root, "notes", "note", &[("name", title), ("body", &body)])?;
            let note = one(direct_notes(&root)?, "name", title)?;
            return Ok(json!({"ok":true,"created":true,"note":snapshot(&note)?}));
        }
        ensure!(op == "answer", "Unknown Notes operation");
        let expected = input_text(input, "expected_body", MAX_BODY, true)?;
        let answer = input_text(input, "answer", 100_000, false)?;
        let note = one(
            direct_notes(&root)?,
            "id",
            input_text(input, "note_id", 2048, false)?,
        )?;
        let before = snapshot(&note)?;
        ensure!(before["blocked"].is_null(), "Request note is unavailable");
        ensure!(
            before["body"] == expected,
            "Notes CONFLICT: request changed"
        );
        set(&note, "body", &with_answer(expected, answer))?;
        Ok(json!({"ok":true,"note":snapshot(&note)?}))
    }
}

pub fn call(op: &str, account: Option<&str>, input: Value) -> Result<Value> {
    // Scripting Bridge reports transport errors and may raise Objective-C exceptions.
    objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
        autoreleasepool(|_| {
            let notes = Notes::new()?;
            let result = notes.execute(op, account, &input);
            if let Some(error) = unsafe { notes.app.lastError() } {
                bail!("Notes automation: {error}");
            }
            result
        })
    }))
    .map_err(|error| anyhow::anyhow!("Notes automation failed: {error:?}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_preserves_question_formatting_and_escapes_output() {
        let question = "<div style=\"font-weight: bold\">My question</div>";
        let answer = with_answer(question, "<script>not executable</script>\nPersonal answer");
        assert!(answer.starts_with(question));
        assert!(!answer.contains("<script>"));
        assert!(plain(&answer).ends_with("Personal answer"));
    }
}
