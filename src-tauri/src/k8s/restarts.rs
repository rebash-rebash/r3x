use super::context::get_client;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RestartEvent {
    pub pod_name: String,
    pub container: String,
    pub namespace: String,
    pub reason: String,
    pub exit_code: i32,
    pub finished_at: Option<String>,
    pub started_at: Option<String>,
    pub message: Option<String>,
    pub source: String, // "lastState" or "event"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContainerRestartInfo {
    pub name: String,
    pub restart_count: i32,
    pub current_state: String,
    pub current_ready: bool,
    pub last_reason: Option<String>,
    pub last_exit_code: Option<i32>,
    pub last_finished_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PodRestartInfo {
    pub pod_name: String,
    pub namespace: String,
    pub node: String,
    pub age: String,
    pub total_restarts: i32,
    pub containers: Vec<ContainerRestartInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RestartHistory {
    pub workload_name: String,
    pub workload_kind: String,
    pub namespace: String,
    pub total_restarts: i32,
    pub pod_count: usize,
    pub pods: Vec<PodRestartInfo>,
    pub timeline: Vec<RestartEvent>,
}

fn format_age(seconds: i64) -> String {
    if seconds < 0 {
        return "?".to_string();
    }
    let days = seconds / 86400;
    let hours = (seconds % 86400) / 3600;
    let mins = (seconds % 3600) / 60;
    if days > 0 {
        format!("{}d{}h", days, hours)
    } else if hours > 0 {
        format!("{}h{}m", hours, mins)
    } else {
        format!("{}m", mins)
    }
}

fn get_selector(labels: Option<BTreeMap<String, String>>) -> String {
    labels
        .unwrap_or_default()
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(",")
}

fn extract_state_str(state: &serde_json::Value) -> String {
    if state.get("running").is_some() {
        "Running".to_string()
    } else if let Some(w) = state.get("waiting") {
        w.get("reason")
            .and_then(|r| r.as_str())
            .unwrap_or("Waiting")
            .to_string()
    } else if let Some(t) = state.get("terminated") {
        t.get("reason")
            .and_then(|r| r.as_str())
            .unwrap_or("Terminated")
            .to_string()
    } else {
        "Unknown".to_string()
    }
}

fn extract_pod_restart_info(pod: &Pod, now: chrono::DateTime<chrono::Utc>) -> PodRestartInfo {
    let pod_name = pod.metadata.name.clone().unwrap_or_default();
    let namespace = pod.metadata.namespace.clone().unwrap_or_default();
    let node = pod
        .spec
        .as_ref()
        .and_then(|s| s.node_name.clone())
        .unwrap_or_default();
    let age = pod
        .metadata
        .creation_timestamp
        .as_ref()
        .map(|ts| format_age((now - ts.0).num_seconds()))
        .unwrap_or_else(|| "?".to_string());

    // Parse container statuses from raw JSON
    let raw: serde_json::Value =
        serde_json::to_value(pod).unwrap_or(serde_json::Value::Null);
    let status_obj = raw.get("status").cloned().unwrap_or(serde_json::Value::Null);
    let container_statuses = status_obj
        .get("containerStatuses")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let init_statuses = status_obj
        .get("initContainerStatuses")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let all_statuses = [container_statuses, init_statuses].concat();

    let mut total_restarts = 0i32;
    let mut containers = Vec::new();

    for cs in &all_statuses {
        let name = cs
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let restart_count = cs
            .get("restartCount")
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as i32;
        let ready = cs
            .get("ready")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        total_restarts += restart_count;

        let current_state = cs
            .get("state")
            .map(|s| extract_state_str(s))
            .unwrap_or_else(|| "Unknown".to_string());

        let last_state = cs.get("lastState");
        let (last_reason, last_exit_code, last_finished_at) = if let Some(ls) = last_state {
            if let Some(term) = ls.get("terminated") {
                let reason = term
                    .get("reason")
                    .and_then(|r| r.as_str())
                    .map(|s| s.to_string());
                let exit_code = term
                    .get("exitCode")
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32);
                let finished = term
                    .get("finishedAt")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                (reason, exit_code, finished)
            } else {
                (None, None, None)
            }
        } else {
            (None, None, None)
        };

        containers.push(ContainerRestartInfo {
            name,
            restart_count,
            current_state,
            current_ready: ready,
            last_reason,
            last_exit_code,
            last_finished_at,
        });
    }

    PodRestartInfo {
        pod_name,
        namespace,
        node,
        age,
        total_restarts,
        containers,
    }
}

fn extract_timeline_events(pod: &Pod) -> Vec<RestartEvent> {
    let pod_name = pod.metadata.name.clone().unwrap_or_default();
    let namespace = pod.metadata.namespace.clone().unwrap_or_default();

    let raw: serde_json::Value =
        serde_json::to_value(pod).unwrap_or(serde_json::Value::Null);
    let status_obj = raw.get("status").cloned().unwrap_or(serde_json::Value::Null);

    let mut events = Vec::new();

    for key in &["containerStatuses", "initContainerStatuses"] {
        let statuses = status_obj
            .get(key)
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for cs in &statuses {
            let container = cs
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // Extract from lastState.terminated
            if let Some(term) = cs
                .get("lastState")
                .and_then(|ls| ls.get("terminated"))
            {
                let reason = term
                    .get("reason")
                    .and_then(|r| r.as_str())
                    .unwrap_or("Unknown")
                    .to_string();
                let exit_code = term
                    .get("exitCode")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0) as i32;
                let finished_at = term
                    .get("finishedAt")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let started_at = term
                    .get("startedAt")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let message = term
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                events.push(RestartEvent {
                    pod_name: pod_name.clone(),
                    container: container.clone(),
                    namespace: namespace.clone(),
                    reason,
                    exit_code,
                    finished_at,
                    started_at,
                    message,
                    source: "lastState".to_string(),
                });
            }
        }
    }

    events
}

#[tauri::command]
pub async fn get_restart_history(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<RestartHistory, String> {
    let client = get_client(&context).await?;

    // Get the label selector for the workload
    let label_selector = match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_selector(res.spec.and_then(|s| s.selector.match_labels))
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_selector(res.spec.and_then(|s| s.selector.match_labels))
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_selector(res.spec.and_then(|s| s.selector.match_labels))
        }
        "ReplicaSet" => {
            let api: Api<ReplicaSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_selector(res.spec.and_then(|s| s.selector.match_labels))
        }
        "Pod" => {
            // For a single pod, just fetch that pod directly
            let pod_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
            let pod = pod_api.get(&name).await.map_err(|e| format!("{}", e))?;
            let now = chrono::Utc::now();
            let pod_info = extract_pod_restart_info(&pod, now);
            let timeline = extract_timeline_events(&pod);

            return Ok(RestartHistory {
                workload_name: name,
                workload_kind: kind,
                namespace,
                total_restarts: pod_info.total_restarts,
                pod_count: 1,
                pods: vec![pod_info],
                timeline,
            });
        }
        _ => return Err(format!("Unsupported kind: {}", kind)),
    };

    if label_selector.is_empty() {
        return Err("No label selector found".to_string());
    }

    let pod_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let pods = pod_api
        .list(&ListParams::default().labels(&label_selector))
        .await
        .map_err(|e| format!("Failed to list pods: {}", e))?;

    let now = chrono::Utc::now();
    let mut all_pods = Vec::new();
    let mut all_timeline = Vec::new();
    let mut total_restarts = 0i32;

    for pod in &pods.items {
        let info = extract_pod_restart_info(pod, now);
        total_restarts += info.total_restarts;
        all_pods.push(info);
        all_timeline.extend(extract_timeline_events(pod));
    }

    // Sort pods by restart count descending
    all_pods.sort_by(|a, b| b.total_restarts.cmp(&a.total_restarts));

    // Sort timeline by finished_at descending (most recent first)
    all_timeline.sort_by(|a, b| {
        let a_time = a.finished_at.as_deref().unwrap_or("");
        let b_time = b.finished_at.as_deref().unwrap_or("");
        b_time.cmp(a_time)
    });

    Ok(RestartHistory {
        workload_name: name,
        workload_kind: kind,
        namespace,
        total_restarts,
        pod_count: all_pods.len(),
        pods: all_pods,
        timeline: all_timeline,
    })
}
