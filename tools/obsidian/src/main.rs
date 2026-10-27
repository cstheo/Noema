use anyhow::{Context, Result, ensure};
use chrono::Utc;
use clap::{Args, Parser, Subcommand};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Component, Path, PathBuf},
    process::ExitCode,
};
use tempfile::NamedTempFile;
use uuid::Uuid;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const COMPILED_SOURCE: &str = env!("CARGO_MANIFEST_DIR");
const RETIRED: &[&str] = &[
    ".obsidian/dashboard",
    ".obsidian/templates",
    ".obsidian/plugins/noema-templates",
    ".obsidian/DESIGN.md",
    "noema/tasks",
];

#[derive(Parser)]
#[command(about = "Deploy Noema's Obsidian resources and build its Zotero add-on")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Preview or apply managed resources. Close Obsidian before applying.
    Deploy(Deploy),
    /// Build the optional native Zotero paper-review add-on.
    BuildAddon {
        #[arg(long)]
        output: Option<PathBuf>,
    },
}

#[derive(Args)]
#[group(required = true, multiple = false)]
struct Action {
    /// Report drift without writes; exit 1 if deployment differs.
    #[arg(long)]
    check: bool,
    /// Back up, migrate, and deploy managed resources.
    #[arg(long)]
    apply: bool,
}

#[derive(Args)]
struct Deploy {
    #[command(flatten)]
    action: Action,
    #[arg(long, alias = "vault")]
    vault_root: Option<PathBuf>,
}

struct Change {
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}

#[derive(Default)]
struct Plan {
    changes: BTreeMap<String, Change>,
    retired: Vec<String>,
}

fn source() -> Result<PathBuf> {
    let mut candidates = Vec::new();
    for origin in [std::env::current_exe().ok(), std::env::current_dir().ok()]
        .into_iter()
        .flatten()
    {
        candidates.extend(
            origin
                .ancestors()
                .map(|parent| parent.join(noema_config::OBSIDIAN_DIR)),
        );
    }
    candidates.push(PathBuf::from(COMPILED_SOURCE));
    candidates
        .into_iter()
        .find(|path| {
            path.join("Cargo.toml").is_file()
                && path.join("plugins/noema-zotero/manifest.json").is_file()
                && path.join("dashboard").is_dir()
                && path.join("templates").is_dir()
        })
        .context("Cannot locate Noema's Obsidian sources; run from the Noema checkout")?
        .canonicalize()
        .context("Cannot resolve Obsidian source directory")
}

fn config_path(relative: &str) -> String {
    format!("{}/{relative}", noema_config::get().obsidian.config_dir)
}

fn safe_path(vault: &Path, relative: &str) -> Result<PathBuf> {
    let mut path = vault.to_owned();
    for component in Path::new(relative).components() {
        ensure!(
            matches!(component, Component::Normal(_)),
            "Unsafe deployment path: {relative}"
        );
        path.push(component);
        ensure!(
            !path.is_symlink(),
            "Refusing deployment through symlink: {relative}"
        );
    }
    Ok(path)
}

fn read_existing(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("Read {}", path.display())),
    }
}

fn remap(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(remap),
        Value::Object(items) => items.values_mut().for_each(remap),
        Value::String(text) => {
            for (old, new) in [
                (
                    ".obsidian/dashboard/tasks",
                    noema_config::get().journal.folder.as_str(),
                ),
                ("noema/tasks", noema_config::get().journal.folder.as_str()),
                (".obsidian/dashboard", "tools/obsidian/dashboard"),
                (".obsidian/templates", "tools/obsidian/templates"),
            ] {
                if text == old || text.starts_with(&format!("{old}/")) {
                    *text = format!("{new}{}", &text[old.len()..]);
                    break;
                }
            }
        }
        _ => {}
    }
}

impl Plan {
    fn stage(&mut self, vault: &Path, relative: &str, after: Vec<u8>) -> Result<()> {
        let before = read_existing(&safe_path(vault, relative)?)?;
        if before.as_ref() != Some(&after) {
            self.changes
                .insert(relative.into(), Change { before, after });
        }
        Ok(())
    }

    fn settings(
        &mut self,
        vault: &Path,
        relative: &str,
        default: Value,
        update: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<()> {
        let before = read_existing(&safe_path(vault, relative)?)?;
        let old: Value = match &before {
            Some(bytes) => serde_json::from_slice(bytes)
                .with_context(|| format!("Invalid settings: {relative}"))?,
            None => default,
        };
        let mut result = old.clone();
        remap(&mut result);
        update(&mut result).with_context(|| format!("Invalid settings: {relative}"))?;
        if before.is_none() || result != old {
            let mut bytes = serde_json::to_vec_pretty(&result)?;
            bytes.push(b'\n');
            self.stage(vault, relative, bytes)?;
        }
        Ok(())
    }
}

fn files_under(directory: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_name() == "tests" {
            continue;
        }
        ensure!(!path.is_symlink(), "Symlinked source: {}", path.display());
        if path.is_dir() {
            files.extend(files_under(&path)?);
        } else if path.is_file() {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn object(value: &mut Value) -> Result<&mut serde_json::Map<String, Value>> {
    value.as_object_mut().context("Expected a settings object")
}

fn plan(vault: &Path, source: &Path) -> Result<Plan> {
    let mut result = Plan::default();
    result.stage(
        vault,
        &config_path(noema_config::CLIENT_FILE),
        serde_json::to_vec_pretty(&noema_config::get().client())?,
    )?;
    for folder in ["dashboard", "templates"] {
        for path in files_under(&source.join(folder))? {
            let relative = format!(
                "{}/{}",
                noema_config::OBSIDIAN_DIR,
                path.strip_prefix(source)?.display()
            );
            result.stage(vault, &relative, fs::read(path)?)?;
        }
    }
    let plugin = source.join("plugins/noema-zotero");
    for path in files_under(&plugin)? {
        if path.parent() != Some(plugin.as_path()) {
            continue;
        }
        let name = path
            .file_name()
            .context("Missing source filename")?
            .to_string_lossy();
        if (name.ends_with(".js") && !name.ends_with(".test.js"))
            || matches!(name.as_ref(), "manifest.json" | "styles.css")
        {
            result.stage(
                vault,
                &config_path(&format!("plugins/noema-zotero/{name}")),
                fs::read(&path)?,
            )?;
        }
    }
    let mut managed_snippets = Vec::new();
    for path in files_under(&source.join("snippets"))? {
        if path.extension().is_some_and(|ext| ext == "css") {
            managed_snippets.push(
                path.file_stem()
                    .context("Missing snippet name")?
                    .to_string_lossy()
                    .into_owned(),
            );
            let name = path
                .file_name()
                .context("Missing snippet filename")?
                .to_string_lossy();
            result.stage(
                vault,
                &config_path(&format!("snippets/{name}")),
                fs::read(&path)?,
            )?;
        }
    }
    result.settings(
        vault,
        &config_path("community-plugins.json"),
        json!([]),
        |value| {
            let items = value
                .as_array_mut()
                .context("Expected an enabled community plugin list")?;
            ensure!(items.iter().all(Value::is_string), "Expected plugin names");
            items.retain(|item| item != "noema-templates");
            if !items.iter().any(|item| item == "noema-zotero") {
                items.push(json!("noema-zotero"));
            }
            Ok(())
        },
    )?;
    for (relative, defaults) in [
        (
            &config_path("templates.json"),
            json!({"folder": "tools/obsidian/templates"}),
        ),
        (
            &config_path("daily-notes.json"),
            json!({
                "folder": noema_config::get().journal.folder, "format": noema_config::get().journal.format,
                "template": noema_config::get().journal.template
            }),
        ),
        (
            &config_path("plugins/templater-obsidian/data.json"),
            json!({"templates_folder": "tools/obsidian/templates"}),
        ),
    ] {
        result.settings(vault, relative, json!({}), |value| {
            let settings = object(value)?;
            for (key, default) in defaults.as_object().context("Invalid built-in defaults")? {
                settings.insert(key.clone(), default.clone());
            }
            Ok(())
        })?;
    }
    result.settings(
        vault,
        &config_path("plugins/homepage/data.json"),
        json!({}),
        |value| {
            let settings = object(value)?;
            if settings.get("homepages").is_none_or(|value| {
                value.is_null()
                    || value == &json!(false)
                    || value == &json!("")
                    || value == &json!({})
                    || value == &json!([])
                    || value == &json!(0)
            }) {
                settings.insert("version".into(), json!(4));
                settings.insert(
                    "homepages".into(),
                    json!({"Main Homepage": {
                        "value": "tools/obsidian/dashboard/DASHBOARD", "kind": "File",
                        "openOnStartup": true, "autoCreate": false, "view": "Reading view"
                    }}),
                );
            }
            Ok(())
        },
    )?;
    result.settings(
        vault,
        &config_path("plugins/obsidian-checklist-plugin/data.json"),
        json!({}),
        |value| {
            let settings = object(value)?;
            let text = settings.get("includeFiles").map_or(Ok(""), |value| {
                value.as_str().context("Expected includeFiles text")
            })?;
            let mut exclusions: Vec<String> = text
                .lines()
                .map(|line| line.replace("!.obsidian/templates/**", "!tools/obsidian/templates/**"))
                .collect();
            if !exclusions.iter().any(|line| line == "!tools/obsidian/**") {
                exclusions.push("!tools/obsidian/**".into());
            }
            settings.insert("includeFiles".into(), json!(exclusions.join("\n")));
            Ok(())
        },
    )?;
    result.settings(vault, &config_path("appearance.json"), json!({}), |value| {
        let settings = object(value)?;
        let snippets = settings
            .entry("enabledCssSnippets")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .context("Expected enabledCssSnippets list")?;
        let selected = &noema_config::get().obsidian.css_snippets;
        snippets.retain(|item| {
            !managed_snippets.iter().any(|name| item == name)
                || selected.iter().any(|name| item == name)
        });
        for name in selected {
            if !snippets.iter().any(|item| item == name) {
                snippets.push(json!(name));
            }
        }
        Ok(())
    })?;
    for name in ["workspace.json", "workspace-mobile.json"] {
        let relative = config_path(name);
        if safe_path(vault, &relative)?.exists() {
            result.settings(vault, &relative, json!({}), |_| Ok(()))?;
        }
    }
    for relative in RETIRED {
        if safe_path(vault, relative)?.exists() {
            result.retired.push((*relative).into());
        }
    }
    Ok(result)
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path.parent().context("Missing output directory")?;
    fs::create_dir_all(parent)?;
    let mode = fs::metadata(path).map_or(0o600, |metadata| metadata.permissions().mode() & 0o777);
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(content)?;
    temporary.as_file().sync_all()?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(mode))?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn apply(vault: &Path, plan: Plan) -> Result<Option<PathBuf>> {
    if plan.changes.is_empty() && plan.retired.is_empty() {
        return Ok(None);
    }
    let identifier = format!(
        "{}-{}",
        Utc::now().format("%Y%m%dT%H%M%SZ"),
        &Uuid::new_v4().simple().to_string()[..8]
    );
    let backup = safe_path(vault, &config_path(&format!("noema-backups/{identifier}")))?;
    fs::create_dir_all(&backup)?;
    let mut manifest = json!({"files": {}, "retired": plan.retired});
    for (relative, change) in &plan.changes {
        ensure!(
            read_existing(&safe_path(vault, relative)?)? == change.before,
            "File changed during planning: {relative}"
        );
        if let Some(before) = &change.before {
            atomic_write(&backup.join("before").join(relative), before)?;
        }
        manifest["files"][relative] = json!({
            "existed": change.before.is_some(),
            "after_sha256": format!("{:x}", Sha256::digest(&change.after))
        });
    }
    let mut bytes = serde_json::to_vec_pretty(&manifest)?;
    bytes.push(b'\n');
    atomic_write(&backup.join("manifest.json"), &bytes)?;
    for (relative, change) in &plan.changes {
        let path = safe_path(vault, relative)?;
        ensure!(
            read_existing(&path)? == change.before,
            "File changed during deployment; see backup: {relative}"
        );
        atomic_write(&path, &change.after)?;
    }
    for relative in &plan.retired {
        let destination = backup.join("retired").join(relative);
        fs::create_dir_all(destination.parent().context("Missing archive directory")?)?;
        fs::rename(safe_path(vault, relative)?, destination)?;
    }
    Ok(Some(backup))
}

fn build_addon(source: &Path, output: &Path) -> Result<()> {
    let source = source.join("plugins/noema-zotero");
    let addon = source.join("zotero-addon");
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    ensure!(!output.is_symlink(), "Refusing symlinked add-on output");
    let mut temporary = NamedTempFile::new_in(parent)?;
    {
        let mut archive = ZipWriter::new(&mut temporary);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, path) in [
            ("manifest.json", addon.join("manifest.json")),
            ("bootstrap.js", addon.join("bootstrap.js")),
            ("native-template.js", addon.join("native-template.js")),
            (
                "paper-note-template.js",
                source.join("paper-note-template.js"),
            ),
        ] {
            archive.start_file(name, options)?;
            archive.write_all(&fs::read(path)?)?;
        }
        archive.finish()?;
    }
    temporary.as_file().sync_all()?;
    temporary.persist(output).map_err(|error| error.error)?;
    println!("{}", output.canonicalize()?.display());
    Ok(())
}

fn run() -> Result<bool> {
    let cli = Cli::parse();
    let source = source()?;
    let repo = source
        .parent()
        .and_then(Path::parent)
        .context("Missing Noema root")?;
    noema_config::initialize(repo)?;
    match cli.command {
        Command::Deploy(args) => {
            let default_vault = source
                .parent()
                .and_then(Path::parent)
                .context("Missing Noema root")?;
            let vault = args
                .vault_root
                .as_deref()
                .unwrap_or(default_vault)
                .canonicalize()?;
            ensure!(vault.is_dir(), "Vault must be an existing directory");
            let plan = plan(&vault, &source)?;
            println!(
                "Managed changes: {}; legacy paths to archive: {}",
                plan.changes.len(),
                plan.retired.len()
            );
            if args.action.check {
                for relative in plan.changes.keys() {
                    println!("Update: {relative}");
                }
                for relative in &plan.retired {
                    println!("Archive: {relative}");
                }
                return Ok(!plan.changes.is_empty() || !plan.retired.is_empty());
            }
            match apply(&vault, plan)? {
                Some(backup) => println!("Backup: {}", backup.display()),
                None => println!("Deployment is current; no changes made."),
            }
        }
        Command::BuildAddon { output } => {
            let output =
                output.unwrap_or_else(|| PathBuf::from(&noema_config::get().obsidian.addon_output));
            let output = if output.is_absolute() {
                output
            } else {
                repo.join(output)
            };
            build_addon(&source, &output)?;
        }
    }
    Ok(false)
}

fn main() -> ExitCode {
    match run() {
        Ok(false) => ExitCode::SUCCESS,
        Ok(true) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("Noema Obsidian: {error:#}");
            ExitCode::FAILURE
        }
    }
}
