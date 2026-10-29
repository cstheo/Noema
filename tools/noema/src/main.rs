use anyhow::{Context, Result, ensure};
use clap::{ArgGroup, Args, Parser, Subcommand};
use noema_memory::{check, context, lock, record, repository, require_complete, store::Overlay};
use std::{
    io::{self, Read},
    path::PathBuf,
    process::ExitCode,
};

#[derive(Parser)]
#[command(about = "Retrieve, record, and check Noema memory")]
struct Cli {
    #[arg(long, global = true)]
    root: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Validate memory structure, evidence, and dependencies without writes.
    Check {
        #[arg(long)]
        json: bool,
    },
    /// Select bounded, evidence-linked context without writes.
    Context {
        #[arg(long)]
        work: Option<String>,
        #[arg(long, default_value = "")]
        query: String,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long, default_value_t = 12000, value_parser = clap::value_parser!(usize))]
        max_chars: usize,
        #[arg(long)]
        bootstrap: bool,
        #[arg(long)]
        json: bool,
    },
    /// Publish a checked JSON change set, or recover an interrupted write.
    Record(Record),
}

#[derive(Args)]
#[command(group(ArgGroup::new("source").required(true).args(["input", "recover"])))]
struct Record {
    /// JSON change set; use - for stdin.
    input: Option<PathBuf>,
    #[arg(long)]
    recover: bool,
    #[arg(long, conflicts_with = "recover")]
    dry_run: bool,
    #[arg(long)]
    json: bool,
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(clean) => {
            if clean {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("{error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<bool> {
    let root = repository(cli.root.as_deref())?;
    let write = matches!(&cli.command, Command::Record(_));
    let _lock = lock(&root, write)?;
    match cli.command {
        Command::Check { json } => {
            require_complete(&root)?;
            let check::Inspection { pages, report, .. } = check::inspect(&root, &Overlay::new())?;
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
            require_complete(&root)?;
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
        Command::Record(args) => {
            let output = if args.recover {
                record::recover(&root)?
            } else {
                let path = args.input.context("Supply a change set")?;
                let mut bytes = Vec::new();
                if path.as_os_str() == "-" {
                    io::stdin().take(1_048_577).read_to_end(&mut bytes)?;
                } else {
                    std::fs::File::open(&path)
                        .with_context(|| format!("Open {}", path.display()))?
                        .take(1_048_577)
                        .read_to_end(&mut bytes)?;
                }
                ensure!(bytes.len() <= 1_048_576, "Change set exceeds 1 MiB");
                let request: record::Request =
                    serde_json::from_slice(&bytes).context("Parse change set")?;
                record::apply(&root, &request, args.dry_run)?
            };
            if args.json {
                println!("{}", serde_json::to_string_pretty(&output)?);
            } else if args.recover {
                println!("Recovered {}", output.id);
            } else if output.already_recorded {
                println!("Already recorded {}", output.id);
            } else {
                println!(
                    "{} {}: {} files",
                    if args.dry_run {
                        "Validated"
                    } else {
                        "Recorded"
                    },
                    output.id,
                    output.changed.len()
                );
            }
            Ok(true)
        }
    }
}
