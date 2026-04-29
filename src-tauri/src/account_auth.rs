use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use url::Url;

use crate::account_store::AccountStore;
use crate::auth::{self, AuthState, PendingOAuth};
use crate::error::{BackendError, Result};
use crate::oauth;
use crate::plugin_engine::manifest::{
    AuthStrategyKind, AuthStrategyManifest, DeviceCodeConfig, LoadedPlugin, OAuthPkceConfig,
    TokenRequestKind,
};
use crate::secrets;
use crate::utils::now_unix_ms;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAuthStartResponse {
    pub request_id: String,
    pub url: String,
    pub redirect_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAuthResult {
    pub account_id: String,
    pub expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
    token_type: Option<String>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: Option<i64>,
    interval: Option<u64>,
}

fn provider_error(message: impl Into<String>) -> BackendError {
    BackendError::Plugin(message.into())
}

fn default_callback_path(config: &OAuthPkceConfig) -> String {
    config
        .callback_path
        .clone()
        .unwrap_or_else(|| "/auth/callback".to_string())
}

fn encode_form_string_pairs(pairs: &[(&str, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

fn encode_form_str_pairs(pairs: &[(&str, &str)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

fn oauth_redirect_host(config: &OAuthPkceConfig) -> Result<&str> {
    let host = config
        .redirect_host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or("localhost");

    match host {
        "localhost" | "127.0.0.1" => Ok(host),
        _ => Err(provider_error(format!(
            "unsupported OAuth redirectHost '{}'; use localhost or 127.0.0.1",
            host
        ))),
    }
}

fn callback_redirect_uri(
    config: &OAuthPkceConfig,
    port: u16,
    callback_path: &str,
) -> Result<String> {
    let host = oauth_redirect_host(config)?;
    Ok(format!("http://{host}:{port}{callback_path}"))
}

pub fn strategy_for_account<'a>(
    plugin: &'a LoadedPlugin,
    auth_strategy_id: Option<&str>,
) -> Result<&'a AuthStrategyManifest> {
    let auth = plugin.manifest.auth.as_ref().ok_or_else(|| {
        provider_error(format!(
            "{} does not declare account auth",
            plugin.manifest.name
        ))
    })?;

    let requested = auth_strategy_id
        .filter(|value| !value.trim().is_empty())
        .or(auth.default_strategy_id.as_deref())
        .ok_or_else(|| {
            provider_error(format!(
                "{} has no default auth strategy",
                plugin.manifest.name
            ))
        })?;

    auth.strategies
        .iter()
        .find(|strategy| strategy.id == requested)
        .ok_or_else(|| {
            provider_error(format!(
                "auth strategy '{}' is not supported by {}",
                requested, plugin.manifest.name
            ))
        })
}

pub fn ensure_account_matches_plugin(
    store: &AccountStore,
    plugin: &LoadedPlugin,
    account_id: &str,
) -> Result<crate::models::AccountRecord> {
    let account = store
        .get_account(account_id)?
        .ok_or(BackendError::AccountNotFound)?;
    if account.plugin_id != plugin.manifest.id {
        return Err(provider_error(format!(
            "account belongs to '{}' not '{}'",
            account.plugin_id, plugin.manifest.id
        )));
    }
    Ok(account)
}

pub async fn start_account_auth(
    _app: AppHandle,
    auth_state: State<'_, AuthState>,
    store: State<'_, AccountStore>,
    plugin: LoadedPlugin,
    account_id: String,
) -> Result<AccountAuthStartResponse> {
    let account = ensure_account_matches_plugin(store.inner(), &plugin, &account_id)?;
    let strategy = strategy_for_account(&plugin, account.auth_strategy_id.as_deref())?;

    match strategy.kind {
        AuthStrategyKind::OAuthPkce => {
            let config = strategy.oauth.as_ref().ok_or_else(|| {
                provider_error(format!(
                    "{} OAuth strategy is missing config",
                    strategy.label
                ))
            })?;
            start_pkce_flow(auth_state, &plugin, strategy, &account.id, config)
        }
        AuthStrategyKind::DeviceCode => {
            let config = strategy.device.as_ref().ok_or_else(|| {
                provider_error(format!(
                    "{} device strategy is missing config",
                    strategy.label
                ))
            })?;
            start_device_flow(auth_state, &plugin, strategy, &account.id, config).await
        }
        AuthStrategyKind::BrowserCookie => Err(provider_error(
            "browser-cookie auth is not implemented in the generic account flow yet",
        )),
        AuthStrategyKind::ApiKey | AuthStrategyKind::Json => Err(provider_error(
            "this account uses manual credentials; paste credentials instead",
        )),
    }
}

fn start_pkce_flow(
    auth_state: State<'_, AuthState>,
    plugin: &LoadedPlugin,
    strategy: &AuthStrategyManifest,
    account_id: &str,
    config: &OAuthPkceConfig,
) -> Result<AccountAuthStartResponse> {
    let pkce = oauth::generate_pkce();
    let state = uuid::Uuid::new_v4().to_string();
    let callback_path = default_callback_path(config);
    let (port, receiver, cancel_flag) = auth::start_local_callback_listener_with_options(
        state.clone(),
        &callback_path,
        config.callback_port,
    )?;
    let redirect_uri = callback_redirect_uri(config, port, &callback_path)?;
    let url = build_authorize_url(config, &redirect_uri, &pkce.challenge, &state)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    auth_state.insert(
        request_id.clone(),
        PendingOAuth::new(
            plugin.manifest.id.clone(),
            strategy.id.clone(),
            "oauthPkce".to_string(),
            account_id.to_string(),
            pkce.verifier,
            redirect_uri.clone(),
            cancel_flag,
            receiver,
        ),
    );

    Ok(AccountAuthStartResponse {
        request_id,
        url,
        redirect_uri,
        user_code: None,
    })
}

fn build_authorize_url(
    config: &OAuthPkceConfig,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> Result<String> {
    let mut url = Url::parse(&config.authorize_url)
        .map_err(|err| provider_error(format!("OAuth authorize URL invalid: {err}")))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", "code");
        query.append_pair("client_id", &config.client_id);
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("code_challenge", challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("state", state);
        if !config.scopes.is_empty() {
            query.append_pair("scope", &config.scopes.join(" "));
        }
        for (key, value) in &config.authorize_params {
            query.append_pair(key, value);
        }
    }
    Ok(url.to_string())
}

async fn start_device_flow(
    auth_state: State<'_, AuthState>,
    plugin: &LoadedPlugin,
    strategy: &AuthStrategyManifest,
    account_id: &str,
    config: &DeviceCodeConfig,
) -> Result<AccountAuthStartResponse> {
    let client = reqwest::Client::new();
    let mut form = vec![("client_id", config.client_id.clone())];
    if let Some(scope) = config
        .scope
        .as_ref()
        .filter(|scope| !scope.trim().is_empty())
    {
        form.push(("scope", scope.clone()));
    }

    let response = client
        .post(&config.device_code_url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(encode_form_string_pairs(&form))
        .send()
        .await
        .map_err(|err| provider_error(format!("device authorization request failed: {err}")))?;
    let status = response.status();
    let text = response.text().await.map_err(|err| {
        provider_error(format!("device authorization response read failed: {err}"))
    })?;
    if !status.is_success() {
        return Err(provider_error(format!(
            "device authorization failed: HTTP {} {}",
            status.as_u16(),
            text
        )));
    }
    let body: DeviceCodeResponse = serde_json::from_str(&text)
        .map_err(|err| provider_error(format!("device authorization decode failed: {err}")))?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let expires_at = now_unix_ms() + body.expires_in.unwrap_or(900).saturating_mul(1000);
    auth_state.insert(
        request_id.clone(),
        PendingOAuth::new_device_flow(
            plugin.manifest.id.clone(),
            strategy.id.clone(),
            account_id.to_string(),
            body.device_code,
            body.interval.unwrap_or(5).max(1),
            expires_at,
        ),
    );

    Ok(AccountAuthStartResponse {
        request_id,
        url: body
            .verification_uri_complete
            .unwrap_or_else(|| body.verification_uri.clone()),
        redirect_uri: body.verification_uri,
        user_code: Some(body.user_code),
    })
}

pub async fn finish_account_auth(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    store: State<'_, AccountStore>,
    plugin: LoadedPlugin,
    request_id: String,
    timeout_ms: Option<u64>,
) -> Result<AccountAuthResult> {
    let flow = auth_state
        .get(&request_id)
        .ok_or_else(|| provider_error("OAuth request not found"))?;
    if flow.plugin_id != plugin.manifest.id {
        return Err(provider_error("OAuth request belongs to another plugin"));
    }
    let account = ensure_account_matches_plugin(store.inner(), &plugin, &flow.account_id)?;
    let strategy = strategy_for_account(&plugin, Some(&flow.strategy_id))?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(180_000).max(1));

    let result = match flow.flow_kind.as_str() {
        "oauthPkce" => {
            let config = strategy.oauth.as_ref().ok_or_else(|| {
                provider_error(format!(
                    "{} OAuth strategy is missing config",
                    strategy.label
                ))
            })?;
            let receiver = flow
                .take_receiver()
                .ok_or_else(|| provider_error("OAuth request already being completed"))?;
            let callback = tokio::time::timeout(timeout, receiver)
                .await
                .map_err(|_| provider_error("OAuth timed out"))?
                .map_err(|_| provider_error("OAuth callback listener closed"))??;
            let token = exchange_code(
                config,
                &flow.redirect_uri,
                &callback.code,
                &flow.verifier,
                &callback.state,
            )
            .await?;
            persist_token_response(&app, store.inner(), &account.id, token)?
        }
        "deviceCode" => {
            let config = strategy.device.as_ref().ok_or_else(|| {
                provider_error(format!(
                    "{} device strategy is missing config",
                    strategy.label
                ))
            })?;
            let token = poll_device_token(config, &flow, timeout).await?;
            persist_token_response(&app, store.inner(), &account.id, token)?
        }
        _ => return Err(provider_error("unsupported auth request kind")),
    };

    auth_state.remove(&request_id);
    Ok(AccountAuthResult {
        account_id: account.id,
        expires_at: result,
    })
}

async fn exchange_code(
    config: &OAuthPkceConfig,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
    callback_state: &str,
) -> Result<TokenResponse> {
    let client = reqwest::Client::new();
    let mut fields = serde_json::Map::new();
    fields.insert(
        "grant_type".to_string(),
        serde_json::json!("authorization_code"),
    );
    fields.insert("code".to_string(), serde_json::json!(code));
    fields.insert("redirect_uri".to_string(), serde_json::json!(redirect_uri));
    fields.insert("client_id".to_string(), serde_json::json!(config.client_id));
    fields.insert("code_verifier".to_string(), serde_json::json!(verifier));
    if let Some(secret) = &config.client_secret {
        fields.insert("client_secret".to_string(), serde_json::json!(secret));
    }
    if config.include_state_in_token_request {
        fields.insert("state".to_string(), serde_json::json!(callback_state));
    }

    let response = match config.token_request {
        TokenRequestKind::Form => {
            let form = fields
                .iter()
                .filter_map(|(key, value)| value.as_str().map(|value| (key.as_str(), value)))
                .collect::<Vec<_>>();
            client
                .post(&config.token_url)
                .header("Accept", "application/json")
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(encode_form_str_pairs(&form))
                .send()
                .await
        }
        TokenRequestKind::Json => {
            client
                .post(&config.token_url)
                .header("Accept", "application/json")
                .json(&fields)
                .send()
                .await
        }
    }
    .map_err(|err| provider_error(format!("OAuth token request failed: {err}")))?;

    parse_token_response(response).await
}

async fn poll_device_token(
    config: &DeviceCodeConfig,
    flow: &PendingOAuth,
    timeout: Duration,
) -> Result<TokenResponse> {
    let client = reqwest::Client::new();
    let started = std::time::Instant::now();
    let device_code = flow
        .device_code
        .as_ref()
        .ok_or_else(|| provider_error("device code missing"))?;
    let mut interval = flow.device_interval.unwrap_or(5).max(1);

    loop {
        if flow.cancel_flag.load(Ordering::SeqCst) {
            return Err(provider_error("OAuth cancelled"));
        }
        if started.elapsed() >= timeout
            || now_unix_ms() >= flow.device_expires_at.unwrap_or(i64::MAX)
        {
            return Err(provider_error("OAuth timed out"));
        }

        let form = [
            ("client_id", config.client_id.as_str()),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ];
        let response = client
            .post(&config.token_url)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(encode_form_str_pairs(&form))
            .send()
            .await
            .map_err(|err| provider_error(format!("device token request failed: {err}")))?;

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|err| provider_error(format!("device token response read failed: {err}")))?;
        let parsed: TokenResponse = serde_json::from_str(&text)
            .map_err(|err| provider_error(format!("device token decode failed: {err}")))?;
        if status.is_success()
            && parsed
                .access_token
                .as_deref()
                .is_some_and(|value| !value.is_empty())
        {
            return Ok(parsed);
        }

        match parsed.error.as_deref().unwrap_or_default() {
            "authorization_pending" => {}
            "slow_down" => interval = interval.saturating_add(5),
            "expired_token" => return Err(provider_error("OAuth device code expired")),
            error if !error.is_empty() => {
                return Err(provider_error(
                    parsed
                        .error_description
                        .unwrap_or_else(|| error.to_string()),
                ));
            }
            _ if !status.is_success() => {
                return Err(provider_error(format!(
                    "device token request failed: HTTP {} {}",
                    status.as_u16(),
                    text
                )));
            }
            _ => {}
        }

        tokio::time::sleep(Duration::from_secs(interval)).await;
    }
}

async fn parse_token_response(response: reqwest::Response) -> Result<TokenResponse> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| provider_error(format!("OAuth token response read failed: {err}")))?;
    let parsed: TokenResponse = serde_json::from_str(&text)
        .map_err(|err| provider_error(format!("OAuth token response decode failed: {err}")))?;
    if !status.is_success() {
        return Err(provider_error(
            parsed
                .error_description
                .or(parsed.error)
                .unwrap_or_else(|| format!("OAuth token request failed: HTTP {}", status.as_u16())),
        ));
    }
    if parsed
        .access_token
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        return Err(provider_error("OAuth response missing access_token"));
    }
    Ok(parsed)
}

fn persist_token_response(
    app: &AppHandle,
    store: &AccountStore,
    account_id: &str,
    token: TokenResponse,
) -> Result<i64> {
    let expires_at = now_unix_ms() / 1000 + token.expires_in.unwrap_or(3600).max(0);
    let credentials = serde_json::json!({
        "type": "oauth",
        "accessToken": token.access_token.unwrap_or_default(),
        "refreshToken": token.refresh_token,
        "idToken": token.id_token,
        "expiresAt": expires_at,
        "tokenType": token.token_type,
        "scope": token.scope,
    });
    secrets::set_account_credentials(app, store, account_id, &credentials)?;
    Ok(expires_at)
}

pub fn cancel_account_auth(auth_state: State<'_, AuthState>, request_id: String) -> bool {
    auth_state.cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn test_oauth_config() -> OAuthPkceConfig {
        OAuthPkceConfig {
            authorize_url: "https://auth.openai.com/oauth/authorize".to_string(),
            token_url: "https://auth.openai.com/oauth/token".to_string(),
            client_id: "client".to_string(),
            client_secret: None,
            scopes: vec!["openid".to_string()],
            redirect_host: None,
            callback_path: Some("/auth/callback".to_string()),
            callback_port: Some(1455),
            authorize_params: HashMap::new(),
            token_request: TokenRequestKind::Form,
            include_state_in_token_request: false,
        }
    }

    #[test]
    fn callback_redirect_uri_uses_localhost_for_registered_oauth_clients() {
        let config = test_oauth_config();
        assert_eq!(
            callback_redirect_uri(&config, 1455, "/auth/callback").expect("redirect should build"),
            "http://localhost:1455/auth/callback"
        );
    }

    #[test]
    fn callback_redirect_uri_can_use_manifest_redirect_host() {
        let mut config = test_oauth_config();
        config.redirect_host = Some("127.0.0.1".to_string());

        assert_eq!(
            callback_redirect_uri(&config, 1455, "/auth/callback").expect("redirect should build"),
            "http://127.0.0.1:1455/auth/callback"
        );
    }

    #[test]
    fn callback_redirect_uri_rejects_non_loopback_redirect_host() {
        let mut config = test_oauth_config();
        config.redirect_host = Some("example.com".to_string());

        let error = callback_redirect_uri(&config, 1455, "/auth/callback")
            .expect_err("external redirect host should fail");
        assert!(error.to_string().contains("unsupported OAuth redirectHost"));
    }

    #[test]
    fn authorize_url_uses_exact_redirect_uri() {
        let config = test_oauth_config();

        let url = build_authorize_url(
            &config,
            "http://localhost:1455/auth/callback",
            "challenge",
            "state",
        )
        .expect("authorize url should build");
        let parsed = Url::parse(&url).expect("authorize url should parse");
        let redirect_uri = parsed
            .query_pairs()
            .find_map(|(key, value)| (key == "redirect_uri").then(|| value.to_string()));

        assert_eq!(
            redirect_uri.as_deref(),
            Some("http://localhost:1455/auth/callback")
        );
    }
}
