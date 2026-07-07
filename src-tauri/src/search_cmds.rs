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
pub fn list_files(root: String) -> Result<Vec<String>, String> {
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
pub fn search_text(root: String, query: String) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let output = crate::util::command("rg")
        .args([
            "--json",
            "--max-count",
            "200",
            "--fixed-strings",
            "--smart-case",
            &query,
            &root,
        ])
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
