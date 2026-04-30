use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{BackendError, Result};
use crate::plugin_engine::manifest::{
    OpenCodeExternalAuth, OpenCodeExternalAuthStrategy, OpenCodeExternalAuthType,
};

const OPENCODE_AUTH_RELATIVE_PATH: [&str; 4] = [".local", "share", "opencode", "auth.json"];

pub fn write_auth(
    config: &OpenCodeExternalAuth,
    strategy: &OpenCodeExternalAuthStrategy,
    credentials: &serde_json::Value,
) -> Result<PathBuf> {
    let auth_payload = build_opencode_auth_payload(strategy, credentials)?;
    let auth_file_path = resolve_auth_file_path()?;
    let mut auth_entries = read_auth_entries(&auth_file_path)?;
    auth_entries.insert(non_empty_auth_key(config)?, auth_payload);
    write_auth_entries(&auth_file_path, &auth_entries)?;
    Ok(auth_file_path)
}

pub fn current_auth_matches(
    config: &OpenCodeExternalAuth,
    strategy: &OpenCodeExternalAuthStrategy,
    credentials: &serde_json::Value,
) -> Result<bool> {
    let auth_file_path = resolve_auth_file_path()?;
    let auth_entries = read_auth_entries(&auth_file_path)?;
    let Some(current) = auth_entries.get(non_empty_auth_key(config)?.as_str()) else {
        return Ok(false);
    };
    let candidate = build_opencode_auth_payload(strategy, credentials)?;
    Ok(auth_payload_matches(current, &candidate))
}

fn build_opencode_auth_payload(
    strategy: &OpenCodeExternalAuthStrategy,
    credentials: &serde_json::Value,
) -> Result<serde_json::Value> {
    match strategy.auth_type {
        OpenCodeExternalAuthType::Api => {
            let key = required_string_field(strategy, credentials, "key")?;
            Ok(serde_json::json!({ "type": "api", "key": key }))
        }
        OpenCodeExternalAuthType::OAuth => {
            let access = required_string_field(strategy, credentials, "access")?;
            let refresh = required_string_field(strategy, credentials, "refresh")?;
            let expires = oauth_expires_number(strategy, credentials)?;
            let mut payload = serde_json::Map::new();
            payload.insert(
                "type".to_string(),
                serde_json::Value::String("oauth".to_string()),
            );
            payload.insert("access".to_string(), serde_json::Value::String(access));
            payload.insert("refresh".to_string(), serde_json::Value::String(refresh));
            payload.insert("expires".to_string(), serde_json::Value::Number(expires));

            if let Some(account_id) = optional_string_field(strategy, credentials, "accountId")? {
                payload.insert(
                    "accountId".to_string(),
                    serde_json::Value::String(account_id),
                );
            }
            if let Some(enterprise_url) =
                optional_string_field(strategy, credentials, "enterpriseUrl")?
            {
                payload.insert(
                    "enterpriseUrl".to_string(),
                    serde_json::Value::String(enterprise_url),
                );
            }

            Ok(serde_json::Value::Object(payload))
        }
    }
}

fn auth_payload_matches(current: &serde_json::Value, candidate: &serde_json::Value) -> bool {
    match (current.get("type"), candidate.get("type")) {
        (Some(current_type), Some(candidate_type)) if current_type != candidate_type => false,
        _ => {
            if current.get("type").and_then(|value| value.as_str()) == Some("api") {
                return same_non_empty_string(current, candidate, "key");
            }
            if current.get("type").and_then(|value| value.as_str()) == Some("oauth") {
                return same_non_empty_string(current, candidate, "accountId")
                    || same_non_empty_string(current, candidate, "refresh")
                    || same_non_empty_string(current, candidate, "access");
            }
            current == candidate
        }
    }
}

fn same_non_empty_string(
    current: &serde_json::Value,
    candidate: &serde_json::Value,
    field: &str,
) -> bool {
    let Some(current_value) = current.get(field).and_then(|value| value.as_str()) else {
        return false;
    };
    let Some(candidate_value) = candidate.get(field).and_then(|value| value.as_str()) else {
        return false;
    };
    !current_value.trim().is_empty() && current_value == candidate_value
}

fn field_pointer<'a>(strategy: &'a OpenCodeExternalAuthStrategy, name: &str) -> Result<&'a str> {
    strategy
        .fields
        .get(name)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| provider_error(format!("OpenCode field mapping '{name}' is missing")))
}

fn optional_field_value<'a>(
    strategy: &OpenCodeExternalAuthStrategy,
    credentials: &'a serde_json::Value,
    name: &str,
) -> Result<Option<&'a serde_json::Value>> {
    let Some(pointer) = strategy.fields.get(name).map(|value| value.trim()) else {
        return Ok(None);
    };
    if pointer.is_empty() {
        return Ok(None);
    }
    Ok(credentials.pointer(pointer))
}

fn required_string_field(
    strategy: &OpenCodeExternalAuthStrategy,
    credentials: &serde_json::Value,
    name: &str,
) -> Result<String> {
    let pointer = field_pointer(strategy, name)?;
    let value = credentials.pointer(pointer).ok_or_else(|| {
        provider_error(format!(
            "OpenCode field '{name}' points to missing credential value"
        ))
    })?;
    string_from_value(value).ok_or_else(|| {
        provider_error(format!(
            "OpenCode field '{name}' must point to a non-empty string"
        ))
    })
}

fn optional_string_field(
    strategy: &OpenCodeExternalAuthStrategy,
    credentials: &serde_json::Value,
    name: &str,
) -> Result<Option<String>> {
    let Some(value) = optional_field_value(strategy, credentials, name)? else {
        return Ok(None);
    };
    Ok(string_from_value(value))
}

fn string_from_value(value: &serde_json::Value) -> Option<String> {
    let value = value.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn required_number_field(
    strategy: &OpenCodeExternalAuthStrategy,
    credentials: &serde_json::Value,
    name: &str,
) -> Result<serde_json::Number> {
    let pointer = field_pointer(strategy, name)?;
    let value = credentials.pointer(pointer).ok_or_else(|| {
        provider_error(format!(
            "OpenCode field '{name}' points to missing credential value"
        ))
    })?;
    number_from_value(value).ok_or_else(|| {
        provider_error(format!(
            "OpenCode field '{name}' must point to a finite number"
        ))
    })
}

fn optional_number_field(
    strategy: &OpenCodeExternalAuthStrategy,
    credentials: &serde_json::Value,
    name: &str,
) -> Result<Option<serde_json::Number>> {
    let Some(value) = optional_field_value(strategy, credentials, name)? else {
        return Ok(None);
    };
    Ok(number_from_value(value))
}

fn oauth_expires_number(
    strategy: &OpenCodeExternalAuthStrategy,
    credentials: &serde_json::Value,
) -> Result<serde_json::Number> {
    let number = if strategy
        .fields
        .get("expires")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        required_number_field(strategy, credentials, "expires")?
    } else {
        optional_number_field(strategy, credentials, "expires")?.unwrap_or_else(|| 0.into())
    };
    expires_to_millis(number)
}

fn expires_to_millis(number: serde_json::Number) -> Result<serde_json::Number> {
    let Some(value) = number.as_f64() else {
        return Err(provider_error("OpenCode field 'expires' must be finite"));
    };
    if !value.is_finite() || value < 0.0 || value > i64::MAX as f64 {
        return Err(provider_error("OpenCode field 'expires' must be finite"));
    }

    let millis = if value > 0.0 && value < 100_000_000_000.0 {
        value * 1000.0
    } else {
        value
    };

    Ok(serde_json::Number::from(millis.floor() as i64))
}

fn number_from_value(value: &serde_json::Value) -> Option<serde_json::Number> {
    match value {
        serde_json::Value::Number(number) => Some(number.clone()),
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(integer) = trimmed.parse::<i64>() {
                return Some(integer.into());
            }
            let parsed = trimmed.parse::<f64>().ok()?;
            serde_json::Number::from_f64(parsed)
        }
        _ => None,
    }
}

fn non_empty_auth_key(config: &OpenCodeExternalAuth) -> Result<String> {
    let key = config.auth_key.trim();
    if key.is_empty() {
        return Err(provider_error("OpenCode authKey is empty"));
    }
    Ok(key.to_string())
}

fn resolve_auth_file_path() -> Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let app_data = env::var_os("APPDATA")
            .or_else(|| env::var_os("LOCALAPPDATA"))
            .ok_or_else(|| BackendError::Path("APPDATA is not set".to_string()))?;
        let mut path = PathBuf::from(app_data);
        path.push("opencode");
        path.push("auth.json");
        Ok(path)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home_dir =
            env::var_os("HOME").ok_or_else(|| BackendError::Path("HOME is not set".to_string()))?;
        let mut path = PathBuf::from(home_dir);
        for part in OPENCODE_AUTH_RELATIVE_PATH {
            path.push(part);
        }
        Ok(path)
    }
}

fn read_auth_entries(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }

    let raw = fs::read_to_string(path)?;
    if raw.trim().is_empty() {
        return Ok(serde_json::Map::new());
    }

    let parsed: serde_json::Value = serde_json::from_str(&raw)?;
    parsed.as_object().cloned().ok_or_else(|| {
        provider_error(format!(
            "OpenCode auth file is not a JSON object: {}",
            path.display()
        ))
    })
}

fn write_auth_entries(
    path: &Path,
    entries: &serde_json::Map<String, serde_json::Value>,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let serialized = serde_json::to_string_pretty(entries)?;
    fs::write(path, format!("{serialized}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn provider_error(message: impl Into<String>) -> BackendError {
    BackendError::Plugin(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn oauth_strategy() -> OpenCodeExternalAuthStrategy {
        OpenCodeExternalAuthStrategy {
            auth_type: OpenCodeExternalAuthType::OAuth,
            fields: HashMap::from([
                ("access".to_string(), "/accessToken".to_string()),
                ("refresh".to_string(), "/refreshToken".to_string()),
                ("expires".to_string(), "/expiresAt".to_string()),
                ("accountId".to_string(), "/accountId".to_string()),
            ]),
        }
    }

    fn api_strategy() -> OpenCodeExternalAuthStrategy {
        OpenCodeExternalAuthStrategy {
            auth_type: OpenCodeExternalAuthType::Api,
            fields: HashMap::from([("key".to_string(), "/apiKey".to_string())]),
        }
    }

    #[test]
    fn builds_oauth_payload_from_manifest_mapping() {
        let credentials = serde_json::json!({
            "accessToken": "access",
            "refreshToken": "refresh",
            "expiresAt": 1770000000,
            "accountId": "acct_123"
        });

        let payload = build_opencode_auth_payload(&oauth_strategy(), &credentials).unwrap();

        assert_eq!(payload["type"], "oauth");
        assert_eq!(payload["access"], "access");
        assert_eq!(payload["refresh"], "refresh");
        assert_eq!(payload["expires"], 1770000000000_i64);
        assert_eq!(payload["accountId"], "acct_123");
    }

    #[test]
    fn builds_oauth_payload_with_default_zero_expiry() {
        let strategy = OpenCodeExternalAuthStrategy {
            auth_type: OpenCodeExternalAuthType::OAuth,
            fields: HashMap::from([
                ("access".to_string(), "/accessToken".to_string()),
                ("refresh".to_string(), "/accessToken".to_string()),
            ]),
        };
        let credentials = serde_json::json!({ "accessToken": "gho_token" });

        let payload = build_opencode_auth_payload(&strategy, &credentials).unwrap();

        assert_eq!(payload["type"], "oauth");
        assert_eq!(payload["access"], "gho_token");
        assert_eq!(payload["refresh"], "gho_token");
        assert_eq!(payload["expires"], 0);
    }

    #[test]
    fn builds_api_payload_from_manifest_mapping() {
        let credentials = serde_json::json!({ "apiKey": "zai-key" });

        let payload = build_opencode_auth_payload(&api_strategy(), &credentials).unwrap();

        assert_eq!(
            payload,
            serde_json::json!({ "type": "api", "key": "zai-key" })
        );
    }

    #[test]
    fn matches_api_payload_by_key() {
        assert!(auth_payload_matches(
            &serde_json::json!({ "type": "api", "key": "same" }),
            &serde_json::json!({ "type": "api", "key": "same" })
        ));
        assert!(!auth_payload_matches(
            &serde_json::json!({ "type": "api", "key": "one" }),
            &serde_json::json!({ "type": "api", "key": "two" })
        ));
    }

    #[test]
    fn matches_oauth_payload_by_stable_fields() {
        assert!(auth_payload_matches(
            &serde_json::json!({
                "type": "oauth",
                "access": "new-access",
                "refresh": "same-refresh",
                "expires": 1770000100,
                "accountId": "acct_123"
            }),
            &serde_json::json!({
                "type": "oauth",
                "access": "old-access",
                "refresh": "same-refresh",
                "expires": 1770000000,
                "accountId": "acct_123"
            })
        ));
        assert!(!auth_payload_matches(
            &serde_json::json!({ "type": "oauth", "refresh": "one" }),
            &serde_json::json!({ "type": "oauth", "refresh": "two" })
        ));
    }
}
