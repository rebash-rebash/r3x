use kube::config::{KubeConfigOptions, Kubeconfig};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct K8sContext {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    pub is_active: bool,
}

/// Cached client with creation timestamp for token refresh.
struct CachedClient {
    context: String,
    client: kube::Client,
    created_at: std::time::Instant,
}

/// Cached client to avoid re-authenticating on every API call.
/// Automatically refreshes after 45 minutes to handle cloud provider token expiry
/// (GKE, EKS, AKS tokens typically expire after ~1 hour).
static CLIENT_CACHE: std::sync::OnceLock<Arc<RwLock<Option<CachedClient>>>> =
    std::sync::OnceLock::new();

/// Max age before proactively refreshing the client (45 min).
const MAX_CLIENT_AGE: std::time::Duration = std::time::Duration::from_secs(45 * 60);

fn cache() -> &'static Arc<RwLock<Option<CachedClient>>> {
    CLIENT_CACHE.get_or_init(|| Arc::new(RwLock::new(None)))
}

#[tauri::command]
pub async fn list_contexts() -> Result<Vec<K8sContext>, String> {
    let kubeconfig =
        Kubeconfig::read().map_err(|e| format!("Failed to read kubeconfig: {}", e))?;

    let current_context = kubeconfig.current_context.clone().unwrap_or_default();

    let contexts: Vec<K8sContext> = kubeconfig
        .contexts
        .iter()
        .map(|ctx| {
            let context = ctx.context.as_ref();
            K8sContext {
                name: ctx.name.clone(),
                cluster: context.map(|c| c.cluster.clone()).unwrap_or_default(),
                user: context.and_then(|c| c.user.clone()).unwrap_or_default(),
                namespace: context.and_then(|c| c.namespace.clone()),
                is_active: ctx.name == current_context,
            }
        })
        .collect();

    Ok(contexts)
}

#[tauri::command]
pub async fn get_current_context() -> Result<String, String> {
    let kubeconfig =
        Kubeconfig::read().map_err(|e| format!("Failed to read kubeconfig: {}", e))?;
    kubeconfig
        .current_context
        .ok_or_else(|| "No current context set".to_string())
}

/// Force-reconnect: clears cached client and PATH, then reconnects.
/// Called by the frontend "Retry Connection" button after user re-authenticates.
#[tauri::command]
pub async fn reconnect(context_name: String) -> Result<String, String> {
    // Re-inherit shell PATH to pick up any new tools installed since app launch
    crate::inherit_shell_path();
    // Delegate to switch_context which handles cache invalidation
    switch_context(context_name).await
}

#[tauri::command]
pub async fn switch_context(context_name: String) -> Result<String, String> {
    // Always invalidate cache first — ensures stale tokens are never reused
    {
        let mut guard = cache().write().await;
        *guard = None;
    }

    // Build a completely fresh client (re-reads kubeconfig, re-runs exec auth plugin)
    let client = create_client_for_context(&context_name).await?;

    // Verify connection
    use k8s_openapi::api::core::v1::Namespace;
    use kube::api::Api;
    let ns_api: Api<Namespace> = Api::all(client.clone());
    ns_api
        .list(&Default::default())
        .await
        .map_err(|e| format_connection_error(&context_name, &e.to_string()))?;

    // Store verified client in cache
    let mut guard = cache().write().await;
    *guard = Some(CachedClient {
        context: context_name.clone(),
        client,
        created_at: std::time::Instant::now(),
    });

    Ok(format!("Switched to context: {}", context_name))
}

/// Get the cached client, or create one if not cached for this context.
/// Automatically refreshes the client if the cached one is older than 45 minutes,
/// ensuring cloud provider exec-based tokens (GKE, EKS, AKS) don't expire.
pub async fn get_client(context_name: &str) -> Result<kube::Client, String> {
    // Check cache first
    {
        let guard = cache().read().await;
        if let Some(cached) = guard.as_ref() {
            if cached.context == context_name && cached.created_at.elapsed() < MAX_CLIENT_AGE {
                return Ok(cached.client.clone());
            }
        }
    }

    // Not cached, different context, or expired — build and cache
    let client = create_client_for_context(context_name).await?;
    let mut guard = cache().write().await;
    *guard = Some(CachedClient {
        context: context_name.to_string(),
        client: client.clone(),
        created_at: std::time::Instant::now(),
    });
    Ok(client)
}

/// Force-refresh the client for the given context.
/// Called when an API call fails with an auth error so the next attempt uses a fresh token.
#[allow(dead_code)]
pub async fn refresh_client(context_name: &str) -> Result<kube::Client, String> {
    let client = create_client_for_context(context_name).await?;
    let mut guard = cache().write().await;
    *guard = Some(CachedClient {
        context: context_name.to_string(),
        client: client.clone(),
        created_at: std::time::Instant::now(),
    });
    Ok(client)
}

/// Invalidate the cached client, forcing the next get_client call to rebuild.
#[allow(dead_code)]
pub async fn invalidate_client() {
    let mut guard = cache().write().await;
    *guard = None;
}

async fn create_client_for_context(context_name: &str) -> Result<kube::Client, String> {
    let kubeconfig = Kubeconfig::read().map_err(|e| {
        format!(
            "Failed to read kubeconfig: {}\n\n\
             How to fix:\n\
             • Ensure ~/.kube/config exists and is valid\n\
             • Run: kubectl config view",
            e
        )
    })?;

    let options = KubeConfigOptions {
        context: Some(context_name.to_string()),
        ..Default::default()
    };

    // Try building config normally first
    let config = match kube::Config::from_custom_kubeconfig(kubeconfig.clone(), &options).await {
        Ok(config) => config,
        Err(e) => {
            let err_str = e.to_string();
            // If exec plugin not found, try fallback: get token directly from cloud CLI
            if err_str.contains("No such file") || err_str.contains("exec") {
                eprintln!("[r3x] Exec plugin failed ({}), trying token fallback...", err_str);
                create_config_with_token_fallback(kubeconfig, context_name, &options).await?
            } else {
                return Err(format!("Failed to build config for '{}': {}", context_name, e));
            }
        }
    };

    kube::Client::try_from(config)
        .map_err(|e| format!("Failed to create client for '{}': {}", context_name, e))
}

/// Fallback: when the exec auth plugin binary is missing, try to get a token
/// directly from the cloud provider CLI (gcloud, aws, az) and patch the kubeconfig
/// to use a bearer token instead of exec-based auth.
async fn create_config_with_token_fallback(
    mut kubeconfig: Kubeconfig,
    context_name: &str,
    options: &KubeConfigOptions,
) -> Result<kube::Config, String> {
    // Find which user this context references
    let ctx_entry = kubeconfig.contexts.iter()
        .find(|c| c.name == context_name)
        .ok_or_else(|| format!("Context '{}' not found in kubeconfig", context_name))?;

    let user_name = ctx_entry.context.as_ref()
        .and_then(|c| c.user.clone())
        .unwrap_or_default();

    // Detect provider from context/user name and get token
    let token = if context_name.contains("gke_") || user_name.contains("gke_") {
        get_gcloud_token()?
    } else if context_name.contains("eks") || user_name.contains("eks") {
        get_aws_token(context_name)?
    } else if context_name.contains("aks") || user_name.contains("aks") || user_name.contains("azure") {
        get_az_token()?
    } else {
        // Try gcloud first as most common, then aws, then az
        get_gcloud_token()
            .or_else(|_| get_aws_token(context_name))
            .or_else(|_| get_az_token())
            .map_err(|_| format!(
                "Auth plugin not found and could not get token from any cloud CLI.\n\n\
                 How to fix:\n\
                 • GKE: Run 'gcloud auth login' (or install gke-gcloud-auth-plugin)\n\
                 • EKS: Run 'aws sso login' (or install aws-iam-authenticator)\n\
                 • AKS: Run 'az login' (or install kubelogin)"
            ))?
    };

    eprintln!("[r3x] Got token via cloud CLI fallback ({}... chars)", token.len());

    // Patch the user entry: remove exec, add token
    if let Some(user_entry) = kubeconfig.auth_infos.iter_mut().find(|u| u.name == user_name) {
        if let Some(ref mut auth) = user_entry.auth_info {
            auth.exec = None;
            auth.token = Some(secrecy::SecretString::new(token.into()));
        }
    }

    kube::Config::from_custom_kubeconfig(kubeconfig, options)
        .await
        .map_err(|e| format!("Failed to build config with token fallback: {}", e))
}

/// Get GCP access token via gcloud CLI
fn get_gcloud_token() -> Result<String, String> {
    let output = std::process::Command::new("gcloud")
        .args(["auth", "print-access-token"])
        .output()
        .map_err(|e| format!("gcloud not found: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gcloud auth failed: {}", stderr.trim()));
    }

    let token = String::from_utf8(output.stdout)
        .map_err(|e| format!("Invalid gcloud output: {}", e))?;
    let token = token.trim().to_string();

    if token.is_empty() {
        return Err("gcloud returned empty token — run 'gcloud auth login' first".to_string());
    }
    Ok(token)
}

/// Get AWS EKS token via aws CLI
fn get_aws_token(context_name: &str) -> Result<String, String> {
    // Try to extract cluster name from context (e.g., "arn:aws:eks:region:account:cluster/name")
    let cluster_name = context_name
        .split('/')
        .last()
        .unwrap_or(context_name);

    let output = std::process::Command::new("aws")
        .args(["eks", "get-token", "--cluster-name", cluster_name, "--output", "json"])
        .output()
        .map_err(|e| format!("aws CLI not found: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("aws eks get-token failed: {}", stderr.trim()));
    }

    let json_str = String::from_utf8(output.stdout)
        .map_err(|e| format!("Invalid aws output: {}", e))?;

    // Parse the token from JSON response: {"kind":"ExecCredential","status":{"token":"..."}}
    if let Some(token_start) = json_str.find("\"token\"") {
        let rest = &json_str[token_start..];
        if let Some(val_start) = rest.find('"').and_then(|i| rest[i+1..].find('"').map(|j| i + 1 + j + 1)) {
            if let Some(val_end) = rest[val_start..].find('"') {
                let token = &rest[val_start..val_start + val_end];
                if !token.is_empty() {
                    return Ok(token.to_string());
                }
            }
        }
    }
    Err("Could not parse token from aws eks get-token output".to_string())
}

/// Get Azure access token via az CLI
fn get_az_token() -> Result<String, String> {
    let output = std::process::Command::new("az")
        .args(["account", "get-access-token", "--resource", "6dae42f8-4368-4678-94ff-3960e28e3630", "--query", "accessToken", "-o", "tsv"])
        .output()
        .map_err(|e| format!("az CLI not found: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("az auth failed: {}", stderr.trim()));
    }

    let token = String::from_utf8(output.stdout)
        .map_err(|e| format!("Invalid az output: {}", e))?;
    let token = token.trim().to_string();

    if token.is_empty() {
        return Err("az returned empty token — run 'az login' first".to_string());
    }
    Ok(token)
}

/// Build a user-friendly connection error message with OS-specific diagnostic steps.
fn format_connection_error(context_name: &str, err: &str) -> String {
    let err_lower = err.to_lowercase();

    let (title, steps) = if err_lower.contains("connect") || err_lower.contains("connection refused")
        || err_lower.contains("timed out") || err_lower.contains("dns") || err_lower.contains("resolve")
    {
        (
            format!("Connection failed to cluster '{}'", context_name),
            vec![
                "Check if the cluster API server is reachable (VPN connected? Private cluster?)".to_string(),
                format!("Verify auth plugin is installed:\n  {}\n  {}\n  {}",
                    gke_install_hint(), eks_install_hint(), aks_install_hint()),
                "Re-authenticate and refresh credentials:\n  GKE: gcloud auth login && gcloud container clusters get-credentials <CLUSTER> --region <REGION> --project <PROJECT>\n  EKS: aws sso login --profile <PROFILE>\n  AKS: az login && az aks get-credentials --resource-group <RG> --name <CLUSTER>".to_string(),
                "Check firewall or proxy settings are not blocking the connection".to_string(),
                format!("Test with kubectl: kubectl --context {} get namespaces", context_name),
            ],
        )
    } else if err_lower.contains("401") || err_lower.contains("unauthorized") {
        (
            format!("Authentication failed for cluster '{}'", context_name),
            vec![
                "Your token has expired. Re-authenticate:\n  GKE: gcloud auth login\n  EKS: aws sso login --profile <PROFILE>\n  AKS: az login".to_string(),
                "Refresh kubeconfig credentials:\n  GKE: gcloud container clusters get-credentials <CLUSTER> --region <REGION> --project <PROJECT>\n  EKS: aws eks update-kubeconfig --name <CLUSTER> --region <REGION>\n  AKS: az aks get-credentials --resource-group <RG> --name <CLUSTER>".to_string(),
                "Check if your account has RBAC access to the cluster".to_string(),
                format!("Test with kubectl: kubectl --context {} auth whoami", context_name),
            ],
        )
    } else if err_lower.contains("403") || err_lower.contains("forbidden") {
        (
            format!("Access denied to cluster '{}'", context_name),
            vec![
                "Your credentials are valid but you lack permissions on this cluster".to_string(),
                "Ask your cluster admin to grant you the appropriate RBAC role".to_string(),
                format!("Check your permissions: kubectl --context {} auth can-i --list", context_name),
            ],
        )
    } else if err_lower.contains("certificate") || err_lower.contains("tls") || err_lower.contains("ssl") {
        (
            format!("TLS/Certificate error for cluster '{}'", context_name),
            vec![
                "The cluster's CA certificate may be invalid or expired".to_string(),
                "Refresh your kubeconfig to get updated certificates:\n  GKE: gcloud container clusters get-credentials <CLUSTER> --region <REGION>\n  EKS: aws eks update-kubeconfig --name <CLUSTER>\n  AKS: az aks get-credentials --resource-group <RG> --name <CLUSTER>".to_string(),
                "If using a corporate proxy, ensure its CA cert is trusted by your OS".to_string(),
            ],
        )
    } else {
        (
            format!("Failed to connect to cluster '{}'", context_name),
            vec![
                format!("Test with kubectl: kubectl --context {} get namespaces", context_name),
                "Check your kubeconfig: kubectl config view".to_string(),
                "Re-authenticate if needed:\n  GKE: gcloud auth login\n  EKS: aws sso login\n  AKS: az login".to_string(),
            ],
        )
    };

    let mut msg = format!("{}\n\nError: {}\n\nHow to fix:", title, err);
    for (i, step) in steps.iter().enumerate() {
        msg.push_str(&format!("\n{}. {}", i + 1, step));
    }
    msg
}

fn gke_install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "gcloud components install gke-gcloud-auth-plugin  (or: brew install google-cloud-sdk)"
    } else if cfg!(target_os = "windows") {
        "gcloud components install gke-gcloud-auth-plugin"
    } else {
        "sudo apt-get install google-cloud-cli-gke-gcloud-auth-plugin  (or: gcloud components install gke-gcloud-auth-plugin)"
    }
}

fn eks_install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "brew install aws-iam-authenticator  (or: curl -o aws-iam-authenticator https://amazon-eks.s3.us-west-2.amazonaws.com/...)"
    } else if cfg!(target_os = "windows") {
        "choco install aws-iam-authenticator  (or download from AWS docs)"
    } else {
        "curl -Lo aws-iam-authenticator https://amazon-eks.s3.us-west-2.amazonaws.com/... && chmod +x aws-iam-authenticator && sudo mv aws-iam-authenticator /usr/local/bin/"
    }
}

fn aks_install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "brew install Azure/kubelogin/kubelogin  (or: az aks install-cli)"
    } else if cfg!(target_os = "windows") {
        "az aks install-cli  (or: choco install kubelogin)"
    } else {
        "az aks install-cli  (or: sudo snap install kubelogin)"
    }
}
