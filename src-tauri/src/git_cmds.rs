use git2::{Repository, Status, StatusOptions};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
pub struct GitInfo {
    pub is_repo: bool,
    pub branch: String,
}

#[derive(Serialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // M, A, D, R, U (untracked), C (conflict)
    pub staged: bool,
}

fn open(repo: &str) -> Result<Repository, String> {
    Repository::discover(repo).map_err(|e| e.message().to_string())
}

#[tauri::command]
pub async fn git_info(repo: String) -> GitInfo {
    match open(&repo) {
        Ok(r) => {
            let branch = r
                .head()
                .ok()
                .and_then(|h| h.shorthand().map(String::from))
                .unwrap_or_else(|| "HEAD".into());
            GitInfo { is_repo: true, branch }
        }
        Err(_) => GitInfo { is_repo: false, branch: String::new() },
    }
}

#[tauri::command]
pub async fn git_status(repo: String) -> Result<Vec<GitFileStatus>, String> {
    let r = open(&repo)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = r.statuses(Some(&mut opts)).map_err(|e| e.message().to_string())?;

    let mut out = Vec::new();
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let s = entry.status();
        if s.contains(Status::CONFLICTED) {
            out.push(GitFileStatus { path, status: "C".into(), staged: false });
            continue;
        }
        // index side (staged)
        if s.intersects(
            Status::INDEX_NEW | Status::INDEX_MODIFIED | Status::INDEX_DELETED | Status::INDEX_RENAMED,
        ) {
            let letter = if s.contains(Status::INDEX_NEW) {
                "A"
            } else if s.contains(Status::INDEX_DELETED) {
                "D"
            } else if s.contains(Status::INDEX_RENAMED) {
                "R"
            } else {
                "M"
            };
            out.push(GitFileStatus { path: path.clone(), status: letter.into(), staged: true });
        }
        // worktree side (unstaged)
        if s.contains(Status::WT_NEW) {
            out.push(GitFileStatus { path, status: "U".into(), staged: false });
        } else if s.contains(Status::WT_DELETED) {
            out.push(GitFileStatus { path, status: "D".into(), staged: false });
        } else if s.intersects(Status::WT_MODIFIED | Status::WT_RENAMED | Status::WT_TYPECHANGE) {
            out.push(GitFileStatus { path, status: "M".into(), staged: false });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn git_stage(repo: String, path: String) -> Result<(), String> {
    let r = open(&repo)?;
    let mut index = r.index().map_err(|e| e.message().to_string())?;
    let rel = Path::new(&path);
    let workdir = r.workdir().ok_or("bare repo")?;
    if workdir.join(rel).exists() {
        index.add_path(rel).map_err(|e| e.message().to_string())?;
    } else {
        index.remove_path(rel).map_err(|e| e.message().to_string())?;
    }
    index.write().map_err(|e| e.message().to_string())
}

#[tauri::command]
pub async fn git_unstage(repo: String, path: String) -> Result<(), String> {
    let r = open(&repo)?;
    let head = r.head().and_then(|h| h.peel(git2::ObjectType::Commit)).ok();
    r.reset_default(head.as_ref(), [&path])
        .map_err(|e| e.message().to_string())
}

#[tauri::command]
pub async fn git_discard(repo: String, path: String) -> Result<(), String> {
    let r = open(&repo)?;
    let mut cb = git2::build::CheckoutBuilder::new();
    cb.path(&path).force();
    r.checkout_head(Some(&mut cb)).map_err(|e| e.message().to_string())
}

#[tauri::command]
pub async fn git_commit(repo: String, message: String) -> Result<String, String> {
    let r = open(&repo)?;
    let sig = r.signature().map_err(|e| e.message().to_string())?;
    let mut index = r.index().map_err(|e| e.message().to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = r.find_tree(tree_id).map_err(|e| e.message().to_string())?;
    let parent = r.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = r
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| e.message().to_string())?;
    Ok(oid.to_string())
}

#[derive(Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = crate::util::command("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

#[tauri::command]
pub async fn find_repos(root: String) -> Vec<String> {
    fn scan(dir: &Path, depth: u32, out: &mut Vec<String>) {
        if out.len() >= 20 {
            return;
        }
        if dir.join(".git").exists() {
            out.push(dir.to_string_lossy().into_owned());
            return; // don't descend into a repo looking for nested repos
        }
        if depth == 0 {
            return;
        }
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if !p.is_dir() {
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_lowercase();
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    continue;
                }
                scan(&p, depth - 1, out);
            }
        }
    }
    let mut out = Vec::new();
    scan(Path::new(&root), 2, &mut out);
    out
}

#[tauri::command]
pub async fn git_log(repo: String, path: Option<String>, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let n = format!("-n{}", limit.unwrap_or(100));
    let mut args: Vec<String> = vec![
        "log".into(),
        n,
        "--pretty=format:%H\u{1f}%h\u{1f}%an\u{1f}%ad\u{1f}%s".into(),
        "--date=relative".into(),
    ];
    if let Some(p) = path {
        args.push("--".into());
        args.push(p);
    }
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = run_git(&repo, &args_ref)?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\u{1f}').collect();
            (f.len() == 5).then(|| GitCommit {
                hash: f[0].into(),
                short: f[1].into(),
                author: f[2].into(),
                date: f[3].into(),
                message: f[4].into(),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn git_show_commit(repo: String, hash: String) -> Result<String, String> {
    run_git(&repo, &["show", "--stat", "--patch", &hash])
}

// files changed in a commit, for the Graph drill-down. Returns [{path, status}].
#[tauri::command]
pub async fn git_commit_files(repo: String, hash: String) -> Result<Vec<GitFileStatus>, String> {
    let out = run_git(&repo, &["show", "--name-status", "--format=", &hash])?;
    let mut files = Vec::new();
    for line in out.lines() {
        let mut parts = line.splitn(2, '\t');
        let (Some(st), Some(path)) = (parts.next(), parts.next()) else { continue };
        let status = match st.chars().next().unwrap_or('M') {
            'A' => "A", 'D' => "D", 'R' => "R", _ => "M",
        };
        files.push(GitFileStatus { path: path.to_string(), status: status.into(), staged: true });
    }
    Ok(files)
}

// rev "" = index (stage 0), otherwise e.g. "HEAD" or a commit hash
#[tauri::command]
pub async fn git_file_at(repo: String, rev: String, path: String) -> Result<String, String> {
    let spec = format!("{}:{}", rev, path.replace('\\', "/"));
    run_git(&repo, &["show", &spec])
}

#[tauri::command]
pub async fn git_branches(repo: String) -> Result<Vec<String>, String> {
    Ok(run_git(&repo, &["branch", "--format=%(refname:short)"])?
        .lines()
        .map(String::from)
        .collect())
}

#[tauri::command]
pub async fn git_checkout(repo: String, branch: String) -> Result<String, String> {
    run_git(&repo, &["checkout", &branch])
}

#[tauri::command]
pub async fn git_push(repo: String) -> Result<String, String> {
    run_git(&repo, &["push"])
}

#[tauri::command]
pub async fn git_pull(repo: String) -> Result<String, String> {
    run_git(&repo, &["pull"])
}

#[tauri::command]
pub async fn git_stage_all(repo: String) -> Result<String, String> {
    run_git(&repo, &["add", "-A"])
}

#[tauri::command]
pub async fn git_merge(repo: String, branch: String) -> Result<String, String> {
    run_git(&repo, &["merge", &branch])
}

#[tauri::command]
pub async fn git_remote_url(repo: String) -> Result<String, String> {
    Ok(run_git(&repo, &["remote", "get-url", "origin"])?.trim().to_string())
}

#[tauri::command]
pub async fn git_default_branch(repo: String) -> String {
    run_git(&repo, &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
        .map(|s| s.trim().replace("origin/", ""))
        .unwrap_or_else(|_| "main".into())
}

// full diff for AI commit-message generation (truncated to keep prompts sane)
#[tauri::command]
pub async fn git_diff_all(repo: String, staged: bool) -> Result<String, String> {
    let status = run_git(&repo, &["status", "--short"])?;
    let diff = if staged {
        run_git(&repo, &["diff", "--cached"])?
    } else {
        run_git(&repo, &["diff", "HEAD"]).or_else(|_| run_git(&repo, &["diff"]))?
    };
    let mut out = format!("# git status --short\n{status}\n# diff\n{diff}");
    if out.len() > 60000 {
        out.truncate(60000);
        out.push_str("\n... (diff truncated)");
    }
    Ok(out)
}

#[tauri::command]
pub async fn git_diff_file(repo: String, path: String, staged: bool) -> Result<String, String> {
    // ponytail: shell out to git for diff text — libgit2 patch formatting is more
    // code for the same output; git CLI is guaranteed present for our users.
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(&path);
    let out = crate::util::command("git")
        .args(&args)
        .current_dir(&repo)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
