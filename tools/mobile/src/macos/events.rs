//! Vnode notifications for the configured journal, without an idle scan timer.

use anyhow::{Context, Result, bail};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc::Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

struct Queue(OwnedFd);

impl Queue {
    fn new() -> Result<Self> {
        // SAFETY: kqueue returns a new descriptor, transferred once to OwnedFd.
        let descriptor = unsafe { libc::kqueue() };
        if descriptor < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self(unsafe { OwnedFd::from_raw_fd(descriptor) }))
    }

    fn add(&self, ident: usize, filter: i16, flags: u16, fflags: u32) -> Result<()> {
        let event = libc::kevent {
            ident,
            filter,
            flags,
            fflags,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: the change pointer is valid for one event; no output is requested.
        let result = unsafe {
            libc::kevent(
                self.0.as_raw_fd(),
                &event,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        };
        if result < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    fn wait(&self, timeout: Option<Duration>) -> Result<Vec<libc::kevent>> {
        let zero = libc::kevent {
            ident: 0,
            filter: 0,
            flags: 0,
            fflags: 0,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let mut events = [zero; 64];
        let duration = timeout.map(|value| libc::timespec {
            tv_sec: value.as_secs().try_into().unwrap_or(libc::time_t::MAX),
            tv_nsec: value.subsec_nanos().into(),
        });
        loop {
            // SAFETY: the output buffer holds 64 events; timeout lives through this call.
            let count = unsafe {
                libc::kevent(
                    self.0.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    events.as_mut_ptr(),
                    events.len() as i32,
                    duration.as_ref().map_or(std::ptr::null(), |value| value),
                )
            };
            if count >= 0 {
                let received = events[..count as usize].to_vec();
                for event in &received {
                    if event.flags & libc::EV_ERROR != 0 && event.data != 0 {
                        bail!(
                            "kqueue: {}",
                            std::io::Error::from_raw_os_error(event.data as i32)
                        );
                    }
                }
                return Ok(received);
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error.into());
            }
        }
    }
}

type Stamp = (u64, u64, i64, i64, u64);
type Snapshot = BTreeMap<PathBuf, Stamp>;

fn inspect(
    path: &Path,
    wanted: &mut BTreeSet<PathBuf>,
    snapshot: &mut Snapshot,
    descend: bool,
) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Ok(());
    }
    wanted.insert(path.to_path_buf());
    snapshot.insert(
        path.to_path_buf(),
        (
            metadata.dev(),
            metadata.ino(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.len(),
        ),
    );
    if metadata.is_dir() && descend {
        let entries = match fs::read_dir(path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if kind.is_dir()
                || (kind.is_file() && entry.path().extension().is_some_and(|value| value == "md"))
            {
                inspect(&entry.path(), wanted, snapshot, true)?;
            }
        }
    }
    Ok(())
}

struct JournalWatch {
    root: PathBuf,
    queue: Queue,
    files: BTreeMap<PathBuf, (File, u64, u64)>,
    snapshot: Snapshot,
}

impl JournalWatch {
    fn refresh(&mut self) -> Result<bool> {
        let mut wanted = BTreeSet::new();
        let mut snapshot = BTreeMap::new();
        for supplied in crate::journal::watch_paths(&self.root)? {
            let mut parent = supplied.clone();
            while !parent.exists() || parent.canonicalize().ok().as_ref() != Some(&parent) {
                if !parent.pop() {
                    break;
                }
            }
            wanted.insert(if parent.is_dir() {
                parent
            } else {
                parent.parent().unwrap_or(&self.root).to_path_buf()
            });
            if supplied.canonicalize().ok().as_ref() != Some(&supplied) {
                continue;
            }
            if supplied.is_dir()
                && let Some(parent) = supplied.parent()
            {
                wanted.insert(parent.to_path_buf());
            }
            inspect(&supplied, &mut wanted, &mut snapshot, true)?;
        }
        self.files.retain(|path, (_, device, inode)| {
            wanted.contains(path)
                && fs::symlink_metadata(path)
                    .is_ok_and(|metadata| metadata.dev() == *device && metadata.ino() == *inode)
        });
        for path in wanted {
            if self.files.contains_key(&path) {
                continue;
            }
            let file = match OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_EVTONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&path)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            let metadata = file.metadata()?;
            self.queue.add(
                file.as_raw_fd() as usize,
                libc::EVFILT_VNODE,
                libc::EV_ADD | libc::EV_CLEAR,
                libc::NOTE_WRITE
                    | libc::NOTE_EXTEND
                    | libc::NOTE_ATTRIB
                    | libc::NOTE_RENAME
                    | libc::NOTE_DELETE
                    | libc::NOTE_REVOKE,
            )?;
            self.files
                .insert(path, (file, metadata.dev(), metadata.ino()));
        }
        let changed = snapshot != self.snapshot;
        self.snapshot = snapshot;
        Ok(changed)
    }
}

pub struct Watcher {
    stop: UnixStream,
    thread: Option<JoinHandle<()>>,
    error: Arc<Mutex<Option<String>>>,
}

impl Watcher {
    pub fn error(&self) -> Option<String> {
        self.error
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.stop.write_all(b"x");
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn watch(root: &Path, wake: Sender<crate::Event>) -> Result<Watcher> {
    let (stop, reader) = UnixStream::pair()?;
    let mut state = JournalWatch {
        root: root.to_path_buf(),
        queue: Queue::new()?,
        files: BTreeMap::new(),
        snapshot: BTreeMap::new(),
    };
    state.queue.add(
        reader.as_raw_fd() as usize,
        libc::EVFILT_READ,
        libc::EV_ADD | libc::EV_CLEAR,
        0,
    )?;
    state
        .refresh()
        .context("initialize journal notifications")?;
    let error = Arc::new(Mutex::new(None));
    let failures = Arc::clone(&error);
    let thread = thread::Builder::new()
        .name("journal-events".into())
        .spawn(move || {
            let result = (|| -> Result<()> {
                loop {
                    let events = state.queue.wait(None)?;
                    if events.iter().any(|event| {
                        event.ident == reader.as_raw_fd() as usize
                            && event.filter == libc::EVFILT_READ
                    }) {
                        return Ok(());
                    }
                    let deadline = Instant::now() + Duration::from_secs(1);
                    loop {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            break;
                        }
                        let events = state
                            .queue
                            .wait(Some(remaining.min(Duration::from_millis(250))))?;
                        if events.iter().any(|event| {
                            event.ident == reader.as_raw_fd() as usize
                                && event.filter == libc::EVFILT_READ
                        }) {
                            return Ok(());
                        }
                        if events.is_empty() {
                            break;
                        }
                    }
                    if state.refresh()? && wake.send(crate::Event::Todos).is_err() {
                        return Ok(());
                    }
                }
            })();
            if let Err(failure) = result {
                *failures.lock().unwrap_or_else(|error| error.into_inner()) =
                    Some(failure.to_string());
                let _ = wake.send(crate::Event::Todos);
            }
        })?;
    Ok(Watcher {
        stop,
        thread: Some(thread),
        error,
    })
}
