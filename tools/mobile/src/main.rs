mod agent;
mod bridge;
mod journal;
mod macos;
mod service;
mod state;
mod tasks;
mod util;

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use fs2::FileExt;
use macos::{notes, reminders};
use serde_json::{Value, json};
use state::{Bindings, Paths};
use std::{fs::OpenOptions, os::unix::fs::OpenOptionsExt, path::PathBuf};
use uuid::Uuid;

/// Daily Notes, iCloud Reminders, and personal answers on the Mac.
#[derive(Parser)]
#[command(name = "noema-mobile", version)]
struct Cli {
    #[arg(
        long,
        global = true,
        help = "Noema repository (detected from the executable or working directory)"
    )]
    repo: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create the dedicated iCloud Notes folders.
    Init {
        #[arg(long)]
        account_id: Option<String>,
    },
    /// Connect the dedicated iCloud Reminders list.
    InitReminders {
        #[arg(long)]
        account_id: Option<String>,
    },
    /// Run independently of a chat window or Obsidian.
    Run,
    /// Show local tasks, integration errors, and launchd state.
    Status,
    /// Install the Rust executable and start the user LaunchAgent.
    Install,
    /// Stop the LaunchAgent, preserving all records.
    Uninstall,
    /// Create an AI research request from the Mac.
    Submit { text: String },
}

pub enum Event {
    Todos,
    Completed {
        note_id: String,
        version: String,
        result: std::result::Result<String, String>,
    },
    Stop,
}

fn repository(selected: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(root) = selected {
        return Ok(root);
    }
    for start in [std::env::current_exe()?, std::env::current_dir()?] {
        if let Some(root) = start.ancestors().find(|root| {
            root.join(noema_config::MOBILE_DIR)
                .join("Cargo.toml")
                .is_file()
                && root.join("corpus").is_dir()
        }) {
            return Ok(root.to_owned());
        }
    }
    anyhow::bail!("Select the Noema repository with --repo");
}

fn initialize(paths: &Paths, account_id: Option<&str>) -> Result<Value> {
    let bindings = if paths.local.join(state::BINDINGS_FILE).exists() {
        let bindings = paths.bindings()?;
        ensure!(
            account_id.is_none_or(|id| id == bindings.account_id),
            "This worker is already bound to another account; preserve its state before rebinding"
        );
        bindings
    } else {
        let listing = notes::call("probe", None, json!({}))?;
        let candidates = listing["accounts"]
            .as_array()
            .context("Missing Notes accounts")?
            .iter()
            .filter(|account| {
                account_id.map_or(account["name"] == "iCloud", |id| account["id"] == id)
            })
            .collect::<Vec<_>>();
        ensure!(
            candidates.len() == 1,
            "Select the iCloud account explicitly with --account-id; local-only Notes are not a mobile link"
        );
        Bindings {
            account_id: candidates[0]["id"]
                .as_str()
                .context("Invalid Notes account")?
                .into(),
            reminders: None,
        }
    };
    notes::call("setup", Some(&bindings.account_id), json!({}))?;
    paths.save_bindings(&bindings)?;
    paths.database()?;
    Ok(
        json!({"initialized":true,"notes_folder":noema_config::get().mobile.notes_folder,
        "agent":agent::status()}),
    )
}

fn status(paths: &Paths) -> Result<Value> {
    let db = paths.database()?;
    let mut reminders = state::metadata(&db, &["reminders_last_contact", "reminders_error"])?;
    reminders["enabled"] = json!(paths.bindings()?.reminders.is_some());
    let tasks = state::requests(&db)?.iter().map(|task| json!({
        "note_id":task.note_id,"status":task.status,"updated":task.updated,"error":task.error
    })).collect::<Vec<_>>();
    Ok(
        json!({"service":service::service_status(&paths.repo)?,"agent":agent::status(),
        "connection":state::metadata(&db,&["last_contact","notes_error"])?,
        "reminders":reminders,"todos":state::metadata(&db,&["todos_last_contact","todos_error"])?,
        "events":state::metadata(&db,&["journal_events","reminders_events"])?,"requests":tasks}),
    )
}

fn run(cli: Cli) -> Result<()> {
    // Runtime state and subprocess logs contain private personal material.
    unsafe {
        libc::umask(0o077);
    }
    let repo = repository(cli.repo)?;
    let paths = Paths::new(&repo)?;
    let result = match cli.command {
        Command::Init { account_id } => initialize(&paths, account_id.as_deref())?,
        Command::InitReminders { account_id } => {
            let mut bindings = paths.bindings()?;
            reminders::call("authorize", json!({}))?;
            let mut call = reminders::call;
            let selected = tasks::initialize(
                &mut call,
                bindings.reminders.as_ref(),
                account_id.as_deref(),
            )?;
            bindings.reminders =
                Some(json!({"account_id":selected["account_id"],"list_id":selected["list_id"]}));
            paths.save_bindings(&bindings)?;
            json!({"initialized":true,"list":noema_config::get().mobile.reminders_list,"restart":"Run install to restart the worker."})
        }
        Command::Run => {
            let lock_path = paths.local.join("worker.lock");
            util::no_symlinks(&lock_path)?;
            let lock = OpenOptions::new()
                .append(true)
                .create(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(lock_path)?;
            FileExt::try_lock_exclusive(&lock).context("The mobile worker is already running")?;
            let bindings = paths.bindings()?;
            let db = paths.database()?;
            bridge::Bridge::new(paths, bindings, db)?.run()?;
            return Ok(());
        }
        Command::Status => status(&paths)?,
        Command::Install => {
            json!({"installed":service::install(&paths.repo)?,"service":service::service_status(&paths.repo)?})
        }
        Command::Uninstall => {
            service::uninstall(&paths.repo)?;
            json!({"uninstalled":true,"data_preserved":true})
        }
        Command::Submit { text } => {
            ensure!(
                !text.trim().is_empty() && text.chars().count() <= 32_000,
                "A request must contain 1–32,000 characters"
            );
            let bindings = paths.bindings()?;
            let title = format!(
                "Request {} {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                &Uuid::new_v4().simple().to_string()[..4]
            );
            let result = notes::call(
                "create",
                Some(&bindings.account_id),
                json!({
                    "title":title,"text":text
                }),
            )?;
            json!({"created":result["created"],"folder":noema_config::get().mobile.notes_folder})
        }
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn main() {
    let cli = Cli::parse();
    let native = matches!(
        cli.command,
        Command::Run
            | Command::Init { .. }
            | Command::InitReminders { .. }
            | Command::Submit { .. }
    );
    let result = (|| -> Result<()> {
        let root = repository(cli.repo.clone())?.canonicalize()?;
        if !matches!(cli.command, Command::Uninstall) {
            noema_config::initialize(&root)?;
        }
        if native {
            let installed = service::application_binary(&root);
            if std::env::current_exe()? != installed {
                service::prepare_app(&root)?;
                use std::os::unix::process::CommandExt;
                return Err(std::process::Command::new(installed)
                    .args(std::env::args_os().skip(1))
                    .exec()
                    .into());
            }
            macos::run(move || run(cli));
        }
        run(cli)
    })();
    if let Err(error) = result {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
