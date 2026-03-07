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

/// Cached client to avoid re-authenticating on every API call.
static CLIENT_CACHE: std::sync::OnceLock<Arc<RwLock<Option<(String, kube::Client)>>>> =
    std::sync::OnceLock::new();

fn cache() -> &'static Arc<RwLock<Option<(String, kube::Client)>>> {
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

#[tauri::command]
pub async fn switch_context(context_name: String) -> Result<String, String> {
    // Build a fresh client and cache it
    let client = create_client_for_context(&context_name).await?;

    // Verify connection
    use k8s_openapi::api::core::v1::Namespace;
    use kube::api::Api;
    let ns_api: Api<Namespace> = Api::all(client.clone());
    ns_api
        .list(&Default::default())
        .await
        .map_err(|e| format!("Failed to connect to cluster '{}': {}", context_name, e))?;

    // Store in cache
    let mut guard = cache().write().await;
    *guard = Some((context_name.clone(), client));

    Ok(format!("Switched to context: {}", context_name))
}

/// Get the cached client, or create one if not cached for this context.
pub async fn get_client(context_name: &str) -> Result<kube::Client, String> {
    // Check cache first
    {
        let guard = cache().read().await;
        if let Some((cached_ctx, client)) = guard.as_ref() {
            if cached_ctx == context_name {
                return Ok(client.clone());
            }
        }
    }

    // Not cached or different context — build and cache
    let client = create_client_for_context(context_name).await?;
    let mut guard = cache().write().await;
    *guard = Some((context_name.to_string(), client.clone()));
    Ok(client)
}

async fn create_client_for_context(context_name: &str) -> Result<kube::Client, String> {
    let kubeconfig =
        Kubeconfig::read().map_err(|e| format!("Failed to read kubeconfig: {}", e))?;

    let options = KubeConfigOptions {
        context: Some(context_name.to_string()),
        ..Default::default()
    };

    let config = kube::Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .map_err(|e| format!("Failed to build config for context '{}': {}", context_name, e))?;

    kube::Client::try_from(config)
        .map_err(|e| format!("Failed to create client for context '{}': {}", context_name, e))
}
