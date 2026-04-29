use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tiny_http::{Header, ListenAddr, Response, Server};
use tokio::sync::oneshot;
use url::Url;

use crate::error::{BackendError, Result};

const CALLBACK_TIMEOUT_SECS: u64 = 180;

#[derive(Debug)]
pub struct OAuthCallback {
    pub code: String,
    pub state: String,
}

#[derive(Debug)]
pub struct PendingOAuth {
    pub plugin_id: String,
    pub strategy_id: String,
    pub flow_kind: String,
    pub account_id: String,
    pub verifier: String,
    pub redirect_uri: String,
    pub device_code: Option<String>,
    pub device_interval: Option<u64>,
    pub device_expires_at: Option<i64>,
    pub cancel_flag: Arc<AtomicBool>,
    receiver: Mutex<Option<oneshot::Receiver<Result<OAuthCallback>>>>,
}

impl PendingOAuth {
    pub fn new(
        plugin_id: String,
        strategy_id: String,
        flow_kind: String,
        account_id: String,
        verifier: String,
        redirect_uri: String,
        cancel_flag: Arc<AtomicBool>,
        receiver: oneshot::Receiver<Result<OAuthCallback>>,
    ) -> Self {
        Self {
            plugin_id,
            strategy_id,
            flow_kind,
            account_id,
            verifier,
            redirect_uri,
            device_code: None,
            device_interval: None,
            device_expires_at: None,
            cancel_flag,
            receiver: Mutex::new(Some(receiver)),
        }
    }

    pub fn new_device_flow(
        plugin_id: String,
        strategy_id: String,
        account_id: String,
        device_code: String,
        device_interval: u64,
        device_expires_at: i64,
    ) -> Self {
        Self {
            plugin_id,
            strategy_id,
            flow_kind: "deviceCode".to_string(),
            account_id,
            verifier: String::new(),
            redirect_uri: String::new(),
            device_code: Some(device_code),
            device_interval: Some(device_interval),
            device_expires_at: Some(device_expires_at),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            receiver: Mutex::new(None),
        }
    }

    pub fn new_browser_cookie_flow(
        plugin_id: String,
        strategy_id: String,
        account_id: String,
        window_label: String,
        expires_at: i64,
    ) -> Self {
        Self {
            plugin_id,
            strategy_id,
            flow_kind: "browserCookie".to_string(),
            account_id,
            verifier: String::new(),
            redirect_uri: String::new(),
            device_code: Some(window_label),
            device_interval: Some(1),
            device_expires_at: Some(expires_at),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            receiver: Mutex::new(None),
        }
    }

    pub fn take_receiver(&self) -> Option<oneshot::Receiver<Result<OAuthCallback>>> {
        let mut receiver = self.receiver.lock().expect("oauth receiver mutex poisoned");
        receiver.take()
    }
}

#[derive(Debug, Default)]
pub struct AuthState {
    flows: Mutex<HashMap<String, Arc<PendingOAuth>>>,
}

impl AuthState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, request_id: String, flow: PendingOAuth) {
        let mut flows = self.flows.lock().expect("auth state mutex poisoned");
        flows.insert(request_id, Arc::new(flow));
    }

    pub fn get(&self, request_id: &str) -> Option<Arc<PendingOAuth>> {
        let flows = self.flows.lock().expect("auth state mutex poisoned");
        flows.get(request_id).cloned()
    }

    pub fn remove(&self, request_id: &str) -> Option<Arc<PendingOAuth>> {
        let mut flows = self.flows.lock().expect("auth state mutex poisoned");
        flows.remove(request_id)
    }

    pub fn cancel(&self, request_id: &str) -> bool {
        let mut flows = self.flows.lock().expect("auth state mutex poisoned");
        if let Some(flow) = flows.remove(request_id) {
            flow.cancel_flag.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }
}

pub fn start_local_callback_listener_with_options(
    expected_state: String,
    callback_path: &str,
    port: Option<u16>,
) -> Result<(
    u16,
    oneshot::Receiver<Result<OAuthCallback>>,
    Arc<AtomicBool>,
)> {
    let callback_path = if callback_path.starts_with('/') {
        callback_path.to_string()
    } else {
        format!("/{callback_path}")
    };

    let bind_addr = match port {
        Some(port) => format!("127.0.0.1:{port}"),
        None => "127.0.0.1:0".to_string(),
    };
    let server = Server::http(&bind_addr)
        .map_err(|err| BackendError::Plugin(format!("OAuth listener failed: {err}")))?;
    let port = match server.server_addr() {
        ListenAddr::IP(addr) => addr.port(),
        _ => {
            return Err(BackendError::Plugin(
                "OAuth listener address unavailable".to_string(),
            ));
        }
    };

    let (sender, receiver) = oneshot::channel();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let cancel_flag_thread = cancel_flag.clone();
    let callback_path_thread = callback_path.clone();

    thread::spawn(move || {
        let header =
            Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap();
        let started_at = Instant::now();
        let poll_interval = Duration::from_millis(200);

        loop {
            if cancel_flag_thread.load(Ordering::SeqCst) {
                let _ = sender.send(Err(BackendError::Plugin("OAuth cancelled".to_string())));
                return;
            }

            if started_at.elapsed() >= Duration::from_secs(CALLBACK_TIMEOUT_SECS) {
                let _ = sender.send(Err(BackendError::Plugin(
                    "OAuth callback timed out".to_string(),
                )));
                return;
            }

            let request = match server.recv_timeout(poll_interval) {
                Ok(Some(request)) => request,
                Ok(None) => continue,
                Err(err) => {
                    let _ = sender.send(Err(BackendError::Plugin(format!(
                        "OAuth callback failed: {err}"
                    ))));
                    return;
                }
            };

            let url = format!("http://localhost{}", request.url());
            let parsed = Url::parse(&url)
                .map_err(|err| BackendError::Plugin(format!("OAuth callback URL invalid: {err}")));

            let result = match parsed {
                Ok(parsed) => {
                    if parsed.path() != callback_path_thread {
                        Err(BackendError::Plugin(
                            "OAuth callback path mismatch".to_string(),
                        ))
                    } else {
                        let mut code: Option<String> = None;
                        let mut state: Option<String> = None;
                        for (key, value) in parsed.query_pairs() {
                            match key.as_ref() {
                                "code" => code = Some(value.to_string()),
                                "state" => state = Some(value.to_string()),
                                _ => {}
                            }
                        }

                        let code = match code {
                            Some(code) => Ok(code),
                            None => Err(BackendError::Plugin(
                                "OAuth callback missing code".to_string(),
                            )),
                        };

                        match code {
                            Ok(code) => {
                                let state = state.unwrap_or_default();
                                if !state.is_empty() && state != expected_state {
                                    Err(BackendError::Plugin(
                                        "OAuth callback state mismatch".to_string(),
                                    ))
                                } else {
                                    Ok(OAuthCallback { code, state })
                                }
                            }
                            Err(err) => Err(err),
                        }
                    }
                }
                Err(err) => Err(err),
            };

            let response = match &result {
                Ok(_) => Response::from_string(
                    "<html><body><h2>Authentication complete.</h2><p>You can close this tab.</p></body></html>",
                )
                .with_status_code(200),
                Err(err) => Response::from_string(format!(
                    "<html><body><h2>Authentication failed.</h2><p>{}</p></body></html>",
                    err
                ))
                .with_status_code(400),
            }
            .with_header(header);

            let _ = request.respond(response);
            let _ = sender.send(result);
            return;
        }
    });

    Ok((port, receiver, cancel_flag))
}
