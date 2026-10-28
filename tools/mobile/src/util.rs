use anyhow::{Context, Result, ensure};
use std::{
    collections::BTreeSet,
    fs,
    io::{Seek, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{DirBuilderExt, PermissionsExt},
            process::CommandExt,
        },
    },
    path::Path,
    process::{Child, Command, ExitStatus, Output, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Default)]
struct Processes {
    cancelled: bool,
    pids: BTreeSet<u32>,
}

static PROCESSES: Mutex<Processes> = Mutex::new(Processes {
    cancelled: false,
    pids: BTreeSet::new(),
});

struct Captured {
    child: Child,
    tracked: bool,
}

fn kill_group(pid: u32) {
    // Each child starts a separate process group, including its descendants.
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}

impl Captured {
    fn spawn(command: &mut Command) -> Result<Self> {
        let mut processes = PROCESSES
            .lock()
            .map_err(|_| anyhow::anyhow!("Command registry poisoned"))?;
        ensure!(
            !processes.cancelled,
            "Command cancelled; the service is stopping"
        );
        let child = command
            .process_group(0)
            .spawn()
            .context("Could not start command")?;
        processes.pids.insert(child.id());
        Ok(Self {
            child,
            tracked: true,
        })
    }

    fn try_wait(&mut self) -> Result<Option<ExitStatus>> {
        let mut processes = PROCESSES
            .lock()
            .map_err(|_| anyhow::anyhow!("Command registry poisoned"))?;
        ensure!(
            !processes.cancelled,
            "Command cancelled; the service is stopping"
        );
        let status = self.child.try_wait()?;
        if status.is_some() && self.tracked {
            // Stop descendants that kept the pipes open after their parent exited.
            kill_group(self.child.id());
            processes.pids.remove(&self.child.id());
            self.tracked = false;
        }
        Ok(status)
    }
}

impl Drop for Captured {
    fn drop(&mut self) {
        if self.tracked {
            let mut processes = PROCESSES
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            kill_group(self.child.id());
            processes.pids.remove(&self.child.id());
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

pub fn no_symlinks(path: &Path) -> Result<()> {
    for part in path.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(metadata) => ensure!(
                !metadata.file_type().is_symlink(),
                "Refusing a symlinked path: {}",
                part.display()
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).with_context(|| format!("Inspect {}", part.display())),
        }
    }
    Ok(())
}

pub fn private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    no_symlinks(path)?;
    let parent = path.parent().context("File has no parent directory")?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)?;
    no_symlinks(path)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    no_symlinks(path)?;
    file.persist(path)?;
    Ok(())
}

pub fn cancel_running() {
    let mut processes = PROCESSES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    processes.cancelled = true;
    for &pid in &processes.pids {
        kill_group(pid);
    }
}

/// Bounded command execution; credentials and request text never enter argv.
pub fn capture(command: &mut Command, input: Option<&[u8]>, timeout: Duration) -> Result<Output> {
    ensure!(!timeout.is_zero(), "Command timeout must be positive");
    let mut stdin = tempfile::tempfile()?;
    if let Some(bytes) = input {
        stdin.write_all(bytes)?;
    }
    stdin.rewind()?;
    let mut process = Captured::spawn(
        command
            .stdin(stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )?;
    const LIMIT: usize = 8 * 1024 * 1024;
    let output = process.child.stdout.take().context("Missing stdout pipe")?;
    let errors = process.child.stderr.take().context("Missing stderr pipe")?;
    let mut streams = [
        libc::pollfd {
            fd: output.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: errors.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut buffer = [0_u8; 65536];
    let deadline = Instant::now() + timeout;
    let mut status = None;
    loop {
        if status.is_none() {
            status = process.try_wait()?;
        }
        if streams.iter().all(|stream| stream.fd < 0)
            && let Some(status) = status
        {
            return Ok(Output {
                status,
                stdout,
                stderr,
            });
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        ensure!(
            !remaining.is_zero(),
            "Command timed out after {} seconds",
            timeout.as_secs()
        );
        // Owned output/error pipes remain open until this function returns.
        let ready = unsafe {
            libc::poll(
                streams.as_mut_ptr(),
                streams.len() as libc::nfds_t,
                remaining.as_millis().clamp(1, 25) as libc::c_int,
            )
        };
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
        for (index, stream) in streams.iter_mut().enumerate() {
            if stream.fd < 0 || stream.revents == 0 {
                continue;
            }
            ensure!(
                stream.revents & libc::POLLNVAL == 0,
                "Command pipe closed unexpectedly"
            );
            let count = unsafe { libc::read(stream.fd, buffer.as_mut_ptr().cast(), buffer.len()) };
            if count < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error.into());
            }
            if count == 0 {
                stream.fd = -1;
                continue;
            }
            ensure!(
                stdout.len() + stderr.len() + count as usize <= LIMIT,
                "Command output exceeded 8 MiB"
            );
            if index == 0 {
                stdout.extend_from_slice(&buffer[..count as usize]);
            } else {
                stderr.extend_from_slice(&buffer[..count as usize]);
            }
        }
    }
}
