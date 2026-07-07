// Extension host bridge: spawns the Node sidecar (exthost.js) and pipes
// newline-delimited JSON both ways. Correlation of request ids happens in JS.
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::Emitter;

const EXTHOST_JS: &str = include_str!("exthost.js");

pub struct ExtHost {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct ExtHostState(pub Mutex<Option<ExtHost>>);

#[tauri::command]
pub async fn exthost_start(app: tauri::AppHandle, state: tauri::State<'_, ExtHostState>, ext_dir: String) -> Result<String, String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut old) = guard.take() {
        let _ = old.child.kill();
    }
    let dir = crate::util::data_dir();
    let script = dir.join("exthost.js");
    std::fs::write(&script, EXTHOST_JS).map_err(|e| e.to_string())?;
    let ext_dir = if ext_dir.is_empty() {
        dir.join("extensions").to_string_lossy().into_owned()
    } else {
        ext_dir
    };

    let mut child = crate::util::command("node")
        .arg(&script)
        .arg(&ext_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Node.js not found (required for extension host): {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let app2 = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = app2.emit("exthost-line", line);
        }
        let _ = app2.emit("exthost-exit", ());
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app.emit("exthost-stderr", line);
        }
    });

    *guard = Some(ExtHost { child, stdin });
    Ok("started".into())
}

#[tauri::command]
pub async fn exthost_send(state: tauri::State<'_, ExtHostState>, line: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let h = guard.as_mut().ok_or("extension host not running")?;
    writeln!(h.stdin, "{}", line).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn exthost_stop(state: tauri::State<'_, ExtHostState>) -> Result<(), String> {
    if let Some(mut h) = state.0.lock().unwrap().take() {
        let _ = h.child.kill();
    }
    Ok(())
}
