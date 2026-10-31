use anyhow::{Result, ensure};
use clap::{Parser, Subcommand};
use noema_memory::{check, context, repository};
use std::{path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(about = "Recall and check Noema memory")]
struct Cli {
    #[arg(long, global = true)]
    root: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Validate memory structure and review dates without writes.
    Check {
        #[arg(long)]
        json: bool,
    },
    /// Select bounded task context without writes.
    Context {
        #[arg(long)]
        work: Option<String>,
        #[arg(long, default_value = "")]
        query: String,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long, default_value_t = 12000)]
        max_chars: usize,
        #[arg(long)]
        bootstrap: bool,
        #[arg(long)]
        json: bool,
    },
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("{error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<bool> {
    let root = repository(cli.root.as_deref())?;
    match cli.command {
        Command::Check { json } => {
            let check::Inspection { pages, report } = check::inspect(&root)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!(
                    "{} pages; {} errors; {} warnings",
                    pages.len(),
                    report.errors.len(),
                    report.warnings.len()
                );
                for error in &report.errors {
                    println!("error: {error}");
                }
                for warning in &report.warnings {
                    println!("review: {warning}");
                }
            }
            Ok(report.is_clean())
        }
        Command::Context {
            work,
            query,
            cwd,
            max_chars,
            bootstrap,
            json,
        } => {
            ensure!(
                (256..=100_000).contains(&max_chars),
                "--max-chars must be between 256 and 100000"
            );
            let output = context::context(
                &root,
                &context::Options {
                    query,
                    work,
                    cwd: cwd.or_else(|| std::env::current_dir().ok()),
                    max_chars,
                    bootstrap,
                },
            )?;
            if json {
                println!("{}", serde_json::to_string_pretty(&output)?);
            } else {
                print!("{}", output.text);
            }
            Ok(true)
        }
    }
}
