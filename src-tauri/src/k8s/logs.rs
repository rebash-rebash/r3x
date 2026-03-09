use super::context::get_client;
use futures::AsyncBufReadExt;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams, LogParams};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::{AppHandle, Emitter, Window};

#[tauri::command]
pub async fn get_pod_logs(
    context: String,
    namespace: String,
    pod_name: String,
    container: Option<String>,
    tail_lines: Option<i64>,
) -> Result<Vec<String>, String> {
    let client = get_client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    let mut params = LogParams {
        tail_lines: Some(tail_lines.unwrap_or(100)),
        timestamps: true,
        ..Default::default()
    };

    if let Some(c) = container {
        params.container = Some(c);
    }

    let logs = api
        .logs(&pod_name, &params)
        .await
        .map_err(|e| format!("Failed to get logs: {}", e))?;

    let lines: Vec<String> = logs.lines().map(|l| l.to_string()).collect();
    Ok(lines)
}

#[tauri::command]
pub async fn stream_pod_logs(
    window: Window,
    context: String,
    namespace: String,
    pod_name: String,
    container: Option<String>,
) -> Result<(), String> {
    let client = get_client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    let mut params = LogParams {
        follow: true,
        tail_lines: Some(50),
        timestamps: true,
        ..Default::default()
    };

    if let Some(c) = container {
        params.container = Some(c);
    }

    let event_name = format!("log-stream-{}-{}", namespace, pod_name);

    tokio::spawn(async move {
        match api.log_stream(&pod_name, &params).await {
            Ok(stream) => {
                let reader = futures::io::BufReader::new(stream);
                let mut lines = reader.lines();
                use futures::StreamExt;
                while let Some(Ok(line)) = lines.next().await {
                    let _ = window.emit(&event_name, &line);
                }
            }
            Err(e) => {
                let _ = window.emit(&event_name, format!("[ERROR] {}", e));
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn get_pod_containers(
    context: String,
    namespace: String,
    pod_name: String,
) -> Result<Vec<String>, String> {
    let client = get_client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    let pod = api
        .get(&pod_name)
        .await
        .map_err(|e| format!("Failed to get pod: {}", e))?;

    let containers = pod
        .spec
        .map(|spec| {
            spec.containers
                .iter()
                .map(|c| c.name.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(containers)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkloadLogLine {
    pub pod: String,
    pub container: String,
    pub timestamp: String,
    pub message: String,
}

#[tauri::command]
pub async fn get_workload_logs(
    context: String,
    namespace: String,
    kind: String,
    name: String,
    tail_lines: Option<i64>,
) -> Result<Vec<WorkloadLogLine>, String> {
    let client = get_client(&context).await?;

    // Get the workload's label selector
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
        _ => return Err(format!("Unsupported kind for workload logs: {}", kind)),
    };

    if selector.is_empty() {
        return Ok(vec![]);
    }

    let label_selector = selector
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(",");

    // List pods matching the selector
    let pod_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let pods = pod_api
        .list(&ListParams::default().labels(&label_selector))
        .await
        .map_err(|e| format!("Failed to list pods: {}", e))?;

    let tail = tail_lines.unwrap_or(50);

    // Fetch logs from all pods in parallel
    let mut handles = Vec::new();
    for pod in pods.items {
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        let containers: Vec<String> = pod
            .spec
            .as_ref()
            .map(|s| s.containers.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default();

        for container_name in containers {
            let api = pod_api.clone();
            let pn = pod_name.clone();
            let cn = container_name.clone();
            handles.push(tokio::spawn(async move {
                let params = LogParams {
                    tail_lines: Some(tail),
                    timestamps: true,
                    container: Some(cn.clone()),
                    ..Default::default()
                };
                match api.logs(&pn, &params).await {
                    Ok(logs) => {
                        let lines: Vec<WorkloadLogLine> = logs
                            .lines()
                            .filter(|l| !l.is_empty())
                            .map(|l| {
                                let parts: Vec<&str> = l.splitn(2, ' ').collect();
                                let (ts, msg) = if parts.len() == 2 {
                                    (parts[0].to_string(), parts[1].to_string())
                                } else {
                                    ("".to_string(), l.to_string())
                                };
                                WorkloadLogLine {
                                    pod: pn.clone(),
                                    container: cn.clone(),
                                    timestamp: ts,
                                    message: msg,
                                }
                            })
                            .collect();
                        lines
                    }
                    Err(_) => vec![],
                }
            }));
        }
    }

    let mut all_lines: Vec<WorkloadLogLine> = Vec::new();
    for handle in handles {
        if let Ok(lines) = handle.await {
            all_lines.extend(lines);
        }
    }

    // Sort by timestamp (RFC3339 timestamps sort lexicographically)
    all_lines.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    // Keep last 1000 lines max
    if all_lines.len() > 1000 {
        all_lines = all_lines.split_off(all_lines.len() - 1000);
    }

    Ok(all_lines)
}

/// Get the label selector for a workload resource
async fn get_workload_selector(
    client: &kube::Client,
    namespace: &str,
    kind: &str,
    name: &str,
) -> Result<BTreeMap<String, String>, String> {
    match kind {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
            let res = api.get(name).await.map_err(|e| format!("{}", e))?;
            Ok(res.spec.and_then(|s| s.selector.match_labels).unwrap_or_default())
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client.clone(), namespace);
            let res = api.get(name).await.map_err(|e| format!("{}", e))?;
            Ok(res.spec.and_then(|s| s.selector.match_labels).unwrap_or_default())
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client.clone(), namespace);
            let res = api.get(name).await.map_err(|e| format!("{}", e))?;
            Ok(res.spec.and_then(|s| s.selector.match_labels).unwrap_or_default())
        }
        "ReplicaSet" => {
            let api: Api<ReplicaSet> = Api::namespaced(client.clone(), namespace);
            let res = api.get(name).await.map_err(|e| format!("{}", e))?;
            Ok(res.spec.and_then(|s| s.selector.match_labels).unwrap_or_default())
        }
        _ => Err(format!("Unsupported kind: {}", kind)),
    }
}

#[tauri::command]
pub async fn stream_workload_logs(
    app_handle: AppHandle,
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<String, String> {
    let client = get_client(&context).await?;
    let selector = get_workload_selector(&client, &namespace, &kind, &name).await?;

    if selector.is_empty() {
        return Err("No label selector found".to_string());
    }

    let label_selector = selector
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(",");

    let event_name = format!("workload-log-stream-{}-{}-{}", namespace, kind, name);
    let event_name_clone = event_name.clone();

    let pod_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let pods = pod_api
        .list(&ListParams::default().labels(&label_selector))
        .await
        .map_err(|e| format!("Failed to list pods: {}", e))?;

    // Spawn a stream for each pod/container
    for pod in pods.items {
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        let containers: Vec<String> = pod
            .spec
            .as_ref()
            .map(|s| s.containers.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default();

        for container_name in containers {
            let api = pod_api.clone();
            let pn = pod_name.clone();
            let cn = container_name.clone();
            let en = event_name_clone.clone();
            let handle = app_handle.clone();

            tokio::spawn(async move {
                let params = LogParams {
                    follow: true,
                    tail_lines: Some(10),
                    timestamps: true,
                    container: Some(cn.clone()),
                    ..Default::default()
                };

                match api.log_stream(&pn, &params).await {
                    Ok(stream) => {
                        let reader = futures::io::BufReader::new(stream);
                        let mut lines = reader.lines();
                        use futures::StreamExt;
                        while let Some(Ok(line)) = lines.next().await {
                            let parts: Vec<&str> = line.splitn(2, ' ').collect();
                            let (ts, msg) = if parts.len() == 2 {
                                (parts[0].to_string(), parts[1].to_string())
                            } else {
                                ("".to_string(), line.clone())
                            };
                            let log_line = WorkloadLogLine {
                                pod: pn.clone(),
                                container: cn.clone(),
                                timestamp: ts,
                                message: msg,
                            };
                            let _ = handle.emit(&en, &log_line);
                        }
                    }
                    Err(e) => {
                        let log_line = WorkloadLogLine {
                            pod: pn.clone(),
                            container: cn.clone(),
                            timestamp: "".to_string(),
                            message: format!("[ERROR] {}", e),
                        };
                        let _ = handle.emit(&en, &log_line);
                    }
                }
            });
        }
    }

    Ok(event_name)
}
