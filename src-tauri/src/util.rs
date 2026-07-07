// Spawn helper: on Windows, suppress the console window that pops up for every
// child process (node/git/rg/powershell/cmd). CREATE_NO_WINDOW = 0x08000000.
use std::path::PathBuf;
use std::process::Command;

// Portable data dir: keep extensions/settings next to the program when that dir
// is writable (portable install), else fall back to %APPDATA%\CozyCode.
// ponytail: probe-write once; good enough — no need to cache across the process.
pub fn data_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let data = dir.join("data");
            if std::fs::create_dir_all(&data).is_ok() {
                let probe = data.join(".w");
                if std::fs::write(&probe, b"1").is_ok() {
                    let _ = std::fs::remove_file(&probe);
                    return data;
                }
            }
        }
    }
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    let dir = PathBuf::from(base).join("CozyCode");
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
