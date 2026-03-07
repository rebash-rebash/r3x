use super::context::get_client;
use k8s_openapi::api::core::v1::{Node, Pod};
use k8s_openapi::api::policy::v1::Eviction;
use kube::api::{Api, ListParams, PostParams};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NodeInfo {
    pub name: String,
    pub status: String,
    pub roles: Vec<String>,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub container_runtime: String,
    pub kernel_version: String,
    pub cpu_capacity: String,
    pub memory_capacity: String,
    pub pods_capacity: String,
    pub cpu_allocatable: String,
    pub memory_allocatable: String,
    pub pods_allocatable: String,
    pub conditions: Vec<NodeCondition>,
    pub age: String,
    pub internal_ip: String,
    pub external_ip: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NodeCondition {
    pub condition_type: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub last_transition: Option<String>,
}

#[tauri::command]
pub async fn get_node_details(
    context: String,
    name: String,
) -> Result<NodeInfo, String> {
    let client = get_client(&context).await?;
    let api: Api<Node> = Api::all(client);

    let node = api
        .get(&name)
        .await
        .map_err(|e| format!("Failed to get node: {}", e))?;

    let meta = &node.metadata;
    let status = node.status.as_ref();
    let spec = node.spec.as_ref();

    let labels = meta.labels.clone().unwrap_or_default();
    let roles: Vec<String> = labels
        .keys()
        .filter(|k| k.starts_with("node-role.kubernetes.io/"))
        .map(|k| k.trim_start_matches("node-role.kubernetes.io/").to_string())
        .collect();

    let node_info = status.and_then(|s| s.node_info.as_ref());

    let ready_status = status
        .and_then(|s| s.conditions.as_ref())
        .and_then(|conds| conds.iter().find(|c| c.type_ == "Ready"))
        .map(|c| {
            if c.status == "True" {
                "Ready".to_string()
            } else {
                "NotReady".to_string()
            }
        })
        .unwrap_or_else(|| "Unknown".to_string());

    // Check for scheduling disabled
    let unschedulable = spec.and_then(|s| s.unschedulable).unwrap_or(false);
    let final_status = if unschedulable {
        format!("{},SchedulingDisabled", ready_status)
    } else {
        ready_status
    };

    let conditions: Vec<NodeCondition> = status
        .and_then(|s| s.conditions.as_ref())
        .map(|conds| {
            conds
                .iter()
                .map(|c| NodeCondition {
                    condition_type: c.type_.clone(),
                    status: c.status.clone(),
                    reason: c.reason.clone(),
                    message: c.message.clone(),
                    last_transition: c
                        .last_transition_time
                        .as_ref()
                        .map(|t| t.0.format("%Y-%m-%d %H:%M:%S").to_string()),
                })
                .collect()
        })
        .unwrap_or_default();

    let capacity = status.and_then(|s| s.capacity.as_ref());
    let allocatable = status.and_then(|s| s.allocatable.as_ref());

    let get_quantity = |map: Option<&std::collections::BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>, key: &str| -> String {
        map.and_then(|m| m.get(key))
            .map(|q| q.0.clone())
            .unwrap_or_else(|| "-".to_string())
    };

    let addresses = status.and_then(|s| s.addresses.as_ref());
    let get_addr = |addr_type: &str| -> String {
        addresses
            .and_then(|addrs| addrs.iter().find(|a| a.type_ == addr_type))
            .map(|a| a.address.clone())
            .unwrap_or_else(|| "-".to_string())
    };

    let age = super::resources::format_age_pub(meta.creation_timestamp.as_ref())
        .unwrap_or_else(|| "-".to_string());

    Ok(NodeInfo {
        name: meta.name.clone().unwrap_or_default(),
        status: final_status,
        roles: if roles.is_empty() { vec!["<none>".to_string()] } else { roles },
        version: node_info.map(|i| i.kubelet_version.clone()).unwrap_or_default(),
        os: node_info.map(|i| i.os_image.clone()).unwrap_or_default(),
        arch: node_info.map(|i| i.architecture.clone()).unwrap_or_default(),
        container_runtime: node_info.map(|i| i.container_runtime_version.clone()).unwrap_or_default(),
        kernel_version: node_info.map(|i| i.kernel_version.clone()).unwrap_or_default(),
        cpu_capacity: get_quantity(capacity, "cpu"),
        memory_capacity: get_quantity(capacity, "memory"),
        pods_capacity: get_quantity(capacity, "pods"),
        cpu_allocatable: get_quantity(allocatable, "cpu"),
        memory_allocatable: get_quantity(allocatable, "memory"),
        pods_allocatable: get_quantity(allocatable, "pods"),
        conditions,
        age,
        internal_ip: get_addr("InternalIP"),
        external_ip: get_addr("ExternalIP"),
    })
}

#[tauri::command]
pub async fn cordon_node(context: String, name: String) -> Result<String, String> {
    let client = get_client(&context).await?;
    let api: Api<Node> = Api::all(client);

    let patch = serde_json::json!({
        "spec": { "unschedulable": true }
    });
    api.patch(
        &name,
        &kube::api::PatchParams::default(),
        &kube::api::Patch::Merge(patch),
    )
    .await
    .map_err(|e| format!("Failed to cordon node: {}", e))?;

    Ok(format!("Node '{}' cordoned", name))
}

#[tauri::command]
pub async fn uncordon_node(context: String, name: String) -> Result<String, String> {
    let client = get_client(&context).await?;
    let api: Api<Node> = Api::all(client);

    let patch = serde_json::json!({
        "spec": { "unschedulable": false }
    });
    api.patch(
        &name,
        &kube::api::PatchParams::default(),
        &kube::api::Patch::Merge(patch),
    )
    .await
    .map_err(|e| format!("Failed to uncordon node: {}", e))?;

    Ok(format!("Node '{}' uncordoned", name))
}

#[tauri::command]
pub async fn drain_node(
    context: String,
    name: String,
    ignore_daemonsets: bool,
) -> Result<String, String> {
    let client = get_client(&context).await?;

    // 1. Cordon the node first
    let node_api: Api<Node> = Api::all(client.clone());
    let patch = serde_json::json!({
        "spec": { "unschedulable": true }
    });
    node_api
        .patch(
            &name,
            &kube::api::PatchParams::default(),
            &kube::api::Patch::Merge(patch),
        )
        .await
        .map_err(|e| format!("Failed to cordon node: {}", e))?;

    // 2. List all pods on this node
    let pod_api: Api<Pod> = Api::all(client.clone());
    let pods = pod_api
        .list(&ListParams::default().fields(&format!("spec.nodeName={}", name)))
        .await
        .map_err(|e| format!("Failed to list pods on node: {}", e))?;

    let mut evicted = 0;
    let mut skipped = 0;
    let mut errors = Vec::new();

    for pod in &pods.items {
        let pod_name = pod.metadata.name.as_deref().unwrap_or("");
        let pod_ns = pod.metadata.namespace.as_deref().unwrap_or("default");

        // Skip mirror pods (static pods managed by kubelet)
        if let Some(annotations) = &pod.metadata.annotations {
            if annotations.contains_key("kubernetes.io/config.mirror") {
                skipped += 1;
                continue;
            }
        }

        // Skip DaemonSet pods if requested
        if ignore_daemonsets {
            if let Some(refs) = &pod.metadata.owner_references {
                if refs.iter().any(|r| r.kind == "DaemonSet") {
                    skipped += 1;
                    continue;
                }
            }
        }

        // Evict the pod
        let eviction = Eviction {
            metadata: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta {
                name: Some(pod_name.to_string()),
                namespace: Some(pod_ns.to_string()),
                ..Default::default()
            },
            delete_options: None,
        };

        let eviction_bytes = serde_json::to_vec(&eviction)
            .map_err(|e| format!("Failed to serialize eviction: {}", e))?;

        let ns_pod_api: Api<Pod> = Api::namespaced(client.clone(), pod_ns);
        match ns_pod_api
            .create_subresource::<Eviction>("eviction", pod_name, &PostParams::default(), eviction_bytes)
            .await
        {
            Ok(_) => evicted += 1,
            Err(e) => errors.push(format!("{}/{}: {}", pod_ns, pod_name, e)),
        }
    }

    let mut msg = format!(
        "Node '{}' drained: {} evicted, {} skipped",
        name, evicted, skipped
    );
    if !errors.is_empty() {
        msg.push_str(&format!(", {} errors: {}", errors.len(), errors.join("; ")));
    }
    Ok(msg)
}
