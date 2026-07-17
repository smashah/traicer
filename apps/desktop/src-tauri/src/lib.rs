use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{
    pkcs8::{DecodePrivateKey, EncodePrivateKey},
    Signer, SigningKey,
};
use rand_core::{OsRng, RngCore};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    path::BaseDirectory,
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_dialog::DialogExt;
use zeroize::{Zeroize, Zeroizing};

const VAULT_SERVICE: &str = "market.traice.traicer";
const CONFIG_KEY: &str = "capture-config-v1";
const MARKETPLACE_KEY: &str = "marketplace-credential";
const SIGNING_KEY: &str = "device-signing-private-key";
const STORAGE_KEY: &str = "storage-secret-access-key";
const WRAPPING_KEY: &str = "trace-wrapping-key";
const PROXY_CA_CERT: &str = "proxy-ca-certificate";
const PROXY_CA_KEY: &str = "proxy-ca-private-key";
const PROXY_LEAF_CERT: &str = "proxy-leaf-certificate";
const PROXY_LEAF_KEY: &str = "proxy-leaf-private-key";
const PROXY_TRUST_JOURNAL: &str = "proxy-trust-journal-v1";

struct DaemonProcess {
    child: Child,
    control_port: u16,
    control_token: String,
    gateway_port: Option<u16>,
    proxy_port: Option<u16>,
}

impl Drop for DaemonProcess {
    fn drop(&mut self) {
        self.control_token.zeroize();
    }
}

#[derive(Default)]
struct ManagedDaemon {
    process: Option<DaemonProcess>,
    recent_starts: VecDeque<Instant>,
}

#[derive(Default)]
struct DaemonState(Mutex<ManagedDaemon>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatus {
    capture_status: String,
    control_port: Option<u16>,
    gateway_port: Option<u16>,
    gateway_url: Option<String>,
    proxy_url: Option<String>,
    health: Option<serde_json::Value>,
    running: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    available: bool,
    notes: Option<String>,
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyTrustStatus {
    installed: bool,
    platform: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyLine {
    control_port: u16,
    gateway_port: Option<u16>,
    proxy_port: Option<u16>,
    protocol_version: u8,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    adapter_capability: String,
    bucket: String,
    bucket_alias: String,
    capture_policy_id: String,
    client: String,
    device_id: String,
    endpoint: String,
    marketplace_api: String,
    #[serde(default)]
    marketplace_connected: bool,
    policy_allowed_paths: Vec<String>,
    policy_version: String,
    prefix: String,
    provider: String,
    public_key: String,
    redaction_profile: String,
    region: String,
    signer_key_id: String,
    storage_access_key_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeConfig {
    bucket: String,
    client: String,
    device_id: String,
    endpoint: String,
    marketplace_api: String,
    marketplace_connected: bool,
    prefix: String,
    provider: String,
    public_key: String,
    region: String,
    signer_key_id: String,
}

impl From<&StoredConfig> for SafeConfig {
    fn from(config: &StoredConfig) -> Self {
        Self {
            bucket: config.bucket.clone(),
            client: config.client.clone(),
            device_id: config.device_id.clone(),
            endpoint: config.endpoint.clone(),
            marketplace_api: config.marketplace_api.clone(),
            marketplace_connected: config.marketplace_connected,
            prefix: config.prefix.clone(),
            provider: config.provider.clone(),
            public_key: config.public_key.clone(),
            region: config.region.clone(),
            signer_key_id: config.signer_key_id.clone(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigureInput {
    bucket: String,
    client: String,
    endpoint: String,
    marketplace_api: String,
    marketplace_credential: String,
    prefix: String,
    provider: String,
    region: String,
    storage_access_key_id: String,
    storage_secret: String,
}

impl Drop for ConfigureInput {
    fn drop(&mut self) {
        self.marketplace_credential.zeroize();
        self.storage_access_key_id.zeroize();
        self.storage_secret.zeroize();
    }
}

#[derive(Deserialize)]
struct DeviceResponseData {
    id: String,
}

#[derive(Deserialize)]
struct DeviceResponse {
    data: DeviceResponseData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturePolicyResponseData {
    id: String,
    policy_version: u64,
}

#[derive(Deserialize)]
struct CapturePolicyResponse {
    data: CapturePolicyResponseData,
}

fn vault_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(VAULT_SERVICE, key).map_err(|_| "Credential vault unavailable".into())
}

fn vault_write(key: &str, value: &str) -> Result<(), String> {
    vault_entry(key)?
        .set_password(value)
        .map_err(|_| "Credential vault write failed".into())
}

fn vault_read(key: &str) -> Result<String, String> {
    vault_entry(key)?
        .get_password()
        .map_err(|_| "Required credential is missing from the operating-system vault".into())
}

fn random_base64(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut value);
    let encoded = URL_SAFE_NO_PAD.encode(&value);
    value.zeroize();
    encoded
}

fn ensure_proxy_certificates() -> Result<(), String> {
    if [PROXY_CA_CERT, PROXY_CA_KEY, PROXY_LEAF_CERT, PROXY_LEAF_KEY]
        .iter()
        .all(|key| vault_read(key).is_ok())
    {
        return Ok(());
    }
    let mut ca_params = CertificateParams::new(Vec::new())
        .map_err(|_| "Proxy CA parameters could not be generated")?;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "Traicer Local Capture CA");
    ca_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
    ];
    let ca_key = KeyPair::generate().map_err(|_| "Proxy CA key generation failed")?;
    let ca_cert = ca_params
        .self_signed(&ca_key)
        .map_err(|_| "Proxy CA certificate generation failed")?;

    let mut leaf_params = CertificateParams::new(vec![
        "api.openai.com".to_owned(),
        "api.anthropic.com".to_owned(),
    ])
    .map_err(|_| "Proxy leaf parameters could not be generated")?;
    leaf_params
        .distinguished_name
        .push(DnType::CommonName, "Traicer Selected Provider Endpoints");
    leaf_params.use_authority_key_identifier_extension = true;
    leaf_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let leaf_key = KeyPair::generate().map_err(|_| "Proxy leaf key generation failed")?;
    let leaf_cert = leaf_params
        .signed_by(&leaf_key, &ca_cert, &ca_key)
        .map_err(|_| "Proxy leaf certificate generation failed")?;

    vault_write(PROXY_CA_CERT, &ca_cert.pem())?;
    vault_write(PROXY_CA_KEY, &ca_key.serialize_pem())?;
    vault_write(PROXY_LEAF_CERT, &leaf_cert.pem())?;
    vault_write(PROXY_LEAF_KEY, &leaf_key.serialize_pem())?;
    Ok(())
}

fn proxy_trust_status_inner() -> ProxyTrustStatus {
    ProxyTrustStatus {
        installed: vault_entry(PROXY_TRUST_JOURNAL)
            .ok()
            .and_then(|entry| entry.get_password().ok())
            .is_some(),
        platform: std::env::consts::OS.to_owned(),
    }
}

fn with_temporary_ca<T>(
    operation: impl FnOnce(&PathBuf) -> Result<T, String>,
) -> Result<T, String> {
    let path = std::env::temp_dir().join(format!("traicer-ca-{}.pem", uuid::Uuid::new_v4()));
    let mut certificate = vault_read(PROXY_CA_CERT)?;
    std::fs::write(&path, certificate.as_bytes())
        .map_err(|_| "Temporary CA certificate could not be written")?;
    certificate.zeroize();
    let result = operation(&path);
    let _ = std::fs::remove_file(&path);
    result
}

#[tauri::command]
fn proxy_trust_status() -> ProxyTrustStatus {
    proxy_trust_status_inner()
}

#[tauri::command]
fn proxy_trust_install() -> Result<ProxyTrustStatus, String> {
    ensure_proxy_certificates()?;
    with_temporary_ca(|path| {
        #[cfg(target_os = "macos")]
        let status = {
            let home = std::env::var("HOME").map_err(|_| "User home directory unavailable")?;
            Command::new("security")
                .args(["add-trusted-cert", "-r", "trustRoot", "-k"])
                .arg(PathBuf::from(home).join("Library/Keychains/login.keychain-db"))
                .arg(path)
                .status()
        };
        #[cfg(target_os = "windows")]
        let status = Command::new("certutil")
            .args(["-user", "-addstore", "Root"])
            .arg(path)
            .status();
        #[cfg(target_os = "linux")]
        let status = {
            let home = std::env::var("HOME").map_err(|_| "User home directory unavailable")?;
            Command::new("certutil")
                .args(["-A", "-d"])
                .arg(format!("sql:{home}/.pki/nssdb"))
                .args(["-n", "Traicer Local Capture CA", "-t", "C,,", "-i"])
                .arg(path)
                .status()
        };
        match status {
            Ok(value) if value.success() => Ok(()),
            _ => Err(
                "The current-user certificate store rejected the Traicer CA installation".into(),
            ),
        }
    })?;
    vault_write(PROXY_TRUST_JOURNAL, std::env::consts::OS)?;
    Ok(proxy_trust_status_inner())
}

#[tauri::command]
fn proxy_trust_remove(state: State<'_, DaemonState>) -> Result<ProxyTrustStatus, String> {
    if state
        .0
        .lock()
        .map_err(|_| "Daemon state lock poisoned")?
        .process
        .is_some()
    {
        return Err("Stop the Traicer daemon before removing proxy CA trust".into());
    }
    #[cfg(target_os = "macos")]
    let status = {
        let home = std::env::var("HOME").map_err(|_| "User home directory unavailable")?;
        Command::new("security")
            .args(["delete-certificate", "-c", "Traicer Local Capture CA"])
            .arg(PathBuf::from(home).join("Library/Keychains/login.keychain-db"))
            .status()
    };
    #[cfg(target_os = "windows")]
    let status = Command::new("certutil")
        .args(["-user", "-delstore", "Root", "Traicer Local Capture CA"])
        .status();
    #[cfg(target_os = "linux")]
    let status = {
        let home = std::env::var("HOME").map_err(|_| "User home directory unavailable")?;
        Command::new("certutil")
            .args(["-D", "-d"])
            .arg(format!("sql:{home}/.pki/nssdb"))
            .args(["-n", "Traicer Local Capture CA"])
            .status()
    };
    if !matches!(status, Ok(value) if value.success()) {
        return Err("The current-user certificate store rejected Traicer CA removal".into());
    }
    if let Ok(entry) = vault_entry(PROXY_TRUST_JOURNAL) {
        let _ = entry.delete_credential();
    }
    Ok(proxy_trust_status_inner())
}

fn canonical_json(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::Null => Ok("null".into()),
        serde_json::Value::Bool(value) => Ok(value.to_string()),
        serde_json::Value::Number(value) => Ok(value.to_string()),
        serde_json::Value::String(value) => {
            serde_json::to_string(value).map_err(|_| "Canonical JSON encoding failed".into())
        }
        serde_json::Value::Array(values) => {
            let values = values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", values.join(",")))
        }
        serde_json::Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let fields = keys
                .into_iter()
                .map(|key| {
                    let encoded_key = serde_json::to_string(key)
                        .map_err(|_| "Canonical JSON key encoding failed".to_string())?;
                    let encoded_value = canonical_json(&values[key])?;
                    Ok(format!("{encoded_key}:{encoded_value}"))
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(format!("{{{}}}", fields.join(",")))
        }
    }
}

fn record_daemon_start(starts: &mut VecDeque<Instant>, now: Instant) -> Result<(), String> {
    let restart_window = Duration::from_secs(5 * 60);
    while starts
        .front()
        .is_some_and(|started| now.duration_since(*started) > restart_window)
    {
        starts.pop_front();
    }
    if starts.len() >= 3 {
        return Err("Daemon restart budget exhausted; wait five minutes before retrying".into());
    }
    starts.push_back(now);
    Ok(())
}

fn validate_configuration(input: &ConfigureInput) -> Result<(), String> {
    if !matches!(input.provider.as_str(), "anthropic" | "openai") {
        return Err("Unsupported provider".into());
    }
    if input.storage_secret.is_empty()
        || input.storage_access_key_id.is_empty()
        || input.bucket.is_empty()
    {
        return Err("Seller storage credentials are required".into());
    }
    for value in [&input.marketplace_api, &input.endpoint] {
        let url = reqwest::Url::parse(value).map_err(|_| "A configured endpoint is invalid")?;
        if url.scheme() != "https" && !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
            return Err("Configured endpoints must use HTTPS outside loopback development".into());
        }
    }
    Ok(())
}

fn restore_existing_storage_defaults(
    input: &mut ConfigureInput,
    config: &StoredConfig,
    stored_secret: Option<String>,
) -> Result<(), String> {
    if input.storage_access_key_id.trim().is_empty() {
        input.storage_access_key_id = config.storage_access_key_id.clone();
    }
    if input.storage_secret.is_empty() {
        input.storage_secret =
            stored_secret.ok_or("Stored seller storage credential is unavailable")?;
    }
    Ok(())
}

struct ConfigurationIdentity {
    adapter_capability: String,
    private_key: String,
    public_key: String,
    signer_key_id: String,
    signing: SigningKey,
    wrapping_key: String,
}

impl Drop for ConfigurationIdentity {
    fn drop(&mut self) {
        self.private_key.zeroize();
        self.wrapping_key.zeroize();
    }
}

fn create_configuration_identity() -> Result<ConfigurationIdentity, String> {
    let signing = SigningKey::generate(&mut OsRng);
    let public_bytes = signing.verifying_key().to_bytes();
    let private_document = signing
        .to_pkcs8_der()
        .map_err(|_| "Device signing key generation failed")?;
    Ok(ConfigurationIdentity {
        adapter_capability: random_base64(24),
        private_key: URL_SAFE_NO_PAD.encode(private_document.as_bytes()),
        public_key: URL_SAFE_NO_PAD.encode(public_bytes),
        signer_key_id: hex::encode(Sha256::digest(public_bytes))[..32].to_owned(),
        signing,
        wrapping_key: random_base64(32),
    })
}

fn restore_configuration_identity(
    config: &StoredConfig,
    private_key: String,
    wrapping_key: String,
) -> Result<ConfigurationIdentity, String> {
    let private_key = Zeroizing::new(private_key);
    let wrapping_key = Zeroizing::new(wrapping_key);
    let private_bytes = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(private_key.as_str())
            .map_err(|_| "Stored signing identity is incompatible")?,
    );
    let signing = SigningKey::from_pkcs8_der(&private_bytes)
        .map_err(|_| "Stored signing identity is incompatible")?;
    let public_bytes = signing.verifying_key().to_bytes();
    let public_key = URL_SAFE_NO_PAD.encode(public_bytes);
    let signer_key_id = hex::encode(Sha256::digest(public_bytes))[..32].to_owned();
    if public_key != config.public_key || signer_key_id != config.signer_key_id {
        return Err("Stored signing identity does not match the configured device".into());
    }
    Ok(ConfigurationIdentity {
        adapter_capability: config.adapter_capability.clone(),
        private_key: private_key.to_string(),
        public_key,
        signer_key_id,
        signing,
        wrapping_key: wrapping_key.to_string(),
    })
}

#[tauri::command]
async fn configure_device(mut input: ConfigureInput) -> Result<SafeConfig, String> {
    let existing_config = vault_entry(CONFIG_KEY)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|mut value| {
            let config = serde_json::from_str::<StoredConfig>(&value).ok();
            value.zeroize();
            config
        });
    if let Some(config) = existing_config.as_ref() {
        let stored_secret = if input.storage_secret.is_empty() {
            Some(vault_read(STORAGE_KEY)?)
        } else {
            None
        };
        restore_existing_storage_defaults(&mut input, config, stored_secret)?;
    }
    validate_configuration(&input)?;
    ensure_proxy_certificates()?;
    let existing_device_id = existing_config
        .as_ref()
        .map(|config| config.device_id.clone());
    let replaces_device_id = existing_config
        .as_ref()
        .filter(|config| config.marketplace_connected)
        .map(|config| config.device_id.clone());
    let mut identity = if let Some(config) = existing_config.as_ref() {
        restore_configuration_identity(config, vault_read(SIGNING_KEY)?, vault_read(WRAPPING_KEY)?)?
    } else {
        create_configuration_identity()?
    };
    let adapters = if input.provider == "anthropic" {
        vec!["anthropic-messages/1"]
    } else {
        vec!["openai-responses/1", "openai-chat-completions/1"]
    };
    let (endpoint_allowlist, policy_allowed_paths) = if input.provider == "anthropic" {
        (
            vec!["https://api.anthropic.com/v1/messages"],
            vec!["/v1/messages"],
        )
    } else {
        (
            vec![
                "https://api.openai.com/v1/responses",
                "https://api.openai.com/v1/chat/completions",
            ],
            vec!["/v1/responses", "/v1/chat/completions"],
        )
    };
    let marketplace_credential =
        Zeroizing::new(if input.marketplace_credential.trim().is_empty() {
            vault_read(MARKETPLACE_KEY).unwrap_or_default()
        } else {
            input.marketplace_credential.clone()
        });
    let marketplace_connected = !marketplace_credential.trim().is_empty();
    let already_connected = existing_config
        .as_ref()
        .is_some_and(|config| config.marketplace_connected);
    let (device_id, capture_policy_id, policy_version) =
        if marketplace_connected && already_connected {
            let existing = existing_config
                .as_ref()
                .ok_or("Existing account configuration is unavailable")?;
            (
                existing.device_id.clone(),
                existing.capture_policy_id.clone(),
                existing.policy_version.clone(),
            )
        } else if marketplace_connected {
            let response = reqwest::Client::new()
                .post(format!(
                    "{}/api/v1/traicer/devices",
                    input.marketplace_api.trim_end_matches('/')
                ))
                .bearer_auth(marketplace_credential.as_str())
                .json(&serde_json::json!({
                    "adapters": adapters,
                    "clientVersion": env!("CARGO_PKG_VERSION"),
                    "name": format!("{} on {}", input.client, std::env::consts::OS),
                    "operatingSystemClass": std::env::consts::OS,
                    "publicKey": identity.public_key,
                    "publicKeyFingerprint": identity.signer_key_id,
                    "replacesDeviceId": replaces_device_id.clone(),
                }))
                .send()
                .await
                .map_err(|_| "Marketplace device registration was unavailable")?;
            if !response.status().is_success() {
                return Err("Marketplace rejected device registration".into());
            }
            let registered: DeviceResponse = response
                .json()
                .await
                .map_err(|_| "Marketplace returned an invalid device registration")?;
            let mut policy_payload = serde_json::json!({
                "deviceId": registered.data.id,
                "eligibilityRules": {
                    "unsupportedEndpoints": "deny",
                    "unsupportedRepositories": "deny"
                },
                "endpointAllowlist": endpoint_allowlist,
                "redactionProfile": "strict-default",
                "repositoryRules": {
                    "declaration": "deny by default; capture only explicitly configured clients"
                },
                "signatureAlgorithm": "Ed25519",
                "status": "active"
            });
            let policy_bytes = canonical_json(&policy_payload)?.into_bytes();
            let signature = URL_SAFE_NO_PAD.encode(identity.signing.sign(&policy_bytes).to_bytes());
            policy_payload
                .as_object_mut()
                .ok_or("Capture policy payload was invalid")?
                .insert("signature".into(), serde_json::Value::String(signature));
            let policy_response = reqwest::Client::new()
                .post(format!(
                    "{}/api/v1/traicer/capture-policy",
                    input.marketplace_api.trim_end_matches('/')
                ))
                .bearer_auth(marketplace_credential.as_str())
                .json(&policy_payload)
                .send()
                .await
                .map_err(|_| "Marketplace capture-policy activation was unavailable")?;
            if !policy_response.status().is_success() {
                return Err("Marketplace rejected the signed capture policy".into());
            }
            let activated: CapturePolicyResponse = policy_response
                .json()
                .await
                .map_err(|_| "Marketplace returned an invalid capture policy")?;
            (
                registered.data.id,
                activated.data.id,
                format!("policy/{}", activated.data.policy_version),
            )
        } else {
            (
                existing_device_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                "strict-default".to_owned(),
                "local/1".to_owned(),
            )
        };
    let bucket_digest = hex::encode(Sha256::digest(input.bucket.as_bytes()));
    let config = StoredConfig {
        adapter_capability: identity.adapter_capability.clone(),
        bucket: input.bucket.clone(),
        bucket_alias: format!("seller-{}", &bucket_digest[..12]),
        capture_policy_id,
        client: input.client.clone(),
        device_id,
        endpoint: input.endpoint.clone(),
        marketplace_api: input.marketplace_api.clone(),
        marketplace_connected,
        policy_allowed_paths: policy_allowed_paths
            .into_iter()
            .map(str::to_owned)
            .collect(),
        policy_version,
        prefix: input.prefix.clone(),
        provider: input.provider.clone(),
        public_key: identity.public_key.clone(),
        redaction_profile: "strict-default".into(),
        region: input.region.clone(),
        signer_key_id: identity.signer_key_id.clone(),
        storage_access_key_id: input.storage_access_key_id.clone(),
    };
    let config_json = Zeroizing::new(
        serde_json::to_string(&config).map_err(|_| "Configuration serialization failed")?,
    );
    vault_write(CONFIG_KEY, &config_json)?;
    if marketplace_connected {
        vault_write(MARKETPLACE_KEY, &marketplace_credential)?;
    } else if let Ok(entry) = vault_entry(MARKETPLACE_KEY) {
        let _ = entry.delete_credential();
    }
    vault_write(SIGNING_KEY, &identity.private_key)?;
    vault_write(STORAGE_KEY, &input.storage_secret)?;
    vault_write(WRAPPING_KEY, &identity.wrapping_key)?;
    identity.private_key.zeroize();
    identity.wrapping_key.zeroize();
    input.marketplace_credential.zeroize();
    input.storage_access_key_id.zeroize();
    input.storage_secret.zeroize();
    Ok(SafeConfig::from(&config))
}

#[tauri::command]
fn load_configuration() -> Result<Option<SafeConfig>, String> {
    match vault_entry(CONFIG_KEY)?.get_password() {
        Ok(value) => {
            let value = Zeroizing::new(value);
            let config: StoredConfig =
                serde_json::from_str(&value).map_err(|_| "Stored configuration is incompatible")?;
            Ok(Some(SafeConfig::from(&config)))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Credential vault read failed".into()),
    }
}

fn daemon_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("TRAICER_DAEMON_PATH") {
        return Ok(PathBuf::from(path));
    }
    let file = if cfg!(windows) {
        "traicer-daemon.exe"
    } else {
        "traicer-daemon"
    };
    if let Ok(current) = std::env::current_exe() {
        if let Some(directory) = current.parent() {
            let adjacent = directory.join(file);
            if adjacent.is_file() {
                return Ok(adjacent);
            }
        }
    }
    app.path()
        .resolve(file, BaseDirectory::Resource)
        .map_err(|_| "Bundled Traicer daemon could not be resolved".into())
}

fn listener_url(port: Option<u16>) -> Option<String> {
    Some(format!("http://127.0.0.1:{}", port?))
}

fn build_bootstrap() -> Result<(String, String), String> {
    ensure_proxy_certificates()?;
    let config_json = Zeroizing::new(vault_read(CONFIG_KEY)?);
    let config: StoredConfig =
        serde_json::from_str(&config_json).map_err(|_| "Stored configuration is incompatible")?;
    let control_token = Zeroizing::new(random_base64(32));
    let marketplace_credential = vault_read(MARKETPLACE_KEY).ok().map(Zeroizing::new);
    let signing_private_key = Zeroizing::new(vault_read(SIGNING_KEY)?);
    let storage_secret = Zeroizing::new(vault_read(STORAGE_KEY)?);
    let vault_key = Zeroizing::new(vault_read(WRAPPING_KEY)?);
    let proxy_certificate = Zeroizing::new(vault_read(PROXY_LEAF_CERT)?);
    let proxy_private_key = Zeroizing::new(vault_read(PROXY_LEAF_KEY)?);
    let upstream_origin = if config.provider == "anthropic" {
        "https://api.anthropic.com"
    } else {
        "https://api.openai.com"
    };
    let mut marketplace = serde_json::json!({ "apiBaseUrl": config.marketplace_api });
    if let Some(credential) = marketplace_credential.as_ref() {
        marketplace
            .as_object_mut()
            .ok_or("Marketplace bootstrap was invalid")?
            .insert(
                "credential".into(),
                serde_json::Value::String(credential.to_string()),
            );
    }
    let bootstrap = serde_json::to_string(&serde_json::json!({
        "capture": {
            "adapterCapability": config.adapter_capability,
            "bucketAlias": config.bucket_alias,
            "client": config.client,
            "deviceId": config.device_id,
            "marketplace": marketplace,
            "policy": {
                "allowedPaths": config.policy_allowed_paths,
                "capturePolicyId": config.capture_policy_id,
                "pipelineVersion": "pipeline/1",
                "policyVersion": config.policy_version,
                "redactionProfile": config.redaction_profile
            },
            "proxyTls": {
                "certificatePem": proxy_certificate.as_str(),
                "privateKeyPem": proxy_private_key.as_str(),
                "targetHosts": ["api.openai.com", "api.anthropic.com"]
            },
            "signerKeyId": config.signer_key_id,
            "signingPrivateKey": signing_private_key.as_str(),
            "storage": {
                "accessKeyId": config.storage_access_key_id,
                "addressingStyle": "path",
                "bucket": config.bucket,
                "endpoint": config.endpoint,
                "prefix": config.prefix,
                "secretAccessKey": storage_secret.as_str(),
                "signingRegion": config.region,
                "storageCapabilityProfileId": "s3-full-readback-v1"
            },
            "upstreamOrigin": upstream_origin
        },
        "controlToken": control_token.as_str(),
        "protocolVersion": 1,
        "vaultKey": vault_key.as_str()
    }))
    .map_err(|_| "Daemon bootstrap generation failed")?;
    Ok((bootstrap, control_token.to_string()))
}

#[tauri::command]
fn daemon_start(app: AppHandle, state: State<'_, DaemonState>) -> Result<DaemonStatus, String> {
    let mut managed = state.0.lock().map_err(|_| "Daemon state unavailable")?;
    if let Some(process) = managed.process.as_mut() {
        if process
            .child
            .try_wait()
            .map_err(|_| "Daemon status failed")?
            .is_none()
        {
            return Ok(DaemonStatus {
                capture_status: "starting".into(),
                control_port: Some(process.control_port),
                gateway_port: process.gateway_port,
                gateway_url: listener_url(process.gateway_port),
                proxy_url: listener_url(process.proxy_port),
                health: None,
                running: true,
            });
        }
        managed.process = None;
    }
    record_daemon_start(&mut managed.recent_starts, Instant::now())?;
    let (bootstrap, control_token) = build_bootstrap()?;
    let bootstrap = Zeroizing::new(bootstrap);
    let control_token = Zeroizing::new(control_token);
    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| "Desktop cache directory is unavailable")?
        .join("decrypted");
    let runtime_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Desktop runtime directory is unavailable")?
        .join("runtime");
    let runtime_directory_created = !runtime_directory.exists();
    std::fs::create_dir_all(&runtime_directory)
        .map_err(|_| "Desktop runtime directory could not be created")?;
    #[cfg(unix)]
    if runtime_directory_created {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&runtime_directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Desktop runtime directory permissions could not be secured")?;
    }
    let mut command = Command::new(daemon_binary(&app)?);
    command.env("TRAICER_PLAINTEXT_CACHE_DIRECTORY", cache_directory);
    command.current_dir(runtime_directory);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Traicer daemon could not be started")?;
    if let Some(mut stdin) = child.stdin.take() {
        if stdin
            .write_all(bootstrap.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .is_err()
        {
            let _ = child.kill();
            return Err("Daemon bootstrap transfer failed".into());
        }
    }
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Err("Daemon ready channel unavailable".into());
    };
    let mut line = String::new();
    if BufReader::new(stdout).read_line(&mut line).is_err() {
        let _ = child.kill();
        return Err("Daemon ready message failed".into());
    }
    let ready: ReadyLine = match serde_json::from_str(&line) {
        Ok(ready) => ready,
        Err(_) => {
            line.zeroize();
            let _ = child.kill();
            return Err("Daemon ready message was invalid".into());
        }
    };
    line.zeroize();
    if ready.kind != "ready" || ready.protocol_version != 1 {
        let _ = child.kill();
        return Err("Daemon protocol version is incompatible".into());
    }
    managed.process = Some(DaemonProcess {
        child,
        control_port: ready.control_port,
        control_token: control_token.to_string(),
        gateway_port: ready.gateway_port,
        proxy_port: ready.proxy_port,
    });
    Ok(DaemonStatus {
        capture_status: "healthy".into(),
        control_port: Some(ready.control_port),
        gateway_port: ready.gateway_port,
        gateway_url: listener_url(ready.gateway_port),
        proxy_url: listener_url(ready.proxy_port),
        health: None,
        running: true,
    })
}

async fn control_request(
    state: &DaemonState,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let (port, token) = {
        let managed = state.0.lock().map_err(|_| "Daemon state unavailable")?;
        let process = managed.process.as_ref().ok_or("Daemon is not running")?;
        (process.control_port, process.control_token.clone())
    };
    let client = reqwest::Client::new();
    let mut request = client
        .request(method, format!("http://127.0.0.1:{port}{path}"))
        .bearer_auth(token);
    if let Some(value) = body {
        request = request.json(&value);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Local daemon did not respond")?;
    if !response.status().is_success() {
        return Err("Local daemon rejected the control request".into());
    }
    response
        .json()
        .await
        .map_err(|_| "Local daemon returned invalid status".into())
}

#[tauri::command]
async fn daemon_health(state: State<'_, DaemonState>) -> Result<DaemonStatus, String> {
    let (control_port, gateway_port, proxy_port, running) = {
        let mut managed = state.0.lock().map_err(|_| "Daemon state unavailable")?;
        match managed.process.as_mut() {
            Some(process) => {
                let running = process
                    .child
                    .try_wait()
                    .map_err(|_| "Daemon status failed")?
                    .is_none();
                (
                    Some(process.control_port),
                    process.gateway_port,
                    process.proxy_port,
                    running,
                )
            }
            None => (None, None, None, false),
        }
    };
    if !running {
        return Ok(DaemonStatus {
            capture_status: "stopped".into(),
            control_port,
            gateway_port,
            gateway_url: None,
            proxy_url: None,
            health: None,
            running: false,
        });
    }
    let health = control_request(&state, reqwest::Method::GET, "/v1/health", None).await?;
    let capture_status = health
        .get("captureStatus")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("degraded")
        .to_owned();
    Ok(DaemonStatus {
        capture_status,
        control_port,
        gateway_port,
        gateway_url: listener_url(gateway_port),
        proxy_url: listener_url(proxy_port),
        health: Some(health),
        running: true,
    })
}

#[tauri::command]
async fn daemon_pause(
    state: State<'_, DaemonState>,
    reason: String,
) -> Result<serde_json::Value, String> {
    if !["user", "privacy", "maintenance"].contains(&reason.as_str()) {
        return Err("Invalid pause reason".into());
    }
    control_request(
        &state,
        reqwest::Method::POST,
        "/v1/control/pause",
        Some(serde_json::json!({ "reason": reason, "scope": "all" })),
    )
    .await
}

#[tauri::command]
async fn daemon_resume(state: State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    control_request(
        &state,
        reqwest::Method::POST,
        "/v1/control/resume",
        Some(serde_json::json!({})),
    )
    .await
}

#[tauri::command]
async fn diagnostics_export(state: State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    control_request(
        &state,
        reqwest::Method::POST,
        "/v1/diagnostics/export",
        Some(serde_json::json!({})),
    )
    .await
}

#[tauri::command]
async fn daemon_work(state: State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    control_request(&state, reqwest::Method::GET, "/v1/work", None).await
}

#[tauri::command]
async fn daemon_traces(state: State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    control_request(&state, reqwest::Method::GET, "/v1/traces?limit=100", None).await
}

#[tauri::command]
async fn daemon_clear_trace_cache(
    state: State<'_, DaemonState>,
) -> Result<serde_json::Value, String> {
    control_request(&state, reqwest::Method::DELETE, "/v1/cache/plaintext", None).await
}

fn validate_trace_id(trace_id: &str) -> Result<(), String> {
    if trace_id.is_empty()
        || trace_id.len() > 128
        || !trace_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("A valid local trace ID is required".into());
    }
    Ok(())
}

async fn read_owner_trace(
    app: &AppHandle,
    state: &DaemonState,
    trace_id: &str,
) -> Result<serde_json::Value, String> {
    validate_trace_id(trace_id)?;
    let (port, token) = {
        let managed = state.0.lock().map_err(|_| "Daemon state unavailable")?;
        let process = managed.process.as_ref().ok_or("Daemon is not running")?;
        (process.control_port, process.control_token.clone())
    };
    let mut response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/traces/read"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "selector": trace_id }))
        .send()
        .await
        .map_err(|_| "Local daemon did not respond")?;
    if !response.status().is_success() {
        return Err("Local daemon rejected trace inspection".into());
    }
    let mut buffered = Vec::new();
    let mut result = None;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local daemon returned an invalid trace stream")?
    {
        buffered.extend_from_slice(&chunk);
        while let Some(position) = buffered.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffered.drain(..=position).collect();
            let line = &line[..line.len().saturating_sub(1)];
            if line.is_empty() {
                continue;
            }
            let event: serde_json::Value = serde_json::from_slice(line)
                .map_err(|_| "Local daemon returned an invalid trace stream")?;
            match event.get("type").and_then(serde_json::Value::as_str) {
                Some("trace") => result = Some(event),
                Some("progress") => {
                    let safe_progress = serde_json::json!({
                        "completedBytes": event.get("completedBytes"),
                        "phase": event.get("phase"),
                        "totalBytes": event.get("totalBytes"),
                    });
                    let _ = app.emit("trace-read-progress", safe_progress);
                }
                Some("error") => return Err("The selected trace could not be read safely".into()),
                _ => {}
            }
        }
    }
    if !buffered.is_empty() {
        let event: serde_json::Value = serde_json::from_slice(&buffered)
            .map_err(|_| "Local daemon returned an invalid trace stream")?;
        match event.get("type").and_then(serde_json::Value::as_str) {
            Some("trace") => result = Some(event),
            Some("error") => return Err("The selected trace could not be read safely".into()),
            _ => {}
        }
    }
    result.ok_or_else(|| "Local daemon did not return the selected trace".into())
}

#[tauri::command]
async fn daemon_read_trace(
    app: AppHandle,
    state: State<'_, DaemonState>,
    trace_id: String,
) -> Result<serde_json::Value, String> {
    read_owner_trace(&app, &state, &trace_id).await
}

fn write_owner_export(destination: &Path, trace: &serde_json::Value) -> Result<(), String> {
    use std::fs::{create_dir_all, hard_link, remove_file, OpenOptions};
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    let directory = destination.parent().ok_or("Export directory is invalid")?;
    for ancestor in directory.ancestors() {
        if let Ok(metadata) = std::fs::symlink_metadata(ancestor) {
            if metadata.file_type().is_symlink() {
                return Err("Plaintext exports cannot traverse symbolic links".into());
            }
        }
    }
    let directory_created = !directory.exists();
    create_dir_all(directory).map_err(|_| "Plaintext export directory could not be created")?;
    for ancestor in directory.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor)
            .map_err(|_| "Plaintext export directory could not be verified")?;
        if metadata.file_type().is_symlink() {
            return Err("Plaintext exports cannot traverse symbolic links".into());
        }
    }
    #[cfg(unix)]
    if directory_created {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Plaintext export directory permissions could not be secured")?;
    }
    let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Plaintext export could not be created")?;
        serde_json::to_writer_pretty(&mut file, trace)
            .map_err(|_| "Plaintext export could not be encoded")?;
        file.write_all(b"\n")
            .and_then(|_| file.sync_all())
            .map_err(|_| "Plaintext export could not be committed")?;
        hard_link(&temporary, destination).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "Plaintext export already exists".to_owned()
            } else {
                "Plaintext export could not be committed".to_owned()
            }
        })?;
        Ok(())
    })();
    let _ = remove_file(&temporary);
    result
}

#[tauri::command]
async fn daemon_export_trace(
    app: AppHandle,
    state: State<'_, DaemonState>,
    trace_id: String,
) -> Result<Option<String>, String> {
    let destination = app
        .dialog()
        .file()
        .set_file_name(format!("{trace_id}.json"))
        .add_filter("Canonical Traice JSON", &["json"])
        .blocking_save_file();
    let Some(destination) = destination else {
        return Ok(None);
    };
    let destination = destination
        .as_path()
        .ok_or("The selected export destination is not a local file")?;
    let event = read_owner_trace(&app, &state, &trace_id).await?;
    let trace = event
        .get("trace")
        .ok_or("Local daemon returned an invalid trace")?;
    write_owner_export(destination, trace)?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn daemon_delete_trace(
    state: State<'_, DaemonState>,
    trace_id: String,
    reason: String,
) -> Result<serde_json::Value, String> {
    if reason.trim().len() < 8 {
        return Err("A deletion reason is required".into());
    }
    control_request(
        &state,
        reqwest::Method::POST,
        &format!("/v1/traces/{trace_id}/delete"),
        Some(serde_json::json!({ "reason": reason })),
    )
    .await
}

#[tauri::command]
async fn daemon_commit_dataset(
    state: State<'_, DaemonState>,
    request_id: String,
) -> Result<serde_json::Value, String> {
    control_request(
        &state,
        reqwest::Method::POST,
        "/v1/datasets/commit",
        Some(serde_json::json!({ "requestId": request_id })),
    )
    .await
}

#[tauri::command]
async fn daemon_propose_agreement(
    state: State<'_, DaemonState>,
    request_id: String,
) -> Result<serde_json::Value, String> {
    control_request(
        &state,
        reqwest::Method::POST,
        "/v1/agreements/propose",
        Some(serde_json::json!({ "requestId": request_id })),
    )
    .await
}

#[tauri::command]
async fn daemon_prepare_delivery(
    state: State<'_, DaemonState>,
    request_id: String,
) -> Result<serde_json::Value, String> {
    control_request(
        &state,
        reqwest::Method::POST,
        "/v1/deliveries/prepare",
        Some(serde_json::json!({ "requestId": request_id })),
    )
    .await
}

#[tauri::command]
fn autostart_status(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;

    app.autolaunch()
        .is_enabled()
        .map_err(|_| "Autostart status is unavailable".into())
}

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|_| "Autostart could not be enabled")?;
    } else {
        manager
            .disable()
            .map_err(|_| "Autostart could not be disabled")?;
    }
    manager
        .is_enabled()
        .map_err(|_| "Autostart status is unavailable".into())
}

#[tauri::command]
async fn update_check(app: AppHandle) -> Result<UpdateStatus, String> {
    use tauri_plugin_updater::UpdaterExt;

    let update = app
        .updater()
        .map_err(|_| "Updater configuration is unavailable")?
        .check()
        .await
        .map_err(|_| "The signed update feed is unavailable")?;
    Ok(match update {
        Some(update) => UpdateStatus {
            available: true,
            notes: update.body,
            version: Some(update.version),
        },
        None => UpdateStatus {
            available: false,
            notes: None,
            version: None,
        },
    })
}

#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let update = app
        .updater()
        .map_err(|_| "Updater configuration is unavailable")?
        .check()
        .await
        .map_err(|_| "The signed update feed is unavailable")?
        .ok_or("No signed update is available")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| "The signed update could not be installed")?;
    app.restart();
}

#[tauri::command]
fn daemon_stop(state: State<'_, DaemonState>) -> Result<(), String> {
    let mut managed = state.0.lock().map_err(|_| "Daemon state unavailable")?;
    if let Some(mut process) = managed.process.take() {
        let _ = process.child.kill();
        let _ = process.child.wait();
        process.control_token.zeroize();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(DaemonState::default())
        .invoke_handler(tauri::generate_handler![
            autostart_set,
            autostart_status,
            configure_device,
            daemon_health,
            daemon_commit_dataset,
            daemon_clear_trace_cache,
            daemon_delete_trace,
            daemon_export_trace,
            daemon_pause,
            daemon_propose_agreement,
            daemon_prepare_delivery,
            daemon_resume,
            daemon_read_trace,
            daemon_start,
            daemon_stop,
            daemon_traces,
            daemon_work,
            diagnostics_export,
            load_configuration,
            proxy_trust_install,
            proxy_trust_remove,
            proxy_trust_status,
            update_check,
            update_install
        ])
        .setup(|app| {
            use tauri_plugin_autostart::ManagerExt;

            let open = MenuItem::with_id(app, "open", "Open Traicer", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause capture", true, None::<&str>)?;
            let resume = MenuItem::with_id(app, "resume", "Resume capture", true, None::<&str>)?;
            let diagnostics =
                MenuItem::with_id(app, "diagnostics", "Diagnostics", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Traicer", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &pause, &resume, &diagnostics, &quit])?;
            TrayIconBuilder::new().menu(&menu).build(app)?;
            if app.autolaunch().is_enabled().unwrap_or(false)
                && vault_entry(CONFIG_KEY)
                    .and_then(|entry| entry.get_password().map_err(|_| "missing".into()))
                    .is_ok()
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let state = handle.state::<DaemonState>();
                    let _ = daemon_start(handle.clone(), state);
                });
            }
            Ok(())
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" | "diagnostics" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "pause" | "resume" => {
                let handle = app.clone();
                let pause = event.id.as_ref() == "pause";
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<DaemonState>();
                    let (path, body) = if pause {
                        (
                            "/v1/control/pause",
                            Some(serde_json::json!({ "reason": "user", "scope": "all" })),
                        )
                    } else {
                        ("/v1/control/resume", Some(serde_json::json!({})))
                    };
                    let _ = control_request(&state, reqwest::Method::POST, path, body).await;
                });
            }
            "quit" => {
                if let Ok(mut managed) = app.state::<DaemonState>().0.lock() {
                    if let Some(mut process) = managed.process.take() {
                        let _ = process.child.kill();
                        process.control_token.zeroize();
                    }
                }
                app.exit(0)
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("failed to run Traicer");
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        time::{Duration, Instant},
    };

    use super::{
        canonical_json, create_configuration_identity, listener_url, record_daemon_start,
        restore_configuration_identity, restore_existing_storage_defaults, validate_trace_id,
        write_owner_export, ConfigureInput, StoredConfig,
    };

    #[test]
    fn canonical_json_matches_the_marketplace_signature_contract() {
        let value = serde_json::json!({
            "z": [2, { "b": true, "a": "2026-07-13T12:00:00.000Z" }],
            "a": "first"
        });
        assert_eq!(
            canonical_json(&value).expect("canonical JSON"),
            "{\"a\":\"first\",\"z\":[2,{\"a\":\"2026-07-13T12:00:00.000Z\",\"b\":true}]}"
        );
    }

    #[test]
    fn account_attachment_preserves_the_existing_device_identity() {
        let original = create_configuration_identity().expect("device identity");
        let config = StoredConfig {
            adapter_capability: original.adapter_capability.clone(),
            bucket: "seller-traces".into(),
            bucket_alias: "seller".into(),
            capture_policy_id: "capture-default".into(),
            client: "desktop".into(),
            device_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "https://example.invalid".into(),
            marketplace_api: "https://api.traice.market".into(),
            marketplace_connected: false,
            policy_allowed_paths: vec!["/v1/responses".into()],
            policy_version: "1".into(),
            prefix: "traces/".into(),
            provider: "openai".into(),
            public_key: original.public_key.clone(),
            redaction_profile: "default".into(),
            region: "auto".into(),
            signer_key_id: original.signer_key_id.clone(),
            storage_access_key_id: "owner-key".into(),
        };
        let mut account_attachment = ConfigureInput {
            bucket: config.bucket.clone(),
            client: config.client.clone(),
            endpoint: config.endpoint.clone(),
            marketplace_api: config.marketplace_api.clone(),
            marketplace_credential: "new-account-credential".into(),
            prefix: config.prefix.clone(),
            provider: config.provider.clone(),
            region: config.region.clone(),
            storage_access_key_id: String::new(),
            storage_secret: String::new(),
        };
        restore_existing_storage_defaults(
            &mut account_attachment,
            &config,
            Some("preserved-storage-secret".into()),
        )
        .expect("restore storage defaults");
        assert_eq!(account_attachment.storage_access_key_id, "owner-key");
        assert_eq!(
            account_attachment.storage_secret,
            "preserved-storage-secret"
        );

        let restored = restore_configuration_identity(
            &config,
            original.private_key.clone(),
            original.wrapping_key.clone(),
        )
        .expect("restore existing identity");

        assert_eq!(restored.public_key, original.public_key);
        assert_eq!(restored.signer_key_id, original.signer_key_id);
        assert_eq!(restored.adapter_capability, original.adapter_capability);
        assert_eq!(restored.private_key, original.private_key);
        assert_eq!(restored.wrapping_key, original.wrapping_key);
        assert_eq!(restored.signing.to_bytes(), original.signing.to_bytes());
    }

    #[test]
    fn daemon_restart_budget_limits_crash_loops_and_recovers_after_the_window() {
        let now = Instant::now();
        let mut starts = VecDeque::new();
        for _ in 0..3 {
            record_daemon_start(&mut starts, now).expect("start within budget");
        }
        assert!(record_daemon_start(&mut starts, now).is_err());
        record_daemon_start(&mut starts, now + Duration::from_secs(301)).expect("budget recovers");
    }

    #[test]
    fn plaintext_exports_are_explicit_owner_only_and_never_overwrite() {
        let root = std::env::temp_dir()
            .canonicalize()
            .expect("canonical temporary directory")
            .join(format!("traicer-export-{}", uuid::Uuid::new_v4()));
        let destination = root.join("trace.json");
        write_owner_export(
            &destination,
            &serde_json::json!({ "schema": "traice.trace/1", "traceId": "trace-1" }),
        )
        .expect("first export");
        assert!(
            write_owner_export(&destination, &serde_json::json!({ "replaced": true })).is_err()
        );
        assert!(!std::fs::read_to_string(&destination)
            .expect("export contents")
            .contains("replaced"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&root)
                    .expect("export directory metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&destination)
                    .expect("export metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn plaintext_exports_reject_symbolic_link_parents() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir()
            .canonicalize()
            .expect("canonical temporary directory")
            .join(format!("traicer-export-{}", uuid::Uuid::new_v4()));
        let real = root.join("real");
        let linked = root.join("linked");
        std::fs::create_dir_all(&real).expect("real directory");
        symlink(&real, &linked).expect("linked directory");
        assert!(write_owner_export(
            &linked.join("trace.json"),
            &serde_json::json!({ "traceId": "trace-1" }),
        )
        .is_err());
        assert!(!real.join("trace.json").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn listener_urls_never_expose_adapter_capabilities() {
        assert_eq!(
            listener_url(Some(43123)).as_deref(),
            Some("http://127.0.0.1:43123")
        );
        assert_eq!(listener_url(None), None);
    }

    #[test]
    fn desktop_owner_reads_accept_only_local_trace_ids() {
        assert!(validate_trace_id("018f1f0d-91aa-7b64-bb02-7db61861b18d").is_ok());
        assert!(validate_trace_id("../../private-object").is_err());
        assert!(validate_trace_id("").is_err());
    }
}
