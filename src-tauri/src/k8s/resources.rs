use super::context::get_client;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Namespace, Node, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service,
    ServiceAccount,
};
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use kube::api::{Api, ListParams};
use kube::Client;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Cached resolved API resources from discovery, keyed by kind.
struct ResolvedApiResource {
    ar: kube::api::ApiResource,
    scope: kube::discovery::Scope,
}

struct DiscoveryCache {
    context: String,
    resources: std::collections::HashMap<String, ResolvedApiResource>,
    created_at: std::time::Instant,
}

static DISCOVERY_CACHE: std::sync::OnceLock<Arc<RwLock<Option<DiscoveryCache>>>> =
    std::sync::OnceLock::new();

fn discovery_cache() -> &'static Arc<RwLock<Option<DiscoveryCache>>> {
    DISCOVERY_CACHE.get_or_init(|| Arc::new(RwLock::new(None)))
}

/// Max age for discovery cache (5 minutes).
const DISCOVERY_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(300);

async fn get_cached_api_resource(
    client: &Client,
    context: &str,
    kind: &str,
) -> Result<Option<(kube::api::ApiResource, kube::discovery::Scope)>, String> {
    // Check cache
    {
        let guard = discovery_cache().read().await;
        if let Some(cached) = guard.as_ref() {
            if cached.context == context && cached.created_at.elapsed() < DISCOVERY_MAX_AGE {
                return Ok(cached.resources.get(kind).map(|r| (r.ar.clone(), r.scope.clone())));
            }
        }
    }

    // Run full discovery and cache all resources
    let discovery = kube::discovery::Discovery::new(client.clone())
        .run()
        .await
        .map_err(|e| format!("Discovery failed: {}", e))?;

    let mut resources = std::collections::HashMap::new();
    for group in discovery.groups() {
        for (ar, caps) in group.recommended_resources() {
            resources.insert(ar.kind.clone(), ResolvedApiResource {
                ar: ar.clone(),
                scope: caps.scope.clone(),
            });
        }
    }

    let result = resources.get(kind).map(|r| (r.ar.clone(), r.scope.clone()));

    let mut guard = discovery_cache().write().await;
    *guard = Some(DiscoveryCache {
        context: context.to_string(),
        resources,
        created_at: std::time::Instant::now(),
    });

    Ok(result)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct K8sResource {
    pub name: String,
    pub namespace: Option<String>,
    pub kind: String,
    pub status: Option<String>,
    pub age: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub extra: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NamespaceInfo {
    pub name: String,
    pub status: String,
    pub age: String,
}

#[tauri::command]
pub async fn list_namespaces(context: String) -> Result<Vec<NamespaceInfo>, String> {
    let client = get_client(&context).await?;
    let api: Api<Namespace> = Api::all(client);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list namespaces: {}", e))?;

    let namespaces = list
        .items
        .into_iter()
        .map(|ns| {
            let meta = ns.metadata;
            let status = ns
                .status
                .and_then(|s| s.phase)
                .unwrap_or_else(|| "Unknown".to_string());
            let age = format_age(meta.creation_timestamp.as_ref())
                .unwrap_or_else(|| "-".to_string());
            NamespaceInfo {
                name: meta.name.unwrap_or_default(),
                status,
                age,
            }
        })
        .collect();

    Ok(namespaces)
}

#[tauri::command]
pub async fn list_resources(
    context: String,
    namespace: String,
    kind: String,
    label_selector: Option<String>,
) -> Result<Vec<K8sResource>, String> {
    let client = get_client(&context).await?;
    let ls = label_selector.as_deref().unwrap_or("");
    match kind.as_str() {
        "pods" => list_typed_resources::<Pod>(&client, &namespace, "Pod", ls).await,
        "deployments" => {
            list_typed_resources::<Deployment>(&client, &namespace, "Deployment", ls).await
        }
        "services" => list_typed_resources::<Service>(&client, &namespace, "Service", ls).await,
        "configmaps" => {
            list_typed_resources::<ConfigMap>(&client, &namespace, "ConfigMap", ls).await
        }
        "secrets" => list_typed_resources::<Secret>(&client, &namespace, "Secret", ls).await,
        "statefulsets" => {
            list_typed_resources::<StatefulSet>(&client, &namespace, "StatefulSet", ls).await
        }
        "daemonsets" => {
            list_typed_resources::<DaemonSet>(&client, &namespace, "DaemonSet", ls).await
        }
        "replicasets" => {
            list_typed_resources::<ReplicaSet>(&client, &namespace, "ReplicaSet", ls).await
        }
        "jobs" => list_typed_resources::<Job>(&client, &namespace, "Job", ls).await,
        "cronjobs" => list_typed_resources::<CronJob>(&client, &namespace, "CronJob", ls).await,
        "ingresses" => list_typed_resources::<Ingress>(&client, &namespace, "Ingress", ls).await,
        "networkpolicies" => {
            list_typed_resources::<NetworkPolicy>(&client, &namespace, "NetworkPolicy", ls).await
        }
        "serviceaccounts" => {
            list_typed_resources::<ServiceAccount>(&client, &namespace, "ServiceAccount", ls).await
        }
        "persistentvolumeclaims" => {
            list_typed_resources::<PersistentVolumeClaim>(&client, &namespace, "PersistentVolumeClaim", ls)
                .await
        }
        "persistentvolumes" => list_pvs(&client).await,
        "nodes" => list_nodes(&client).await,
        _ => Err(format!("Unknown resource kind: {}", kind)),
    }
}

async fn list_typed_resources<K>(
    client: &Client,
    namespace: &str,
    kind: &str,
    label_selector: &str,
) -> Result<Vec<K8sResource>, String>
where
    K: kube::api::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned
        + serde::Serialize
        + k8s_openapi::Metadata<Ty = k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta>,
    <K as kube::api::Resource>::DynamicType: Default,
{
    let api: Api<K> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), namespace)
    };

    let mut lp = ListParams::default();
    if !label_selector.is_empty() {
        lp = lp.labels(label_selector);
    }
    let list = api
        .list(&lp)
        .await
        .map_err(|e| format!("Failed to list {}: {}", kind, e))?;

    let resources = list
        .items
        .into_iter()
        .map(|item| {
            let meta = item.metadata().clone();
            let extra =
                serde_json::to_value(&item).unwrap_or(serde_json::Value::Null);
            K8sResource {
                name: meta.name.unwrap_or_default(),
                namespace: meta.namespace,
                kind: kind.to_string(),
                status: extract_status(&extra),
                age: format_age(meta.creation_timestamp.as_ref()),
                labels: meta.labels.unwrap_or_default(),
                extra,
            }
        })
        .collect();

    Ok(resources)
}

async fn list_pvs(client: &Client) -> Result<Vec<K8sResource>, String> {
    let api: Api<PersistentVolume> = Api::all(client.clone());
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list persistent volumes: {}", e))?;

    let resources = list
        .items
        .into_iter()
        .map(|pv| {
            let meta = pv.metadata.clone();
            let status_str = pv
                .status
                .as_ref()
                .and_then(|s| s.phase.clone());
            let extra = serde_json::to_value(&pv).unwrap_or(serde_json::Value::Null);
            K8sResource {
                name: meta.name.unwrap_or_default(),
                namespace: None,
                kind: "PersistentVolume".to_string(),
                status: status_str,
                age: format_age(meta.creation_timestamp.as_ref()),
                labels: meta.labels.unwrap_or_default(),
                extra,
            }
        })
        .collect();

    Ok(resources)
}

async fn list_nodes(client: &Client) -> Result<Vec<K8sResource>, String> {
    let api: Api<Node> = Api::all(client.clone());
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list nodes: {}", e))?;

    let resources = list
        .items
        .into_iter()
        .map(|node| {
            let meta = node.metadata.clone();
            let status_str = node
                .status
                .as_ref()
                .and_then(|s| s.conditions.as_ref())
                .and_then(|conds| {
                    conds
                        .iter()
                        .find(|c| c.type_ == "Ready")
                        .map(|c| {
                            if c.status == "True" {
                                "Ready".to_string()
                            } else {
                                "NotReady".to_string()
                            }
                        })
                });
            let extra = serde_json::to_value(&node).unwrap_or(serde_json::Value::Null);
            K8sResource {
                name: meta.name.unwrap_or_default(),
                namespace: None,
                kind: "Node".to_string(),
                status: status_str,
                age: format_age(meta.creation_timestamp.as_ref()),
                labels: meta.labels.unwrap_or_default(),
                extra,
            }
        })
        .collect();

    Ok(resources)
}

#[tauri::command]
pub async fn get_resource_yaml(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<String, String> {
    let client = get_client(&context).await?;

    let yaml = match kind.as_str() {
        "Pod" => get_yaml::<Pod>(&client, &namespace, &name).await,
        "Deployment" => get_yaml::<Deployment>(&client, &namespace, &name).await,
        "Service" => get_yaml::<Service>(&client, &namespace, &name).await,
        "ConfigMap" => get_yaml::<ConfigMap>(&client, &namespace, &name).await,
        "Secret" => get_yaml::<Secret>(&client, &namespace, &name).await,
        "StatefulSet" => get_yaml::<StatefulSet>(&client, &namespace, &name).await,
        "DaemonSet" => get_yaml::<DaemonSet>(&client, &namespace, &name).await,
        "ReplicaSet" => get_yaml::<ReplicaSet>(&client, &namespace, &name).await,
        "Job" => get_yaml::<Job>(&client, &namespace, &name).await,
        "CronJob" => get_yaml::<CronJob>(&client, &namespace, &name).await,
        "Ingress" => get_yaml::<Ingress>(&client, &namespace, &name).await,
        "NetworkPolicy" => get_yaml::<NetworkPolicy>(&client, &namespace, &name).await,
        "ServiceAccount" => get_yaml::<ServiceAccount>(&client, &namespace, &name).await,
        "PersistentVolumeClaim" => {
            get_yaml::<PersistentVolumeClaim>(&client, &namespace, &name).await
        }
        "PersistentVolume" => get_yaml_cluster::<PersistentVolume>(&client, &name).await,
        "Node" => get_yaml_cluster::<Node>(&client, &name).await,
        _ => get_yaml_dynamic(&client, &namespace, &kind, &name, &context).await,
    }?;

    Ok(yaml)
}

async fn get_yaml_dynamic(
    client: &Client,
    namespace: &str,
    kind: &str,
    name: &str,
    context: &str,
) -> Result<String, String> {
    if let Some((ar, scope)) = get_cached_api_resource(client, context, kind).await? {
        let api: Api<kube::api::DynamicObject> = if scope == kube::discovery::Scope::Cluster {
            Api::all_with(client.clone(), &ar)
        } else {
            Api::namespaced_with(client.clone(), namespace, &ar)
        };

        let resource = api
            .get(name)
            .await
            .map_err(|e| format!("Failed to get resource: {}", e))?;

        let mut value = serde_json::to_value(&resource)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        if let Some(metadata) = value.get_mut("metadata").and_then(|m| m.as_object_mut()) {
            metadata.remove("managedFields");
        }
        return serde_yaml::to_string(&value)
            .map_err(|e| format!("Failed to serialize YAML: {}", e));
    }

    Err(format!("Unknown resource kind: {}", kind))
}

/// Fast YAML fetch for dynamic resources when we already know the API resource info.
/// Skips discovery entirely.
#[tauri::command]
pub async fn get_dynamic_resource_yaml(
    context: String,
    namespace: String,
    name: String,
    group: String,
    version: String,
    plural: String,
    kind: String,
    scope: String,
) -> Result<String, String> {
    let client = get_client(&context).await?;
    let ar = kube::api::ApiResource {
        group: group.clone(),
        version: version.clone(),
        api_version: if group.is_empty() { version } else { format!("{}/{}", group, version) },
        kind,
        plural,
    };
    let is_cluster = scope == "Cluster";
    let api: Api<kube::api::DynamicObject> = if is_cluster {
        Api::all_with(client.clone(), &ar)
    } else {
        Api::namespaced_with(client.clone(), &namespace, &ar)
    };

    let resource = api
        .get(&name)
        .await
        .map_err(|e| format!("Failed to get resource: {}", e))?;

    let mut value = serde_json::to_value(&resource)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    if let Some(metadata) = value.get_mut("metadata").and_then(|m| m.as_object_mut()) {
        metadata.remove("managedFields");
    }
    serde_yaml::to_string(&value).map_err(|e| format!("Failed to serialize YAML: {}", e))
}



async fn get_yaml<K>(client: &Client, namespace: &str, name: &str) -> Result<String, String>
where
    K: kube::api::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned
        + serde::Serialize
        + k8s_openapi::Metadata<Ty = k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta>,
    <K as kube::api::Resource>::DynamicType: Default,
{
    let api: Api<K> = Api::namespaced(client.clone(), namespace);
    let resource = api
        .get(name)
        .await
        .map_err(|e| format!("Failed to get resource: {}", e))?;

    // Strip managedFields from display (like k9s)
    let mut value = serde_json::to_value(&resource)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    if let Some(metadata) = value.get_mut("metadata").and_then(|m| m.as_object_mut()) {
        metadata.remove("managedFields");
    }
    serde_yaml::to_string(&value).map_err(|e| format!("Failed to serialize YAML: {}", e))
}

async fn get_yaml_cluster<K>(client: &Client, name: &str) -> Result<String, String>
where
    K: kube::api::Resource<Scope = k8s_openapi::ClusterResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned
        + serde::Serialize
        + k8s_openapi::Metadata<Ty = k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta>,
    <K as kube::api::Resource>::DynamicType: Default,
{
    let api: Api<K> = Api::all(client.clone());
    let resource = api
        .get(name)
        .await
        .map_err(|e| format!("Failed to get resource: {}", e))?;

    let mut value = serde_json::to_value(&resource)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    if let Some(metadata) = value.get_mut("metadata").and_then(|m| m.as_object_mut()) {
        metadata.remove("managedFields");
    }
    serde_yaml::to_string(&value).map_err(|e| format!("Failed to serialize YAML: {}", e))
}

#[tauri::command]
pub async fn delete_resource(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<String, String> {
    let client = get_client(&context).await?;
    match kind.as_str() {
        "Pod" => delete_typed::<Pod>(&client, &namespace, &name).await,
        "Deployment" => delete_typed::<Deployment>(&client, &namespace, &name).await,
        "Service" => delete_typed::<Service>(&client, &namespace, &name).await,
        "ConfigMap" => delete_typed::<ConfigMap>(&client, &namespace, &name).await,
        "Secret" => delete_typed::<Secret>(&client, &namespace, &name).await,
        "Job" => delete_typed::<Job>(&client, &namespace, &name).await,
        _ => Err(format!("Delete not supported for kind: {}", kind)),
    }
}

async fn delete_typed<K>(client: &Client, namespace: &str, name: &str) -> Result<String, String>
where
    K: kube::api::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    <K as kube::api::Resource>::DynamicType: Default,
{
    let api: Api<K> = Api::namespaced(client.clone(), namespace);
    api.delete(name, &Default::default())
        .await
        .map_err(|e| format!("Failed to delete resource: {}", e))?;
    Ok(format!("Deleted {} '{}'", std::any::type_name::<K>(), name))
}

#[tauri::command]
pub async fn get_resource_pods(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<Vec<K8sResource>, String> {
    let client = get_client(&context).await?;

    // Get the resource's selector labels
    let selector = match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("Failed to get deployment: {}", e))?;
            res.spec.and_then(|s| s.selector.match_labels).unwrap_or_default()
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("Failed to get statefulset: {}", e))?;
            res.spec.and_then(|s| s.selector.match_labels).unwrap_or_default()
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("Failed to get daemonset: {}", e))?;
            res.spec.and_then(|s| s.selector.match_labels).unwrap_or_default()
        }
        "ReplicaSet" => {
            let api: Api<ReplicaSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("Failed to get replicaset: {}", e))?;
            res.spec.and_then(|s| s.selector.match_labels).unwrap_or_default()
        }
        _ => return Err(format!("Unsupported kind for pod lookup: {}", kind)),
    };

    if selector.is_empty() {
        return Ok(vec![]);
    }

    let label_selector = selector
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(",");

    let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let list = api
        .list(&ListParams::default().labels(&label_selector))
        .await
        .map_err(|e| format!("Failed to list pods: {}", e))?;

    let resources = list
        .items
        .into_iter()
        .map(|item| {
            let meta = item.metadata.clone();
            let extra = serde_json::to_value(&item).unwrap_or(serde_json::Value::Null);
            K8sResource {
                name: meta.name.unwrap_or_default(),
                namespace: meta.namespace,
                kind: "Pod".to_string(),
                status: extract_status(&extra),
                age: format_age(meta.creation_timestamp.as_ref()),
                labels: meta.labels.unwrap_or_default(),
                extra,
            }
        })
        .collect();

    Ok(resources)
}

#[tauri::command]
pub async fn apply_resource_yaml(
    context: String,
    yaml_content: String,
) -> Result<String, String> {
    let client = get_client(&context).await?;

    // Parse YAML into a mutable JSON value
    let mut value: serde_json::Value =
        serde_yaml::from_str(&yaml_content).map_err(|e| format!("Invalid YAML: {}", e))?;

    let api_version = value
        .get("apiVersion")
        .and_then(|v| v.as_str())
        .ok_or("Missing apiVersion")?
        .to_string();
    let kind = value
        .get("kind")
        .and_then(|v| v.as_str())
        .ok_or("Missing kind")?
        .to_string();
    let name = value
        .pointer("/metadata/name")
        .and_then(|v| v.as_str())
        .ok_or("Missing metadata.name")?
        .to_string();
    let namespace = value
        .pointer("/metadata/namespace")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();

    // Strip server-managed fields (like k9s does before applying)
    if let Some(metadata) = value.get_mut("metadata").and_then(|m| m.as_object_mut()) {
        metadata.remove("managedFields");
        metadata.remove("resourceVersion");
        metadata.remove("uid");
        metadata.remove("creationTimestamp");
        metadata.remove("generation");
        metadata.remove("selfLink");
        // Clean up annotations that are server-managed
        if let Some(annotations) = metadata.get_mut("annotations").and_then(|a| a.as_object_mut()) {
            annotations.remove("kubectl.kubernetes.io/last-applied-configuration");
        }
    }
    // Remove status — it's read-only for most resources
    value.as_object_mut().map(|obj| obj.remove("status"));

    // Determine group and version from apiVersion
    let (group, version) = if api_version.contains('/') {
        let parts: Vec<&str> = api_version.splitn(2, '/').collect();
        (parts[0].to_string(), parts[1].to_string())
    } else {
        ("".to_string(), api_version.clone())
    };

    // Map kind to plural resource name
    let plural = kind_to_plural(&kind);

    let ar = kube::api::ApiResource {
        group,
        version,
        api_version,
        kind: kind.clone(),
        plural,
    };

    let api: Api<kube::api::DynamicObject> =
        Api::namespaced_with(client.clone(), &namespace, &ar);

    // Convert to DynamicObject
    let obj: kube::api::DynamicObject =
        serde_json::from_value(value).map_err(|e| format!("Failed to parse resource: {}", e))?;

    // Use server-side apply
    let params = kube::api::PatchParams::apply("r3x").force();
    let patch = kube::api::Patch::Apply(&obj);
    api.patch(&name, &params, &patch)
        .await
        .map_err(|e| format!("Failed to apply resource: {}", e))?;

    Ok(format!("{} '{}' applied successfully", kind, name))
}

fn kind_to_plural(kind: &str) -> String {
    match kind {
        "Pod" => "pods",
        "Deployment" => "deployments",
        "Service" => "services",
        "ConfigMap" => "configmaps",
        "Secret" => "secrets",
        "StatefulSet" => "statefulsets",
        "DaemonSet" => "daemonsets",
        "ReplicaSet" => "replicasets",
        "Job" => "jobs",
        "CronJob" => "cronjobs",
        "Ingress" => "ingresses",
        "NetworkPolicy" => "networkpolicies",
        "ServiceAccount" => "serviceaccounts",
        "PersistentVolume" => "persistentvolumes",
        "PersistentVolumeClaim" => "persistentvolumeclaims",
        "Namespace" => "namespaces",
        "Node" => "nodes",
        "HorizontalPodAutoscaler" => "horizontalpodautoscalers",
        "PodDisruptionBudget" => "poddisruptionbudgets",
        "Role" => "roles",
        "RoleBinding" => "rolebindings",
        "ClusterRole" => "clusterroles",
        "ClusterRoleBinding" => "clusterrolebindings",
        _ => {
            let lower = kind.to_lowercase();
            return if lower.ends_with('s') {
                lower
            } else {
                format!("{}s", lower)
            };
        }
    }
    .to_string()
}

fn extract_status(value: &serde_json::Value) -> Option<String> {
    // Pod phase
    if let Some(phase) = value.pointer("/status/phase").and_then(|v| v.as_str()) {
        return Some(phase.to_string());
    }
    // Deployment/StatefulSet/ReplicaSet/DaemonSet available replicas
    if let (Some(desired), Some(ready)) = (
        value
            .pointer("/status/replicas")
            .and_then(|v| v.as_i64()),
        value
            .pointer("/status/readyReplicas")
            .and_then(|v| v.as_i64()),
    ) {
        return Some(format!("{}/{}", ready, desired));
    }
    // DaemonSet: desiredNumberScheduled / numberReady
    if let (Some(desired), Some(ready)) = (
        value
            .pointer("/status/desiredNumberScheduled")
            .and_then(|v| v.as_i64()),
        value
            .pointer("/status/numberReady")
            .and_then(|v| v.as_i64()),
    ) {
        return Some(format!("{}/{}", ready, desired));
    }
    // Node: Ready/NotReady from conditions
    if let Some(conditions) = value.pointer("/status/conditions").and_then(|v| v.as_array()) {
        if let Some(ready_cond) = conditions.iter().find(|c| {
            c.get("type").and_then(|t| t.as_str()) == Some("Ready")
        }) {
            let status = ready_cond.get("status").and_then(|s| s.as_str()).unwrap_or("Unknown");
            return Some(if status == "True" { "Ready".to_string() } else { "NotReady".to_string() });
        }
    }
    // PersistentVolume: phase
    if let Some(phase) = value.pointer("/status/phase").and_then(|v| v.as_str()) {
        return Some(phase.to_string());
    }
    // Service type
    if let Some(svc_type) = value.pointer("/spec/type").and_then(|v| v.as_str()) {
        if ["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"].contains(&svc_type) {
            return Some(svc_type.to_string());
        }
    }
    // Job: completions
    if let Some(succeeded) = value.pointer("/status/succeeded").and_then(|v| v.as_i64()) {
        let completions = value.pointer("/spec/completions").and_then(|v| v.as_i64()).unwrap_or(1);
        return Some(format!("{}/{}", succeeded, completions));
    }
    // Job active/failed
    if value.pointer("/spec/completions").is_some() {
        let active = value.pointer("/status/active").and_then(|v| v.as_i64()).unwrap_or(0);
        let failed = value.pointer("/status/failed").and_then(|v| v.as_i64()).unwrap_or(0);
        if failed > 0 {
            return Some(format!("Failed({})", failed));
        }
        if active > 0 {
            return Some("Running".to_string());
        }
    }
    // CronJob: schedule + suspend
    if let Some(schedule) = value.pointer("/spec/schedule").and_then(|v| v.as_str()) {
        let suspended = value.pointer("/spec/suspend").and_then(|v| v.as_bool()).unwrap_or(false);
        return Some(if suspended {
            format!("{} (Suspended)", schedule)
        } else {
            schedule.to_string()
        });
    }
    // ConfigMap: data count
    if let Some(data) = value.get("data").and_then(|v| v.as_object()) {
        return Some(format!("{} keys", data.len()));
    }
    // Secret: data count + type
    if let Some(secret_type) = value.pointer("/type").and_then(|v| v.as_str()) {
        if secret_type.contains("kubernetes.io") || secret_type.contains("/") || secret_type == "Opaque" {
            let count = value.get("data").and_then(|v| v.as_object()).map(|d| d.len()).unwrap_or(0);
            return Some(format!("{} ({} keys)", secret_type, count));
        }
    }
    // Ingress: hosts
    if let Some(rules) = value.pointer("/spec/rules").and_then(|v| v.as_array()) {
        let hosts: Vec<&str> = rules.iter()
            .filter_map(|r| r.get("host").and_then(|h| h.as_str()))
            .collect();
        if !hosts.is_empty() {
            return Some(hosts.join(", "));
        }
    }
    // ServiceAccount: just show "Active"
    if value.get("secrets").is_some() || value.get("automountServiceAccountToken").is_some()
        || value.pointer("/metadata/name").is_some() && value.get("kind").and_then(|k| k.as_str()) == Some("ServiceAccount")
    {
        // ServiceAccounts don't have a real status, show token status
        let automount = value.get("automountServiceAccountToken").and_then(|v| v.as_bool()).unwrap_or(true);
        return Some(if automount { "AutoMount".to_string() } else { "NoAutoMount".to_string() });
    }
    // PVC: phase
    if let Some(phase) = value.pointer("/status/phase").and_then(|v| v.as_str()) {
        return Some(phase.to_string());
    }
    None
}

pub fn format_age_pub(
    timestamp: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::Time>,
) -> Option<String> {
    format_age(timestamp)
}

pub fn extract_status_pub(value: &serde_json::Value) -> Option<String> {
    extract_status(value)
}

fn format_age(
    timestamp: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::Time>,
) -> Option<String> {
    let ts = timestamp?;
    let created = ts.0;
    let now = chrono::Utc::now();
    let duration = now.signed_duration_since(created);

    let seconds = duration.num_seconds();
    if seconds < 60 {
        Some(format!("{}s", seconds))
    } else if seconds < 3600 {
        Some(format!("{}m", seconds / 60))
    } else if seconds < 86400 {
        Some(format!("{}h", seconds / 3600))
    } else {
        Some(format!("{}d", seconds / 86400))
    }
}
