// Workspace search / quick-open / replace. Native (the `regex` crate + a std walk) so
// it works with nothing installed — no external ripgrep. Heavy dirs are skipped and
// counts are capped to stay fast on large trees.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: u64,
    pub text: String,
}

const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "out", "vendor", ".cache", ".next", ".venv"];
const MAX_FILES: usize = 20000;

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 12 || out.len() >= MAX_FILES {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue; // skip .git / dotdirs / heavy build dirs
            }
            walk(&p, depth + 1, out);
        } else {
            out.push(p);
        }
    }
}

// no NUL byte in the head => treat as text (skip binaries)
fn is_text(bytes: &[u8]) -> bool {
    !bytes.iter().take(8192).any(|&b| b == 0)
}

// literal (escaped) or regex, with smart-case: case-insensitive unless the query has
// an uppercase letter or the caller forced case-sensitivity.
fn matcher(query: &str, is_regex: bool, case: Option<bool>) -> Result<regex::Regex, String> {
    let sensitive = matches!(case, Some(true)) || query.chars().any(|c| c.is_uppercase());
    let pat = if is_regex { query.to_string() } else { regex::escape(query) };
    regex::RegexBuilder::new(&pat)
        .case_insensitive(!sensitive)
        .build()
        .map_err(|e| e.to_string())
}

// Ctrl+P quick open — paths relative to the workspace root.
#[tauri::command]
pub async fn list_files(root: String) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    walk(Path::new(&root), 0, &mut files);
    let base = Path::new(&root);
    Ok(files
        .iter()
        .filter_map(|p| p.strip_prefix(base).ok().map(|r| r.to_string_lossy().into_owned()))
        .collect())
}

#[tauri::command]
pub async fn search_text(root: String, query: String, regex: Option<bool>, case: Option<bool>) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let re = matcher(&query, regex == Some(true), case)?;
    let mut files = Vec::new();
    walk(Path::new(&root), 0, &mut files);
    let mut matches = Vec::new();
    for f in files {
        if matches.len() >= 1000 {
            break;
        }
        let Ok(bytes) = std::fs::read(&f) else { continue };
        if !is_text(&bytes) {
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else { continue };
        let path = f.to_string_lossy().into_owned();
        let mut per_file = 0;
        for (i, line) in content.lines().enumerate() {
            if re.is_match(line) {
                matches.push(SearchMatch {
                    path: path.clone(),
                    line: (i + 1) as u64,
                    text: line.trim_end().chars().take(300).collect(),
                });
                per_file += 1;
                if per_file >= 200 || matches.len() >= 1000 {
                    break;
                }
            }
        }
    }
    Ok(matches)
}

// Replace All across the workspace. Returns the number of files changed.
#[tauri::command]
pub async fn search_replace(root: String, find: String, replace: String, regex: Option<bool>, case: Option<bool>) -> Result<u32, String> {
    if find.is_empty() {
        return Err("nothing to find".into());
    }
    let is_regex = regex == Some(true);
    let re = matcher(&find, is_regex, case)?;
    let mut files = Vec::new();
    walk(Path::new(&root), 0, &mut files);
    let mut changed = 0u32;
    for f in files {
        let Ok(content) = std::fs::read_to_string(&f) else { continue };
        if !re.is_match(&content) {
            continue;
        }
        // regex mode: allow $1 group refs. literal mode: NoExpand so $ stays literal.
        let new = if is_regex {
            re.replace_all(&content, replace.as_str()).into_owned()
        } else {
            re.replace_all(&content, regex::NoExpand(replace.as_str())).into_owned()
        };
        if new != content && std::fs::write(&f, new).is_ok() {
            changed += 1;
        }
    }
    Ok(changed)
}
