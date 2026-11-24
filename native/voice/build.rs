fn main() {
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=windows/audio_sessions.cpp");
        println!("cargo:rerun-if-changed=windows/smoke_capture_watch.cpp");
        cc::Build::new()
            .cpp(true)
            .file("windows/audio_sessions.cpp")
            .file("windows/smoke_capture_watch.cpp")
            .compile("voice_audio_sessions");
        println!("cargo:rustc-link-lib=ole32");
    }
}
