use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: u64,
    pub text: String,
}

// for Ctrl+P quick open — respects .gitignore like VSCode
#[tauri::command]
pub async fn list_files(root: String) -> Result<Vec<String>, String> {
    let output = crate::util::command("rg")
        .args(["--files"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("ripgrep not found: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .take(20000)
        .map(String::from)
        .collect())
}

// ponytail: shells out to ripgrep like VSCode itself does; bundle rg.exe with the
// installer when packaging (Phase 5) so users don't need it on PATH.
#[tauri::command]
pub async fn search_text(root: String, query: String, regex: Option<bool>, case: Option<bool>) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let mut args: Vec<String> = vec!["--json".into(), "--max-count".into(), "200".into()];
    if regex != Some(true) {
        args.push("--fixed-strings".into());
    }
    if case == Some(true) {
        args.push("--case-sensitive".into());
    } else {
        args.push("--smart-case".into());
    }
    args.push(query.clone());
    args.push(root.clone());
    let output = crate::util::command("rg")
        .args(&args)
        .output()
        .map_err(|e| format!("ripgrep not found: {e}"))?;

    let mut matches = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v["type"] != "match" {
            continue;
        }
        let d = &v["data"];
        matches.push(SearchMatch {
            path: d["path"]["text"].as_str().unwrap_or("").to_string(),
            line: d["line_number"].as_u64().unwrap_or(0),
            text: d["lines"]["text"]
                .as_str()
                .unwrap_or("")
                .trim_end()
                .chars()
                .take(300)
                .collect(),
        });
        if matches.len() >= 1000 {
            break;
        }
    }
    Ok(matches)
}

// Replace All across the workspace. Uses rg to find files with matches, then
// applies the replacement per file (literal or regex). Returns files changed.
#[tauri::command]
pub async fn search_replace(root: String, find: String, replace: String, regex: Option<bool>, case: Option<bool>) -> Result<u32, String> {
    if find.is_empty() {
        return Err("nothing to find".into());
    }
    let mut args: Vec<String> = vec!["--files-with-matches".into()];
    if regex != Some(true) {
        args.push("--fixed-strings".into());
    }
    if case == Some(true) { args.push("--case-sensitive".into()); } else { args.push("--smart-case".into()); }
    args.push(find.clone());
    args.push(root.clone());
    let out = crate::util::command("rg").args(&args).output().map_err(|e| e.to_string())?;
    let files: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().map(String::from).collect();

    let re = if regex == Some(true) {
        Some(regex_lite(&find, case == Some(true))?)
    } else {
        None
    };
    let mut changed = 0u32;
    for f in files {
        let Ok(content) = std::fs::read_to_string(&f) else { continue };
        let new = match &re {
            Some(r) => r.replace_all(&content, replace.as_str()).into_owned(),
            None => content.replace(&find, &replace),
        };
        if new != content && std::fs::write(&f, new).is_ok() {
            changed += 1;
        }
    }
    Ok(changed)
}

// tiny regex wrapper via the `regex` crate is heavy to add; reuse rg for matching
// and do literal replace unless regex requested. For regex replace we need a real
// engine — use the `regex` crate.
fn regex_lite(pat: &str, case: bool) -> Result<regex::Regex, String> {
    regex::RegexBuilder::new(pat)
        .case_insensitive(!case)
        .build()
        .map_err(|e| e.to_string())
}
