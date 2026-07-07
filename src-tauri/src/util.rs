// Spawn helper: on Windows, suppress the console window that pops up for every
// child process (node/git/rg/powershell/cmd). CREATE_NO_WINDOW = 0x08000000.
use std::path::PathBuf;
use std::process::Command;

// Portable data dir: ALWAYS next to the program (`<exe dir>/data`). User data and
// extensions live in the install folder only — no roaming/appdata copy.
pub fn data_dir() -> PathBuf {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("data")))
        .unwrap_or_else(|| PathBuf::from("data"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}
