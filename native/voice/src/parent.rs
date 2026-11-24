#[cfg(windows)]
pub fn watch(pid: u32) -> Result<(), &'static str> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{
            GetCurrentProcess, OpenProcess, TerminateProcess, WaitForSingleObject, INFINITE,
            PROCESS_SYNCHRONIZE,
        },
    };

    // A process handle remains bound to this process instance across PID reuse.
    // The watchdog also covers a blocked SDK call or a blocked stdout write.
    let parent = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if parent.is_null() {
        return Err("parent-unavailable");
    }
    let parent = parent as usize;
    std::thread::spawn(move || {
        let handle = parent as windows_sys::Win32::Foundation::HANDLE;
        let result = unsafe { WaitForSingleObject(handle, INFINITE) };
        unsafe { CloseHandle(handle) };
        let code = if result == WAIT_OBJECT_0 { 0 } else { 1 };
        // Windows ends all threads without running process-level destructors.
        unsafe { TerminateProcess(GetCurrentProcess(), code) };
        std::process::exit(code as i32);
    });
    Ok(())
}

#[cfg(not(windows))]
pub fn watch(_: u32) -> Result<(), &'static str> {
    Err("platform-unsupported")
}
