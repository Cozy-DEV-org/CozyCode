// Spawn helper: on Windows, suppress the console window that pops up for every
// child process (node/git/rg/powershell/cmd). CREATE_NO_WINDOW = 0x08000000.
use std::process::Command;

pub fn command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}
