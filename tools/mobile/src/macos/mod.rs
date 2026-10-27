//! Apple APIs stay at this boundary; the worker and records remain plain Rust.

pub mod events;
pub mod notes;
pub mod reminders;

use anyhow::Result;
use objc2::{MainThreadMarker, rc::autoreleasepool};
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

/// AppKit owns the main thread, while blocking synchronization runs on one worker.
/// This also gives macOS privacy prompts the installed application's identity.
pub fn run(work: impl FnOnce() -> Result<()> + Send + 'static) -> ! {
    let Some(main) = MainThreadMarker::new() else {
        eprintln!("Noema must start on the main thread");
        std::process::exit(1);
    };
    let app = NSApplication::sharedApplication(main);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    dispatch2::DispatchQueue::main().exec_async(move || {
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                autoreleasepool(|_| work())
            }))
            .unwrap_or_else(|_| Err(anyhow::anyhow!("Noema synchronization worker panicked")));
            if let Err(error) = result {
                eprintln!("{error:#}");
                std::process::exit(1);
            }
            dispatch2::DispatchQueue::main().exec_async(|| {
                if let Some(main) = MainThreadMarker::new() {
                    NSApplication::sharedApplication(main).terminate(None);
                }
            });
        });
    });
    app.run();
    std::process::exit(0)
}
