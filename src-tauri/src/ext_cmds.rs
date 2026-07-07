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
pub fn ext_search(query: String) -> Result<String, String> {
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
pub fn ext_install(namespace: String, name: String, version: String) -> Result<String, String> {
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
pub fn ext_uninstall(id: String) -> Result<(), String> {
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
}

#[tauri::command]
pub fn ext_list() -> Result<Vec<ExtInfo>, String> {
    let root = ext_root()?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let ext_dir = entry.path().join("extension");
        let pkg_path = ext_dir.join("package.json");
        let Ok(raw) = std::fs::read_to_string(&pkg_path) else { continue };
        let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        let id = entry.file_name().to_string_lossy().into_owned();
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
        });
    }
    Ok(out)
}
