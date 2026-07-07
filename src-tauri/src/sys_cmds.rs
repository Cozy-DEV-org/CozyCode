// System helpers: detect installed shells, open URLs in the default browser.
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
}

fn exists(p: &str) -> bool {
    Path::new(p).exists()
}

fn which(exe: &str) -> Option<String> {
    let out = crate::util::command("where").arg(exe).output().ok()?;
    if out.status.success() {
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    }
}

// Detect the shells actually present on this machine, in VSCode-ish preference order.
#[tauri::command]
pub fn detect_shells() -> Vec<ShellInfo> {
    let mut out = Vec::new();
    let mut push = |name: &str, path: String, args: Vec<&str>| {
        if !out.iter().any(|s: &ShellInfo| s.path.eq_ignore_ascii_case(&path)) {
            out.push(ShellInfo { name: name.into(), path, args: args.into_iter().map(String::from).collect() });
        }
    };
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());

    // PowerShell 7 (pwsh) preferred
    if let Some(p) = which("pwsh.exe") {
        push("PowerShell", p, vec![]);
    }
    let ps = format!("{sysroot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    if exists(&ps) {
        push("Windows PowerShell", ps, vec![]);
    }
    let cmd = format!("{sysroot}\\System32\\cmd.exe");
    if exists(&cmd) {
        push("Command Prompt", cmd, vec![]);
    }
    // Git Bash
    for gp in [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ] {
        if exists(gp) {
            push("Git Bash", gp.to_string(), vec!["--login", "-i"]);
        }
    }
    if let Some(p) = which("bash.exe").filter(|p| p.to_lowercase().contains("git")) {
        push("Git Bash", p, vec!["--login", "-i"]);
    }
    // WSL
    let wsl = format!("{sysroot}\\System32\\wsl.exe");
    if exists(&wsl) {
        push("WSL", wsl, vec![]);
    }
    // zsh / bash on PATH (e.g. msys, cygwin)
    for sh in ["zsh.exe", "bash.exe"] {
        if let Some(p) = which(sh) {
            let name = if sh.starts_with("zsh") { "zsh" } else { "bash" };
            push(name, p, vec![]);
        }
    }
    out
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("invalid url".into());
    }
    // cmd start handles the default browser; empty title arg is required.
    crate::util::command("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
