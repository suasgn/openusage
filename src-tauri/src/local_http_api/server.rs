use super::cache::{cache_state, enabled_snapshots_ordered};
use crate::AppState;
use crate::account_store::AccountStore;
use crate::error::BackendError;
use crate::external_auth;
use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use tauri::Manager;

const BIND_ADDR: &str = "127.0.0.1:6736";
const OPENCODE_SYNC_PATH: &str = "/v1/external-auth/opencode/sync";
const OPENCODE_ROTATE_PATH: &str = "/v1/external-auth/opencode/rotate";

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

pub fn start_server(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(BIND_ADDR) {
            Ok(l) => {
                log::info!("local HTTP API listening on {}", BIND_ADDR);
                l
            }
            Err(e) => {
                log::warn!(
                    "failed to bind local HTTP API on {}: {} — feature disabled for this session",
                    BIND_ADDR,
                    e
                );
                return;
            }
        };

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let app = app.clone();
                    std::thread::spawn(move || handle_connection(stream, app));
                }
                Err(e) => log::debug!("local HTTP API accept error: {}", e),
            }
        }
    });
}

fn handle_connection(mut stream: TcpStream, app: tauri::AppHandle) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));

    // Read request (up to 4 KB is plenty for a request line + headers)
    let mut buf = [0u8; 4096];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return,
    };
    let request = String::from_utf8_lossy(&buf[..n]);

    // Parse request line: "METHOD /path HTTP/1.x\r\n..."
    let first_line = request.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_path = parts.next().unwrap_or("");

    // Strip query string and trailing slash (but keep root "/v1/usage" intact)
    let path = raw_path.split('?').next().unwrap_or(raw_path);
    let path = if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    };

    let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
    let response = route(method, path, body, Some(&app));
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn route(method: &str, path: &str, body: &str, app: Option<&tauri::AppHandle>) -> String {
    // Match routes
    if path == "/v1/usage" {
        return match method {
            "GET" => handle_get_usage_collection(),
            "OPTIONS" => response_no_content(),
            _ => response_method_not_allowed(),
        };
    }

    if path == OPENCODE_SYNC_PATH {
        return match method {
            "POST" => handle_sync_opencode_auth(body, app),
            "OPTIONS" => response_no_content(),
            _ => response_method_not_allowed(),
        };
    }

    if path == OPENCODE_ROTATE_PATH {
        return match method {
            "POST" => handle_rotate_opencode_auth(body, app),
            "OPTIONS" => response_no_content(),
            _ => response_method_not_allowed(),
        };
    }

    if let Some(provider_id) = path.strip_prefix("/v1/usage/") {
        if !provider_id.is_empty() && !provider_id.contains('/') {
            return match method {
                "GET" => handle_get_usage_single(provider_id),
                "OPTIONS" => response_no_content(),
                _ => response_method_not_allowed(),
            };
        }
    }

    response_not_found("not_found")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncOpenCodeAuthRequest {
    account_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RotateOpenCodeAuthRequest {
    plugin_id: Option<String>,
    opencode_auth_key: Option<String>,
}

enum RotateOpenCodeAuthTarget {
    PluginId(String),
    OpenCodeAuthKey(String),
}

impl RotateOpenCodeAuthRequest {
    fn target(self) -> std::result::Result<RotateOpenCodeAuthTarget, &'static str> {
        if let Some(plugin_id) = non_empty_string(self.plugin_id) {
            return Ok(RotateOpenCodeAuthTarget::PluginId(plugin_id));
        }
        if let Some(auth_key) = non_empty_string(self.opencode_auth_key) {
            return Ok(RotateOpenCodeAuthTarget::OpenCodeAuthKey(auth_key));
        }
        Err("pluginId or opencodeAuthKey is required")
    }
}

fn non_empty_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn handle_sync_opencode_auth(body: &str, app: Option<&tauri::AppHandle>) -> String {
    let request = match serde_json::from_str::<SyncOpenCodeAuthRequest>(body) {
        Ok(request) if !request.account_id.trim().is_empty() => request,
        Ok(_) => return response_bad_request("accountId is required"),
        Err(err) => return response_bad_request(format!("invalid JSON body: {err}")),
    };
    let Some(app) = app else {
        return response_service_unavailable("app_unavailable");
    };
    let state = app.state::<Mutex<AppState>>();
    let store = app.state::<AccountStore>();
    match external_auth::sync_opencode_account(
        app,
        state.inner(),
        store.inner(),
        &request.account_id,
    ) {
        Ok(result) => response_json_value(200, "OK", &result),
        Err(err) => response_backend_error(err),
    }
}

fn handle_rotate_opencode_auth(body: &str, app: Option<&tauri::AppHandle>) -> String {
    let target = match serde_json::from_str::<RotateOpenCodeAuthRequest>(body) {
        Ok(request) => match request.target() {
            Ok(target) => target,
            Err(message) => return response_bad_request(message),
        },
        Err(err) => return response_bad_request(format!("invalid JSON body: {err}")),
    };
    let Some(app) = app else {
        return response_service_unavailable("app_unavailable");
    };
    let state = app.state::<Mutex<AppState>>();
    let store = app.state::<AccountStore>();
    let result = match target {
        RotateOpenCodeAuthTarget::PluginId(plugin_id) => {
            external_auth::rotate_opencode_plugin(app, state.inner(), store.inner(), &plugin_id)
        }
        RotateOpenCodeAuthTarget::OpenCodeAuthKey(auth_key) => {
            external_auth::rotate_opencode_auth_key(app, state.inner(), store.inner(), &auth_key)
        }
    };
    match result {
        Ok(result) => response_json_value(200, "OK", &result),
        Err(err) => response_backend_error(err),
    }
}

fn handle_get_usage_collection() -> String {
    let snapshots = {
        let state = cache_state().lock().expect("cache state poisoned");
        enabled_snapshots_ordered(&state)
    };
    let body = serde_json::to_string(&snapshots).unwrap_or_else(|_| "[]".to_string());
    response_json(200, "OK", &body)
}

fn handle_get_usage_single(provider_id: &str) -> String {
    let state = cache_state().lock().expect("cache state poisoned");

    // Check if provider is known at all
    let is_known = state.known_plugin_ids.iter().any(|id| id == provider_id);
    if !is_known {
        return response_not_found("provider_not_found");
    }

    match state.snapshots.get(provider_id) {
        Some(snapshot) => {
            let body = serde_json::to_string(snapshot).unwrap_or_else(|_| "{}".to_string());
            response_json(200, "OK", &body)
        }
        None => response_no_content(),
    }
}

// ---------------------------------------------------------------------------
// HTTP response builders
// ---------------------------------------------------------------------------

const CORS_HEADERS: &str = "\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type";

fn response_json_value<T: serde::Serialize>(status: u16, reason: &str, value: &T) -> String {
    let body = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    response_json(status, reason, &body)
}

fn response_json(status: u16, reason: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n{}\r\nContent-Length: {}\r\n\r\n{}",
        status,
        reason,
        CORS_HEADERS,
        body.as_bytes().len(),
        body,
    )
}

fn response_no_content() -> String {
    format!(
        "HTTP/1.1 204 No Content\r\nConnection: close\r\n{}\r\n\r\n",
        CORS_HEADERS,
    )
}

fn response_not_found(error_code: &str) -> String {
    let body = format!(r#"{{"error":"{}"}}"#, error_code);
    response_json(404, "Not Found", &body)
}

fn response_bad_request(message: impl Into<String>) -> String {
    response_error_json(400, "Bad Request", "bad_request", message)
}

fn response_service_unavailable(error_code: &str) -> String {
    let body = serde_json::json!({ "error": error_code }).to_string();
    response_json(503, "Service Unavailable", &body)
}

fn response_backend_error(err: BackendError) -> String {
    match err {
        BackendError::AccountNotFound => {
            response_error_json(404, "Not Found", "account_not_found", "account not found")
        }
        BackendError::Validation(message) | BackendError::Plugin(message) => {
            response_error_json(400, "Bad Request", "request_failed", message)
        }
        other => response_error_json(
            500,
            "Internal Server Error",
            "request_failed",
            other.to_string(),
        ),
    }
}

fn response_error_json(
    status: u16,
    reason: &str,
    error_code: &str,
    message: impl Into<String>,
) -> String {
    let body = serde_json::json!({ "error": error_code, "message": message.into() }).to_string();
    response_json(status, reason, &body)
}

fn response_method_not_allowed() -> String {
    let body = r#"{"error":"method_not_allowed"}"#;
    response_json(405, "Method Not Allowed", body)
}

#[cfg(test)]
mod tests {
    use super::super::cache::{CachedPluginSnapshot, cache_state};
    use super::*;
    use serial_test::serial;

    fn make_snapshot(id: &str, name: &str) -> CachedPluginSnapshot {
        CachedPluginSnapshot {
            provider_id: id.to_string(),
            display_name: name.to_string(),
            plan: Some("Pro".to_string()),
            lines: vec![],
            fetched_at: "2026-03-26T08:15:30Z".to_string(),
        }
    }

    fn route_test(method: &str, path: &str) -> String {
        route(method, path, "", None)
    }

    #[test]
    fn route_get_usage_returns_200() {
        let resp = route_test("GET", "/v1/usage");
        assert!(resp.starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn route_unknown_path_returns_404() {
        let resp = route_test("GET", "/v2/something");
        assert!(resp.starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn route_post_returns_405() {
        let resp = route_test("POST", "/v1/usage");
        assert!(resp.starts_with("HTTP/1.1 405"));
    }

    #[test]
    fn route_options_returns_204_with_cors() {
        let resp = route_test("OPTIONS", "/v1/usage");
        assert!(resp.starts_with("HTTP/1.1 204"));
        assert!(resp.contains("Access-Control-Allow-Origin: *"));
    }

    #[test]
    fn route_opencode_sync_requires_json_body() {
        let resp = route("POST", OPENCODE_SYNC_PATH, "not-json", None);
        assert!(resp.starts_with("HTTP/1.1 400"));
        assert!(resp.contains("bad_request"));
    }

    #[test]
    fn route_opencode_rotate_requires_app_state_after_valid_body() {
        let resp = route(
            "POST",
            OPENCODE_ROTATE_PATH,
            r#"{"pluginId":"codex"}"#,
            None,
        );
        assert!(resp.starts_with("HTTP/1.1 503"));
        assert!(resp.contains("app_unavailable"));
    }

    #[test]
    fn route_opencode_rotate_accepts_opencode_auth_key() {
        let resp = route(
            "POST",
            OPENCODE_ROTATE_PATH,
            r#"{"opencodeAuthKey":"zai-coding-plan","modelId":"glm-4.6"}"#,
            None,
        );
        assert!(resp.starts_with("HTTP/1.1 503"));
        assert!(resp.contains("app_unavailable"));
    }

    #[test]
    fn route_opencode_rotate_requires_target() {
        let resp = route("POST", OPENCODE_ROTATE_PATH, r#"{"pluginId":" "}"#, None);
        assert!(resp.starts_with("HTTP/1.1 400"));
        assert!(resp.contains("pluginId or opencodeAuthKey is required"));
    }

    #[test]
    #[serial]
    fn route_unknown_provider_returns_404() {
        {
            let mut state = cache_state().lock().unwrap();
            state.known_plugin_ids = vec!["claude".to_string()];
            state.snapshots.clear();
        }

        let resp = route_test("GET", "/v1/usage/nonexistent");
        assert!(resp.starts_with("HTTP/1.1 404"));
        assert!(resp.contains("provider_not_found"));
    }

    #[test]
    #[serial]
    fn route_known_uncached_provider_returns_204() {
        {
            let mut state = cache_state().lock().unwrap();
            state.known_plugin_ids = vec!["claude".to_string()];
            state.snapshots.clear();
        }

        let resp = route_test("GET", "/v1/usage/claude");
        assert!(resp.starts_with("HTTP/1.1 204"));
    }

    #[test]
    #[serial]
    fn route_known_cached_provider_returns_200() {
        {
            let mut state = cache_state().lock().unwrap();
            state.known_plugin_ids = vec!["claude".to_string()];
            state
                .snapshots
                .insert("claude".to_string(), make_snapshot("claude", "Claude"));
        }

        let resp = route_test("GET", "/v1/usage/claude");
        assert!(resp.starts_with("HTTP/1.1 200"));
        assert!(resp.contains("fetchedAt"));
    }

    #[test]
    fn route_options_on_provider_returns_204() {
        let resp = route_test("OPTIONS", "/v1/usage/claude");
        assert!(resp.starts_with("HTTP/1.1 204"));
        assert!(resp.contains("Access-Control-Allow-Methods: GET, POST, OPTIONS"));
    }

    #[test]
    fn response_json_includes_cors_headers() {
        let resp = response_json(200, "OK", "[]");
        assert!(resp.contains("Access-Control-Allow-Origin: *"));
        assert!(resp.contains("Content-Type: application/json; charset=utf-8"));
    }
}
