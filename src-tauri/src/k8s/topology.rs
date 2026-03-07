use super::context::get_client;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopoNode {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub status: Option<String>,
    pub children: Vec<TopoNode>,
}

#[tauri::command]
pub async fn get_topology(
    context: String,
    namespace: String,
) -> Result<Vec<TopoNode>, String> {
    let client = get_client(&context).await?;
    let mut roots: Vec<TopoNode> = Vec::new();

    // Fetch all relevant resources in parallel
    let (deployments, statefulsets, daemonsets, replicasets, pods) = tokio::try_join!(
        fetch_deployments(&client, &namespace),
        fetch_statefulsets(&client, &namespace),
        fetch_daemonsets(&client, &namespace),
        fetch_replicasets(&client, &namespace),
        fetch_pods(&client, &namespace),
    )?;

    // Index pods by owner reference
    let mut pods_by_owner: BTreeMap<String, Vec<PodInfo>> = BTreeMap::new();
    let mut orphan_pods: Vec<PodInfo> = Vec::new();

    for pod in &pods {
        if let Some(owner_key) = &pod.owner_key {
            pods_by_owner.entry(owner_key.clone()).or_default().push(pod.clone());
        } else {
            orphan_pods.push(pod.clone());
        }
    }

    // Index replicasets by owner
    let mut rs_by_owner: BTreeMap<String, Vec<RSInfo>> = BTreeMap::new();
    let mut orphan_rs: Vec<RSInfo> = Vec::new();

    for rs in &replicasets {
        if let Some(owner_key) = &rs.owner_key {
            rs_by_owner.entry(owner_key.clone()).or_default().push(rs.clone());
        } else {
            orphan_rs.push(rs.clone());
        }
    }

    // Build Deployment trees: Deployment -> ReplicaSet -> Pod -> Containers
    for dep in &deployments {
        let dep_key = format!("Deployment/{}/{}", dep.namespace, dep.name);
        let child_rs = rs_by_owner.remove(&dep_key).unwrap_or_default();

        let rs_nodes: Vec<TopoNode> = child_rs.into_iter().map(|rs| {
            let rs_key = format!("ReplicaSet/{}/{}", rs.namespace, rs.name);
            let child_pods = pods_by_owner.remove(&rs_key).unwrap_or_default();
            let pod_nodes = build_pod_nodes(child_pods);

            TopoNode {
                id: rs_key,
                kind: "ReplicaSet".into(),
                name: rs.name,
                namespace: rs.namespace,
                status: Some(rs.status),
                children: pod_nodes,
            }
        }).collect();

        roots.push(TopoNode {
            id: dep_key,
            kind: "Deployment".into(),
            name: dep.name.clone(),
            namespace: dep.namespace.clone(),
            status: Some(dep.status.clone()),
            children: rs_nodes,
        });
    }

    // Build StatefulSet trees: StatefulSet -> Pod -> Containers
    for ss in &statefulsets {
        let ss_key = format!("StatefulSet/{}/{}", ss.namespace, ss.name);
        let child_pods = pods_by_owner.remove(&ss_key).unwrap_or_default();
        let pod_nodes = build_pod_nodes(child_pods);

        roots.push(TopoNode {
            id: ss_key,
            kind: "StatefulSet".into(),
            name: ss.name.clone(),
            namespace: ss.namespace.clone(),
            status: Some(ss.status.clone()),
            children: pod_nodes,
        });
    }

    // Build DaemonSet trees: DaemonSet -> Pod -> Containers
    for ds in &daemonsets {
        let ds_key = format!("DaemonSet/{}/{}", ds.namespace, ds.name);
        let child_pods = pods_by_owner.remove(&ds_key).unwrap_or_default();
        let pod_nodes = build_pod_nodes(child_pods);

        roots.push(TopoNode {
            id: ds_key,
            kind: "DaemonSet".into(),
            name: ds.name.clone(),
            namespace: ds.namespace.clone(),
            status: Some(ds.status.clone()),
            children: pod_nodes,
        });
    }

    // Orphan ReplicaSets (not owned by a Deployment)
    for rs in orphan_rs {
        let rs_key = format!("ReplicaSet/{}/{}", rs.namespace, rs.name);
        let child_pods = pods_by_owner.remove(&rs_key).unwrap_or_default();
        let pod_nodes = build_pod_nodes(child_pods);

        roots.push(TopoNode {
            id: rs_key,
            kind: "ReplicaSet".into(),
            name: rs.name,
            namespace: rs.namespace,
            status: Some(rs.status),
            children: pod_nodes,
        });
    }

    // Orphan pods (not owned by any controller)
    for pod in orphan_pods {
        roots.push(TopoNode {
            id: format!("Pod/{}/{}", pod.namespace, pod.name),
            kind: "Pod".into(),
            name: pod.name,
            namespace: pod.namespace,
            status: Some(pod.status),
            children: pod.containers.into_iter().map(|c| TopoNode {
                id: format!("Container/{}", c),
                kind: "Container".into(),
                name: c,
                namespace: String::new(),
                status: None,
                children: vec![],
            }).collect(),
        });
    }

    Ok(roots)
}

fn build_pod_nodes(pods: Vec<PodInfo>) -> Vec<TopoNode> {
    pods.into_iter().map(|pod| {
        let container_nodes: Vec<TopoNode> = pod.containers.into_iter().map(|c| TopoNode {
            id: format!("Container/{}/{}", pod.name, c),
            kind: "Container".into(),
            name: c,
            namespace: String::new(),
            status: None,
            children: vec![],
        }).collect();

        TopoNode {
            id: format!("Pod/{}/{}", pod.namespace, pod.name),
            kind: "Pod".into(),
            name: pod.name,
            namespace: pod.namespace,
            status: Some(pod.status),
            children: container_nodes,
        }
    }).collect()
}

// ---- Internal data structs ----

#[derive(Clone)]
struct DeploymentInfo {
    name: String,
    namespace: String,
    status: String,
}

#[derive(Clone)]
struct RSInfo {
    name: String,
    namespace: String,
    status: String,
    owner_key: Option<String>,
}

#[derive(Clone)]
struct StatefulSetInfo {
    name: String,
    namespace: String,
    status: String,
}

#[derive(Clone)]
struct DaemonSetInfo {
    name: String,
    namespace: String,
    status: String,
}

#[derive(Clone)]
struct PodInfo {
    name: String,
    namespace: String,
    status: String,
    containers: Vec<String>,
    owner_key: Option<String>,
}

fn owner_key(meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta) -> Option<String> {
    let owners = meta.owner_references.as_ref()?;
    let owner = owners.first()?;
    let ns = meta.namespace.as_deref().unwrap_or("default");
    Some(format!("{}/{}/{}", owner.kind, ns, owner.name))
}

async fn fetch_deployments(client: &kube::Client, namespace: &str) -> Result<Vec<DeploymentInfo>, String> {
    let api: Api<Deployment> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), namespace)
    };
    let list = api.list(&ListParams::default()).await
        .map_err(|e| format!("Failed to list deployments: {}", e))?;

    Ok(list.items.into_iter().map(|d| {
        let meta = d.metadata;
        let ready = d.status.as_ref()
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0);
        let desired = d.spec.as_ref()
            .and_then(|s| s.replicas)
            .unwrap_or(0);
        DeploymentInfo {
            name: meta.name.unwrap_or_default(),
            namespace: meta.namespace.unwrap_or_default(),
            status: format!("{}/{}", ready, desired),
        }
    }).collect())
}

async fn fetch_statefulsets(client: &kube::Client, namespace: &str) -> Result<Vec<StatefulSetInfo>, String> {
    let api: Api<StatefulSet> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), namespace)
    };
    let list = api.list(&ListParams::default()).await
        .map_err(|e| format!("Failed to list statefulsets: {}", e))?;

    Ok(list.items.into_iter().map(|s| {
        let meta = s.metadata;
        let ready = s.status.as_ref()
            .and_then(|st| st.ready_replicas)
            .unwrap_or(0);
        let desired = s.spec.as_ref()
            .and_then(|sp| sp.replicas)
            .unwrap_or(0);
        StatefulSetInfo {
            name: meta.name.unwrap_or_default(),
            namespace: meta.namespace.unwrap_or_default(),
            status: format!("{}/{}", ready, desired),
        }
    }).collect())
}

async fn fetch_daemonsets(client: &kube::Client, namespace: &str) -> Result<Vec<DaemonSetInfo>, String> {
    let api: Api<DaemonSet> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), namespace)
    };
    let list = api.list(&ListParams::default()).await
        .map_err(|e| format!("Failed to list daemonsets: {}", e))?;

    Ok(list.items.into_iter().map(|d| {
        let meta = d.metadata;
        let ready = d.status.as_ref()
            .map(|s| s.number_ready)
            .unwrap_or(0);
        let desired = d.status.as_ref()
            .map(|s| s.desired_number_scheduled)
            .unwrap_or(0);
        DaemonSetInfo {
            name: meta.name.unwrap_or_default(),
            namespace: meta.namespace.unwrap_or_default(),
            status: format!("{}/{}", ready, desired),
        }
    }).collect())
}

async fn fetch_replicasets(client: &kube::Client, namespace: &str) -> Result<Vec<RSInfo>, String> {
    let api: Api<ReplicaSet> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), namespace)
    };
    let list = api.list(&ListParams::default()).await
        .map_err(|e| format!("Failed to list replicasets: {}", e))?;

    Ok(list.items.into_iter().map(|r| {
        let meta = r.metadata.clone();
        let ready = r.status.as_ref()
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0);
        let desired = r.spec.as_ref()
            .and_then(|s| s.replicas)
            .unwrap_or(0);
        RSInfo {
            name: meta.name.unwrap_or_default(),
            namespace: meta.namespace.clone().unwrap_or_default(),
            status: format!("{}/{}", ready, desired),
            owner_key: owner_key(&r.metadata),
        }
    }).collect())
}

async fn fetch_pods(client: &kube::Client, namespace: &str) -> Result<Vec<PodInfo>, String> {
    let api: Api<Pod> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), namespace)
    };
    let list = api.list(&ListParams::default()).await
        .map_err(|e| format!("Failed to list pods: {}", e))?;

    Ok(list.items.into_iter().map(|p| {
        let meta = p.metadata.clone();
        let phase = p.status.as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".into());
        let containers = p.spec.as_ref()
            .map(|s| s.containers.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default();
        PodInfo {
            name: meta.name.unwrap_or_default(),
            namespace: meta.namespace.clone().unwrap_or_default(),
            status: phase,
            containers,
            owner_key: owner_key(&p.metadata),
        }
    }).collect())
}
