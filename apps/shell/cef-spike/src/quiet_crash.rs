//! Chromium ends itself with a trap when it cannot go on (a `FATAL` log line). Left alone, each
//! one raises the system's "quit unexpectedly" window; the spike's experiments are expected to
//! hit a few, so it exits plainly instead. Not for the product.

extern "C" fn exit_quietly(signal: libc::c_int) {
    const MESSAGE: &[u8] = b"[spike] fatal signal, exiting without a crash report; stack:\n";
    let mut frames = [std::ptr::null_mut(); 48];
    // SAFETY: `write` and `_exit` are async-signal-safe; the stack dump is not strictly so, which
    // a process about to exit can afford.
    unsafe {
        libc::write(2, MESSAGE.as_ptr().cast(), MESSAGE.len());
        let depth = libc::backtrace(frames.as_mut_ptr(), frames.len() as libc::c_int);
        libc::backtrace_symbols_fd(frames.as_ptr(), depth, 2);
        libc::_exit(128 + signal);
    }
}

pub fn install() {
    for signal in [libc::SIGTRAP, libc::SIGABRT, libc::SIGSEGV, libc::SIGBUS, libc::SIGILL] {
        // SAFETY: installs a handler that only calls async-signal-safe functions.
        unsafe {
            libc::signal(signal, exit_quietly as extern "C" fn(libc::c_int) as libc::sighandler_t);
        }
    }
}
