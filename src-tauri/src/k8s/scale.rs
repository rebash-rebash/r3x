use super::context::get_client;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use kube::api::{Api, Patch, PatchParams};

#[tauri::command]
pub async fn scale_resource(
    context: String,
    namespace: String,
    kind: String,
    name: String,
    replicas: i32,
) -> Result<String, String> {
    let client = get_client(&context).await?;
    let patch = serde_json::json!({
        "spec": {
            "replicas": replicas
        }
    });
    let pp = PatchParams::apply("r3x");

    match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, &namespace);
            api.patch(&name, &pp, &Patch::Merge(&patch))
                .await
                .map_err(|e| format!("Failed to scale deployment: {}", e))?;
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, &namespace);
            api.patch(&name, &pp, &Patch::Merge(&patch))
                .await
                .map_err(|e| format!("Failed to scale statefulset: {}", e))?;
        }
        _ => return Err(format!("Scaling not supported for kind: {}", kind)),
    }

    Ok(format!("Scaled {} '{}' to {} replicas", kind, name, replicas))
}

#[tauri::command]
pub async fn rollout_restart(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<String, String> {
    let client = get_client(&context).await?;
    let now = chrono::Utc::now().to_rfc3339();
    let patch = serde_json::json!({
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "kubectl.kubernetes.io/restartedAt": now
                    }
                }
            }
        }
    });
    let pp = PatchParams::apply("r3x").force();

    match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, &namespace);
            api.patch(&name, &pp, &Patch::Apply(&patch))
                .await
                .map_err(|e| format!("Failed to restart deployment: {}", e))?;
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, &namespace);
            api.patch(&name, &pp, &Patch::Apply(&patch))
                .await
                .map_err(|e| format!("Failed to restart statefulset: {}", e))?;
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client, &namespace);
            api.patch(&name, &pp, &Patch::Apply(&patch))
                .await
                .map_err(|e| format!("Failed to restart daemonset: {}", e))?;
        }
        _ => return Err(format!("Rollout restart not supported for kind: {}", kind)),
    }

    Ok(format!("Restarted {} '{}'", kind, name))
}
