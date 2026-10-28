use anyhow::{Context, Result, ensure};
use clap::Parser;
use noema_memory::{
    hooks::{self, Event},
    repository,
};
use serde_json::json;
use std::{
    io::{self, Read},
    path::PathBuf,
    process::ExitCode,
};

#[derive(Parser)]
#[command(about = "Load Noema context and request lifecycle reviews")]
struct Cli {
    #[arg(long)]
    root: Option<PathBuf>,
}

fn main() -> ExitCode {
    let result = match Cli::try_parse() {
        Ok(cli) => run(cli),
        Err(error) if !error.use_stderr() => {
            print!("{error}");
            return ExitCode::SUCCESS;
        }
        Err(error) => Err(error.into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Noema hook: {error:#}");
            println!(
                "{}",
                json!({"systemMessage":"Noema lifecycle event could not be processed. Inspect the hook error before relying on automatic loading or consolidation."})
            );
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<()> {
    let mut bytes = Vec::new();
    io::stdin().take(65_537).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 65_536, "Hook input exceeds 64 KiB");
    let event: Event = serde_json::from_slice(&bytes).context("Parse hook event")?;
    let root = repository(cli.root.as_deref())?;
    println!("{}", serde_json::to_string(&hooks::run(&root, event)?)?);
    Ok(())
}
