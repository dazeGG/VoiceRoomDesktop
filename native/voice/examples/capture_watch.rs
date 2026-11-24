//! Reports capture-session creation for the Windows integration smoke.
#[cfg(windows)]
extern "C" {
    fn voice_smoke_watch_capture() -> bool;
}

fn main() {
    #[cfg(windows)]
    if unsafe { voice_smoke_watch_capture() } {
        return;
    }
    eprintln!("capture observer failed");
    std::process::exit(1);
}
