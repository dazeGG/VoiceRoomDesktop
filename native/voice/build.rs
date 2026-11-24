fn main() {
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=windows/audio_sessions.cpp");
        cc::Build::new()
            .cpp(true)
            .file("windows/audio_sessions.cpp")
            .compile("voice_audio_sessions");
        println!("cargo:rustc-link-lib=ole32");
    }
}
