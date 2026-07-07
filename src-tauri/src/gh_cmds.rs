// GitHub REST API bridge (token auth) + OAuth Device Flow (browser sign-in).
use serde::Serialize;
use std::process::Command;

fn ps_json(script: &str) -> Result<serde_json::Value, String> {
    let out = crate::util::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).chars().take(400).collect());
    }
    serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
}

// Step 1: request a device+user code. client_id = a GitHub OAuth App with
// "Device Flow" enabled (no client secret needed for device flow).
#[tauri::command]
pub async fn gh_device_start(client_id: String, scope: String) -> Result<DeviceCode, String> {
    let cid: String = client_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
    let sc: String = scope.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | ' ')).collect();
    if cid.is_empty() {
        return Err("no client id".into());
    }
    let v = ps_json(&format!(
        "Invoke-RestMethod -Uri 'https://github.com/login/device/code' -Method Post \
         -Headers @{{'Accept'='application/json'}} \
         -Body @{{client_id='{cid}'; scope='{sc}'}} | ConvertTo-Json -Compress"
    ))?;
    Ok(DeviceCode {
        device_code: v["device_code"].as_str().unwrap_or("").into(),
        user_code: v["user_code"].as_str().unwrap_or("").into(),
        verification_uri: v["verification_uri"].as_str().unwrap_or("https://github.com/login/device").into(),
        interval: v["interval"].as_u64().unwrap_or(5),
    })
}

// Step 2: poll for the token. Returns Ok(Some(token)) when authorized,
// Ok(None) while pending, Err on hard failure.
#[tauri::command]
pub async fn gh_device_poll(client_id: String, device_code: String) -> Result<Option<String>, String> {
    let cid: String = client_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
    let dc: String = device_code.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    let v = ps_json(&format!(
        "Invoke-RestMethod -Uri 'https://github.com/login/oauth/access_token' -Method Post \
         -Headers @{{'Accept'='application/json'}} \
         -Body @{{client_id='{cid}'; device_code='{dc}'; grant_type='urn:ietf:params:oauth:grant-type:device_code'}} | ConvertTo-Json -Compress"
    ))?;
    if let Some(tok) = v["access_token"].as_str() {
        return Ok(Some(tok.to_string()));
    }
    match v["error"].as_str() {
        Some("authorization_pending") | Some("slow_down") => Ok(None),
        Some(e) => Err(e.to_string()),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn gh_api(token: String, method: String, path: String, body: Option<String>) -> Result<String, String> {
    let tok: String = token.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    if !path.starts_with('/') || path.contains('\'') {
        return Err("bad path".into());
    }
    let m = match method.as_str() {
        "GET" | "POST" | "PATCH" | "PUT" | "DELETE" => method.as_str(),
        _ => return Err("bad method".into()),
    };
    let mut script = format!(
        "Invoke-RestMethod -Uri 'https://api.github.com{path}' -Method {m} \
         -Headers @{{'Authorization'='Bearer {tok}'; 'Accept'='application/vnd.github+json'; 'User-Agent'='CozyCode'}}"
    );
    if let Some(b) = body {
        let tmp = std::env::temp_dir().join("cozy_gh_body.json");
        std::fs::write(&tmp, b.as_bytes()).map_err(|e| e.to_string())?;
        script = format!(
            "$body = [System.IO.File]::ReadAllText('{}'); {script} -Body $body -ContentType 'application/json'",
            tmp.to_string_lossy()
        );
    }
    script.push_str(" | ConvertTo-Json -Depth 15 -Compress");
    let out = crate::util::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).chars().take(500).collect())
    }
}
