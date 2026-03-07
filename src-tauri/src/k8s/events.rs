use super::context::get_client;
use k8s_openapi::api::core::v1::Event;
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct K8sEvent {
    pub kind: Option<String>,
    pub name: Option<String>,
    pub namespace: Option<String>,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub event_type: Option<String>,
    pub count: Option<i32>,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
    pub source: Option<String>,
}

#[tauri::command]
pub async fn list_events(
    context: String,
    namespace: String,
) -> Result<Vec<K8sEvent>, String> {
    let client = get_client(&context).await?;
    let api: Api<Event> = if namespace == "_all" {
        Api::all(client)
    } else {
        Api::namespaced(client, &namespace)
    };

    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list events: {}", e))?;

    let mut events: Vec<K8sEvent> = list
        .items
        .into_iter()
        .map(|ev| {
            let source = ev
                .source
                .as_ref()
                .and_then(|s| s.component.clone());

            K8sEvent {
                kind: ev.involved_object.kind.clone(),
                name: ev.involved_object.name.clone(),
                namespace: ev.involved_object.namespace.clone(),
                reason: ev.reason.clone(),
                message: ev.message.clone(),
                event_type: ev.type_.clone(),
                count: ev.count,
                first_seen: ev
                    .first_timestamp
                    .as_ref()
                    .map(|t| t.0.format("%H:%M:%S").to_string()),
                last_seen: ev
                    .last_timestamp
                    .as_ref()
                    .map(|t| t.0.format("%H:%M:%S").to_string()),
                source,
            }
        })
        .collect();

    // Sort by last_seen descending (most recent first)
    events.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));

    Ok(events)
}
