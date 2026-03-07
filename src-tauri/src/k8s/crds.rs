use super::context::get_client;
use super::resources::{format_age_pub, K8sResource};
use kube::api::{Api, ApiResource, DynamicObject, ListParams};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CrdInfo {
    pub name: String,
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub scope: String, // "Namespaced" or "Cluster"
    pub short_names: Vec<String>,
    pub category: Option<String>,
}

#[tauri::command]
pub async fn list_crds(context: String) -> Result<Vec<CrdInfo>, String> {
    let client = get_client(&context).await?;

    let raw: serde_json::Value = client
        .request::<serde_json::Value>(
            http::Request::builder()
                .uri("/apis/apiextensions.k8s.io/v1/customresourcedefinitions")
                .body(Vec::new())
                .map_err(|e| format!("Failed to build request: {}", e))?,
        )
        .await
        .map_err(|e| format!("Failed to list CRDs: {}", e))?;

    let items = raw
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or("Invalid CRD response")?;

    let mut crds = Vec::new();
    for item in items {
        let name = item
            .pointer("/metadata/name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let group = item
            .pointer("/spec/group")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let scope = item
            .pointer("/spec/scope")
            .and_then(|v| v.as_str())
            .unwrap_or("Namespaced")
            .to_string();

        let kind = item
            .pointer("/spec/names/kind")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let plural = item
            .pointer("/spec/names/plural")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let short_names: Vec<String> = item
            .pointer("/spec/names/shortNames")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        // Get the served + storage version (prefer storage, fallback to first served)
        let version = item
            .pointer("/spec/versions")
            .and_then(|v| v.as_array())
            .and_then(|versions| {
                versions
                    .iter()
                    .find(|v| v.get("storage").and_then(|s| s.as_bool()).unwrap_or(false))
                    .or_else(|| {
                        versions
                            .iter()
                            .find(|v| v.get("served").and_then(|s| s.as_bool()).unwrap_or(false))
                    })
                    .and_then(|v| v.get("name").and_then(|n| n.as_str()))
            })
            .unwrap_or("v1")
            .to_string();

        // Try to get category from categories list
        let category = item
            .pointer("/spec/names/categories")
            .and_then(|v| v.as_array())
            .and_then(|cats| cats.first())
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        if !kind.is_empty() {
            crds.push(CrdInfo {
                name,
                group,
                version,
                kind,
                plural,
                scope,
                short_names,
                category,
            });
        }
    }

    // Sort by group then kind
    crds.sort_by(|a, b| a.group.cmp(&b.group).then(a.kind.cmp(&b.kind)));

    Ok(crds)
}

#[tauri::command]
pub async fn list_custom_resources(
    context: String,
    group: String,
    version: String,
    plural: String,
    kind: String,
    scope: String,
    namespace: String,
) -> Result<Vec<K8sResource>, String> {
    let client = get_client(&context).await?;

    let ar = ApiResource {
        group: group.clone(),
        version: version.clone(),
        api_version: if group.is_empty() {
            version.clone()
        } else {
            format!("{}/{}", group, version)
        },
        kind: kind.clone(),
        plural: plural.clone(),
    };

    let api: Api<DynamicObject> = if scope == "Cluster" || namespace == "_all" {
        Api::all_with(client, &ar)
    } else {
        Api::namespaced_with(client, &namespace, &ar)
    };

    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list {}: {}", plural, e))?;

    let resources: Vec<K8sResource> = list
        .items
        .into_iter()
        .map(|obj| {
            let raw = serde_json::to_value(&obj).unwrap_or_default();
            let name = obj.metadata.name.unwrap_or_default();
            let ns = obj.metadata.namespace;
            let labels = obj.metadata.labels.unwrap_or_default();
            let age = format_age_pub(obj.metadata.creation_timestamp.as_ref());

            // Try to extract status from common patterns
            let status = raw
                .pointer("/status/phase")
                .or_else(|| raw.pointer("/status/state"))
                .or_else(|| {
                    // Check conditions for a "Ready" condition
                    raw.pointer("/status/conditions")
                        .and_then(|v| v.as_array())
                        .and_then(|conds| {
                            conds.iter().find(|c| {
                                c.get("type").and_then(|t| t.as_str()) == Some("Ready")
                                    || c.get("type").and_then(|t| t.as_str())
                                        == Some("Reconciled")
                            })
                        })
                        .and_then(|c| c.get("status"))
                })
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            K8sResource {
                name,
                namespace: ns,
                kind: kind.clone(),
                status,
                age,
                labels,
                extra: raw,
            }
        })
        .collect();

    Ok(resources)
}
