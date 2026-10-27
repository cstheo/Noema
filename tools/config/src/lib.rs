//! One validated configuration shared by the Rust applications and deployed UI.

use anyhow::{Context, Result, ensure};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path},
    sync::OnceLock,
};

static CONFIG: OnceLock<Config> = OnceLock::new();
pub mod date;

pub const FILE: &str = "tools/config.toml";
pub const MOBILE_DIR: &str = "tools/mobile";
pub const OBSIDIAN_DIR: &str = "tools/obsidian";
pub const CLIENT_FILE: &str = "noema.json";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub timezone: Tz,
    pub locale: String,
    pub journal: Journal,
    pub mobile: Mobile,
    pub agent: Agent,
    pub obsidian: Obsidian,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Journal {
    pub folder: String,
    pub format: String,
    pub template: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mobile {
    pub notes_folder: String,
    pub reminders_list: String,
    pub notes_poll_seconds: u64,
    pub reconcile_seconds: u64,
    pub settle_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Agent {
    pub timeout_seconds: u64,
    pub executable: String,
    pub model: Option<String>,
    pub instructions_file: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Obsidian {
    pub config_dir: String,
    pub css_snippets: Vec<String>,
    pub addon_output: String,
    pub zotero: Zotero,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Zotero {
    pub research_folder: String,
    pub refresh_seconds: u64,
}

#[derive(Serialize)]
pub struct ClientConfig<'a> {
    timezone: Tz,
    locale: &'a str,
    journal: &'a Journal,
    zotero: &'a Zotero,
}

impl Journal {
    pub fn parts(&self) -> Result<Vec<String>> {
        relative(&self.format)?;
        let parts = date::format_parts(&self.format, false)?;
        ensure!(
            [["YYYY", "YY"], ["MM", "M"], ["DD", "D"]]
                .iter()
                .all(|group| parts.iter().any(|part| group.contains(&part.as_str()))),
            "Daily Notes filenames must include a year, month and day"
        );
        // Validate the rendered path too: bracket literals can conceal '.' or '..'.
        let rendered: String = parts
            .iter()
            .map(|part| match part.as_str() {
                "YYYY" | "YY" => "2000",
                "MM" | "M" => "01",
                "DD" | "D" => "02",
                _ => date::literal(part),
            })
            .collect();
        relative(&rendered)?;
        Ok(parts)
    }
}

fn valid_locale(value: &str) -> bool {
    // Deliberately support language[-Script][-REGION], without extension syntax.
    let alpha = |s: &str| s.bytes().all(|c| c.is_ascii_alphabetic());
    let mut parts = value.split('-');
    let Some(language) = parts.next() else {
        return false;
    };
    if !(2..=3).contains(&language.len()) || !alpha(language) {
        return false;
    }
    let mut tail = parts.next();
    if tail.is_some_and(|s| s.len() == 4 && alpha(s)) {
        tail = parts.next();
    }
    if let Some(region) = tail
        && !((region.len() == 2 && alpha(region))
            || (region.len() == 3 && region.bytes().all(|c| c.is_ascii_digit())))
    {
        return false;
    }
    parts.next().is_none()
}

fn relative(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && !value.contains('\\')
            && !value.chars().any(char::is_control)
            && !Path::new(value).is_absolute()
            && value
                .split('/')
                .all(|part| !matches!(part, "" | "." | ".."))
            && Path::new(value)
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "Expected a repository-relative path without traversal: {value:?}"
    );
    Ok(())
}

impl Config {
    pub fn load(repo: &Path) -> Result<Self> {
        let path = repo.join(FILE);
        let text = fs::read_to_string(&path).with_context(|| format!("Read {}", path.display()))?;
        let config: Self =
            toml::from_str(&text).with_context(|| format!("Parse {}", path.display()))?;
        config
            .validate()
            .with_context(|| format!("Invalid {}", path.display()))?;
        Ok(config)
    }

    fn validate(&self) -> Result<()> {
        ensure!(
            valid_locale(&self.locale),
            "locale must be language[-Script][-REGION], for example en or zh-Hans-CN"
        );
        for path in [&self.journal.folder, &self.obsidian.zotero.research_folder] {
            relative(path)?;
            ensure!(
                path.starts_with("corpus/"),
                "Personal records must stay under corpus/: {path}"
            );
        }
        self.journal.parts()?;
        if !self.journal.template.is_empty() {
            relative(&self.journal.template)?;
        }
        relative(&self.obsidian.config_dir)?;
        ensure!(
            !self.obsidian.config_dir.contains('/')
                && ![".git", "tools", "corpus", "noema"]
                    .contains(&self.obsidian.config_dir.as_str()),
            "Invalid Obsidian config_dir"
        );
        for name in [&self.mobile.notes_folder, &self.mobile.reminders_list] {
            ensure!(
                !name.trim().is_empty()
                    && name.chars().count() <= 200
                    && !name.chars().any(char::is_control)
                    && !name.contains('/'),
                "Invalid Apple folder/list name"
            );
        }
        for (name, seconds, min, max) in [
            (
                "notes_poll_seconds",
                self.mobile.notes_poll_seconds,
                10,
                86_400,
            ),
            (
                "reconcile_seconds",
                self.mobile.reconcile_seconds,
                10,
                86_400,
            ),
            ("settle_seconds", self.mobile.settle_seconds, 10, 300),
            ("agent.timeout_seconds", self.agent.timeout_seconds, 10, 600),
            (
                "refresh_seconds",
                self.obsidian.zotero.refresh_seconds,
                10,
                86_400,
            ),
        ] {
            ensure!(
                (min..=max).contains(&seconds),
                "{name} must be between {min} and {max}"
            );
        }
        let executable = Path::new(&self.agent.executable);
        ensure!(
            !self.agent.executable.is_empty()
                && !self.agent.executable.chars().any(char::is_control)
                && (executable.is_absolute()
                    || (executable.components().count() == 1
                        && executable
                            .components()
                            .all(|part| matches!(part, Component::Normal(_))))),
            "agent.executable must be a command name or absolute path"
        );
        if let Some(model) = &self.agent.model {
            ensure!(
                !model.trim().is_empty() && !model.chars().any(char::is_control),
                "Invalid agent.model"
            );
        }
        if let Some(path) = &self.agent.instructions_file {
            relative(path)?;
        }
        for snippet in &self.obsidian.css_snippets {
            ensure!(
                !snippet.is_empty()
                    && snippet
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')),
                "Invalid CSS snippet name"
            );
        }
        ensure!(
            !self.obsidian.addon_output.is_empty()
                && !self.obsidian.addon_output.chars().any(char::is_control),
            "Invalid addon_output"
        );
        Ok(())
    }

    pub fn client(&self) -> ClientConfig<'_> {
        ClientConfig {
            timezone: self.timezone,
            locale: &self.locale,
            journal: &self.journal,
            zotero: &self.obsidian.zotero,
        }
    }
}

pub fn initialize(repo: &Path) -> Result<()> {
    CONFIG
        .set(Config::load(repo)?)
        .map_err(|_| anyhow::anyhow!("Configuration already initialized"))
}

pub fn get() -> &'static Config {
    CONFIG
        .get()
        .expect("configuration initialized at application startup")
}

pub fn timezone() -> Tz {
    get().timezone
}
