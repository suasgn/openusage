use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use rand::rngs::OsRng;
use sha2::Sha256;
use tauri::{AppHandle, Runtime};
use tauri_plugin_keyring::KeyringExt;

use crate::account_store::AccountStore;
use crate::error::{BackendError, Result};
use crate::models::{AccountRecord, EncryptedCredentials};

const SERVICE_NAME: &str = "openburn";
const MASTER_KEY_PREFIX: &str = "master-key-v";
const KEY_VERSION: u32 = 1;
const ALGORITHM: &str = "xchacha20poly1305";
const HKDF_SALT: &[u8] = b"openburn-credentials-v1";

static MASTER_KEY_CACHE: OnceLock<Mutex<HashMap<u32, [u8; 32]>>> = OnceLock::new();

fn credential_id(account: &AccountRecord) -> String {
    format!("{}:{}", account.plugin_id, account.id)
}

fn master_key_name(version: u32) -> String {
    format!("{MASTER_KEY_PREFIX}{version}")
}

fn read_master_key<R: Runtime>(app: &AppHandle<R>, version: u32) -> Result<Option<[u8; 32]>> {
    let cache = MASTER_KEY_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(key) = cache
        .lock()
        .expect("master key cache mutex poisoned")
        .get(&version)
        .copied()
    {
        return Ok(Some(key));
    }

    let key_name = master_key_name(version);
    let payload = app
        .keyring()
        .get_secret(SERVICE_NAME, &key_name)
        .map_err(|err| BackendError::Keyring(err.to_string()))?;
    let payload = match payload {
        Some(payload) => payload,
        None => return Ok(None),
    };

    let key: [u8; 32] = payload
        .try_into()
        .map_err(|_| BackendError::Crypto("master key length invalid".to_string()))?;
    let mut cache = cache.lock().expect("master key cache mutex poisoned");
    cache.insert(version, key);
    Ok(Some(key))
}

fn get_or_create_master_key<R: Runtime>(app: &AppHandle<R>, version: u32) -> Result<[u8; 32]> {
    if let Some(key) = read_master_key(app, version)? {
        return Ok(key);
    }

    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    let key_name = master_key_name(version);
    app.keyring()
        .set_secret(SERVICE_NAME, &key_name, &key)
        .map_err(|err| BackendError::Keyring(err.to_string()))?;

    let cache = MASTER_KEY_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    cache
        .lock()
        .expect("master key cache mutex poisoned")
        .insert(version, key);
    Ok(key)
}

fn derive_key(master_key: &[u8; 32], credential_id: &str) -> Result<[u8; 32]> {
    let hkdf = Hkdf::<Sha256>::new(Some(HKDF_SALT), master_key);
    let mut derived = [0u8; 32];
    hkdf.expand(credential_id.as_bytes(), &mut derived)
        .map_err(|_| BackendError::Crypto("key derivation failed".to_string()))?;
    Ok(derived)
}

fn encrypt_credentials<R: Runtime>(
    app: &AppHandle<R>,
    account: &AccountRecord,
    credentials: &serde_json::Value,
) -> Result<EncryptedCredentials> {
    let master_key = get_or_create_master_key(app, KEY_VERSION)?;
    let credential_id = credential_id(account);
    let key = derive_key(&master_key, &credential_id)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key)
        .map_err(|_| BackendError::Crypto("invalid encryption key".to_string()))?;

    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let payload = serde_json::to_vec(credentials)?;
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: &payload,
                aad: credential_id.as_bytes(),
            },
        )
        .map_err(|_| BackendError::Crypto("encryption failed".to_string()))?;

    Ok(EncryptedCredentials {
        alg: ALGORITHM.to_string(),
        key_version: KEY_VERSION,
        nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
}

#[allow(dead_code)]
fn decrypt_credentials<R: Runtime>(
    app: &AppHandle<R>,
    account: &AccountRecord,
    encrypted: &EncryptedCredentials,
) -> Result<serde_json::Value> {
    if encrypted.key_version > KEY_VERSION {
        return Err(BackendError::Crypto(format!(
            "unsupported key version: {}",
            encrypted.key_version
        )));
    }

    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(&encrypted.nonce)
        .map_err(|err| BackendError::Crypto(format!("invalid nonce: {err}")))?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&encrypted.ciphertext)
        .map_err(|err| BackendError::Crypto(format!("invalid ciphertext: {err}")))?;

    let master_key = read_master_key(app, encrypted.key_version)?.ok_or_else(|| {
        BackendError::Crypto(format!("master key v{} missing", encrypted.key_version))
    })?;

    let credential_id = credential_id(account);
    let key = derive_key(&master_key, &credential_id)?;

    let plaintext = match encrypted.alg.as_str() {
        "xchacha20poly1305" => {
            if nonce_bytes.len() != 24 {
                return Err(BackendError::Crypto("invalid nonce length".to_string()));
            }
            let cipher = XChaCha20Poly1305::new_from_slice(&key)
                .map_err(|_| BackendError::Crypto("invalid decryption key".to_string()))?;
            let nonce = XNonce::from_slice(&nonce_bytes);
            cipher
                .decrypt(
                    nonce,
                    Payload {
                        msg: &ciphertext,
                        aad: credential_id.as_bytes(),
                    },
                )
                .map_err(|_| BackendError::Crypto("decryption failed".to_string()))?
        }
        "chacha20poly1305" => {
            if nonce_bytes.len() != 12 {
                return Err(BackendError::Crypto("invalid nonce length".to_string()));
            }
            let cipher = ChaCha20Poly1305::new_from_slice(&key)
                .map_err(|_| BackendError::Crypto("invalid decryption key".to_string()))?;
            let nonce = Nonce::from_slice(&nonce_bytes);
            cipher
                .decrypt(
                    nonce,
                    Payload {
                        msg: &ciphertext,
                        aad: credential_id.as_bytes(),
                    },
                )
                .map_err(|_| BackendError::Crypto("decryption failed".to_string()))?
        }
        _ => {
            return Err(BackendError::Crypto(format!(
                "unsupported algorithm: {}",
                encrypted.alg
            )));
        }
    };

    let value = serde_json::from_slice(&plaintext)?;
    Ok(value)
}

pub fn set_account_credentials<R: Runtime>(
    app: &AppHandle<R>,
    store: &AccountStore,
    account_id: &str,
    credentials: &serde_json::Value,
) -> Result<()> {
    let account = store
        .get_account(account_id)?
        .ok_or(BackendError::AccountNotFound)?;
    let encrypted = encrypt_credentials(app, &account, credentials)?;
    store.set_credentials_blob(account_id, encrypted)
}

#[allow(dead_code)]
pub fn get_account_credentials<R: Runtime>(
    app: &AppHandle<R>,
    store: &AccountStore,
    account_id: &str,
) -> Result<Option<serde_json::Value>> {
    let account = store
        .get_account(account_id)?
        .ok_or(BackendError::AccountNotFound)?;

    let Some(encrypted) = store.get_credentials_blob(account_id)? else {
        return Ok(None);
    };

    let value = decrypt_credentials(app, &account, &encrypted)?;
    if encrypted.key_version != KEY_VERSION || encrypted.alg != ALGORITHM {
        let updated = encrypt_credentials(app, &account, &value)?;
        store.set_credentials_blob(account_id, updated)?;
    }

    Ok(Some(value))
}

pub fn has_account_credentials(store: &AccountStore, account_id: &str) -> Result<bool> {
    store.has_credentials_blob(account_id)
}

pub fn clear_account_credentials(store: &AccountStore, account_id: &str) -> Result<()> {
    store.delete_credentials_blob(account_id)
}
