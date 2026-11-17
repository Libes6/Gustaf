//! CEF's renderer, GPU and utility processes. It ships inside the module, next to the framework.

use cef::{args::Args, *};

#[path = "../quiet_crash.rs"]
mod quiet_crash;

fn main() {
    quiet_crash::install();
    let args = Args::new();
    let exe = std::env::current_exe().expect("helper path");

    // The sandbox library lives in the framework, three levels up from `X.app/Contents/MacOS`.
    let _sandbox = (!std::env::args().any(|arg| arg == "--no-sandbox")).then(|| {
        let mut sandbox = cef::sandbox::Sandbox::new();
        sandbox.initialize(args.as_main_args());
        sandbox
    });

    let loader = library_loader::LibraryLoader::new(&exe, true);
    assert!(loader.load(), "the CEF framework did not load");
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    // Chromium may have replaced the handlers while it loaded.
    quiet_crash::install();
    let code = execute_process(
        Some(args.as_main_args()),
        None::<&mut App>,
        std::ptr::null_mut(),
    );
    std::process::exit(code);
}
