//! Own and manage one per-user LaunchAgent, preserving its previous installation.

use crate::util;
use anyhow::{Context, Result, bail, ensure};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Output},
    thread,
    time::{Duration, Instant},
};

const LABEL: &str = "cn.noema.mobile";

struct Paths {
    root: PathBuf,
    binary: PathBuf,
    plist: PathBuf,
    log: PathBuf,
}

impl Paths {
    fn new(root: &Path) -> Result<Self> {
        let root = root.canonicalize()?;
        let home = std::env::var_os("HOME").context("HOME is not available")?;
        Ok(Self {
            binary: application_binary(&root),
            plist: PathBuf::from(home).join(format!("Library/LaunchAgents/{LABEL}.plist")),
            log: root
                .join(noema_config::MOBILE_DIR)
                .join(".local/service.log"),
            root,
        })
    }

    fn arguments(&self) -> Vec<String> {
        vec![
            self.binary.display().to_string(),
            "run".into(),
            "--repo".into(),
            self.root.display().to_string(),
        ]
    }

    fn owns_arguments(&self, arguments: &[String]) -> bool {
        arguments == self.arguments()
    }

    fn owns_config(&self, data: &Value) -> bool {
        let arguments = data["ProgramArguments"].as_array().and_then(|values| {
            values
                .iter()
                .map(|value| value.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        });
        data["Label"] == LABEL
            && data["WorkingDirectory"] == self.root.display().to_string()
            && arguments.is_some_and(|arguments| self.owns_arguments(&arguments))
    }

    fn existing_config(&self) -> Result<Option<Vec<u8>>> {
        util::no_symlinks(&self.plist)?;
        let content = match fs::read(&self.plist) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let data: Value = plist::from_bytes(&content)
            .context("Existing mobile service plist cannot be verified.")?;
        ensure!(
            self.owns_config(&data),
            "An unrelated service already uses cn.noema.mobile."
        );
        Ok(Some(content))
    }

    fn check_job(&self, job: &Output) -> Result<()> {
        if !job.status.success() {
            return Ok(());
        }
        let text = String::from_utf8_lossy(&job.stdout);
        let source = field(&text, "path")?;
        let arguments = Regex::new(r"(?ms)^\s*arguments = \{\s*\n(.*?)^\s*\}")?
            .captures(&text)
            .map(|capture| {
                capture[1]
                    .lines()
                    .map(|line| line.trim().trim_matches('"').to_owned())
                    .collect::<Vec<_>>()
            });
        ensure!(
            source.as_deref().map(|path| path.trim_matches('"')) == self.plist.to_str()
                && arguments.is_some_and(|arguments| self.owns_arguments(&arguments)),
            "The loaded cn.noema.mobile job does not belong to this checkout."
        );
        Ok(())
    }
}

fn field(text: &str, name: &str) -> Result<Option<String>> {
    Ok(
        Regex::new(&format!(r"(?m)^\s*{} = (.+)$", regex::escape(name)))?
            .captures(text)
            .map(|capture| capture[1].trim().to_owned()),
    )
}

fn target() -> String {
    format!("gui/{}/{LABEL}", unsafe { libc::getuid() })
}

fn launchctl(arguments: &[&str]) -> Result<Output> {
    util::capture(
        Command::new("/bin/launchctl").args(arguments),
        None,
        Duration::from_secs(20),
    )
}

fn job() -> Result<Output> {
    launchctl(&["print", &target()])
}

fn require_success(result: Output, action: &str) -> Result<()> {
    if !result.status.success() {
        let errors = String::from_utf8_lossy(&result.stderr);
        let detail = if errors.trim().is_empty() {
            format!("exit {}", result.status)
        } else {
            errors.trim().to_owned()
        };
        bail!("Could not {action} mobile service: {detail}");
    }
    Ok(())
}

fn wait_for_exit(job: &Output) -> Result<()> {
    let Some(pid) = field(&String::from_utf8_lossy(&job.stdout), "pid")?
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|pid| *pid > 0)
    else {
        return Ok(());
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if unsafe { libc::kill(pid, 0) } < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            bail!("Could not check whether mobile service PID {pid} exited: {error}");
        }
        ensure!(
            Instant::now() < deadline,
            "Mobile service PID {pid} did not exit within 10 seconds; check service.log before retrying."
        );
        thread::sleep(
            Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

fn bootstrap(paths: &Paths) -> Result<()> {
    let delays = [200, 500, 1000];
    let domain = format!("gui/{}", unsafe { libc::getuid() });
    for attempt in 0..=delays.len() {
        let result = launchctl(&[
            "bootstrap",
            &domain,
            paths.plist.to_str().context("Invalid LaunchAgent path")?,
        ])?;
        if result.status.success() {
            return Ok(());
        }
        if result.status.code() != Some(5) || attempt == delays.len() {
            return require_success(result, "start");
        }
        let current = job()?;
        paths.check_job(&current)?;
        let missing = current.status.code() == Some(113)
            || (!current.status.success()
                && String::from_utf8_lossy(&current.stderr).contains("Could not find service"));
        if !missing {
            return require_success(result, "start");
        }
        thread::sleep(Duration::from_millis(delays[attempt]));
    }
    bail!("Could not start mobile service")
}

fn environment() -> Value {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut directories = vec![home.join(".local/bin")];
    directories.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .into_iter()
        .map(PathBuf::from),
    );
    directories.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let mut seen = HashSet::new();
    directories.retain(|path| path.is_absolute() && path.is_dir() && seen.insert(path.clone()));
    let mut environment =
        json!({"PATH": std::env::join_paths(directories).unwrap_or_default().to_string_lossy()});
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] {
        for key in [name.to_owned(), name.to_lowercase()] {
            if let Ok(value) = std::env::var(&key) {
                environment[&key] = value.into();
            }
        }
    }
    environment
}

fn config(paths: &Paths) -> Value {
    json!({"Label":LABEL,"ProgramArguments":paths.arguments(),"WorkingDirectory":paths.root,
        "RunAtLoad":true,"KeepAlive":{"SuccessfulExit":false},"ThrottleInterval":30,"ProcessType":"Background",
        "LimitLoadToSessionType":"Aqua","Umask":0o077,"StandardOutPath":paths.log,"StandardErrorPath":paths.log,"EnvironmentVariables":environment()})
}

fn remove_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn install(root: &Path) -> Result<PathBuf> {
    let paths = Paths::new(root)?;
    let executable = std::env::current_exe()?;
    util::no_symlinks(&executable)?;
    ensure!(
        executable.is_file(),
        "The mobile controller must be a real executable."
    );

    for directory in [paths.plist.parent(), paths.log.parent()]
        .into_iter()
        .flatten()
    {
        util::no_symlinks(directory)?;
        fs::create_dir_all(directory)?;
    }
    fs::set_permissions(
        paths.log.parent().context("Missing runtime directory")?,
        fs::Permissions::from_mode(0o700),
    )?;
    let old = paths.existing_config()?;
    let loaded = job()?;
    paths.check_job(&loaded)?;
    util::no_symlinks(&paths.binary)?;
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&paths.log)?;
    ensure!(
        log.metadata()?.nlink() == 1,
        "Refusing a hard-linked service log."
    );
    log.set_permissions(fs::Permissions::from_mode(0o600))?;
    let new_config = config(&paths);
    if loaded.status.success() {
        require_success(launchctl(&["bootout", &target()])?, "stop")?;
        wait_for_exit(&loaded)?;
    }
    let installation = (|| -> Result<()> {
        prepare_app(root)?;
        let mut bytes = Vec::new();
        plist::to_writer_xml(&mut bytes, &new_config)?;
        util::private_write(&paths.plist, &bytes)?;
        bootstrap(&paths)
    })();
    if let Err(error) = installation {
        let restoration = (|| -> Result<()> {
            let current = job()?;
            paths.check_job(&current)?;
            if current.status.success() {
                require_success(
                    launchctl(&["bootout", &target()])?,
                    "stop failed installation",
                )?;
                wait_for_exit(&current)?;
            }
            if let Some(bytes) = &old {
                util::private_write(&paths.plist, bytes)?;
                if loaded.status.success() {
                    bootstrap(&paths)?;
                }
            } else {
                remove_if_present(&paths.plist)?;
            }
            Ok(())
        })();
        if let Err(restore_error) = restoration {
            bail!("{error}; previous service could not be restored: {restore_error}");
        }
        return Err(error);
    }
    Ok(paths.plist)
}

pub fn uninstall(root: &Path) -> Result<()> {
    let paths = Paths::new(root)?;
    paths.existing_config()?;
    let loaded = job()?;
    paths.check_job(&loaded)?;
    if loaded.status.success() {
        require_success(launchctl(&["bootout", &target()])?, "stop")?;
        wait_for_exit(&loaded)?;
    }
    remove_if_present(&paths.plist)
}

pub fn service_status(root: &Path) -> Result<Value> {
    let paths = Paths::new(root)?;
    let old = paths.existing_config()?;
    let loaded = job()?;
    paths.check_job(&loaded)?;
    let text = String::from_utf8_lossy(&loaded.stdout);
    let pid = field(&text, "pid")?.and_then(|value| value.parse::<i32>().ok());
    let last_exit = field(&text, "last exit code")?.and_then(|value| value.parse::<i32>().ok());
    Ok(
        json!({"label":LABEL,"installed":old.is_some(),"loaded":loaded.status.success(),"running":pid.is_some(),
        "state":field(&text,"state")?.unwrap_or_else(|| "not loaded".into()),"pid":pid,"last_exit":last_exit,"plist":paths.plist,"log":paths.log}),
    )
}

fn application_dir(root: &Path) -> PathBuf {
    root.join(noema_config::MOBILE_DIR).join(".local/Noema.app")
}

pub fn application_binary(root: &Path) -> PathBuf {
    application_dir(root).join("Contents/MacOS/noema-mobile")
}

/// One signed Rust application owns Apple permissions and the background worker.
pub fn prepare_app(root: &Path) -> Result<PathBuf> {
    let binary = application_binary(root);
    let executable = std::env::current_exe()?;
    if executable == binary {
        return Ok(binary);
    }
    let bytes = fs::read(executable)?;
    let info = json!({
        "CFBundleIdentifier":LABEL,"CFBundleExecutable":"noema-mobile",
        "CFBundleName":"Noema","CFBundleDisplayName":"Noema","CFBundlePackageType":"APPL",
        "CFBundleVersion":"1","CFBundleShortVersionString":env!("CARGO_PKG_VERSION"),
        "NoemaSourceDigest":util::digest(&bytes),
        "LSMinimumSystemVersion":"14.0","LSUIElement":true,"NSHighResolutionCapable":true,
        "NSAppleEventsUsageDescription":"Noema reads requests and adds personal answers in your Noema Notes folder.",
        "NSRemindersFullAccessUsageDescription":"Noema synchronizes your dedicated Noema reminder list with daily notes.",
        "NSRemindersUsageDescription":"Noema synchronizes your dedicated Noema reminder list with daily notes."
    });
    let app = application_dir(root);
    util::no_symlinks(&app)?;
    // Signing changes executable bytes; compare the original build identity instead.
    if binary.is_file()
        && fs::read(app.join("Contents/Info.plist"))
            .ok()
            .and_then(|bytes| plist::from_bytes::<Value>(&bytes).ok())
            .as_ref()
            == Some(&info)
    {
        return Ok(binary);
    }
    let local = app.parent().context("Missing application directory")?;
    fs::create_dir_all(local)?;
    let staging = tempfile::Builder::new()
        .prefix(".app-build-")
        .tempdir_in(local)?;
    let candidate = staging.path().join("Noema.app");
    let target = candidate.join("Contents/MacOS/noema-mobile");
    util::private_write(&target, &bytes)?;
    fs::set_permissions(&target, fs::Permissions::from_mode(0o700))?;
    let mut xml = Vec::new();
    plist::to_writer_xml(&mut xml, &info)?;
    util::private_write(&candidate.join("Contents/Info.plist"), &xml)?;
    let signed = util::capture(
        Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-", "--identifier", LABEL])
            .arg(&candidate),
        None,
        Duration::from_secs(20),
    )?;
    ensure!(
        signed.status.success(),
        "Could not sign Noema.app: {}",
        String::from_utf8_lossy(&signed.stderr)
    );
    let previous = staging.path().join("previous.app");
    if app.exists() {
        fs::rename(&app, &previous)?;
    }
    if let Err(error) = fs::rename(&candidate, &app) {
        if previous.exists() {
            fs::rename(&previous, &app)?;
        }
        return Err(error.into());
    }
    Ok(binary)
}
