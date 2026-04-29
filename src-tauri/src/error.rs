use thiserror::Error;

#[derive(Debug, Error)]
pub enum BackendError {
    #[error("path error: {0}")]
    Path(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("store error: {0}")]
    Store(String),
    #[error("keyring error: {0}")]
    Keyring(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("plugin error: {0}")]
    Plugin(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("account not found")]
    AccountNotFound,
}

pub type Result<T> = std::result::Result<T, BackendError>;
