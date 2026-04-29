use std::path::{Path, PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde_json::Value;

use crate::error::Result;
use crate::models::AccountRecord;
use crate::plugin_engine::host_api;
use crate::plugin_engine::manifest::{
    AuthCredentialFieldMapping, AuthCredentialImportKind, AuthCredentialImportPath,
    AuthCredentialImportSource, AuthCredentialJsonMapping, AuthCredentialTextDecode,
    AuthCredentialTextMapping, AuthCredentialValueNormalize, AuthStrategyManifest, LoadedPlugin,
};

pub fn import_account_credentials(
    plugin: &LoadedPlugin,
    account: &AccountRecord,
    app_data_dir: &Path,
) -> Result<Option<Value>> {
    let Some(strategy) = import_strategy(plugin, account) else {
        return Ok(None);
    };

    for source in &strategy.import_sources {
        match import_from_source(source, &plugin.manifest.id, app_data_dir) {
            Some(credentials) => {
                log::info!(
                    "imported account credentials for plugin {} account {} from source {}",
                    plugin.manifest.id,
                    account.id,
                    source.id
                );
                return Ok(Some(credentials));
            }
            None => {
                log::debug!(
                    "credential import source {} had no credentials for plugin {} account {}",
                    source.id,
                    plugin.manifest.id,
                    account.id
                );
            }
        }
    }

    Ok(None)
}

fn import_strategy<'a>(
    plugin: &'a LoadedPlugin,
    account: &AccountRecord,
) -> Option<&'a AuthStrategyManifest> {
    if account.plugin_id != plugin.manifest.id {
        return None;
    }
    let auth = plugin.manifest.auth.as_ref()?;
    let strategy_id = account
        .auth_strategy_id
        .as_deref()
        .or(auth.default_strategy_id.as_deref())?;
    auth.strategies
        .iter()
        .find(|strategy| strategy.id == strategy_id && !strategy.import_sources.is_empty())
}

fn import_from_source(
    source: &AuthCredentialImportSource,
    plugin_id: &str,
    app_data_dir: &Path,
) -> Option<Value> {
    match source.kind {
        AuthCredentialImportKind::Env => import_from_env(source),
        AuthCredentialImportKind::EncryptedFileJson => {
            import_from_encrypted_file_json(source, plugin_id, app_data_dir)
        }
        AuthCredentialImportKind::FileJson => {
            import_from_file_json(source, plugin_id, app_data_dir)
        }
        AuthCredentialImportKind::KeychainJson => import_from_keychain_json(source),
        AuthCredentialImportKind::KeychainText => import_from_keychain_text(source),
        AuthCredentialImportKind::PluginDataJson => {
            import_from_file_json(source, plugin_id, app_data_dir)
        }
        AuthCredentialImportKind::SqliteJson => import_from_sqlite_json(source),
    }
}

fn import_from_env(source: &AuthCredentialImportSource) -> Option<Value> {
    let mapping = source.text.as_ref()?;
    env_names(source).into_iter().find_map(|name| {
        host_api::resolve_env_value(&name)
            .and_then(|value| non_empty_string(&value))
            .and_then(|value| map_text_credentials(&value, mapping))
    })
}

fn import_from_file_json(
    source: &AuthCredentialImportSource,
    plugin_id: &str,
    app_data_dir: &Path,
) -> Option<Value> {
    let mapping = source.json.as_ref()?;
    import_paths(source, plugin_id, app_data_dir)
        .into_iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .filter_map(|text| parse_json_or_hex(&text))
        .map(|json| merge_json_paths(json, source, plugin_id, app_data_dir))
        .find_map(|json| map_json_credentials(&json, mapping))
}

fn import_from_encrypted_file_json(
    source: &AuthCredentialImportSource,
    plugin_id: &str,
    app_data_dir: &Path,
) -> Option<Value> {
    let mapping = source.json.as_ref()?;
    let key_paths = import_key_paths(source, plugin_id, app_data_dir);
    if key_paths.is_empty() {
        return None;
    }

    for envelope_path in import_paths(source, plugin_id, app_data_dir) {
        let Some(envelope) = std::fs::read_to_string(envelope_path).ok() else {
            continue;
        };
        for key_path in &key_paths {
            let Some(credentials) = std::fs::read_to_string(key_path)
                .ok()
                .and_then(|key| host_api::decrypt_aes_256_gcm_envelope(&envelope, &key).ok())
                .and_then(|text| parse_json_or_hex(&text))
                .and_then(|json| map_json_credentials(&json, mapping))
            else {
                continue;
            };
            return Some(credentials);
        }
    }

    None
}

fn import_from_keychain_json(source: &AuthCredentialImportSource) -> Option<Value> {
    let mapping = source.json.as_ref()?;
    source.services.iter().find_map(|service| {
        read_keychain_service(&service.service, service.current_user)
            .ok()
            .and_then(|text| parse_json_or_hex(&text))
            .and_then(|json| map_json_credentials(&json, mapping))
    })
}

fn import_from_keychain_text(source: &AuthCredentialImportSource) -> Option<Value> {
    let mapping = source.text.as_ref()?;
    if source.services.iter().any(|service| {
        service
            .target
            .as_deref()
            .and_then(non_empty_string)
            .is_some()
    }) {
        return import_from_keychain_text_fields(source, mapping);
    }

    source.services.iter().find_map(|service| {
        read_keychain_service(&service.service, service.current_user)
            .ok()
            .and_then(|text| map_text_credentials(&text, mapping))
    })
}

fn import_from_keychain_text_fields(
    source: &AuthCredentialImportSource,
    mapping: &AuthCredentialTextMapping,
) -> Option<Value> {
    let mut credentials = mapping.constants.clone();
    let mut inserted = false;

    for service in &source.services {
        let target = service
            .target
            .as_deref()
            .and_then(non_empty_string)
            .unwrap_or_else(|| mapping.target.clone());
        let Some(value) = read_keychain_service(&service.service, service.current_user)
            .ok()
            .and_then(|text| normalize_text_credential_value(&text, mapping))
        else {
            continue;
        };
        credentials.insert(target, Value::String(value));
        inserted = true;
    }

    inserted.then(|| Value::Object(credentials))
}

fn import_from_sqlite_json(source: &AuthCredentialImportSource) -> Option<Value> {
    let mapping = source.json.as_ref()?;
    let db_path = source.db_path.as_deref()?.trim();
    let query = source.query.as_deref()?.trim();
    if db_path.is_empty() || query.is_empty() {
        return None;
    }

    let rows = host_api::sqlite_query_readonly(db_path, query).ok()?;
    let mut value = serde_json::from_str::<Value>(&rows).ok()?;
    if let Some(pointer) = source
        .value_pointer
        .as_deref()
        .filter(|pointer| !pointer.is_empty())
    {
        value = value.pointer(pointer)?.clone();
    }
    if let Value::String(text) = &value {
        if let Some(parsed) = parse_json_or_hex(text) {
            value = parsed;
        }
    }
    map_json_credentials(&value, mapping)
}

fn read_keychain_service(service: &str, current_user: bool) -> std::result::Result<String, String> {
    if current_user {
        host_api::read_keychain_generic_password_for_current_user(service)
    } else {
        host_api::read_keychain_generic_password(service)
    }
}

fn env_names(source: &AuthCredentialImportSource) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(env) = source.env.as_deref().and_then(non_empty_string) {
        names.push(env);
    }
    names.extend(source.envs.iter().filter_map(|env| non_empty_string(env)));
    names
}

fn import_paths(
    source: &AuthCredentialImportSource,
    plugin_id: &str,
    app_data_dir: &Path,
) -> Vec<PathBuf> {
    source
        .paths
        .iter()
        .filter_map(|path| resolve_import_path(path, plugin_id, app_data_dir))
        .filter(|path| path.exists())
        .collect()
}

fn import_key_paths(
    source: &AuthCredentialImportSource,
    plugin_id: &str,
    app_data_dir: &Path,
) -> Vec<PathBuf> {
    source
        .key_paths
        .iter()
        .filter_map(|path| resolve_import_path(path, plugin_id, app_data_dir))
        .filter(|path| path.exists())
        .collect()
}

fn import_merge_paths(
    source: &AuthCredentialImportSource,
    plugin_id: &str,
    app_data_dir: &Path,
) -> Vec<PathBuf> {
    source
        .merge_paths
        .iter()
        .filter_map(|path| resolve_import_path(path, plugin_id, app_data_dir))
        .filter(|path| path.exists())
        .collect()
}

fn merge_json_paths(
    mut value: Value,
    source: &AuthCredentialImportSource,
    plugin_id: &str,
    app_data_dir: &Path,
) -> Value {
    let Value::Object(root) = &mut value else {
        return value;
    };

    for path in import_merge_paths(source, plugin_id, app_data_dir) {
        let Some(Value::Object(extra)) = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| parse_json_or_hex(&text))
        else {
            continue;
        };
        for (key, field_value) in extra {
            root.entry(key).or_insert(field_value);
        }
    }

    value
}

fn resolve_import_path(
    path: &AuthCredentialImportPath,
    plugin_id: &str,
    app_data_dir: &Path,
) -> Option<PathBuf> {
    if let Some(plugin_data_path) = path.plugin_data_path.as_deref().and_then(non_empty_string) {
        return Some(
            app_data_dir
                .join("plugins_data")
                .join(plugin_id)
                .join(plugin_data_path),
        );
    }

    if let Some(env) = path.env.as_deref().and_then(non_empty_string) {
        let base = host_api::resolve_env_value(&env).and_then(|value| non_empty_string(&value))?;
        let suffix = path.suffix.as_deref().unwrap_or_default();
        return Some(PathBuf::from(host_api::expand_path(&format!(
            "{base}{suffix}"
        ))));
    }

    path.path
        .as_deref()
        .and_then(non_empty_string)
        .map(|path| PathBuf::from(host_api::expand_path(&path)))
}

fn map_text_credentials(text: &str, mapping: &AuthCredentialTextMapping) -> Option<Value> {
    let value = normalize_text_credential_value(text, mapping)?;

    let mut credentials = mapping.constants.clone();
    credentials.insert(mapping.target.clone(), Value::String(value));
    Some(Value::Object(credentials))
}

fn normalize_text_credential_value(
    text: &str,
    mapping: &AuthCredentialTextMapping,
) -> Option<String> {
    let mut value = text.trim().to_string();
    if value.is_empty() {
        return None;
    }
    if mapping.decode == Some(AuthCredentialTextDecode::GoKeyringBase64) {
        if let Some(encoded) = value.strip_prefix("go-keyring-base64:") {
            value = BASE64_STANDARD
                .decode(encoded)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())?;
        }
    }
    non_empty_string(&value)
}

fn map_json_credentials(value: &Value, mapping: &AuthCredentialJsonMapping) -> Option<Value> {
    let mut credentials = mapping.constants.clone();
    for field in &mapping.fields {
        let Some(field_value) = extract_field_value(value, field) else {
            if field.required {
                return None;
            }
            continue;
        };
        credentials.insert(field.target.clone(), field_value);
    }

    (!credentials.is_empty()).then(|| Value::Object(credentials))
}

fn extract_field_value(value: &Value, field: &AuthCredentialFieldMapping) -> Option<Value> {
    field_pointers(field).into_iter().find_map(|pointer| {
        value
            .pointer(&pointer)
            .cloned()
            .and_then(|raw| normalize_value(raw, field))
    })
}

fn field_pointers(field: &AuthCredentialFieldMapping) -> Vec<String> {
    let mut pointers = Vec::new();
    if let Some(pointer) = field.pointer.as_deref().and_then(non_empty_string) {
        pointers.push(pointer);
    }
    pointers.extend(
        field
            .pointers
            .iter()
            .filter_map(|pointer| non_empty_string(pointer)),
    );
    pointers
}

fn normalize_value(value: Value, field: &AuthCredentialFieldMapping) -> Option<Value> {
    let value = if let Some(delimiter) = field.join.as_deref() {
        join_array_value(value, delimiter)?
    } else {
        value
    };

    match field.normalize {
        Some(AuthCredentialValueNormalize::EpochSeconds) => normalize_epoch_seconds(value),
        Some(AuthCredentialValueNormalize::Trim) => normalize_trimmed(value),
        None => normalize_trimmed(value).or(Some(Value::Null)),
    }
}

fn join_array_value(value: Value, delimiter: &str) -> Option<Value> {
    match value {
        Value::Array(items) => {
            let joined = items
                .iter()
                .filter_map(|item| value_to_string(item))
                .collect::<Vec<_>>()
                .join(delimiter);
            non_empty_string(&joined).map(Value::String)
        }
        other => normalize_trimmed(other),
    }
}

fn normalize_epoch_seconds(value: Value) -> Option<Value> {
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    if !number.is_finite() || number <= 0.0 {
        return None;
    }
    let seconds = if number > 100_000_000_000.0 {
        number / 1000.0
    } else {
        number
    };
    Some(Value::Number(serde_json::Number::from(
        seconds.floor() as i64
    )))
}

fn normalize_trimmed(value: Value) -> Option<Value> {
    match value {
        Value::String(text) => non_empty_string(&text).map(Value::String),
        Value::Null => None,
        other => Some(other),
    }
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty_string(text),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn decode_hex_utf8(text: &str) -> Option<String> {
    let mut hex = text.trim();
    if hex.starts_with("0x") || hex.starts_with("0X") {
        hex = &hex[2..];
    }
    if hex.is_empty() || hex.len() % 2 != 0 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }

    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for index in (0..hex.len()).step_by(2) {
        bytes.push(u8::from_str_radix(&hex[index..index + 2], 16).ok()?);
    }
    Some(String::from_utf8_lossy(&bytes).to_string())
}

fn parse_json_or_hex(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok().or_else(|| {
        decode_hex_utf8(text).and_then(|decoded| serde_json::from_str::<Value>(&decoded).ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_engine::manifest::{
        AuthCredentialFieldMapping, AuthCredentialJsonMapping, AuthCredentialTextMapping,
        AuthCredentialValueNormalize,
    };
    use serde_json::Map;
    use serde_json::json;

    fn json_mapping() -> AuthCredentialJsonMapping {
        AuthCredentialJsonMapping {
            constants: Map::from_iter([("type".to_string(), json!("oauth"))]),
            fields: vec![
                AuthCredentialFieldMapping {
                    target: "accessToken".to_string(),
                    pointer: Some("/tokens/access_token".to_string()),
                    pointers: Vec::new(),
                    required: true,
                    normalize: Some(AuthCredentialValueNormalize::Trim),
                    join: None,
                },
                AuthCredentialFieldMapping {
                    target: "expiresAt".to_string(),
                    pointer: Some("/tokens/expires_at".to_string()),
                    pointers: Vec::new(),
                    required: false,
                    normalize: Some(AuthCredentialValueNormalize::EpochSeconds),
                    join: None,
                },
            ],
        }
    }

    #[test]
    fn parse_json_or_hex_accepts_hex_json() {
        let hex = "7b22746f6b656e223a22736563726574227d";

        let parsed = parse_json_or_hex(hex).expect("hex JSON should parse");

        assert_eq!(parsed.get("token").and_then(Value::as_str), Some("secret"));
    }

    #[test]
    fn map_json_credentials_uses_manifest_pointers() {
        let source = json!({
            "tokens": {
                "access_token": " access ",
                "expires_at": 1_700_000_000_000_i64,
            }
        });

        let credentials = map_json_credentials(&source, &json_mapping()).expect("credentials");

        assert_eq!(credentials["type"], "oauth");
        assert_eq!(credentials["accessToken"], "access");
        assert_eq!(credentials["expiresAt"], 1_700_000_000_i64);
    }

    #[test]
    fn map_json_credentials_rejects_missing_required_fields() {
        let source = json!({ "tokens": { "refresh_token": "refresh" } });

        let credentials = map_json_credentials(&source, &json_mapping());

        assert!(credentials.is_none());
    }

    #[test]
    fn map_text_credentials_decodes_go_keyring_base64() {
        let mapping = AuthCredentialTextMapping {
            target: "accessToken".to_string(),
            constants: Map::from_iter([("type".to_string(), json!("oauth"))]),
            decode: Some(AuthCredentialTextDecode::GoKeyringBase64),
        };
        let token = BASE64_STANDARD.encode("ghu_secret");

        let credentials = map_text_credentials(&format!("go-keyring-base64:{token}"), &mapping)
            .expect("credentials");

        assert_eq!(credentials["type"], "oauth");
        assert_eq!(credentials["accessToken"], "ghu_secret");
    }
}
