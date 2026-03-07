use super::context::get_client;
use futures::AsyncBufReadExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};
use tauri::{Emitter, Window};

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
