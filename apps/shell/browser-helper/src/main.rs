//! Chromium starts its renderer, GPU and utility processes from this program, which lives in
//! `Contents/Frameworks/Gustaf Browser Helper.app` beside the framework.

#[cfg(target_os = "macos")]
fn main() {
    use cef::{args::Args, *};

    let args = Args::new();
    let exe = std::env::current_exe().expect("helper path");
    // The sandbox library sits in the framework, three levels up from `X.app/Contents/MacOS`.
    let _sandbox = (!std::env::args().any(|arg| arg == "--no-sandbox")).then(|| {
        let mut sandbox = cef::sandbox::Sandbox::new();
        sandbox.initialize(args.as_main_args());
        sandbox
    });
    let loader = library_loader::LibraryLoader::new(&exe, true);
    assert!(loader.load(), "the Chromium framework did not load");
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let code = execute_process(
        Some(args.as_main_args()),
        None::<&mut App>,
        std::ptr::null_mut(),
    );
    std::process::exit(code);
}

#[cfg(not(target_os = "macos"))]
fn main() {}
