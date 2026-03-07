use super::context::get_client;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Namespace, Node, PersistentVolumeClaim, Pod, Secret, Service, ServiceAccount,
};
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use kube::api::{Api, ListParams};
use kube::Client;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
        "Node" => get_yaml_cluster::<Node>(&client, &name).await,
        _ => get_yaml_dynamic(&client, &namespace, &kind, &name).await,
    }?;

    Ok(yaml)
}

async fn get_yaml_dynamic(
    client: &Client,
    namespace: &str,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    // Discover the API resource by kind using the discovery API
    let discovery = kube::discovery::Discovery::new(client.clone())
        .run()
        .await
        .map_err(|e| format!("Discovery failed: {}", e))?;

    for group in discovery.groups() {
        for (ar, caps) in group.recommended_resources() {
            if ar.kind == kind {
                let api: Api<kube::api::DynamicObject> =
                    if caps.scope == kube::discovery::Scope::Cluster {
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
                if let Some(metadata) =
                    value.get_mut("metadata").and_then(|m| m.as_object_mut())
                {
                    metadata.remove("managedFields");
                }
                return serde_yaml::to_string(&value)
                    .map_err(|e| format!("Failed to serialize YAML: {}", e));
            }
        }
    }

    Err(format!("Unknown resource kind: {}", kind))
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
    // Deployment available replicas
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
    // Service type
    if let Some(svc_type) = value.pointer("/spec/type").and_then(|v| v.as_str()) {
        if ["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"].contains(&svc_type) {
            return Some(svc_type.to_string());
        }
    }
    None
}

pub fn format_age_pub(
    timestamp: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::Time>,
) -> Option<String> {
    format_age(timestamp)
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
