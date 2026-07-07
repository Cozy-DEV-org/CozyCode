// Built-in SSH Remote: sftp read/write/list + exec + port forwarding (ssh2/libssh2).
use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Deserialize)]
pub struct SshAuth {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_path: Option<String>,
    pub password: Option<String>,
}

pub struct SshConn {
    session: Session,
    auth: SshAuth,
}

#[derive(Default)]
pub struct SshState {
    conns: Mutex<HashMap<String, SshConn>>,
    forwards: Mutex<HashMap<u16, Arc<AtomicBool>>>,
}

fn connect_session(a: &SshAuth) -> Result<Session, String> {
    let tcp = TcpStream::connect((a.host.as_str(), a.port)).map_err(|e| e.to_string())?;
    tcp.set_read_timeout(Some(Duration::from_secs(30))).ok();
    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| e.to_string())?;
    if let Some(key) = a.key_path.as_deref().filter(|k| !k.is_empty()) {
        sess.userauth_pubkey_file(&a.user, None, Path::new(key), a.password.as_deref().filter(|p| !p.is_empty()))
            .map_err(|e| format!("key auth failed: {}", e))?;
    } else if let Some(pw) = a.password.as_deref() {
        sess.userauth_password(&a.user, pw).map_err(|e| format!("password auth failed: {}", e))?;
    } else {
        return Err("no auth method (set key_path or password)".into());
    }
    Ok(sess)
}

#[tauri::command]
pub fn ssh_connect(state: tauri::State<'_, SshState>, id: String, auth: SshAuth) -> Result<String, String> {
    let sess = connect_session(&auth)?;
    // resolve home dir for default path convenience
    let mut home = String::new();
    if let Ok(mut ch) = sess.channel_session() {
        if ch.exec("echo $HOME").is_ok() {
            ch.read_to_string(&mut home).ok();
            ch.wait_close().ok();
        }
    }
    state.conns.lock().unwrap().insert(id, SshConn { session: sess, auth });
    Ok(home.trim().to_string())
}

#[tauri::command]
pub fn ssh_disconnect(state: tauri::State<'_, SshState>, id: String) {
    state.conns.lock().unwrap().remove(&id);
}

#[derive(Serialize)]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn ssh_list_dir(state: tauri::State<'_, SshState>, id: String, path: String) -> Result<Vec<RemoteEntry>, String> {
    let conns = state.conns.lock().unwrap();
    let c = conns.get(&id).ok_or("not connected")?;
    let sftp = c.session.sftp().map_err(|e| e.to_string())?;
    let mut out: Vec<RemoteEntry> = sftp
        .readdir(Path::new(&path))
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(p, stat)| RemoteEntry {
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path: p.to_string_lossy().replace('\\', "/"),
            is_dir: stat.is_dir(),
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
pub fn ssh_read_file(state: tauri::State<'_, SshState>, id: String, path: String) -> Result<String, String> {
    let conns = state.conns.lock().unwrap();
    let c = conns.get(&id).ok_or("not connected")?;
    let sftp = c.session.sftp().map_err(|e| e.to_string())?;
    let mut f = sftp.open(Path::new(&path)).map_err(|e| e.to_string())?;
    let mut s = String::new();
    f.read_to_string(&mut s).map_err(|e| e.to_string())?;
    Ok(s)
}

#[tauri::command]
pub fn ssh_write_file(state: tauri::State<'_, SshState>, id: String, path: String, content: String) -> Result<(), String> {
    let conns = state.conns.lock().unwrap();
    let c = conns.get(&id).ok_or("not connected")?;
    let sftp = c.session.sftp().map_err(|e| e.to_string())?;
    let mut f = sftp.create(Path::new(&path)).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_exec(state: tauri::State<'_, SshState>, id: String, cmd: String) -> Result<String, String> {
    let conns = state.conns.lock().unwrap();
    let c = conns.get(&id).ok_or("not connected")?;
    let mut ch = c.session.channel_session().map_err(|e| e.to_string())?;
    ch.exec(&cmd).map_err(|e| e.to_string())?;
    let mut s = String::new();
    ch.read_to_string(&mut s).ok();
    ch.wait_close().ok();
    Ok(s)
}

// ponytail: each forwarded client opens its own SSH session — dead simple and
// thread-safe; multiplex channels on one session if handshake latency matters.
#[tauri::command]
pub fn ssh_forward_start(
    state: tauri::State<'_, SshState>,
    id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<(), String> {
    let auth = {
        let conns = state.conns.lock().unwrap();
        conns.get(&id).ok_or("not connected")?.auth.clone()
    };
    let listener = TcpListener::bind(("127.0.0.1", local_port)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).ok();
    let stop = Arc::new(AtomicBool::new(false));
    state.forwards.lock().unwrap().insert(local_port, stop.clone());

    std::thread::spawn(move || {
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match listener.accept() {
                Ok((client, _)) => {
                    let auth = auth.clone();
                    let rh = remote_host.clone();
                    let stop2 = stop.clone();
                    std::thread::spawn(move || {
                        let Ok(sess) = connect_session(&auth) else { return };
                        let Ok(mut ch) = sess.channel_direct_tcpip(&rh, remote_port, None) else { return };
                        client.set_nonblocking(true).ok();
                        sess.set_blocking(false);
                        let mut buf = [0u8; 16384];
                        let mut client = client;
                        loop {
                            if stop2.load(Ordering::Relaxed) {
                                break;
                            }
                            let mut idle = true;
                            match client.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    idle = false;
                                    let mut off = 0;
                                    while off < n {
                                        match ch.write(&buf[off..n]) {
                                            Ok(w) => off += w,
                                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                                std::thread::sleep(Duration::from_millis(2))
                                            }
                                            Err(_) => return,
                                        }
                                    }
                                }
                                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                                Err(_) => break,
                            }
                            match ch.read(&mut buf) {
                                Ok(0) => {
                                    if ch.eof() {
                                        break;
                                    }
                                }
                                Ok(n) => {
                                    idle = false;
                                    let mut off = 0;
                                    while off < n {
                                        match client.write(&buf[off..n]) {
                                            Ok(w) => off += w,
                                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                                std::thread::sleep(Duration::from_millis(2))
                                            }
                                            Err(_) => return,
                                        }
                                    }
                                }
                                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                                Err(_) => break,
                            }
                            if idle {
                                std::thread::sleep(Duration::from_millis(3));
                            }
                        }
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn ssh_forward_stop(state: tauri::State<'_, SshState>, local_port: u16) {
    if let Some(stop) = state.forwards.lock().unwrap().remove(&local_port) {
        stop.store(true, Ordering::Relaxed);
    }
}
