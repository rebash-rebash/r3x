use super::context::get_client;
use super::resources::{extract_status_pub, format_age_pub, K8sResource};
use futures::StreamExt;
use kube::api::{Api, ApiResource, DynamicObject};
use kube::discovery::Scope;
use kube::runtime::{reflector, watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

const MAX_WATCHERS: usize = 16;
const IDLE_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const DEBOUNCE_MS: u64 = 300;

/// Default watchers that should not be evicted by LRU.
const PROTECTED_KINDS: &[&str] = &["pods", "deployments", "services"];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WatcherUpdate {
    pub kind_key: String,
    pub resources: Vec<K8sResource>,
}

struct WatcherHandle {
    stream_task: JoinHandle<()>,
    emitter_task: JoinHandle<()>,
    store: reflector::Store<DynamicObject>,
    display_kind: String,
    last_accessed: Arc<AtomicU64>,
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        self.stream_task.abort();
        self.emitter_task.abort();
    }
}

struct InformerManager {
    watchers: HashMap<String, WatcherHandle>,
    context: String,
}

impl InformerManager {
    fn new() -> Self {
        Self {
            watchers: HashMap::new(),
            context: String::new(),
        }
    }
}

static MANAGER: std::sync::OnceLock<Arc<RwLock<InformerManager>>> = std::sync::OnceLock::new();

fn manager() -> &'static Arc<RwLock<InformerManager>> {
    MANAGER.get_or_init(|| Arc::new(RwLock::new(InformerManager::new())))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Map lowercase plural kind key to (ApiResource, Scope, display_kind).
fn kind_to_api_info(kind: &str) -> Option<(ApiResource, Scope, &'static str)> {
    let (group, version, display_kind, plural) = match kind {
        "pods" => ("", "v1", "Pod", "pods"),
        "deployments" => ("apps", "v1", "Deployment", "deployments"),
        "services" => ("", "v1", "Service", "services"),
        "configmaps" => ("", "v1", "ConfigMap", "configmaps"),
        "secrets" => ("", "v1", "Secret", "secrets"),
        "statefulsets" => ("apps", "v1", "StatefulSet", "statefulsets"),
        "daemonsets" => ("apps", "v1", "DaemonSet", "daemonsets"),
        "replicasets" => ("apps", "v1", "ReplicaSet", "replicasets"),
        "jobs" => ("batch", "v1", "Job", "jobs"),
        "cronjobs" => ("batch", "v1", "CronJob", "cronjobs"),
        "ingresses" => ("networking.k8s.io", "v1", "Ingress", "ingresses"),
        "networkpolicies" => (
            "networking.k8s.io",
            "v1",
            "NetworkPolicy",
            "networkpolicies",
        ),
        "serviceaccounts" => ("", "v1", "ServiceAccount", "serviceaccounts"),
        "persistentvolumeclaims" => (
            "",
            "v1",
            "PersistentVolumeClaim",
            "persistentvolumeclaims",
        ),
        "persistentvolumes" => ("", "v1", "PersistentVolume", "persistentvolumes"),
        "nodes" => ("", "v1", "Node", "nodes"),
        _ => return None,
    };

    let scope = match kind {
        "persistentvolumes" | "nodes" => Scope::Cluster,
        _ => Scope::Namespaced,
    };

    let api_version = if group.is_empty() {
        version.to_string()
    } else {
        format!("{}/{}", group, version)
    };

    Some((
        ApiResource {
            group: group.to_string(),
            version: version.to_string(),
            api_version,
            kind: display_kind.to_string(),
            plural: plural.to_string(),
        },
        scope,
        display_kind,
    ))
}

fn dynamic_to_resource(obj: &DynamicObject, display_kind: &str) -> K8sResource {
    let extra = serde_json::to_value(obj).unwrap_or(serde_json::Value::Null);
    K8sResource {
        name: obj.metadata.name.clone().unwrap_or_default(),
        namespace: obj.metadata.namespace.clone(),
        kind: display_kind.to_string(),
        status: extract_status_pub(&extra),
        age: format_age_pub(obj.metadata.creation_timestamp.as_ref()),
        labels: obj.metadata.labels.clone().unwrap_or_default(),
        extra,
    }
}

#[tauri::command]
pub async fn start_watcher(
    context: String,
    kind: String,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let (ar, _scope, display_kind) =
        kind_to_api_info(&kind).ok_or_else(|| format!("Unsupported kind for watching: {}", kind))?;

    let mut mgr = manager().write().await;

    // Context changed → stop all existing watchers
    if mgr.context != context {
        for (key, _) in mgr.watchers.drain() {
            println!("[r3x] Stopping watcher '{}' (context changed)", key);
        }
        mgr.context = context.clone();
    }

    // Already watching this kind
    if let Some(handle) = mgr.watchers.get(&kind) {
        handle.last_accessed.store(now_millis(), Ordering::Relaxed);
        return Ok(false);
    }

    // Cleanup idle watchers (>5 min since last access), skip protected kinds
    let idle_threshold = now_millis().saturating_sub(IDLE_TIMEOUT_MS);
    let idle_keys: Vec<String> = mgr
        .watchers
        .iter()
        .filter(|(k, h)| {
            !PROTECTED_KINDS.contains(&k.as_str())
                && h.last_accessed.load(Ordering::Relaxed) < idle_threshold
        })
        .map(|(k, _)| k.clone())
        .collect();
    for key in idle_keys {
        if mgr.watchers.remove(&key).is_some() {
            println!("[r3x] Evicted idle watcher '{}'", key);
        }
    }

    // Evict LRU if at max capacity (never evict protected kinds)
    if mgr.watchers.len() >= MAX_WATCHERS {
        let lru_key = mgr
            .watchers
            .iter()
            .filter(|(k, _)| !PROTECTED_KINDS.contains(&k.as_str()))
            .min_by_key(|(_, h)| h.last_accessed.load(Ordering::Relaxed))
            .map(|(k, _)| k.clone());
        if let Some(key) = lru_key {
            if mgr.watchers.remove(&key).is_some() {
                println!("[r3x] Evicted LRU watcher '{}'", key);
            }
        }
    }

    // Create kube client and API handle — always watch all namespaces
    let client = get_client(&context).await?;
    let api: Api<DynamicObject> = Api::all_with(client, &ar);

    // Set up reflector store
    let writer = reflector::store::Writer::<DynamicObject>::new(ar.clone());
    let store = writer.as_reader();
    let store_for_emitter = store.clone();

    // Channel for debounced change notifications
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::channel::<()>(1);

    let kind_key = kind.clone();
    let kind_for_log = kind.clone();

    // Task 1: Feed the reflector (LIST + WATCH loop with auto-reconnect)
    let stream_task = tokio::spawn(async move {
        let config = watcher::Config::default();
        let stream = reflector(writer, watcher(api, config));
        futures::pin_mut!(stream);
        while let Some(event) = stream.next().await {
            match event {
                Ok(_) => {
                    let _ = notify_tx.try_send(());
                }
                Err(e) => {
                    eprintln!("[r3x] Watcher error for '{}': {}", kind_for_log, e);
                }
            }
        }
        eprintln!("[r3x] Watcher stream ended for '{}'", kind_for_log);
    });

    // Task 2: Debounced emission to frontend
    let dk = display_kind.to_string();
    let emitter_task = tokio::spawn(async move {
        while notify_rx.recv().await.is_some() {
            // Debounce: wait briefly, then drain any pending notifications
            tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
            while notify_rx.try_recv().is_ok() {}

            // Read current store state and convert to K8sResource
            let objects = store_for_emitter.state();
            let mut resources: Vec<K8sResource> = objects
                .iter()
                .map(|obj| dynamic_to_resource(obj, &dk))
                .collect();
            resources.sort_by(|a, b| a.name.cmp(&b.name));

            let update = WatcherUpdate {
                kind_key: kind_key.clone(),
                resources,
            };
            let _ = app_handle.emit("watcher-update", &update);
        }
    });

    let last_accessed = Arc::new(AtomicU64::new(now_millis()));

    mgr.watchers.insert(
        kind.clone(),
        WatcherHandle {
            stream_task,
            emitter_task,
            store,
            display_kind: display_kind.to_string(),
            last_accessed,
        },
    );

    println!("[r3x] Started watcher for '{}'", kind);
    Ok(true)
}

#[tauri::command]
pub async fn stop_watcher(kind: String) -> Result<(), String> {
    let mut mgr = manager().write().await;
    if mgr.watchers.remove(&kind).is_some() {
        println!("[r3x] Stopped watcher for '{}'", kind);
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_all_watchers() -> Result<(), String> {
    let mut mgr = manager().write().await;
    let count = mgr.watchers.len();
    mgr.watchers.drain();
    mgr.context.clear();
    println!("[r3x] Stopped all {} watchers", count);
    Ok(())
}

/// Read current cached resources from a running watcher (instant, no API call).
#[tauri::command]
pub async fn get_watched_resources(kind: String) -> Result<Option<Vec<K8sResource>>, String> {
    let mgr = manager().read().await;
    if let Some(handle) = mgr.watchers.get(&kind) {
        handle.last_accessed.store(now_millis(), Ordering::Relaxed);

        let objects = handle.store.state();
        let mut resources: Vec<K8sResource> = objects
            .iter()
            .map(|obj| dynamic_to_resource(obj, &handle.display_kind))
            .collect();
        resources.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(Some(resources))
    } else {
        Ok(None)
    }
}
