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
            push("Git Bash", gp.to_string(), vec!["-i"]);
        }
    }
    if let Some(p) = which("bash.exe").filter(|p| p.to_lowercase().contains("git")) {
        push("Git Bash", p, vec!["-i"]);
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

// Resolve an executable to its full path (handles .cmd/.bat/.exe via `where`,
// which honours PATHEXT). Used so we can launch npm-shim CLIs like `claude`
// (which is claude.cmd, not on the raw CreateProcess search path in a pty).
#[tauri::command]
pub fn resolve_command(name: String) -> Option<String> {
    which(&name)
}

// The path passed on the command line (Open with CozyCode / double-click a file).
// Returns {path, is_dir} or null when launched with no argument.
#[tauri::command]
pub fn launch_target() -> Option<serde_json::Value> {
    let arg = std::env::args().nth(1)?;
    if arg.starts_with('-') {
        return None;
    }
    let p = Path::new(&arg);
    if !p.exists() {
        return None;
    }
    let abs = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    // strip Windows \\?\ verbatim prefix
    let s = abs.to_string_lossy().replace(r"\\?\", "");
    Some(serde_json::json!({ "path": s, "is_dir": abs.is_dir() }))
}

// Register HKCU context-menu entries: "Open with CozyCode" on files and folders.
// currentUser hive => no admin needed. Uninstall by deleting the same keys.
#[tauri::command]
pub fn register_context_menu() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_s = exe.to_string_lossy().replace('\\', "\\\\");
    let ps = format!(
        r#"
$exe = '{exe}'
function AddMenu($root) {{
  New-Item -Path $root -Force | Out-Null
  Set-ItemProperty -Path $root -Name '(Default)' -Value 'Open with CozyCode'
  Set-ItemProperty -Path $root -Name 'Icon' -Value $exe
  New-Item -Path "$root\command" -Force | Out-Null
  Set-ItemProperty -Path "$root\command" -Name '(Default)' -Value ('"' + $exe + '" "%1"')
}}
AddMenu 'HKCU:\Software\Classes\*\shell\CozyCode'
AddMenu 'HKCU:\Software\Classes\Directory\shell\CozyCode'
AddMenu 'HKCU:\Software\Classes\Directory\Background\shell\CozyCode'
"#,
        exe = exe_s
    );
    // Background uses %V not %1 — fix that one command
    let ps = ps.replace(
        "AddMenu 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\CozyCode'",
        "New-Item -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\CozyCode\\command' -Force | Out-Null; \
         Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\CozyCode' -Name '(Default)' -Value 'Open with CozyCode'; \
         Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\CozyCode' -Name 'Icon' -Value $exe; \
         Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\CozyCode\\command' -Name '(Default)' -Value ('\"' + $exe + '\" \"%V\"')",
    );
    let out = crate::util::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).chars().take(300).collect())
    }
}

// Check the latest published release on GitHub (public API, no auth).
#[tauri::command]
pub fn check_update() -> Result<serde_json::Value, String> {
    let out = crate::util::command("powershell")
        .args(["-NoProfile", "-Command",
            "(Invoke-RestMethod -Uri 'https://api.github.com/repos/Cozy-DEV-org/CozyCode/releases/latest' -Headers @{'User-Agent'='CozyCode'}) | Select-Object tag_name,html_url,name | ConvertTo-Json -Compress"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).chars().take(200).collect());
    }
    serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim()).map_err(|e| e.to_string())
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
