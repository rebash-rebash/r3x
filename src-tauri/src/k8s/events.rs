use super::context::get_client;
use futures::{StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::Event;
use kube::api::{Api, ListParams};
use kube::runtime::watcher;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

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
    field_selector: Option<String>,
) -> Result<Vec<K8sEvent>, String> {
    let client = get_client(&context).await?;
    let api: Api<Event> = if namespace == "_all" {
        Api::all(client)
    } else {
        Api::namespaced(client, &namespace)
    };

    let mut lp = ListParams::default();
    if let Some(fs) = field_selector {
        lp = lp.fields(&fs);
    }

    let list = api
        .list(&lp)
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
                    .map(|t| t.0.to_rfc3339()),
                last_seen: ev
                    .last_timestamp
                    .as_ref()
                    .map(|t| t.0.to_rfc3339()),
                source,
            }
        })
        .collect();

    // Sort by last_seen descending (most recent first)
    events.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));

    Ok(events)
}

/// Watch for new Warning events and emit them to the frontend in real-time
#[tauri::command]
pub async fn watch_events(
    context: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let client = get_client(&context).await?;
    let api: Api<Event> = Api::all(client);

    let watcher_config = watcher::Config::default();
    let mut stream = watcher(api, watcher_config).boxed();

    tokio::spawn(async move {
        while let Ok(Some(event)) = stream.try_next().await {
            if let watcher::Event::Apply(ev) | watcher::Event::InitApply(ev) = event {
                // Only emit Warning events
                if ev.type_.as_deref() != Some("Warning") {
                    continue;
                }

                let source = ev
                    .source
                    .as_ref()
                    .and_then(|s| s.component.clone());

                let k8s_event = K8sEvent {
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
                        .map(|t| t.0.to_rfc3339()),
                    last_seen: ev
                        .last_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339()),
                    source,
                };

                let _ = app_handle.emit("cluster-alert", &k8s_event);
            }
        }
    });

    Ok(())
}
