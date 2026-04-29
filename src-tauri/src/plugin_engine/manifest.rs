use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLine {
    #[serde(rename = "type")]
    pub line_type: String,
    pub label: String,
    pub scope: String,
    /// Lower number = higher priority for primary metric selection.
    /// Only progress lines with primary_order are candidates.
    pub primary_order: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLink {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAuth {
    pub default_strategy_id: Option<String>,
    #[serde(default)]
    pub strategies: Vec<AuthStrategyManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginExternalAuth {
    #[serde(default)]
    pub opencode: Option<OpenCodeExternalAuth>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeExternalAuth {
    pub auth_key: String,
    #[serde(default)]
    pub strategies: HashMap<String, OpenCodeExternalAuthStrategy>,
    #[serde(default)]
    pub rotation: Option<OpenCodeExternalAuthRotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeExternalAuthStrategy {
    #[serde(rename = "type")]
    pub auth_type: OpenCodeExternalAuthType,
    #[serde(default)]
    pub fields: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpenCodeExternalAuthType {
    #[serde(rename = "api")]
    Api,
    #[serde(rename = "oauth")]
    OAuth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeExternalAuthRotation {
    #[serde(default)]
    pub line_labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthStrategyKind {
    ApiKey,
    Json,
    #[serde(rename = "oauthPkce")]
    OAuthPkce,
    DeviceCode,
    BrowserCookie,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCredentialField {
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub field_type: Option<AuthCredentialFieldType>,
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub options: Vec<AuthCredentialFieldOption>,
    #[serde(default)]
    pub advanced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCredentialFieldOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthCredentialFieldType {
    Text,
    Password,
    Textarea,
    Select,
    Segmented,
    Checkbox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStrategyManifest {
    pub id: String,
    pub label: String,
    pub kind: AuthStrategyKind,
    #[serde(default)]
    pub fields: Vec<AuthCredentialField>,
    #[serde(default)]
    pub credential_template: Option<serde_json::Value>,
    #[serde(default)]
    pub import_sources: Vec<AuthCredentialImportSource>,
    #[serde(default)]
    pub oauth: Option<OAuthPkceConfig>,
    #[serde(default)]
    pub device: Option<DeviceCodeConfig>,
    #[serde(default)]
    pub browser_cookie: Option<BrowserCookieConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthCredentialImportKind {
    Env,
    EncryptedFileJson,
    FileJson,
    KeychainJson,
    KeychainText,
    PluginDataJson,
    SqliteJson,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCredentialImportSource {
    pub id: String,
    pub kind: AuthCredentialImportKind,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub env: Option<String>,
    #[serde(default)]
    pub envs: Vec<String>,
    #[serde(default)]
    pub paths: Vec<AuthCredentialImportPath>,
    #[serde(default)]
    pub key_paths: Vec<AuthCredentialImportPath>,
    #[serde(default)]
    pub merge_paths: Vec<AuthCredentialImportPath>,
    #[serde(default)]
    pub services: Vec<AuthCredentialImportKeychainService>,
    #[serde(default)]
    pub db_path: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub value_pointer: Option<String>,
    #[serde(default)]
    pub json: Option<AuthCredentialJsonMapping>,
    #[serde(default)]
    pub text: Option<AuthCredentialTextMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCredentialImportPath {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub env: Option<String>,
    #[serde(default)]
    pub suffix: Option<String>,
    #[serde(default)]
    pub plugin_data_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCredentialImportKeychainService {
    pub service: String,
    #[serde(default)]
    pub current_user: bool,
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCredentialJsonMapping {
    #[serde(default)]
    pub constants: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub fields: Vec<AuthCredentialFieldMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCredentialTextMapping {
    pub target: String,
    #[serde(default)]
    pub constants: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub decode: Option<AuthCredentialTextDecode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthCredentialTextDecode {
    GoKeyringBase64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCredentialFieldMapping {
    pub target: String,
    #[serde(default)]
    pub pointer: Option<String>,
    #[serde(default)]
    pub pointers: Vec<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub normalize: Option<AuthCredentialValueNormalize>,
    #[serde(default)]
    pub join: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthCredentialValueNormalize {
    EpochSeconds,
    Trim,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthPkceConfig {
    pub authorize_url: String,
    pub token_url: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub redirect_host: Option<String>,
    #[serde(default)]
    pub callback_path: Option<String>,
    #[serde(default)]
    pub callback_port: Option<u16>,
    #[serde(default)]
    pub authorize_params: HashMap<String, String>,
    #[serde(default)]
    pub token_request: TokenRequestKind,
    #[serde(default)]
    pub include_state_in_token_request: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TokenRequestKind {
    #[default]
    Form,
    Json,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeConfig {
    pub device_code_url: String,
    pub token_url: String,
    pub client_id: String,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCookieConfig {
    pub login_url: String,
    #[serde(default)]
    pub cookie_urls: Vec<String>,
    #[serde(default)]
    pub required_cookie_names: Vec<String>,
    #[serde(default)]
    pub required_any_cookie_names: Vec<String>,
    #[serde(default)]
    pub completion_url_regex: Option<String>,
    #[serde(default)]
    pub completion_url_credential_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub entry: String,
    pub icon: String,
    pub brand_color: Option<String>,
    pub lines: Vec<ManifestLine>,
    #[serde(default)]
    pub links: Vec<PluginLink>,
    #[serde(default)]
    pub auth: Option<PluginAuth>,
    #[serde(default)]
    pub external_auth: Option<PluginExternalAuth>,
}

#[derive(Debug, Clone)]
pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    pub plugin_dir: PathBuf,
    pub entry_script: String,
    pub icon_data_url: String,
}

pub fn load_plugins_from_dir(plugins_dir: &std::path::Path) -> Vec<LoadedPlugin> {
    let mut plugins = Vec::new();
    let entries = match std::fs::read_dir(plugins_dir) {
        Ok(e) => e,
        Err(_) => return plugins,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("plugin.json");
        if !manifest_path.exists() {
            continue;
        }
        match load_single_plugin(&path) {
            Ok(plugin) => plugins.push(plugin),
            Err(err) => {
                log::warn!("failed to load plugin {}: {}", path.display(), err);
            }
        }
    }

    plugins.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    plugins
}

fn load_single_plugin(
    plugin_dir: &std::path::Path,
) -> Result<LoadedPlugin, Box<dyn std::error::Error>> {
    let manifest_path = plugin_dir.join("plugin.json");
    let manifest_text = std::fs::read_to_string(&manifest_path)?;
    let mut manifest: PluginManifest = serde_json::from_str(&manifest_text)?;
    manifest.links = sanitize_plugin_links(&manifest.id, std::mem::take(&mut manifest.links));

    // Validate primary_order: only progress lines can have it
    for line in manifest.lines.iter() {
        if line.primary_order.is_some() && line.line_type != "progress" {
            log::warn!(
                "plugin {} line '{}' has primaryOrder but type is '{}'; will be ignored",
                manifest.id,
                line.label,
                line.line_type
            );
        }
    }

    if manifest.entry.trim().is_empty() {
        return Err("plugin entry field cannot be empty".into());
    }
    if Path::new(&manifest.entry).is_absolute() {
        return Err("plugin entry must be a relative path".into());
    }

    let entry_path = plugin_dir.join(&manifest.entry);
    let canonical_plugin_dir = plugin_dir.canonicalize()?;
    let canonical_entry_path = entry_path.canonicalize()?;
    if !canonical_entry_path.starts_with(&canonical_plugin_dir) {
        return Err("plugin entry must remain within plugin directory".into());
    }
    if !canonical_entry_path.is_file() {
        return Err("plugin entry must be a file".into());
    }

    let entry_script = std::fs::read_to_string(&canonical_entry_path)?;

    let icon_file = plugin_dir.join(&manifest.icon);
    let icon_bytes = std::fs::read(&icon_file)?;
    let icon_data_url = format!("data:image/svg+xml;base64,{}", STANDARD.encode(&icon_bytes));

    Ok(LoadedPlugin {
        manifest,
        plugin_dir: plugin_dir.to_path_buf(),
        entry_script,
        icon_data_url,
    })
}

fn sanitize_plugin_links(plugin_id: &str, links: Vec<PluginLink>) -> Vec<PluginLink> {
    links
        .into_iter()
        .filter_map(|link| {
            let label = link.label.trim().to_string();
            let url = link.url.trim().to_string();

            if label.is_empty() || url.is_empty() {
                log::warn!(
                    "plugin {} has link with empty label/url; skipping",
                    plugin_id
                );
                return None;
            }
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                log::warn!(
                    "plugin {} link '{}' has non-http(s) url '{}'; skipping",
                    plugin_id,
                    label,
                    url
                );
                return None;
            }

            Some(PluginLink { label, url })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_manifest(json: &str) -> PluginManifest {
        serde_json::from_str::<PluginManifest>(json).expect("manifest parse failed")
    }

    #[test]
    fn primary_order_is_none_by_default() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "lines": [
                { "type": "progress", "label": "A", "scope": "overview" }
              ]
            }
            "#,
        );
        assert_eq!(manifest.lines.len(), 1);
        assert!(manifest.lines[0].primary_order.is_none());
        assert!(manifest.links.is_empty());
    }

    #[test]
    fn primary_order_parsed_correctly() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "lines": [
                { "type": "progress", "label": "A", "scope": "overview", "primaryOrder": 1 },
                { "type": "progress", "label": "B", "scope": "overview", "primaryOrder": 2 },
                { "type": "progress", "label": "C", "scope": "overview" }
              ]
            }
            "#,
        );

        assert_eq!(manifest.lines[0].primary_order, Some(1));
        assert_eq!(manifest.lines[1].primary_order, Some(2));
        assert!(manifest.lines[2].primary_order.is_none());
    }

    #[test]
    fn primary_candidates_sorted_by_order() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "lines": [
                { "type": "progress", "label": "Third", "scope": "overview", "primaryOrder": 3 },
                { "type": "progress", "label": "First", "scope": "overview", "primaryOrder": 1 },
                { "type": "progress", "label": "Second", "scope": "overview", "primaryOrder": 2 },
                { "type": "progress", "label": "None", "scope": "overview" }
              ]
            }
            "#,
        );

        // Extract candidates sorted by primary_order (same logic as lib.rs)
        let mut candidates: Vec<_> = manifest
            .lines
            .iter()
            .filter(|l| l.line_type == "progress" && l.primary_order.is_some())
            .collect();
        candidates.sort_by_key(|l| l.primary_order.unwrap());
        let labels: Vec<_> = candidates.iter().map(|l| l.label.as_str()).collect();

        assert_eq!(labels, vec!["First", "Second", "Third"]);
    }

    #[test]
    fn links_are_parsed_when_present() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "x",
              "name": "X",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "brandColor": null,
              "links": [
                { "label": "Status", "url": "https://status.example.com" },
                { "label": "Billing", "url": "https://example.com/billing" }
              ],
              "lines": [
                { "type": "progress", "label": "A", "scope": "overview", "primaryOrder": 1 }
              ]
            }
            "#,
        );

        assert_eq!(manifest.links.len(), 2);
        assert_eq!(manifest.links[0].label, "Status");
        assert_eq!(manifest.links[1].url, "https://example.com/billing");
    }

    #[test]
    fn oauth_pkce_auth_kind_parses_from_manifest() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "codex",
              "name": "Codex",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "auth": {
                "defaultStrategyId": "oauth",
                "strategies": [
                  {
                    "id": "oauth",
                    "label": "OAuth",
                    "kind": "oauthPkce",
                    "fields": [],
                    "oauth": {
                      "authorizeUrl": "https://example.com/authorize",
                      "tokenUrl": "https://example.com/token",
                      "clientId": "client",
                      "redirectHost": "127.0.0.1",
                      "scopes": ["openid"]
                    }
                  }
                ]
              },
              "lines": [
                { "type": "progress", "label": "A", "scope": "overview" }
              ]
            }
            "#,
        );

        let auth = manifest.auth.expect("auth should parse");
        assert_eq!(auth.strategies[0].kind, AuthStrategyKind::OAuthPkce);
        assert_eq!(
            auth.strategies[0]
                .oauth
                .as_ref()
                .and_then(|config| config.redirect_host.as_deref()),
            Some("127.0.0.1")
        );
    }

    #[test]
    fn external_opencode_auth_parses_from_manifest() {
        let manifest = parse_manifest(
            r#"
            {
              "schemaVersion": 1,
              "id": "codex",
              "name": "Codex",
              "version": "0.0.1",
              "entry": "plugin.js",
              "icon": "icon.svg",
              "externalAuth": {
                "opencode": {
                  "authKey": "openai",
                  "strategies": {
                    "oauth": {
                      "type": "oauth",
                      "fields": {
                        "access": "/accessToken",
                        "refresh": "/refreshToken",
                        "expires": "/expiresAt"
                      }
                    }
                  },
                  "rotation": {
                    "lineLabels": ["Session"]
                  }
                }
              },
              "lines": [
                { "type": "progress", "label": "A", "scope": "overview" }
              ]
            }
            "#,
        );

        let opencode = manifest
            .external_auth
            .expect("external auth should parse")
            .opencode
            .expect("opencode config should parse");
        assert_eq!(opencode.auth_key, "openai");
        assert_eq!(
            opencode.strategies["oauth"].auth_type,
            OpenCodeExternalAuthType::OAuth
        );
        assert_eq!(
            opencode.rotation.unwrap().line_labels,
            vec!["Session".to_string()]
        );
    }

    #[test]
    fn repo_plugin_manifests_load_codex_and_other_oauth_plugins() {
        let plugins_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins");
        let plugins = load_plugins_from_dir(&plugins_dir);
        let ids = plugins
            .iter()
            .map(|plugin| plugin.manifest.id.as_str())
            .collect::<Vec<_>>();

        assert!(ids.contains(&"codex"));
        assert!(ids.contains(&"claude"));
        assert!(ids.contains(&"antigravity"));
    }

    #[test]
    fn sanitize_plugin_links_filters_invalid_entries() {
        let links = vec![
            PluginLink {
                label: " Status ".to_string(),
                url: " https://status.example.com ".to_string(),
            },
            PluginLink {
                label: " ".to_string(),
                url: "https://example.com".to_string(),
            },
            PluginLink {
                label: "Docs".to_string(),
                url: "ftp://example.com".to_string(),
            },
        ];

        let sanitized = sanitize_plugin_links("x", links);
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0].label, "Status");
        assert_eq!(sanitized[0].url, "https://status.example.com");
    }
}
