// Public port tunnels. Providers:
//  - cloudflared: `cloudflared tunnel --url http://localhost:PORT` — NO login needed
//  - ngrok:       `ngrok http PORT` — needs authtoken (ngrok config add-authtoken)
//  - tailscale:   `tailscale funnel PORT` — needs tailscale up + login token
// Parses the public URL from the child's output and emits `tunnel-url`.
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Default)]
pub struct TunnelState(pub Mutex<HashMap<u16, Child>>);

// where we cache auto-downloaded tunnel binaries (next to the program / appdata)
fn bin_dir() -> PathBuf {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("tunnels");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// Resolve a provider's binary: PATH first, else our cache, else download the
// latest official release into the cache. Emits progress via `tunnel-log`.
fn ensure_binary(app: &tauri::AppHandle, provider: &str) -> Result<String, String> {
    // already on PATH?
    if let Ok(out) = crate::util::command("where").arg(provider).output() {
        if out.status.success() {
            if let Some(p) = String::from_utf8_lossy(&out.stdout).lines().next() {
                if !p.trim().is_empty() {
                    return Ok(p.trim().to_string());
                }
            }
        }
    }
    let dir = bin_dir();
    let exe = dir.join(format!("{provider}.exe"));
    if exe.exists() {
        return Ok(exe.to_string_lossy().into_owned());
    }
    let _ = app.emit("tunnel-log", format!("Downloading {provider} (latest official release)..."));
    let exe_s = exe.to_string_lossy().into_owned();
    match provider {
        // cloudflared ships a single .exe on its GitHub latest release
        "cloudflared" => {
            let url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
            dl(url, &exe_s)?;
        }
        // ngrok ships a zip; download + expand + move the exe out
        "ngrok" => {
            let zip = dir.join("ngrok.zip");
            dl("https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip", &zip.to_string_lossy())?;
            let ok = crate::util::command("powershell")
                .args(["-NoProfile", "-Command", &format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force; Remove-Item '{}'",
                    zip.to_string_lossy(), dir.to_string_lossy(), zip.to_string_lossy()
                )])
                .output()
                .map_err(|e| e.to_string())?;
            if !ok.status.success() {
                return Err("failed to extract ngrok".into());
            }
        }
        // tailscale is an MSI/system service — must be installed by the user
        "tailscale" => {
            return Err("tailscale must be installed from tailscale.com (system service). Others auto-download.".into());
        }
        _ => return Err("unknown provider".into()),
    }
    let _ = app.emit("tunnel-log", format!("{provider} ready"));
    Ok(exe_s)
}

fn dl(url: &str, dest: &str) -> Result<(), String> {
    let out = crate::util::command("powershell")
        .args(["-NoProfile", "-Command", &format!(
            "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; \
             Invoke-WebRequest -Uri '{url}' -OutFile '{dest}'"
        )])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() && std::path::Path::new(dest).exists() {
        Ok(())
    } else {
        Err(format!("download failed: {}", String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>()))
    }
}

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
    // auto-download the provider binary if it isn't already available
    let bin = ensure_binary(&app, &provider)?;

    // optional auth setup for providers that need it (best-effort, ignore failure)
    if let Some(t) = token.as_deref().filter(|t| !t.trim().is_empty()) {
        let safe: String = t.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect();
        match provider.as_str() {
            "ngrok" => { let _ = crate::util::command(&bin).args(["config", "add-authtoken", &safe]).output(); }
            "tailscale" => { let _ = crate::util::command(&bin).args(["up", &format!("--authkey={safe}")]).output(); }
            _ => {}
        }
    }

    let mut cmd = match provider.as_str() {
        "cloudflared" => {
            let mut c = crate::util::command(&bin);
            c.args(["tunnel", "--url", &format!("http://localhost:{port}")]);
            c
        }
        "ngrok" => {
            let mut c = crate::util::command(&bin);
            c.args(["http", &port.to_string(), "--log", "stdout"]);
            c
        }
        "tailscale" => {
            let mut c = crate::util::command(&bin);
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
