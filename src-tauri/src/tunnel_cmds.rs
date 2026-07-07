// Public port tunnels. Providers:
//  - cloudflared: `cloudflared tunnel --url http://localhost:PORT` — NO login needed
//  - ngrok:       `ngrok http PORT` — needs authtoken (ngrok config add-authtoken)
//  - tailscale:   `tailscale funnel PORT` — needs tailscale up + login token
// Parses the public URL from the child's output and emits `tunnel-url`.
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Default)]
pub struct TunnelState(pub Mutex<HashMap<u16, Child>>);

fn find_url(line: &str) -> Option<String> {
    for pat in ["https://", "http://"] {
        if let Some(i) = line.find(pat) {
            let url: String = line[i..]
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'')
                .collect();
            // ignore localhost / metrics URLs
            if url.contains("localhost") || url.contains("127.0.0.1") || url.contains("://ngrok.com") {
                continue;
            }
            if url.contains("trycloudflare.com") || url.contains("ngrok") || url.contains("ts.net") {
                return Some(url);
            }
        }
    }
    None
}

#[tauri::command]
pub fn tunnel_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, TunnelState>,
    provider: String,
    port: u16,
    token: Option<String>,
) -> Result<(), String> {
    // optional auth setup for providers that need it (best-effort, ignore failure)
    if let Some(t) = token.as_deref().filter(|t| !t.trim().is_empty()) {
        let safe: String = t.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect();
        match provider.as_str() {
            "ngrok" => { let _ = crate::util::command("ngrok").args(["config", "add-authtoken", &safe]).output(); }
            "tailscale" => { let _ = crate::util::command("tailscale").args(["up", &format!("--authkey={safe}")]).output(); }
            _ => {}
        }
    }

    let mut cmd = match provider.as_str() {
        "cloudflared" => {
            let mut c = crate::util::command("cloudflared");
            c.args(["tunnel", "--url", &format!("http://localhost:{port}")]);
            c
        }
        "ngrok" => {
            let mut c = crate::util::command("ngrok");
            c.args(["http", &port.to_string(), "--log", "stdout"]);
            c
        }
        "tailscale" => {
            let mut c = crate::util::command("tailscale");
            c.args(["funnel", &port.to_string()]);
            c
        }
        _ => return Err("unknown provider".into()),
    };

    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{provider} not found: {e}. Install it and ensure it's on PATH."))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    state.0.lock().unwrap().insert(port, child);

    let emit_from = move |app: tauri::AppHandle, reader: Box<dyn BufRead + Send>, port: u16| {
        std::thread::spawn(move || {
            for line in reader.lines().map_while(Result::ok) {
                if let Some(url) = find_url(&line) {
                    let _ = app.emit("tunnel-url", serde_json::json!({ "port": port, "url": url }));
                    break;
                }
            }
        });
    };
    if let Some(o) = stdout {
        emit_from(app.clone(), Box::new(BufReader::new(o)), port);
    }
    if let Some(e) = stderr {
        emit_from(app, Box::new(BufReader::new(e)), port);
    }
    Ok(())
}

#[tauri::command]
pub fn tunnel_stop(state: tauri::State<'_, TunnelState>, port: u16) {
    if let Some(mut child) = state.0.lock().unwrap().remove(&port) {
        let _ = child.kill();
    }
}
