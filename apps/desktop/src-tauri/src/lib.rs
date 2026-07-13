use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{pkcs8::EncodePrivateKey, Signer, SigningKey};
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
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    path::BaseDirectory,
    tray::TrayIconBuilder,
    AppHandle, Manager, State,
};
use zeroize::Zeroize;

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
    if input.marketplace_credential.is_empty()
        || input.storage_secret.is_empty()
        || input.storage_access_key_id.is_empty()
        || input.bucket.is_empty()
    {
        return Err("Marketplace and storage credentials are required".into());
    }
    for value in [&input.marketplace_api, &input.endpoint] {
        let url = reqwest::Url::parse(value).map_err(|_| "A configured endpoint is invalid")?;
        if url.scheme() != "https" && !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
            return Err("Configured endpoints must use HTTPS outside loopback development".into());
        }
    }
    Ok(())
}

#[tauri::command]
async fn configure_device(mut input: ConfigureInput) -> Result<SafeConfig, String> {
    validate_configuration(&input)?;
    ensure_proxy_certificates()?;
    let replaces_device_id = vault_entry(CONFIG_KEY)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|mut value| {
            let device_id = serde_json::from_str::<StoredConfig>(&value)
                .ok()
                .map(|config| config.device_id);
            value.zeroize();
            device_id
        });
    let signing = SigningKey::generate(&mut OsRng);
    let public_bytes = signing.verifying_key().to_bytes();
    let public_key = URL_SAFE_NO_PAD.encode(public_bytes);
    let signer_key_id = hex::encode(Sha256::digest(public_bytes))[..32].to_owned();
    let private_document = signing
        .to_pkcs8_der()
        .map_err(|_| "Device signing key generation failed")?;
    let mut private_key = URL_SAFE_NO_PAD.encode(private_document.as_bytes());
    let adapter_capability = random_base64(24);
    let wrapping_key = random_base64(32);
    let adapters = if input.provider == "anthropic" {
        vec!["anthropic-messages/1"]
    } else {
        vec!["openai-responses/1", "openai-chat-completions/1"]
    };
    let response = reqwest::Client::new()
        .post(format!(
            "{}/api/v1/traicer/devices",
            input.marketplace_api.trim_end_matches('/')
        ))
        .bearer_auth(&input.marketplace_credential)
        .json(&serde_json::json!({
            "adapters": adapters,
            "clientVersion": env!("CARGO_PKG_VERSION"),
            "name": format!("{} on {}", input.client, std::env::consts::OS),
            "operatingSystemClass": std::env::consts::OS,
            "publicKey": public_key,
            "publicKeyFingerprint": signer_key_id,
            "replacesDeviceId": replaces_device_id,
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
    let signature = URL_SAFE_NO_PAD.encode(signing.sign(&policy_bytes).to_bytes());
    policy_payload
        .as_object_mut()
        .ok_or("Capture policy payload was invalid")?
        .insert("signature".into(), serde_json::Value::String(signature));
    let policy_response = reqwest::Client::new()
        .post(format!(
            "{}/api/v1/traicer/capture-policy",
            input.marketplace_api.trim_end_matches('/')
        ))
        .bearer_auth(&input.marketplace_credential)
        .json(&policy_payload)
        .send()
        .await
        .map_err(|_| "Marketplace capture-policy activation was unavailable")?;
    if !policy_response.status().is_success() {
        return Err("Marketplace rejected the signed capture policy".into());
    }
    let activated_policy: CapturePolicyResponse = policy_response
        .json()
        .await
        .map_err(|_| "Marketplace returned an invalid capture policy")?;
    let bucket_digest = hex::encode(Sha256::digest(input.bucket.as_bytes()));
    let config = StoredConfig {
        adapter_capability,
        bucket: input.bucket.clone(),
        bucket_alias: format!("seller-{}", &bucket_digest[..12]),
        capture_policy_id: activated_policy.data.id,
        client: input.client.clone(),
        device_id: registered.data.id,
        endpoint: input.endpoint.clone(),
        marketplace_api: input.marketplace_api.clone(),
        policy_allowed_paths: policy_allowed_paths
            .into_iter()
            .map(str::to_owned)
            .collect(),
        policy_version: format!("policy/{}", activated_policy.data.policy_version),
        prefix: input.prefix.clone(),
        provider: input.provider.clone(),
        public_key,
        redaction_profile: "strict-default".into(),
        region: input.region.clone(),
        signer_key_id,
        storage_access_key_id: input.storage_access_key_id.clone(),
    };
    let config_json =
        serde_json::to_string(&config).map_err(|_| "Configuration serialization failed")?;
    vault_write(CONFIG_KEY, &config_json)?;
    vault_write(MARKETPLACE_KEY, &input.marketplace_credential)?;
    vault_write(SIGNING_KEY, &private_key)?;
    vault_write(STORAGE_KEY, &input.storage_secret)?;
    vault_write(WRAPPING_KEY, &wrapping_key)?;
    private_key.zeroize();
    input.marketplace_credential.zeroize();
    input.storage_access_key_id.zeroize();
    input.storage_secret.zeroize();
    Ok(SafeConfig::from(&config))
}

#[tauri::command]
fn load_configuration() -> Result<Option<SafeConfig>, String> {
    match vault_entry(CONFIG_KEY)?.get_password() {
        Ok(mut value) => {
            let config: StoredConfig =
                serde_json::from_str(&value).map_err(|_| "Stored configuration is incompatible")?;
            value.zeroize();
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

fn gateway_url(port: Option<u16>) -> Option<String> {
    let port = port?;
    let mut config_json = vault_read(CONFIG_KEY).ok()?;
    let config: StoredConfig = serde_json::from_str(&config_json).ok()?;
    config_json.zeroize();
    Some(format!(
        "http://127.0.0.1:{port}/{}/{}",
        config.provider, config.adapter_capability
    ))
}

fn proxy_url(port: Option<u16>) -> Option<String> {
    let port = port?;
    let mut config_json = vault_read(CONFIG_KEY).ok()?;
    let config: StoredConfig = serde_json::from_str(&config_json).ok()?;
    config_json.zeroize();
    Some(format!(
        "http://traicer:{}@127.0.0.1:{port}",
        config.adapter_capability
    ))
}

fn build_bootstrap() -> Result<(String, String), String> {
    ensure_proxy_certificates()?;
    let mut config_json = vault_read(CONFIG_KEY)?;
    let config: StoredConfig =
        serde_json::from_str(&config_json).map_err(|_| "Stored configuration is incompatible")?;
    config_json.zeroize();
    let control_token = random_base64(32);
    let mut marketplace_credential = vault_read(MARKETPLACE_KEY)?;
    let mut signing_private_key = vault_read(SIGNING_KEY)?;
    let mut storage_secret = vault_read(STORAGE_KEY)?;
    let mut vault_key = vault_read(WRAPPING_KEY)?;
    let mut proxy_certificate = vault_read(PROXY_LEAF_CERT)?;
    let mut proxy_private_key = vault_read(PROXY_LEAF_KEY)?;
    let upstream_origin = if config.provider == "anthropic" {
        "https://api.anthropic.com"
    } else {
        "https://api.openai.com"
    };
    let bootstrap = serde_json::to_string(&serde_json::json!({
        "capture": {
            "adapterCapability": config.adapter_capability,
            "bucketAlias": config.bucket_alias,
            "client": config.client,
            "deviceId": config.device_id,
            "marketplace": { "apiBaseUrl": config.marketplace_api, "credential": marketplace_credential },
            "policy": {
                "allowedPaths": config.policy_allowed_paths,
                "capturePolicyId": config.capture_policy_id,
                "pipelineVersion": "pipeline/1",
                "policyVersion": config.policy_version,
                "redactionProfile": config.redaction_profile
            },
            "proxyTls": {
                "certificatePem": proxy_certificate,
                "privateKeyPem": proxy_private_key,
                "targetHosts": ["api.openai.com", "api.anthropic.com"]
            },
            "signerKeyId": config.signer_key_id,
            "signingPrivateKey": signing_private_key,
            "storage": {
                "accessKeyId": config.storage_access_key_id,
                "addressingStyle": "path",
                "bucket": config.bucket,
                "endpoint": config.endpoint,
                "prefix": config.prefix,
                "secretAccessKey": storage_secret,
                "signingRegion": config.region,
                "storageCapabilityProfileId": "s3-full-readback-v1"
            },
            "upstreamOrigin": upstream_origin
        },
        "controlToken": control_token,
        "protocolVersion": 1,
        "vaultKey": vault_key
    }))
    .map_err(|_| "Daemon bootstrap generation failed")?;
    marketplace_credential.zeroize();
    signing_private_key.zeroize();
    storage_secret.zeroize();
    vault_key.zeroize();
    proxy_certificate.zeroize();
    proxy_private_key.zeroize();
    Ok((bootstrap, control_token))
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
                gateway_url: gateway_url(process.gateway_port),
                proxy_url: proxy_url(process.proxy_port),
                health: None,
                running: true,
            });
        }
        managed.process = None;
    }
    record_daemon_start(&mut managed.recent_starts, Instant::now())?;
    let (mut bootstrap, control_token) = build_bootstrap()?;
    let mut child = Command::new(daemon_binary(&app)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Traicer daemon could not be started")?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(bootstrap.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|_| "Daemon bootstrap transfer failed")?;
    }
    bootstrap.zeroize();
    let stdout = child
        .stdout
        .take()
        .ok_or("Daemon ready channel unavailable")?;
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .map_err(|_| "Daemon ready message failed")?;
    let ready: ReadyLine =
        serde_json::from_str(&line).map_err(|_| "Daemon ready message was invalid")?;
    line.zeroize();
    if ready.kind != "ready" || ready.protocol_version != 1 {
        let _ = child.kill();
        return Err("Daemon protocol version is incompatible".into());
    }
    managed.process = Some(DaemonProcess {
        child,
        control_port: ready.control_port,
        control_token,
        gateway_port: ready.gateway_port,
        proxy_port: ready.proxy_port,
    });
    Ok(DaemonStatus {
        capture_status: "healthy".into(),
        control_port: Some(ready.control_port),
        gateway_port: ready.gateway_port,
        gateway_url: gateway_url(ready.gateway_port),
        proxy_url: proxy_url(ready.proxy_port),
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
        gateway_url: gateway_url(gateway_port),
        proxy_url: proxy_url(proxy_port),
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
            daemon_delete_trace,
            daemon_pause,
            daemon_propose_agreement,
            daemon_prepare_delivery,
            daemon_resume,
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

    use super::{canonical_json, record_daemon_start};

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
    fn daemon_restart_budget_limits_crash_loops_and_recovers_after_the_window() {
        let now = Instant::now();
        let mut starts = VecDeque::new();
        for _ in 0..3 {
            record_daemon_start(&mut starts, now).expect("start within budget");
        }
        assert!(record_daemon_start(&mut starts, now).is_err());
        record_daemon_start(&mut starts, now + Duration::from_secs(301)).expect("budget recovers");
    }
}
