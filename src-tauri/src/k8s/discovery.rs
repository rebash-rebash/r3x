use super::context::get_client;
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct ApiResourceInfo {
    pub name: String,       // plural name e.g. "pods", "deployments"
    pub kind: String,       // e.g. "Pod", "Deployment"
    pub group: String,      // e.g. "", "apps", "batch"
    pub version: String,    // e.g. "v1", "v1beta1"
    pub scope: String,      // "Namespaced" or "Cluster"
    pub short_names: Vec<String>,
    pub api_version: String, // "v1" or "apps/v1"
    pub verbs: Vec<String>,
}

#[tauri::command]
pub async fn discover_api_resources(context: String) -> Result<Vec<ApiResourceInfo>, String> {
    let client = get_client(&context).await?;

    let discovery = kube::discovery::Discovery::new(client.clone())
        .run()
        .await
        .map_err(|e| format!("Discovery failed: {}", e))?;

    let mut resources = Vec::new();

    for group in discovery.groups() {
        for (ar, caps) in group.recommended_resources() {
            // Only include resources that support "list" verb (browsable)
            if !caps.supports_operation(kube::discovery::verbs::LIST) {
                continue;
            }

            let scope = if caps.scope == kube::discovery::Scope::Cluster {
                "Cluster"
            } else {
                "Namespaced"
            };

            let mut verbs = Vec::new();
            if caps.supports_operation(kube::discovery::verbs::LIST) {
                verbs.push("list".to_string());
            }
            if caps.supports_operation(kube::discovery::verbs::GET) {
                verbs.push("get".to_string());
            }
            if caps.supports_operation(kube::discovery::verbs::CREATE) {
                verbs.push("create".to_string());
            }
            if caps.supports_operation(kube::discovery::verbs::DELETE) {
                verbs.push("delete".to_string());
            }
            if caps.supports_operation(kube::discovery::verbs::WATCH) {
                verbs.push("watch".to_string());
            }

            resources.push(ApiResourceInfo {
                name: ar.plural.clone(),
                kind: ar.kind.clone(),
                group: ar.group.clone(),
                version: ar.version.clone(),
                scope: scope.to_string(),
                short_names: vec![], // Discovery API doesn't expose short names directly
                api_version: ar.api_version.clone(),
                verbs,
            });
        }
    }

    // Sort: core resources first (empty group), then alphabetically
    resources.sort_by(|a, b| {
        let a_core = a.group.is_empty();
        let b_core = b.group.is_empty();
        b_core.cmp(&a_core).then(a.kind.cmp(&b.kind))
    });

    Ok(resources)
}

/// List any resource dynamically by its API resource info
#[tauri::command]
pub async fn list_dynamic_resources(
    context: String,
    namespace: String,
    group: String,
    version: String,
    plural: String,
    kind: String,
    scope: String,
    label_selector: Option<String>,
) -> Result<Vec<super::resources::K8sResource>, String> {
    let client = get_client(&context).await?;

    let ar = kube::api::ApiResource {
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

    let api: kube::api::Api<kube::api::DynamicObject> =
        if scope == "Cluster" || namespace == "_all" {
            kube::api::Api::all_with(client, &ar)
        } else {
            kube::api::Api::namespaced_with(client, &namespace, &ar)
        };

    let mut lp = kube::api::ListParams::default();
    if let Some(ref ls) = label_selector {
        if !ls.is_empty() {
            lp = lp.labels(ls);
        }
    }

    let list = api
        .list(&lp)
        .await
        .map_err(|e| format!("Failed to list {}: {}", plural, e))?;

    let resources: Vec<super::resources::K8sResource> = list
        .items
        .into_iter()
        .map(|obj| {
            let raw = serde_json::to_value(&obj).unwrap_or_default();
            let name = obj.metadata.name.unwrap_or_default();
            let ns = obj.metadata.namespace;
            let labels = obj.metadata.labels.unwrap_or_default();
            let age = super::resources::format_age_pub(obj.metadata.creation_timestamp.as_ref());

            let status = raw
                .pointer("/status/phase")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    raw.pointer("/status/state")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .or_else(|| {
                    // Check replicas pattern
                    let desired = raw.pointer("/status/replicas").and_then(|v| v.as_i64());
                    let ready = raw.pointer("/status/readyReplicas").and_then(|v| v.as_i64());
                    if let (Some(d), Some(r)) = (desired, ready) {
                        return Some(format!("{}/{}", r, d));
                    }
                    None
                })
                .or_else(|| {
                    // Check conditions
                    raw.pointer("/status/conditions")
                        .and_then(|v| v.as_array())
                        .and_then(|conds| {
                            conds.iter().find(|c| {
                                c.get("type").and_then(|t| t.as_str()) == Some("Ready")
                                    || c.get("type").and_then(|t| t.as_str()) == Some("Available")
                            })
                        })
                        .and_then(|c| c.get("status"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .or_else(|| {
                    raw.pointer("/spec/type")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                });

            super::resources::K8sResource {
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
