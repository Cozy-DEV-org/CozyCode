// CozyCode native extensions.
//
// An extension is a folder with a `cozy.json` manifest + a web entry (HTML/JS/CSS),
// packaged as a `.cext` file — which is just a `.zip` with a different extension, so
// a plain `.zip` imports identically. No VS Code, no Open VSX, no Node sidecar: each
// extension runs as a sandboxed iframe in the workbench and talks to CozyCode through
// the small `cozy` API (see wiki/Writing-Extensions.md).
//
// ponytail: extraction uses PowerShell Expand-Archive — zero extra Rust deps; swap to
// the `zip` crate if PS startup latency (~1s per import) ever matters.
use serde::Serialize;
use std::path::{Path, PathBuf};

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
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
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
    pub name: String,
    pub version: String,
    pub description: String,
    pub icon: String,   // absolute path of the manifest icon, "" if none
    pub main: String,   // absolute path of the entry html, "" if none
    pub root: String,   // absolute dir holding cozy.json (the asset root)
    pub contributes: serde_json::Value,
    pub themes: Vec<ThemeContrib>,
    pub enabled: bool,
}

// per-extension enabled state, stored in data/extensions/.state.json
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
pub async fn ext_set_state(id: String, enabled: bool) -> Result<(), String> {
    let mut s = read_state();
    s[&id] = serde_json::json!({ "enabled": enabled });
    write_state(&s)
}

// ids the user disabled -> the frontend loader skips them
#[tauri::command]
pub async fn ext_disabled_ids() -> Vec<String> {
    let s = read_state();
    s.as_object()
        .map(|o| o.iter().filter(|(_, v)| v["enabled"] == serde_json::json!(false)).map(|(k, _)| k.clone()).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn ext_uninstall(id: String) -> Result<(), String> {
    let dir = ext_root()?.join(sanitize(&id));
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

// Import a .cext / .zip from disk. Extracts, locates cozy.json (root or one level
// deep), reads the id, and installs into data/extensions/<id>. Returns the id.
#[tauri::command]
pub async fn ext_import(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err("file not found".into());
    }
    let src_s = src.to_string_lossy().replace('\'', "''");
    // Expand-Archive only accepts a .zip name — copy to a temp .zip first (this makes
    // .cext work), extract into a fresh temp dir, print the dir back.
    let tmp = run_ps(&format!(
        "$ErrorActionPreference='Stop'; $t = Join-Path $env:TEMP ('cozyimp_' + [guid]::NewGuid().ToString('N')); \
         $z = \"$t.zip\"; Copy-Item -LiteralPath '{src_s}' -Destination $z -Force; \
         Expand-Archive -LiteralPath $z -DestinationPath $t -Force; Remove-Item $z -Force; Write-Output $t"
    ))?;
    let tmp = PathBuf::from(tmp.trim());
    let res = install_from_dir(&tmp);
    let _ = std::fs::remove_dir_all(&tmp);
    res
}

// Download a .cext from a URL (marketplace "Install") then import it. The frontend
// asks the user before calling this — downloads are an explicit-permission action.
#[tauri::command]
pub async fn ext_install_url(url: String) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("invalid url".into());
    }
    let u = url.replace('\'', "''");
    let tmp = run_ps(&format!(
        "$ErrorActionPreference='Stop'; $f = Join-Path $env:TEMP ('cozydl_' + [guid]::NewGuid().ToString('N') + '.cext'); \
         Invoke-WebRequest -Uri '{u}' -OutFile $f; Write-Output $f"
    ))?;
    let tmp = PathBuf::from(tmp.trim());
    let res = ext_import(tmp.to_string_lossy().into_owned()).await;
    let _ = std::fs::remove_file(&tmp);
    res
}

// Find cozy.json under `dir` (root, else one level down), read its id, copy that
// folder into data/extensions/<id>.
fn install_from_dir(dir: &Path) -> Result<String, String> {
    let manifest_dir = find_manifest_dir(dir).ok_or("no cozy.json in package")?;
    let raw = std::fs::read_to_string(manifest_dir.join("cozy.json")).map_err(|e| e.to_string())?;
    let pkg: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad cozy.json: {e}"))?;
    let id = pkg["id"]
        .as_str()
        .map(sanitize)
        .filter(|s| !s.is_empty())
        .ok_or("cozy.json missing \"id\"")?;
    let dest = ext_root()?.join(&id);
    let _ = std::fs::remove_dir_all(&dest);
    copy_dir(&manifest_dir, &dest).map_err(|e| e.to_string())?;
    Ok(id)
}

fn find_manifest_dir(dir: &Path) -> Option<PathBuf> {
    if dir.join("cozy.json").is_file() {
        return Some(dir.to_path_buf());
    }
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() && p.join("cozy.json").is_file() {
            return Some(p);
        }
    }
    None
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
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
        let id = entry.file_name().to_string_lossy().into_owned();
        if id.starts_with('.') {
            continue; // .state.json / partial installs
        }
        let dir = entry.path();
        let Ok(raw) = std::fs::read_to_string(dir.join("cozy.json")) else { continue };
        let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        let rel_abs = |rel: &str| dir.join(rel).to_string_lossy().into_owned();
        let icon = pkg["icon"].as_str().map(|r| dir.join(r)).filter(|p| p.exists()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let main = pkg["main"].as_str().unwrap_or("index.html");
        let main_abs = dir.join(main);
        let mut themes = Vec::new();
        if let Some(arr) = pkg["contributes"]["themes"].as_array() {
            for t in arr {
                let Some(rel) = t["path"].as_str() else { continue };
                themes.push(ThemeContrib {
                    label: t["label"].as_str().unwrap_or(rel).to_string(),
                    path: rel_abs(rel),
                    ui_theme: t["uiTheme"].as_str().unwrap_or("vs-dark").to_string(),
                });
            }
        }
        out.push(ExtInfo {
            id: id.clone(),
            name: pkg["name"].as_str().unwrap_or(&id).to_string(),
            version: pkg["version"].as_str().unwrap_or("0.0.0").to_string(),
            description: pkg["description"].as_str().unwrap_or("").chars().take(200).collect(),
            icon,
            main: if main_abs.exists() { main_abs.to_string_lossy().into_owned() } else { String::new() },
            root: dir.to_string_lossy().into_owned(),
            contributes: pkg["contributes"].clone(),
            themes,
            enabled: state[&id]["enabled"] != serde_json::json!(false), // default enabled
        });
    }
    Ok(out)
}

// ---- extension runtime filesystem helpers (used by e.g. LSP extensions to fetch
// and unpack a language-server binary on first activation) ----

// A per-extension writable dir under the portable data folder. Kept OUT of the
// extension's own folder so re-import / uninstall doesn't wipe a 30 MB server.
#[tauri::command]
pub async fn ext_data_dir(id: String) -> Result<String, String> {
    let dir = crate::util::data_dir().join("ext-data").join(sanitize(&id));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn ext_path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

// Download a URL to a local file. The frontend confirms before calling (downloads are
// an explicit-permission action).
#[tauri::command]
pub async fn ext_download(url: String, dest: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("invalid url".into());
    }
    let u = url.replace('\'', "''");
    let d = dest.replace('\'', "''");
    run_ps(&format!(
        "$ErrorActionPreference='Stop'; $p=Split-Path -Parent '{d}'; if($p){{New-Item -ItemType Directory -Force -Path $p | Out-Null}}; \
         [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '{u}' -OutFile '{d}'"
    ))
    .map(|_| ())
}

// Extract a .zip / .vsix into a directory (both are zip containers).
#[tauri::command]
pub async fn ext_unzip(zip: String, dest: String) -> Result<(), String> {
    let z = zip.replace('\'', "''");
    let d = dest.replace('\'', "''");
    run_ps(&format!(
        "$ErrorActionPreference='Stop'; $src='{z}'; if($src -notmatch '\\.zip$'){{ $tmp=\"$src.zip\"; Copy-Item -LiteralPath $src -Destination $tmp -Force; $src=$tmp }}; \
         Expand-Archive -LiteralPath $src -DestinationPath '{d}' -Force"
    ))
    .map(|_| ())
}

// Workspace-hosted marketplace index: a repo can ship `.cozycode/extensions.json`
// listing other CozyCode extensions (name/description/repo/download) so opening that
// folder surfaces them in the Extensions view. Returns the parsed `extensions` array.
#[tauri::command]
pub async fn ext_marketplace(root: String) -> Result<serde_json::Value, String> {
    if root.is_empty() {
        return Ok(serde_json::json!([]));
    }
    let p = Path::new(&root).join(".cozycode").join("extensions.json");
    let Ok(raw) = std::fs::read_to_string(&p) else { return Ok(serde_json::json!([])) };
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    // accept either a bare array or { "extensions": [...] }
    Ok(if v.is_array() { v } else { v["extensions"].clone() })
}
