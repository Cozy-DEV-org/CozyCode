// Generic piped child process — the transport for language servers (LSP over stdio).
// stdin is written as UTF-8 (LSP messages are UTF-8 JSON with ASCII headers); stdout
// is streamed to the frontend as base64 chunks so byte-exact Content-Length framing
// happens on the JS side without multibyte corruption. Every child dies on app close.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;
use tauri::Emitter;

pub struct ProcHandle {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct ProcState(pub Mutex<HashMap<String, ProcHandle>>);

fn b64(bytes: &[u8]) -> String {
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
    out
}

fn kill_child(h: &mut ProcHandle) {
    let pid = h.child.id();
    #[cfg(windows)]
    { let _ = crate::util::command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output(); }
    let _ = h.child.kill();
}

pub fn kill_all(state: &ProcState) {
    let mut m = state.0.lock().unwrap();
    for (_, mut h) in m.drain() {
        kill_child(&mut h);
    }
}

#[tauri::command]
pub async fn proc_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProcState>,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
) -> Result<(), String> {
    // replace any process already registered under this id
    if let Some(mut old) = state.0.lock().unwrap().remove(&id) {
        kill_child(&mut old);
    }
    let mut cmd = crate::util::command(&program);
    cmd.args(&args);
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn failed ({program}): {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app2.emit("proc-out", serde_json::json!({ "id": id2, "b64": b64(&buf[..n]) }));
                }
            }
        }
        let _ = app2.emit("proc-exit", serde_json::json!({ "id": id2 }));
    });
    let app3 = app.clone();
    let id3 = id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app3.emit("proc-err", serde_json::json!({ "id": id3, "line": line }));
        }
    });

    state.0.lock().unwrap().insert(id, ProcHandle { child, stdin });
    Ok(())
}

#[tauri::command]
pub async fn proc_write(state: tauri::State<'_, ProcState>, id: String, data: String) -> Result<(), String> {
    let mut m = state.0.lock().unwrap();
    let h = m.get_mut(&id).ok_or("process not running")?;
    h.stdin.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    h.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn proc_kill(state: tauri::State<'_, ProcState>, id: String) -> Result<(), String> {
    if let Some(mut h) = state.0.lock().unwrap().remove(&id) {
        kill_child(&mut h);
    }
    Ok(())
}
