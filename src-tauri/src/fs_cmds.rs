use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| {
            let p = e.path();
            DirEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                is_dir: p.is_dir(),
            }
        })
        .collect();
    // dirs first, then files, case-insensitive — same order as VSCode explorer
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

// Last-modified (ms since epoch) for each path, -1 if missing. Lets the editor detect
// files changed on disk externally (e.g. by a sync) and reload open buffers.
#[tauri::command]
pub async fn stat_paths(paths: Vec<String>) -> Vec<f64> {
    paths
        .iter()
        .map(|p| {
            fs::metadata(p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64)
                .unwrap_or(-1.0)
        })
        .collect()
}

// base64 for binary viewers (image/video/pdf/xlsx). std-only base64 encoder.
#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    Ok(out)
}

// Save with an explicit text encoding + optional BOM, like VSCode's "Save with Encoding".
#[tauri::command]
pub async fn write_file_encoded(path: String, content: String, encoding: String) -> Result<(), String> {
    let bytes: Vec<u8> = match encoding.as_str() {
        "utf8" => content.into_bytes(),
        "utf8bom" => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(content.as_bytes());
            v
        }
        "utf16le" => {
            let mut v = vec![0xFF, 0xFE];
            for u in content.encode_utf16() {
                v.extend_from_slice(&u.to_le_bytes());
            }
            v
        }
        "utf16be" => {
            let mut v = vec![0xFE, 0xFF];
            for u in content.encode_utf16() {
                v.extend_from_slice(&u.to_be_bytes());
            }
            v
        }
        "latin1" => content.chars().map(|c| c as u8).collect(),
        _ => return Err(format!("unsupported encoding: {encoding}")),
    };
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("File already exists".into());
    }
    fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<(), String> {
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

// Move a file/dir to the Windows Recycle Bin (recoverable) instead of hard-deleting,
// via VisualBasic FileSystem. No confirmation dialog (OnlyErrorDialogs).
#[tauri::command]
pub async fn recycle_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("path not found".into());
    }
    let p = path.replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; \
         if (Test-Path -LiteralPath '{p}' -PathType Container) {{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('{p}','OnlyErrorDialogs','SendToRecycleBin') }} \
         else {{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('{p}','OnlyErrorDialogs','SendToRecycleBin') }}"
    );
    let out = crate::util::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).chars().take(200).collect())
    }
}

// ---------- Markdown graph (Obsidian-style relations) ----------
// Scans the workspace for .md files and extracts [[wikilinks]] and [text](x.md)
// links so the frontend can draw a relation graph. Capped walk, skips heavy dirs.

#[derive(Serialize)]
pub struct MdNode {
    pub path: String,  // absolute
    pub name: String,  // file stem, e.g. "Changelog"
    pub links: Vec<String>, // raw link targets (wikilink names or relative md paths)
}

fn md_walk(dir: &Path, out: &mut Vec<std::path::PathBuf>, depth: usize, seen: &mut usize) {
    if depth > 6 || *seen > 20000 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        *seen += 1;
        if *seen > 20000 {
            return;
        }
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build" | "out" | "vendor") {
                continue;
            }
            md_walk(&p, out, depth + 1, seen);
        } else if name.to_lowercase().ends_with(".md") {
            out.push(p);
        }
    }
}

#[tauri::command]
pub async fn md_graph(root: String) -> Result<Vec<MdNode>, String> {
    let mut files = Vec::new();
    let mut seen = 0usize;
    md_walk(Path::new(&root), &mut files, 0, &mut seen);
    let mut nodes = Vec::new();
    for f in files {
        let Ok(text) = fs::read_to_string(&f) else { continue };
        let mut links = Vec::new();
        // [[wikilink]] or [[wikilink|alias]]
        let bytes = text.as_bytes();
        let mut i = 0;
        while i + 3 < bytes.len() {
            if bytes[i] == b'[' && bytes[i + 1] == b'[' {
                if let Some(end) = text[i + 2..].find("]]") {
                    let inner = &text[i + 2..i + 2 + end];
                    let target = inner.split('|').next().unwrap_or("").split('#').next().unwrap_or("").trim();
                    if !target.is_empty() {
                        links.push(target.to_string());
                    }
                    i += end + 4;
                    continue;
                }
            }
            // [text](target.md)
            if bytes[i] == b']' && bytes[i + 1] == b'(' {
                if let Some(end) = text[i + 2..].find(')') {
                    let target = text[i + 2..i + 2 + end].split('#').next().unwrap_or("").trim();
                    let t = target.to_lowercase();
                    if t.ends_with(".md") && !t.starts_with("http") {
                        links.push(target.to_string());
                    }
                    i += end + 3;
                    continue;
                }
            }
            i += 1;
        }
        nodes.push(MdNode {
            name: f.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            path: f.to_string_lossy().into_owned(),
            links,
        });
    }
    Ok(nodes)
}
