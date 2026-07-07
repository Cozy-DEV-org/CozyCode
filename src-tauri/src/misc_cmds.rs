// Settings persistence + external formatter runner.
use std::path::PathBuf;
use std::process::Command;

fn settings_path() -> Result<PathBuf, String> {
    Ok(crate::util::data_dir().join("settings.json"))
}

#[tauri::command]
pub async fn settings_read() -> Result<String, String> {
    let p = settings_path()?;
    Ok(std::fs::read_to_string(&p).unwrap_or_else(|_| "{}".into()))
}

#[tauri::command]
pub async fn settings_write(content: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&content).map_err(|e| format!("invalid JSON: {e}"))?;
    std::fs::write(settings_path()?, content).map_err(|e| e.to_string())
}

// Runs a user-configured formatter, e.g. "rustfmt {file}" or "npx prettier --write {file}".
// User-owned config running on the user's own machine — same trust model as VSCode tasks.
#[tauri::command]
pub async fn run_formatter(command: String, path: String) -> Result<String, String> {
    let full = command.replace("{file}", &format!("\"{}\"", path));
    let out = crate::util::command("cmd")
        .args(["/C", &full])
        .output()
        .map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(s)
    } else {
        Err(s.chars().take(800).collect())
    }
}
