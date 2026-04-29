use std::collections::HashSet;
use std::sync::Mutex;

use serde::Serialize;
use tauri::Runtime;

use crate::AppState;
use crate::account_store::AccountStore;
use crate::error::{BackendError, Result};
use crate::local_http_api::cache::cached_snapshot_for_plugin;
use crate::models::AccountRecord;
use crate::opencode_auth_file;
use crate::plugin_engine::manifest::{
    LoadedPlugin, OpenCodeExternalAuth, OpenCodeExternalAuthStrategy,
};
use crate::plugin_engine::runtime::MetricLine;
use crate::secrets;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAuthSyncResult {
    pub plugin_id: String,
    pub account_id: String,
    pub account_label: String,
    pub auth_file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_percent: Option<f64>,
}

pub fn sync_opencode_account<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Mutex<AppState>,
    store: &AccountStore,
    account_id: &str,
) -> Result<ExternalAuthSyncResult> {
    let account = store
        .get_account(account_id)?
        .ok_or(BackendError::AccountNotFound)?;
    let plugin = loaded_plugin_by_id(state, &account.plugin_id)?;
    sync_account_with_plugin(app, store, &plugin, account, None)
}

pub fn rotate_opencode_plugin<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Mutex<AppState>,
    store: &AccountStore,
    plugin_id: &str,
) -> Result<ExternalAuthSyncResult> {
    let plugin_id = normalize_plugin_id(plugin_id)?;
    let plugin = loaded_plugin_by_id(state, &plugin_id)?;
    let config = opencode_config(&plugin)?;
    let rotation_labels = rotation_line_labels(config)?;

    let mut eligible = store
        .list_accounts()?
        .into_iter()
        .filter(|account| account.plugin_id == plugin_id && account.enabled)
        .filter(|account| has_supported_strategy(&plugin, config, account))
        .filter(|account| secrets::has_account_credentials(store, &account.id).unwrap_or(false))
        .collect::<Vec<_>>();

    if eligible.is_empty() {
        return Err(provider_error(format!(
            "No enabled {plugin_id} accounts with OpenCode-syncable credentials"
        )));
    }

    if eligible.len() == 1 {
        return sync_account_with_plugin(app, store, &plugin, eligible.remove(0), None);
    }

    let mut best_other: Option<(AccountRecord, f64)> = None;
    let mut best_current: Option<(AccountRecord, f64)> = None;
    let mut fallback_other: Option<AccountRecord> = None;
    for account in eligible {
        let is_current =
            account_matches_current_opencode_auth(app, store, &plugin, config, &account)?;
        if !is_current && fallback_other.is_none() {
            fallback_other = Some(account.clone());
        }

        let Some(score) = score_account_usage_left(&plugin_id, &account, &rotation_labels, false)
        else {
            continue;
        };

        let best = if is_current {
            &mut best_current
        } else {
            &mut best_other
        };

        if best
            .as_ref()
            .map(|(_, current_score)| score > *current_score)
            .unwrap_or(true)
        {
            *best = Some((account, score));
        }
    }

    if let Some((account, score)) = best_other {
        return sync_account_with_plugin(app, store, &plugin, account, Some(score));
    }
    if let Some(account) = fallback_other {
        return sync_account_with_plugin(app, store, &plugin, account, None);
    }
    if let Some((account, score)) = best_current {
        return sync_account_with_plugin(app, store, &plugin, account, Some(score));
    }

    Err(provider_error(format!(
        "No cached usage data for {plugin_id} accounts. Refresh usage before rotating."
    )))
}

pub fn list_opencode_auth_account_matches<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Mutex<AppState>,
    store: &AccountStore,
) -> Result<Vec<String>> {
    let accounts = store.list_accounts()?;
    let plugins = {
        let locked = state
            .lock()
            .map_err(|_| BackendError::Plugin("plugin state poisoned".to_string()))?;
        locked.plugins.clone()
    };
    let mut matches = Vec::new();

    for account in accounts {
        let Some(plugin) = plugins
            .iter()
            .find(|plugin| plugin.manifest.id == account.plugin_id)
        else {
            continue;
        };
        let Some(config) = plugin
            .manifest
            .external_auth
            .as_ref()
            .and_then(|external| external.opencode.as_ref())
        else {
            continue;
        };
        if !has_supported_strategy(plugin, config, &account) {
            continue;
        }
        if account_matches_current_opencode_auth(app, store, plugin, config, &account)? {
            matches.push(account.id);
        }
    }

    Ok(matches)
}

fn sync_account_with_plugin<R: Runtime>(
    app: &tauri::AppHandle<R>,
    store: &AccountStore,
    plugin: &LoadedPlugin,
    account: AccountRecord,
    remaining_percent: Option<f64>,
) -> Result<ExternalAuthSyncResult> {
    let config = opencode_config(plugin)?;
    let strategy = opencode_strategy_for_account(plugin, config, &account)?;
    let credentials =
        secrets::get_account_credentials(app, store, &account.id)?.ok_or_else(|| {
            provider_error(format!(
                "No credentials configured for {} account '{}'",
                plugin.manifest.name, account.label
            ))
        })?;
    let auth_file_path = opencode_auth_file::write_auth(config, strategy, &credentials)?;

    Ok(ExternalAuthSyncResult {
        plugin_id: plugin.manifest.id.clone(),
        account_id: account.id.clone(),
        account_label: account_label(&account),
        auth_file_path: auth_file_path.to_string_lossy().to_string(),
        remaining_percent,
    })
}

fn normalize_plugin_id(plugin_id: &str) -> Result<String> {
    let plugin_id = plugin_id.trim().to_ascii_lowercase();
    if plugin_id.is_empty() {
        return Err(BackendError::Validation("pluginId is required".to_string()));
    }
    Ok(plugin_id)
}

fn loaded_plugin_by_id(state: &Mutex<AppState>, plugin_id: &str) -> Result<LoadedPlugin> {
    let locked = state
        .lock()
        .map_err(|_| BackendError::Plugin("plugin state poisoned".to_string()))?;
    locked
        .plugins
        .iter()
        .find(|plugin| plugin.manifest.id == plugin_id)
        .cloned()
        .ok_or_else(|| BackendError::Plugin(format!("pluginId '{plugin_id}' is not registered")))
}

fn opencode_config(plugin: &LoadedPlugin) -> Result<&OpenCodeExternalAuth> {
    plugin
        .manifest
        .external_auth
        .as_ref()
        .and_then(|external| external.opencode.as_ref())
        .ok_or_else(|| {
            provider_error(format!(
                "{} does not declare OpenCode external auth sync",
                plugin.manifest.name
            ))
        })
}

fn effective_strategy_id(plugin: &LoadedPlugin, account: &AccountRecord) -> Result<String> {
    account
        .auth_strategy_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            plugin
                .manifest
                .auth
                .as_ref()
                .and_then(|auth| auth.default_strategy_id.clone())
        })
        .ok_or_else(|| provider_error(format!("{} account has no auth strategy", account.label)))
}

fn opencode_strategy_for_account<'a>(
    plugin: &LoadedPlugin,
    config: &'a OpenCodeExternalAuth,
    account: &AccountRecord,
) -> Result<&'a OpenCodeExternalAuthStrategy> {
    let strategy_id = effective_strategy_id(plugin, account)?;
    config.strategies.get(&strategy_id).ok_or_else(|| {
        provider_error(format!(
            "OpenCode auth sync is not supported for {} auth strategy '{}'",
            plugin.manifest.name, strategy_id
        ))
    })
}

fn has_supported_strategy(
    plugin: &LoadedPlugin,
    config: &OpenCodeExternalAuth,
    account: &AccountRecord,
) -> bool {
    opencode_strategy_for_account(plugin, config, account).is_ok()
}

fn account_matches_current_opencode_auth<R: Runtime>(
    app: &tauri::AppHandle<R>,
    store: &AccountStore,
    plugin: &LoadedPlugin,
    config: &OpenCodeExternalAuth,
    account: &AccountRecord,
) -> Result<bool> {
    let strategy = opencode_strategy_for_account(plugin, config, account)?;
    let Some(credentials) = secrets::get_account_credentials(app, store, &account.id)? else {
        return Ok(false);
    };
    opencode_auth_file::current_auth_matches(config, strategy, &credentials)
}

fn rotation_line_labels(config: &OpenCodeExternalAuth) -> Result<HashSet<String>> {
    let labels = config
        .rotation
        .as_ref()
        .map(|rotation| rotation.line_labels.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|label| label.trim())
        .filter(|label| !label.is_empty())
        .map(str::to_string)
        .collect::<HashSet<_>>();
    if labels.is_empty() {
        return Err(provider_error(
            "OpenCode rotation lineLabels are not configured",
        ));
    }
    Ok(labels)
}

fn score_account_usage_left(
    plugin_id: &str,
    account: &AccountRecord,
    rotation_labels: &HashSet<String>,
    allow_unscoped: bool,
) -> Option<f64> {
    let snapshot = cached_snapshot_for_plugin(plugin_id)?;
    let mut score: Option<f64> = None;
    for line in snapshot.lines {
        let MetricLine::Progress {
            label, used, limit, ..
        } = line
        else {
            continue;
        };
        let Some(metric_label) = metric_label_for_account(&label, account, allow_unscoped) else {
            continue;
        };
        if !rotation_labels.contains(metric_label) || limit <= 0.0 || !used.is_finite() {
            continue;
        }
        let remaining = ((limit - used).max(0.0) / limit * 100.0).min(100.0);
        score = Some(
            score
                .map(|current| current.min(remaining))
                .unwrap_or(remaining),
        );
    }
    score
}

fn metric_label_for_account<'a>(
    label: &'a str,
    account: &AccountRecord,
    allow_unscoped: bool,
) -> Option<&'a str> {
    let marker = format!(" @@ {} :: ", account.id);
    if let Some(index) = label.find(&marker) {
        return Some(&label[index + marker.len()..]);
    }
    allow_unscoped.then_some(label)
}

fn account_label(account: &AccountRecord) -> String {
    let label = account.label.trim();
    if !label.is_empty() {
        return label.to_string();
    }
    let short_id = account.id.chars().take(8).collect::<String>();
    if short_id.is_empty() {
        "Account".to_string()
    } else {
        format!("Account {short_id}")
    }
}

fn provider_error(message: impl Into<String>) -> BackendError {
    BackendError::Plugin(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_account_scoped_metric_label() {
        let account = AccountRecord {
            id: "acc-1".to_string(),
            plugin_id: "codex".to_string(),
            enabled: true,
            auth_strategy_id: Some("oauth".to_string()),
            label: "Work".to_string(),
            settings: serde_json::json!({}),
            credentials: None,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
            last_fetch_at: None,
            last_error: None,
        };

        assert_eq!(
            metric_label_for_account("Work @@ acc-1 :: Weekly", &account, false),
            Some("Weekly")
        );
        assert_eq!(
            metric_label_for_account("Weekly", &account, true),
            Some("Weekly")
        );
        assert_eq!(metric_label_for_account("Weekly", &account, false), None);
    }
}
