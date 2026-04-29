mod account_auth;
mod account_import;
mod account_store;
#[cfg(target_os = "macos")]
mod app_nap;
mod auth;
mod config;
mod error;
mod external_auth;
mod local_http_api;
mod models;
mod oauth;
mod opencode_auth_file;
mod panel;
mod plugin_engine;
mod secrets;
mod tray;
mod utils;
#[cfg(target_os = "macos")]
mod webkit_config;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};
use uuid::Uuid;

#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const GLOBAL_SHORTCUT_STORE_KEY: &str = "globalShortcut";

#[cfg(desktop)]
fn managed_shortcut_slot() -> &'static Mutex<Option<String>> {
    static SLOT: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Shared shortcut handler that toggles the panel when the shortcut is pressed.
#[cfg(desktop)]
fn handle_global_shortcut(
    app: &tauri::AppHandle,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    if event.state == ShortcutState::Pressed {
        log::debug!("Global shortcut triggered");
        panel::toggle_panel(app);
    }
}

pub struct AppState {
    pub plugins: Vec<plugin_engine::manifest::LoadedPlugin>,
    pub app_data_dir: PathBuf,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    pub icon_url: String,
    pub brand_color: Option<String>,
    pub lines: Vec<ManifestLineDto>,
    pub links: Vec<PluginLinkDto>,
    pub auth: Option<PluginAuthDto>,
    pub external_auth: Option<PluginExternalAuthDto>,
    /// Ordered list of primary metric candidates (sorted by primaryOrder).
    /// Frontend picks the first one that exists in runtime data.
    pub primary_candidates: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginExternalAuthDto {
    pub opencode: Option<PluginOpenCodeExternalAuthDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOpenCodeExternalAuthDto {
    pub strategy_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAuthDto {
    pub default_strategy_id: Option<String>,
    pub strategies: Vec<AuthStrategyDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStrategyDto {
    pub id: String,
    pub label: String,
    pub kind: plugin_engine::manifest::AuthStrategyKind,
    pub fields: Vec<plugin_engine::manifest::AuthCredentialField>,
    pub credential_template: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLineDto {
    #[serde(rename = "type")]
    pub line_type: String,
    pub label: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLinkDto {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeBatchStarted {
    pub batch_id: String,
    pub plugin_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub batch_id: String,
    pub output: plugin_engine::runtime::PluginOutput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeBatchComplete {
    pub batch_id: String,
}

#[tauri::command]
fn init_panel(app_handle: tauri::AppHandle) {
    panel::init(&app_handle).expect("Failed to initialize panel");
}

#[tauri::command]
fn hide_panel(app_handle: tauri::AppHandle) {
    use tauri_nspanel::ManagerExt;
    if let Ok(panel) = app_handle.get_webview_panel("main") {
        panel.hide();
    }
}

#[tauri::command]
fn open_devtools(#[allow(unused)] app_handle: tauri::AppHandle) {
    #[cfg(debug_assertions)]
    {
        use tauri::Manager;
        if let Some(window) = app_handle.get_webview_window("main") {
            window.open_devtools();
        }
    }
}

fn plugin_error_output(
    plugin: &plugin_engine::manifest::LoadedPlugin,
    message: impl Into<String>,
) -> plugin_engine::runtime::PluginOutput {
    plugin_engine::runtime::PluginOutput {
        provider_id: plugin.manifest.id.clone(),
        display_name: plugin.manifest.name.clone(),
        plan: None,
        lines: vec![plugin_engine::runtime::MetricLine::Badge {
            label: "Error".to_string(),
            text: message.into(),
            color: Some("#ef4444".to_string()),
            subtitle: None,
        }],
        icon_url: plugin.icon_data_url.clone(),
        updated_credentials: None,
    }
}

fn is_error_output(output: &plugin_engine::runtime::PluginOutput) -> bool {
    output.lines.iter().any(|line| {
        matches!(line, plugin_engine::runtime::MetricLine::Badge { label, .. } if label == "Error")
    })
}

fn account_label(account: &models::AccountRecord) -> String {
    let trimmed = account.label.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    let short_id = account.id.chars().take(8).collect::<String>();
    if short_id.is_empty() {
        "Account".to_string()
    } else {
        format!("Account {short_id}")
    }
}

fn scoped_account_label(account: &models::AccountRecord, metric_label: &str) -> String {
    format!(
        "{} @@ {} :: {}",
        account_label(account),
        account.id,
        metric_label
    )
}

fn prefix_metric_line(
    line: plugin_engine::runtime::MetricLine,
    account: &models::AccountRecord,
) -> plugin_engine::runtime::MetricLine {
    match line {
        plugin_engine::runtime::MetricLine::Text {
            label,
            value,
            color,
            subtitle,
        } => plugin_engine::runtime::MetricLine::Text {
            label: scoped_account_label(account, &label),
            value,
            color,
            subtitle,
        },
        plugin_engine::runtime::MetricLine::Progress {
            label,
            used,
            limit,
            format,
            resets_at,
            period_duration_ms,
            color,
        } => plugin_engine::runtime::MetricLine::Progress {
            label: scoped_account_label(account, &label),
            used,
            limit,
            format,
            resets_at,
            period_duration_ms,
            color,
        },
        plugin_engine::runtime::MetricLine::Badge {
            label,
            text,
            color,
            subtitle,
        } => plugin_engine::runtime::MetricLine::Badge {
            label: scoped_account_label(account, &label),
            text,
            color,
            subtitle,
        },
    }
}

fn aggregate_account_outputs(
    plugin: &plugin_engine::manifest::LoadedPlugin,
    outputs: Vec<(models::AccountRecord, plugin_engine::runtime::PluginOutput)>,
) -> plugin_engine::runtime::PluginOutput {
    if outputs.len() == 1 {
        return outputs.into_iter().next().expect("one output").1;
    }

    let mut lines = Vec::new();
    for (account, output) in outputs {
        if let Some(plan) = output
            .plan
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            lines.push(plugin_engine::runtime::MetricLine::Badge {
                label: scoped_account_label(&account, "Plan"),
                text: plan.to_string(),
                color: None,
                subtitle: None,
            });
        }
        for line in output.lines {
            lines.push(prefix_metric_line(line, &account));
        }
    }

    if lines.is_empty() {
        lines.push(plugin_engine::runtime::MetricLine::Badge {
            label: "Status".to_string(),
            text: "No usage data".to_string(),
            color: Some("#a3a3a3".to_string()),
            subtitle: None,
        });
    }

    plugin_engine::runtime::PluginOutput {
        provider_id: plugin.manifest.id.clone(),
        display_name: plugin.manifest.name.clone(),
        plan: None,
        lines,
        icon_url: plugin.icon_data_url.clone(),
        updated_credentials: None,
    }
}

fn run_plugin_probe_with_accounts(
    app_handle: &tauri::AppHandle,
    plugin: &plugin_engine::manifest::LoadedPlugin,
    app_data_dir: &PathBuf,
    app_version: &str,
) -> plugin_engine::runtime::PluginOutput {
    let Some(_auth) = plugin.manifest.auth.as_ref() else {
        return plugin_engine::runtime::run_probe(plugin, app_data_dir, app_version, None, None);
    };

    let store = app_handle.state::<account_store::AccountStore>();
    let accounts = match store.list_accounts() {
        Ok(accounts) => accounts
            .into_iter()
            .filter(|account| account.plugin_id == plugin.manifest.id && account.enabled)
            .collect::<Vec<_>>(),
        Err(err) => return plugin_error_output(plugin, err.to_string()),
    };

    if accounts.is_empty() {
        return plugin_error_output(
            plugin,
            format!("No {} account configured", plugin.manifest.name),
        );
    }

    let mut outputs = Vec::new();
    let mut saw_credentials = false;
    for account in accounts {
        let credentials =
            match secrets::get_account_credentials(app_handle, store.inner(), &account.id) {
                Ok(Some(credentials)) => {
                    saw_credentials = true;
                    credentials
                }
                Ok(None) => {
                    match account_import::import_account_credentials(plugin, &account, app_data_dir)
                    {
                        Ok(Some(credentials)) => {
                            saw_credentials = true;
                            if let Err(err) = secrets::set_account_credentials(
                                app_handle,
                                store.inner(),
                                &account.id,
                                &credentials,
                            ) {
                                let _ = store.record_probe_error(&account.id, &err.to_string());
                                let output = plugin_error_output(plugin, err.to_string());
                                outputs.push((account, output));
                                continue;
                            }
                            credentials
                        }
                        Ok(None) => continue,
                        Err(err) => {
                            let _ = store.record_probe_error(&account.id, &err.to_string());
                            let output = plugin_error_output(plugin, err.to_string());
                            outputs.push((account, output));
                            continue;
                        }
                    }
                }
                Err(err) => {
                    let _ = store.record_probe_error(&account.id, &err.to_string());
                    let output = plugin_error_output(plugin, err.to_string());
                    outputs.push((account, output));
                    continue;
                }
            };

        let account_ctx = plugin_engine::runtime::ProbeAccountContext {
            id: account.id.clone(),
            label: account.label.clone(),
            settings: account.settings.clone(),
        };
        let output = plugin_engine::runtime::run_probe(
            plugin,
            app_data_dir,
            app_version,
            Some(account_ctx),
            Some(credentials),
        );
        if is_error_output(&output) {
            let message = output
                .lines
                .iter()
                .find_map(|line| match line {
                    plugin_engine::runtime::MetricLine::Badge { label, text, .. }
                        if label == "Error" =>
                    {
                        Some(text.clone())
                    }
                    _ => None,
                })
                .unwrap_or_else(|| "probe failed".to_string());
            let _ = store.record_probe_error(&account.id, &message);
        } else {
            if let Some(updated_credentials) = output.updated_credentials.as_ref() {
                let _ = secrets::set_account_credentials(
                    app_handle,
                    store.inner(),
                    &account.id,
                    updated_credentials,
                );
            }
            let _ = store.record_probe_success(&account.id);
        }
        outputs.push((account, output));
    }

    if outputs.is_empty() {
        if saw_credentials {
            plugin_error_output(
                plugin,
                format!("Failed to fetch {} usage", plugin.manifest.name),
            )
        } else {
            plugin_error_output(
                plugin,
                format!("No credentials configured for {}", plugin.manifest.name),
            )
        }
    } else {
        aggregate_account_outputs(plugin, outputs)
    }
}

#[tauri::command]
async fn start_probe_batch(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    _store: tauri::State<'_, account_store::AccountStore>,
    batch_id: Option<String>,
    plugin_ids: Option<Vec<String>>,
) -> Result<ProbeBatchStarted, String> {
    let batch_id = batch_id
        .and_then(|id| {
            let trimmed = id.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let (plugins, app_data_dir, app_version) = {
        let locked = state.lock().map_err(|e| e.to_string())?;
        (
            locked.plugins.clone(),
            locked.app_data_dir.clone(),
            locked.app_version.clone(),
        )
    };

    let selected_plugins = match plugin_ids {
        Some(ids) => {
            let mut by_id: HashMap<String, plugin_engine::manifest::LoadedPlugin> = plugins
                .into_iter()
                .map(|plugin| (plugin.manifest.id.clone(), plugin))
                .collect();
            let mut seen = HashSet::new();
            ids.into_iter()
                .filter_map(|id| {
                    if !seen.insert(id.clone()) {
                        return None;
                    }
                    by_id.remove(&id)
                })
                .collect()
        }
        None => plugins,
    };

    let response_plugin_ids: Vec<String> = selected_plugins
        .iter()
        .map(|plugin| plugin.manifest.id.clone())
        .collect();

    log::info!(
        "probe batch {} starting: {:?}",
        batch_id,
        response_plugin_ids
    );

    if selected_plugins.is_empty() {
        let _ = app_handle.emit(
            "probe:batch-complete",
            ProbeBatchComplete {
                batch_id: batch_id.clone(),
            },
        );
        return Ok(ProbeBatchStarted {
            batch_id,
            plugin_ids: response_plugin_ids,
        });
    }

    let remaining = Arc::new(AtomicUsize::new(selected_plugins.len()));
    for plugin in selected_plugins {
        let handle = app_handle.clone();
        let completion_handle = app_handle.clone();
        let bid = batch_id.clone();
        let completion_bid = batch_id.clone();
        let data_dir = app_data_dir.clone();
        let version = app_version.clone();
        let counter = Arc::clone(&remaining);

        tauri::async_runtime::spawn_blocking(move || {
            let plugin_id = plugin.manifest.id.clone();
            let probe_handle = handle.clone();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_plugin_probe_with_accounts(&probe_handle, &plugin, &data_dir, &version)
            }));

            match result {
                Ok(output) => {
                    let has_error = output.lines.iter().any(|line| {
                        matches!(line, plugin_engine::runtime::MetricLine::Badge { label, .. } if label == "Error")
                    });
                    if has_error {
                        log::warn!("probe {} completed with error", plugin_id);
                    } else {
                        log::info!(
                            "probe {} completed ok ({} lines)",
                            plugin_id,
                            output.lines.len()
                        );
                        local_http_api::cache_successful_output(&output);
                    }
                    let _ = handle.emit(
                        "probe:result",
                        ProbeResult {
                            batch_id: bid,
                            output,
                        },
                    );
                }
                Err(_) => {
                    log::error!("probe {} panicked", plugin_id);
                }
            }

            if counter.fetch_sub(1, Ordering::SeqCst) == 1 {
                log::info!("probe batch {} complete", completion_bid);
                let _ = completion_handle.emit(
                    "probe:batch-complete",
                    ProbeBatchComplete {
                        batch_id: completion_bid,
                    },
                );
            }
        });
    }

    Ok(ProbeBatchStarted {
        batch_id,
        plugin_ids: response_plugin_ids,
    })
}

#[tauri::command]
fn get_log_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    // macOS log directory: ~/Library/Logs/{bundleIdentifier}
    let home = dirs::home_dir().ok_or("no home dir")?;
    let bundle_id = app_handle.config().identifier.clone();
    let log_dir = home.join("Library").join("Logs").join(&bundle_id);
    let log_file = log_dir.join(format!("{}.log", app_handle.package_info().name));
    Ok(log_file.to_string_lossy().to_string())
}

/// Update the global shortcut registration.
/// Pass `null` to disable the shortcut, or a shortcut string like "CommandOrControl+Shift+U".
#[cfg(desktop)]
#[tauri::command]
fn update_global_shortcut(
    app_handle: tauri::AppHandle,
    shortcut: Option<String>,
) -> Result<(), String> {
    let global_shortcut = app_handle.global_shortcut();
    let normalized_shortcut = shortcut.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let mut managed_shortcut = managed_shortcut_slot()
        .lock()
        .map_err(|e| format!("failed to lock managed shortcut state: {}", e))?;

    if *managed_shortcut == normalized_shortcut {
        log::debug!("Global shortcut unchanged");
        return Ok(());
    }

    let previous_shortcut = managed_shortcut.clone();
    if let Some(existing) = previous_shortcut.as_deref() {
        match global_shortcut.unregister(existing) {
            Ok(()) => {
                // Keep in-memory state aligned with actual registration state.
                *managed_shortcut = None;
            }
            Err(e) => {
                log::warn!(
                    "Failed to unregister existing shortcut '{}': {}",
                    existing,
                    e
                );
            }
        }
    }

    if let Some(shortcut) = normalized_shortcut {
        log::info!("Registering global shortcut: {}", shortcut);
        global_shortcut
            .on_shortcut(shortcut.as_str(), |app, _shortcut, event| {
                handle_global_shortcut(app, event);
            })
            .map_err(|e| format!("Failed to register shortcut '{}': {}", shortcut, e))?;
        *managed_shortcut = Some(shortcut);
    } else {
        log::info!("Global shortcut disabled");
        *managed_shortcut = None;
    }

    Ok(())
}

#[tauri::command]
fn list_plugins(state: tauri::State<'_, Mutex<AppState>>) -> Vec<PluginMeta> {
    let plugins = {
        let locked = state.lock().expect("plugin state poisoned");
        locked.plugins.clone()
    };
    log::debug!("list_plugins: {} plugins", plugins.len());

    plugins
        .into_iter()
        .map(|plugin| {
            // Extract primary candidates: progress lines with primary_order, sorted by order
            let mut candidates: Vec<_> = plugin
                .manifest
                .lines
                .iter()
                .filter(|line| line.line_type == "progress" && line.primary_order.is_some())
                .collect();
            candidates.sort_by_key(|line| line.primary_order.unwrap());
            let primary_candidates: Vec<String> =
                candidates.iter().map(|line| line.label.clone()).collect();

            let auth = plugin.manifest.auth.as_ref().map(|auth| PluginAuthDto {
                default_strategy_id: auth.default_strategy_id.clone(),
                strategies: auth
                    .strategies
                    .iter()
                    .map(|strategy| AuthStrategyDto {
                        id: strategy.id.clone(),
                        label: strategy.label.clone(),
                        kind: strategy.kind.clone(),
                        fields: strategy.fields.clone(),
                        credential_template: strategy.credential_template.clone(),
                    })
                    .collect(),
            });

            let external_auth =
                plugin
                    .manifest
                    .external_auth
                    .as_ref()
                    .map(|external| PluginExternalAuthDto {
                        opencode: external.opencode.as_ref().map(|opencode| {
                            let mut strategy_ids =
                                opencode.strategies.keys().cloned().collect::<Vec<_>>();
                            strategy_ids.sort();
                            PluginOpenCodeExternalAuthDto { strategy_ids }
                        }),
                    });

            PluginMeta {
                id: plugin.manifest.id,
                name: plugin.manifest.name,
                icon_url: plugin.icon_data_url,
                brand_color: plugin.manifest.brand_color,
                lines: plugin
                    .manifest
                    .lines
                    .iter()
                    .map(|line| ManifestLineDto {
                        line_type: line.line_type.clone(),
                        label: line.label.clone(),
                        scope: line.scope.clone(),
                    })
                    .collect(),
                links: plugin
                    .manifest
                    .links
                    .iter()
                    .map(|link| PluginLinkDto {
                        label: link.label.clone(),
                        url: link.url.clone(),
                    })
                    .collect(),
                auth,
                external_auth,
                primary_candidates,
            }
        })
        .collect()
}

fn find_loaded_plugin(
    state: &tauri::State<'_, Mutex<AppState>>,
    plugin_id: &str,
) -> Result<plugin_engine::manifest::LoadedPlugin, String> {
    let plugin_id = plugin_id.trim().to_ascii_lowercase();
    if plugin_id.is_empty() {
        return Err("pluginId is required".to_string());
    }
    let locked = state.lock().map_err(|e| e.to_string())?;
    locked
        .plugins
        .iter()
        .find(|plugin| plugin.manifest.id == plugin_id)
        .cloned()
        .ok_or_else(|| format!("pluginId '{}' is not registered", plugin_id))
}

fn validate_account_input_for_plugin(
    plugin: &plugin_engine::manifest::LoadedPlugin,
    auth_strategy_id: Option<String>,
) -> Result<String, String> {
    let auth = plugin
        .manifest
        .auth
        .as_ref()
        .ok_or_else(|| format!("{} does not support accounts", plugin.manifest.name))?;
    let strategy_id = auth_strategy_id
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        })
        .or_else(|| auth.default_strategy_id.clone())
        .or_else(|| auth.strategies.first().map(|strategy| strategy.id.clone()))
        .ok_or_else(|| format!("{} has no auth strategies", plugin.manifest.name))?;
    if !auth
        .strategies
        .iter()
        .any(|strategy| strategy.id == strategy_id)
    {
        return Err(format!(
            "authStrategyId '{}' is not supported by pluginId '{}'",
            strategy_id, plugin.manifest.id
        ));
    }
    Ok(strategy_id)
}

#[tauri::command]
fn list_accounts(
    store: tauri::State<'_, account_store::AccountStore>,
) -> Result<Vec<models::AccountRecord>, String> {
    store.list_accounts().map_err(|err| err.to_string())
}

#[tauri::command]
fn create_account(
    state: tauri::State<'_, Mutex<AppState>>,
    store: tauri::State<'_, account_store::AccountStore>,
    input: models::CreateAccountInput,
) -> Result<models::AccountRecord, String> {
    let plugin = find_loaded_plugin(&state, &input.plugin_id)?;
    let auth_strategy_id = validate_account_input_for_plugin(&plugin, input.auth_strategy_id)?;
    store
        .create_account(models::CreateAccountInput {
            plugin_id: plugin.manifest.id,
            auth_strategy_id: Some(auth_strategy_id),
            label: input.label,
            settings: input.settings,
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn update_account(
    state: tauri::State<'_, Mutex<AppState>>,
    store: tauri::State<'_, account_store::AccountStore>,
    account_id: String,
    input: models::UpdateAccountInput,
) -> Result<models::AccountRecord, String> {
    if let Some(strategy) = input.auth_strategy_id.clone() {
        let account = store
            .get_account(&account_id)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "account not found".to_string())?;
        let plugin = find_loaded_plugin(&state, &account.plugin_id)?;
        validate_account_input_for_plugin(&plugin, Some(strategy))?;
    }
    store
        .update_account(&account_id, input)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn delete_account(
    store: tauri::State<'_, account_store::AccountStore>,
    account_id: String,
) -> Result<Option<models::AccountRecord>, String> {
    store
        .delete_account(&account_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn set_account_credentials(
    app: tauri::AppHandle,
    store: tauri::State<'_, account_store::AccountStore>,
    account_id: String,
    credentials: serde_json::Value,
) -> Result<(), String> {
    secrets::set_account_credentials(&app, store.inner(), &account_id, &credentials)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn has_account_credentials(
    store: tauri::State<'_, account_store::AccountStore>,
    account_id: String,
) -> Result<bool, String> {
    secrets::has_account_credentials(store.inner(), &account_id).map_err(|err| err.to_string())
}

#[tauri::command]
fn clear_account_credentials(
    store: tauri::State<'_, account_store::AccountStore>,
    account_id: String,
) -> Result<(), String> {
    secrets::clear_account_credentials(store.inner(), &account_id).map_err(|err| err.to_string())
}

#[tauri::command]
fn sync_account_to_opencode_auth(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    store: tauri::State<'_, account_store::AccountStore>,
    account_id: String,
) -> Result<external_auth::ExternalAuthSyncResult, String> {
    external_auth::sync_opencode_account(&app, state.inner(), store.inner(), &account_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn start_account_auth(
    app: tauri::AppHandle,
    auth_state: tauri::State<'_, auth::AuthState>,
    state: tauri::State<'_, Mutex<AppState>>,
    store: tauri::State<'_, account_store::AccountStore>,
    plugin_id: String,
    account_id: String,
) -> Result<account_auth::AccountAuthStartResponse, String> {
    let plugin = find_loaded_plugin(&state, &plugin_id)?;
    account_auth::start_account_auth(app, auth_state, store, plugin, account_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn finish_account_auth(
    app: tauri::AppHandle,
    auth_state: tauri::State<'_, auth::AuthState>,
    state: tauri::State<'_, Mutex<AppState>>,
    store: tauri::State<'_, account_store::AccountStore>,
    request_id: String,
    timeout_ms: Option<u64>,
) -> Result<account_auth::AccountAuthResult, String> {
    let plugin_id = auth_state
        .get(&request_id)
        .map(|flow| flow.plugin_id.clone())
        .ok_or_else(|| "auth request not found".to_string())?;
    let plugin = find_loaded_plugin(&state, &plugin_id)?;
    account_auth::finish_account_auth(app, auth_state, store, plugin, request_id, timeout_ms)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn cancel_account_auth(
    app: tauri::AppHandle,
    auth_state: tauri::State<'_, auth::AuthState>,
    request_id: String,
) -> bool {
    account_auth::cancel_account_auth(app, auth_state, request_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
    let _guard = runtime.enter();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_keyring::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_nspanel::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .max_file_size(10_000_000) // 10 MB
                .level(log::LevelFilter::Trace) // Allow all levels; runtime filter via tray menu
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("tao", log::LevelFilter::Info)
                .level_for("tauri_plugin_updater", log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            init_panel,
            hide_panel,
            open_devtools,
            start_probe_batch,
            list_plugins,
            list_accounts,
            create_account,
            update_account,
            delete_account,
            set_account_credentials,
            has_account_credentials,
            clear_account_credentials,
            sync_account_to_opencode_auth,
            start_account_auth,
            finish_account_auth,
            cancel_account_auth,
            get_log_path,
            update_global_shortcut
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            {
                app_nap::disable_app_nap();
                webkit_config::disable_webview_suspension(app.handle());
            }

            let version = app.package_info().version.to_string();
            log::info!("OpenBurn v{} starting", version);

            // Load config early (lazy init via OnceLock, zero-cost after)
            let _proxy = config::get_resolved_proxy();

            let app_data_dir = app.path().app_data_dir().expect("no app data dir");
            let resource_dir = app.path().resource_dir().expect("no resource dir");
            let app_data_dir_tail = app_data_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("unknown");
            let redacted_app_data_dir =
                plugin_engine::host_api::redact_log_message(&app_data_dir.display().to_string());
            log::debug!(
                "app_data_dir: tail={}, path={}",
                app_data_dir_tail,
                redacted_app_data_dir
            );

            let (_, plugins) = plugin_engine::initialize_plugins(&app_data_dir, &resource_dir);
            let known_plugin_ids: Vec<String> =
                plugins.iter().map(|p| p.manifest.id.clone()).collect();
            app.manage(Mutex::new(AppState {
                plugins,
                app_data_dir: app_data_dir.clone(),
                app_version: app.package_info().version.to_string(),
            }));
            let account_store = account_store::AccountStore::load(app.handle())
                .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?;
            app.manage(account_store);
            app.manage(auth::AuthState::new());

            local_http_api::init(&app_data_dir, known_plugin_ids);
            local_http_api::start_server(app.handle().clone());

            tray::create(app.handle())?;

            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Register global shortcut from stored settings
            #[cfg(desktop)]
            {
                use tauri_plugin_store::StoreExt;

                if let Ok(store) = app.handle().store("settings.json") {
                    if let Some(shortcut_value) = store.get(GLOBAL_SHORTCUT_STORE_KEY) {
                        if let Some(shortcut) = shortcut_value.as_str() {
                            let shortcut = shortcut.trim();
                            if !shortcut.is_empty() {
                                let handle = app.handle().clone();
                                log::info!("Registering initial global shortcut: {}", shortcut);
                                if let Err(e) = handle.global_shortcut().on_shortcut(
                                    shortcut,
                                    |app, _shortcut, event| {
                                        handle_global_shortcut(app, event);
                                    },
                                ) {
                                    log::warn!("Failed to register initial global shortcut: {}", e);
                                } else if let Ok(mut managed_shortcut) =
                                    managed_shortcut_slot().lock()
                                {
                                    *managed_shortcut = Some(shortcut.to_string());
                                } else {
                                    log::warn!("Failed to store managed shortcut in memory");
                                }
                            }
                        }
                    }
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, _| {});
}
