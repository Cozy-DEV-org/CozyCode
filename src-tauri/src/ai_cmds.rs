// AI commit-message generation. Provider-agnostic:
// - anthropic=true  -> Anthropic Messages API
// - anthropic=false -> any OpenAI-compatible /chat/completions (openai, openrouter, z.ai, groq, ollama, ...)
// ponytail: HTTP via PowerShell Invoke-RestMethod — no Rust HTTP stack; body passes
// through a temp file so prompts/diffs never touch shell quoting.
use std::process::Command;

fn sanitize_token(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_graphic() && *c != '\'' && *c != '"').collect()
}

// "data:image/png;base64,AAAA" -> ("image/png", "AAAA")
fn parse_data_url(d: &str) -> Option<(String, String)> {
    let rest = d.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(",")?;
    let mt = meta.split(';').next().unwrap_or("image/png").to_string();
    Some((mt, data.to_string()))
}

// images: optional list of data URLs ("data:image/png;base64,....") for vision models
#[tauri::command]
pub async fn ai_generate(
    base_url: String,
    api_key: String,
    model: String,
    anthropic: bool,
    system: String,
    prompt: String,
    images: Option<Vec<String>>,
) -> Result<String, String> {
    let key = sanitize_token(&api_key);
    let url_ok = base_url.starts_with("https://") || base_url.starts_with("http://");
    if !url_ok {
        return Err("base URL must start with http(s)://".into());
    }
    let url = sanitize_token(base_url.trim_end_matches('/'));

    let imgs = images.unwrap_or_default();
    let has_imgs = !imgs.is_empty();

    let body = if anthropic {
        let content = if has_imgs {
            let mut blocks = vec![serde_json::json!({"type": "text", "text": prompt})];
            for d in &imgs {
                if let Some((mt, data)) = parse_data_url(d) {
                    blocks.push(serde_json::json!({
                        "type": "image",
                        "source": {"type": "base64", "media_type": mt, "data": data}
                    }));
                }
            }
            serde_json::Value::Array(blocks)
        } else {
            serde_json::Value::String(prompt.clone())
        };
        serde_json::json!({
            "model": model, "max_tokens": 2048, "system": system,
            "messages": [{"role": "user", "content": content}]
        })
    } else {
        let content = if has_imgs {
            let mut blocks = vec![serde_json::json!({"type": "text", "text": prompt})];
            for d in &imgs {
                blocks.push(serde_json::json!({"type": "image_url", "image_url": {"url": d}}));
            }
            serde_json::Value::Array(blocks)
        } else {
            serde_json::Value::String(prompt.clone())
        };
        serde_json::json!({
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}]
        })
    };
    let tmp = std::env::temp_dir().join("cozy_ai_body.json");
    std::fs::write(&tmp, serde_json::to_vec(&body).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let tmp_s = tmp.to_string_lossy().into_owned();

    let (endpoint, headers) = if anthropic {
        (
            format!("{url}/v1/messages"),
            format!("@{{'x-api-key'='{key}'; 'anthropic-version'='2023-06-01'; 'content-type'='application/json'}}"),
        )
    } else {
        (
            format!("{url}/chat/completions"),
            format!("@{{'Authorization'='Bearer {key}'; 'content-type'='application/json'}}"),
        )
    };
    let script = format!(
        "$body = [System.IO.File]::ReadAllText('{tmp_s}'); \
         (Invoke-RestMethod -Uri '{endpoint}' -Method Post -Headers {headers} -Body $body) | ConvertTo-Json -Depth 20 -Compress"
    );
    let out = crate::util::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| e.to_string())?;
    std::fs::remove_file(&tmp).ok();
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).chars().take(500).collect());
    }
    let resp: serde_json::Value =
        serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim()).map_err(|e| e.to_string())?;
    let text = if anthropic {
        resp["content"][0]["text"].as_str().map(String::from)
    } else {
        resp["choices"][0]["message"]["content"].as_str().map(String::from)
    };
    text.ok_or_else(|| format!("unexpected response: {}", resp.to_string().chars().take(300).collect::<String>()))
}
