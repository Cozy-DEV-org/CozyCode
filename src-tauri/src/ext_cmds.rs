// Extension support via Open VSX registry (open-vsx.org).
// ponytail: downloads/extracts via PowerShell — zero extra Rust deps; swap to
// ureq+zip crates if PS startup latency (~1s) ever matters.
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

fn ext_root() -> Result<PathBuf, String> {
    let dir = crate::util::data_dir().join("extensions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn sanitize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect()
}

fn run_ps(script: &str) -> Result<String, String> {
    let out = crate::util::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

#[tauri::command]
pub async fn ext_search(query: String) -> Result<String, String> {
    let q: String = query
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
        .collect::<String>()
        .replace(' ', "%20");
    run_ps(&format!(
        "(Invoke-RestMethod 'https://open-vsx.org/api/-/search?query={q}&size=24&sortBy=downloadCount') | ConvertTo-Json -Depth 10 -Compress"
    ))
}

#[tauri::command]
pub async fn ext_install(namespace: String, name: String, version: String) -> Result<String, String> {
    let (ns, nm, ver) = (sanitize(&namespace), sanitize(&name), sanitize(&version));
    if ns.is_empty() || nm.is_empty() || ver.is_empty() {
        return Err("invalid extension id".into());
    }
    let id = format!("{ns}.{nm}");
    let dest = ext_root()?.join(&id);
    let dest_s = dest.to_string_lossy().into_owned();
    let url = format!("https://open-vsx.org/api/{ns}/{nm}/{ver}/file/{ns}.{nm}-{ver}.vsix");
    run_ps(&format!(
        "$tmp = Join-Path $env:TEMP 'cozyext.zip'; \
         Invoke-WebRequest -Uri '{url}' -OutFile $tmp; \
         Remove-Item -Recurse -Force '{dest_s}' -ErrorAction SilentlyContinue; \
         Expand-Archive -Path $tmp -DestinationPath '{dest_s}' -Force; \
         Remove-Item $tmp"
    ))?;
    Ok(id)
}

#[tauri::command]
pub async fn ext_uninstall(id: String) -> Result<(), String> {
    let dir = ext_root()?.join(sanitize(&id));
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct ThemeContrib {
    pub label: String,
    pub path: String, // absolute
    pub ui_theme: String,
}

#[derive(Serialize)]
pub struct ExtInfo {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub themes: Vec<ThemeContrib>,
    pub enabled: bool,
    pub auto_update: bool,
}

// per-extension state (enabled / auto-update) stored in data/extensions/.state.json
fn state_path() -> Result<PathBuf, String> {
    Ok(ext_root()?.join(".state.json"))
}
fn read_state() -> serde_json::Value {
    state_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}
fn write_state(v: &serde_json::Value) -> Result<(), String> {
    std::fs::write(state_path()?, serde_json::to_string_pretty(v).unwrap_or_default()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ext_set_state(id: String, enabled: bool, auto_update: bool) -> Result<(), String> {
    let mut s = read_state();
    s[&id] = serde_json::json!({ "enabled": enabled, "autoUpdate": auto_update });
    write_state(&s)
}

// ids that are disabled -> exthost skips them
#[tauri::command]
pub async fn ext_disabled_ids() -> Vec<String> {
    let s = read_state();
    s.as_object()
        .map(|o| o.iter().filter(|(_, v)| v["enabled"] == serde_json::json!(false)).map(|(k, _)| k.clone()).collect())
        .unwrap_or_default()
}

// One-time import of installed VS Code extensions into CozyCode's ext dir.
#[tauri::command]
pub async fn import_vscode_extensions() -> Result<u32, String> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|e| e.to_string())?;
    let src = std::path::Path::new(&home).join(".vscode").join("extensions");
    if !src.exists() {
        return Ok(0);
    }
    let dest = ext_root()?;
    let mut n = 0u32;
    for entry in std::fs::read_dir(&src).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        // VS Code stores each extension as <publisher>.<name>-<version>; keep the id
        let raw = entry.file_name().to_string_lossy().into_owned();
        let id: String = raw.rsplitn(2, '-').last().unwrap_or(&raw).to_string();
        let target = dest.join(sanitize(&id)).join("extension");
        if target.exists() {
            continue;
        }
        if copy_dir(&p, &target).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)?.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ext_list() -> Result<Vec<ExtInfo>, String> {
    let root = ext_root()?;
    let state = read_state();
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let ext_dir = entry.path().join("extension");
        let pkg_path = ext_dir.join("package.json");
        let Ok(raw) = std::fs::read_to_string(&pkg_path) else { continue };
        let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        let id = entry.file_name().to_string_lossy().into_owned();
        let st = &state[&id];
        let mut themes = Vec::new();
        if let Some(arr) = pkg["contributes"]["themes"].as_array() {
            for t in arr {
                let Some(rel) = t["path"].as_str() else { continue };
                themes.push(ThemeContrib {
                    label: t["label"].as_str().unwrap_or(rel).to_string(),
                    path: ext_dir.join(rel).to_string_lossy().into_owned(),
                    ui_theme: t["uiTheme"].as_str().unwrap_or("vs-dark").to_string(),
                });
            }
        }
        let display = pkg["displayName"].as_str().unwrap_or(&id);
        out.push(ExtInfo {
            id: id.clone(),
            display_name: if display.starts_with('%') { id.clone() } else { display.to_string() },
            description: pkg["description"].as_str().unwrap_or("").chars().take(200).collect(),
            version: pkg["version"].as_str().unwrap_or("").to_string(),
            themes,
            enabled: st["enabled"] != serde_json::json!(false), // default enabled
            auto_update: st["autoUpdate"] == serde_json::json!(true),
        });
    }
    Ok(out)
}
