use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::error::{BackendError, Result};
use crate::models::{
    AccountRecord, CreateAccountInput, EncryptedCredentials, UpdateAccountInput,
    is_valid_plugin_id, is_valid_strategy_id, normalize_optional_string, normalize_string,
};
use crate::utils::now_rfc3339;

const STORE_FILE_NAME: &str = "accounts.json";
const STORE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountStoreFile {
    schema_version: u32,
    accounts: Vec<AccountRecord>,
}

impl Default for AccountStoreFile {
    fn default() -> Self {
        Self {
            schema_version: STORE_SCHEMA_VERSION,
            accounts: Vec::new(),
        }
    }
}

#[derive(Debug, Default)]
struct AccountStoreState {
    accounts: Vec<AccountRecord>,
}

#[derive(Debug)]
pub struct AccountStore {
    path: PathBuf,
    state: Mutex<AccountStoreState>,
}

impl AccountStore {
    pub fn load(app: &AppHandle) -> Result<Self> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| BackendError::Path(err.to_string()))?;
        fs::create_dir_all(&data_dir)?;
        let path = data_dir.join(STORE_FILE_NAME);
        Self::load_from_path(path)
    }

    fn load_from_path(path: PathBuf) -> Result<Self> {
        let state = match fs::read_to_string(&path) {
            Ok(contents) => {
                if contents.trim().is_empty() {
                    AccountStoreState::default()
                } else {
                    parse_store_contents(&contents)?
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => AccountStoreState::default(),
            Err(err) => return Err(err.into()),
        };

        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    pub fn list_accounts(&self) -> Result<Vec<AccountRecord>> {
        let state = self.lock_state()?;
        let mut accounts = state.accounts.clone();
        accounts.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(accounts)
    }

    pub fn get_account(&self, account_id: &str) -> Result<Option<AccountRecord>> {
        let account_id = account_id.trim();
        if account_id.is_empty() {
            return Ok(None);
        }
        let state = self.lock_state()?;
        Ok(state
            .accounts
            .iter()
            .find(|account| account.id == account_id)
            .cloned())
    }

    pub fn create_account(&self, input: CreateAccountInput) -> Result<AccountRecord> {
        let plugin_id = normalize_string(&input.plugin_id)
            .map(|value| value.to_ascii_lowercase())
            .ok_or_else(|| BackendError::Validation("pluginId is required".to_string()))?;
        if !is_valid_plugin_id(&plugin_id) {
            return Err(BackendError::Validation(
                "pluginId must match ^[a-z0-9][a-z0-9._-]{1,63}$".to_string(),
            ));
        }
        let auth_strategy_id = match normalize_optional_string(input.auth_strategy_id) {
            Some(strategy_id) => {
                if !is_valid_strategy_id(&strategy_id) {
                    return Err(BackendError::Validation(
                        "authStrategyId must match ^[a-zA-Z][a-zA-Z0-9._-]{1,63}$".to_string(),
                    ));
                }
                Some(strategy_id)
            }
            None => None,
        };

        let label = normalize_optional_string(input.label).unwrap_or_else(|| plugin_id.clone());
        let settings = input.settings.unwrap_or_else(|| serde_json::json!({}));
        if !settings.is_object() {
            return Err(BackendError::Validation(
                "settings must be a JSON object".to_string(),
            ));
        }

        let now = now_rfc3339();
        let account = AccountRecord {
            id: Uuid::new_v4().to_string(),
            plugin_id,
            enabled: true,
            auth_strategy_id,
            label,
            settings,
            credentials: None,
            created_at: now.clone(),
            updated_at: now,
            last_fetch_at: None,
            last_error: None,
        };

        let mut state = self.lock_state()?;
        state.accounts.push(account.clone());
        self.save_locked(&state)?;
        Ok(account)
    }

    pub fn update_account(
        &self,
        account_id: &str,
        input: UpdateAccountInput,
    ) -> Result<AccountRecord> {
        let account_id = account_id.trim();
        if account_id.is_empty() {
            return Err(BackendError::Validation(
                "accountId is required".to_string(),
            ));
        }

        let mut state = self.lock_state()?;
        let account_index = state
            .accounts
            .iter()
            .position(|account| account.id == account_id)
            .ok_or(BackendError::AccountNotFound)?;
        let mut account = state.accounts[account_index].clone();
        if let Some(raw_label) = input.label {
            let label = normalize_string(&raw_label)
                .ok_or_else(|| BackendError::Validation("label cannot be empty".to_string()))?;
            account.label = label;
        }

        if let Some(raw_strategy_id) = input.auth_strategy_id {
            let strategy_id = normalize_string(&raw_strategy_id);
            if let Some(strategy_id) = strategy_id.as_deref() {
                if !is_valid_strategy_id(strategy_id) {
                    return Err(BackendError::Validation(
                        "authStrategyId must match ^[a-zA-Z][a-zA-Z0-9._-]{1,63}$".to_string(),
                    ));
                }
            }
            account.auth_strategy_id = strategy_id;
        }

        if let Some(enabled) = input.enabled {
            account.enabled = enabled;
        }

        if let Some(settings) = input.settings {
            if !settings.is_object() {
                return Err(BackendError::Validation(
                    "settings must be a JSON object".to_string(),
                ));
            }
            account.settings = settings;
        }

        if input.clear_last_error {
            account.last_error = None;
        }

        account.updated_at = now_rfc3339();
        state.accounts[account_index] = account.clone();
        self.save_locked(&state)?;
        Ok(account)
    }

    pub fn delete_account(&self, account_id: &str) -> Result<Option<AccountRecord>> {
        let account_id = account_id.trim();
        if account_id.is_empty() {
            return Ok(None);
        }

        let mut state = self.lock_state()?;
        let index = state
            .accounts
            .iter()
            .position(|account| account.id == account_id);
        let removed = index.map(|index| state.accounts.remove(index));
        if removed.is_some() {
            self.save_locked(&state)?;
        }
        Ok(removed)
    }

    pub fn record_probe_success(&self, account_id: &str) -> Result<()> {
        let account_id = account_id.trim();
        if account_id.is_empty() {
            return Err(BackendError::Validation(
                "accountId is required".to_string(),
            ));
        }

        let mut state = self.lock_state()?;
        let account = state
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
            .ok_or(BackendError::AccountNotFound)?;

        let now = now_rfc3339();
        account.last_fetch_at = Some(now.clone());
        account.last_error = None;
        account.updated_at = now;
        self.save_locked(&state)?;
        Ok(())
    }

    pub fn record_probe_error(&self, account_id: &str, message: &str) -> Result<()> {
        let account_id = account_id.trim();
        if account_id.is_empty() {
            return Err(BackendError::Validation(
                "accountId is required".to_string(),
            ));
        }

        let mut state = self.lock_state()?;
        let account = state
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
            .ok_or(BackendError::AccountNotFound)?;

        account.last_error = Some(message.to_string());
        account.updated_at = now_rfc3339();
        self.save_locked(&state)?;
        Ok(())
    }

    pub fn set_credentials_blob(
        &self,
        account_id: &str,
        encrypted: EncryptedCredentials,
    ) -> Result<()> {
        let account_id = account_id.trim();
        if account_id.is_empty() {
            return Err(BackendError::Validation(
                "accountId is required".to_string(),
            ));
        }

        let mut state = self.lock_state()?;
        let account = state
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
            .ok_or(BackendError::AccountNotFound)?;
        account.credentials = Some(encrypted);
        self.save_locked(&state)?;
        Ok(())
    }

    pub fn get_credentials_blob(&self, account_id: &str) -> Result<Option<EncryptedCredentials>> {
        let account_id = account_id.trim();
        if account_id.is_empty() {
            return Err(BackendError::Validation(
                "accountId is required".to_string(),
            ));
        }

        let state = self.lock_state()?;
        let account = state
            .accounts
            .iter()
            .find(|account| account.id == account_id)
            .ok_or(BackendError::AccountNotFound)?;
        Ok(account.credentials.clone())
    }

    pub fn has_credentials_blob(&self, account_id: &str) -> Result<bool> {
        self.get_credentials_blob(account_id)
            .map(|credentials| credentials.is_some())
    }

    pub fn delete_credentials_blob(&self, account_id: &str) -> Result<()> {
        let account_id = account_id.trim();
        if account_id.is_empty() {
            return Err(BackendError::Validation(
                "accountId is required".to_string(),
            ));
        }

        let mut state = self.lock_state()?;
        let account = state
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
            .ok_or(BackendError::AccountNotFound)?;
        account.credentials = None;
        self.save_locked(&state)?;
        Ok(())
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, AccountStoreState>> {
        self.state
            .lock()
            .map_err(|_| BackendError::Store("account store mutex poisoned".to_string()))
    }

    fn save_locked(&self, state: &AccountStoreState) -> Result<()> {
        let payload = AccountStoreFile {
            schema_version: STORE_SCHEMA_VERSION,
            accounts: state.accounts.clone(),
        };
        let serialized = serde_json::to_string_pretty(&payload)?;
        fs::write(&self.path, serialized)?;
        Ok(())
    }
}

fn parse_store_contents(contents: &str) -> Result<AccountStoreState> {
    let store_file = serde_json::from_str::<AccountStoreFile>(contents)?;
    if store_file.schema_version != STORE_SCHEMA_VERSION {
        return Err(BackendError::Store(format!(
            "unsupported account store schema version: {}",
            store_file.schema_version
        )));
    }

    Ok(AccountStoreState {
        accounts: store_file.accounts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_store_path() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("openburn-account-store-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir.join("accounts.json")
    }

    #[test]
    fn create_account_persists_and_reloads() {
        let path = make_temp_store_path();
        let parent = path
            .parent()
            .expect("temp store path should have a parent")
            .to_path_buf();

        let store = AccountStore::load_from_path(path.clone()).expect("store should load");
        let account = store
            .create_account(CreateAccountInput {
                plugin_id: "codex".to_string(),
                auth_strategy_id: Some("oauth".to_string()),
                label: Some("Codex Personal".to_string()),
                settings: Some(serde_json::json!({"region": "us"})),
            })
            .expect("account should be created");
        assert_eq!(account.plugin_id, "codex");

        drop(store);

        let reloaded = AccountStore::load_from_path(path).expect("store should reload");
        let accounts = reloaded.list_accounts().expect("list should succeed");
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].label, "Codex Personal");

        fs::remove_dir_all(parent).expect("temp dir should be removed");
    }

    #[test]
    fn update_account_can_clear_auth_strategy() {
        let path = make_temp_store_path();
        let parent = path
            .parent()
            .expect("temp store path should have a parent")
            .to_path_buf();

        let store = AccountStore::load_from_path(path).expect("store should load");
        let account = store
            .create_account(CreateAccountInput {
                plugin_id: "codex".to_string(),
                auth_strategy_id: Some("oauth".to_string()),
                label: None,
                settings: None,
            })
            .expect("account should be created");

        let updated = store
            .update_account(
                &account.id,
                UpdateAccountInput {
                    auth_strategy_id: Some("".to_string()),
                    enabled: None,
                    label: None,
                    settings: None,
                    clear_last_error: false,
                },
            )
            .expect("account should be updated");

        assert_eq!(updated.auth_strategy_id, None);

        fs::remove_dir_all(parent).expect("temp dir should be removed");
    }

    #[test]
    fn update_account_can_toggle_enabled() {
        let path = make_temp_store_path();
        let parent = path
            .parent()
            .expect("temp store path should have a parent")
            .to_path_buf();

        let store = AccountStore::load_from_path(path).expect("store should load");
        let account = store
            .create_account(CreateAccountInput {
                plugin_id: "codex".to_string(),
                auth_strategy_id: Some("oauth".to_string()),
                label: Some("Codex".to_string()),
                settings: None,
            })
            .expect("account should be created");

        assert!(account.enabled);

        let disabled = store
            .update_account(
                &account.id,
                UpdateAccountInput {
                    auth_strategy_id: None,
                    enabled: Some(false),
                    label: None,
                    settings: None,
                    clear_last_error: false,
                },
            )
            .expect("account should be updated");

        assert!(!disabled.enabled);

        let enabled = store
            .update_account(
                &account.id,
                UpdateAccountInput {
                    auth_strategy_id: None,
                    enabled: Some(true),
                    label: None,
                    settings: None,
                    clear_last_error: false,
                },
            )
            .expect("account should be updated");

        assert!(enabled.enabled);

        fs::remove_dir_all(parent).expect("temp dir should be removed");
    }

    #[test]
    fn credentials_blob_persists_and_reloads() {
        let path = make_temp_store_path();
        let parent = path
            .parent()
            .expect("temp store path should have a parent")
            .to_path_buf();

        let store = AccountStore::load_from_path(path.clone()).expect("store should load");
        let account = store
            .create_account(CreateAccountInput {
                plugin_id: "codex".to_string(),
                auth_strategy_id: Some("oauth".to_string()),
                label: Some("Codex Personal".to_string()),
                settings: Some(serde_json::json!({})),
            })
            .expect("account should be created");

        let encrypted = EncryptedCredentials {
            alg: "xchacha20poly1305".to_string(),
            key_version: 1,
            nonce: "nonce".to_string(),
            ciphertext: "ciphertext".to_string(),
        };

        store
            .set_credentials_blob(&account.id, encrypted.clone())
            .expect("credentials should be set");
        assert!(
            store
                .has_credentials_blob(&account.id)
                .expect("has credentials should work")
        );

        drop(store);

        let reloaded = AccountStore::load_from_path(path).expect("store should reload");
        let loaded = reloaded
            .get_credentials_blob(&account.id)
            .expect("get credentials should work")
            .expect("credentials should exist");

        assert_eq!(loaded.alg, encrypted.alg);
        assert_eq!(loaded.key_version, encrypted.key_version);

        fs::remove_dir_all(parent).expect("temp dir should be removed");
    }
}
