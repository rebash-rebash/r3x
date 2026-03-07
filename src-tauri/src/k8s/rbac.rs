use super::context::get_client;
use k8s_openapi::api::rbac::v1::{ClusterRoleBinding, RoleBinding};
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RbacSubject {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RbacBinding {
    pub name: String,
    pub namespace: Option<String>,
    pub kind: String,
    pub role_kind: String,
    pub role_name: String,
    pub subjects: Vec<RbacSubject>,
}

#[tauri::command]
pub async fn list_rbac_bindings(
    context: String,
    namespace: String,
) -> Result<Vec<RbacBinding>, String> {
    let client = get_client(&context).await?;
    let mut bindings = Vec::new();

    // Cluster role bindings
    let crb_api: Api<ClusterRoleBinding> = Api::all(client.clone());
    let crbs = crb_api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list ClusterRoleBindings: {}", e))?;

    for crb in crbs.items {
        let meta = crb.metadata;
        let role_ref = crb.role_ref;
        let subjects: Vec<RbacSubject> = crb
            .subjects
            .unwrap_or_default()
            .into_iter()
            .map(|s| RbacSubject {
                kind: s.kind,
                name: s.name,
                namespace: s.namespace,
            })
            .collect();

        bindings.push(RbacBinding {
            name: meta.name.unwrap_or_default(),
            namespace: None,
            kind: "ClusterRoleBinding".to_string(),
            role_kind: role_ref.kind,
            role_name: role_ref.name,
            subjects,
        });
    }

    // Namespaced role bindings
    let rb_api: Api<RoleBinding> = if namespace == "_all" {
        Api::all(client)
    } else {
        Api::namespaced(client, &namespace)
    };

    let rbs = rb_api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list RoleBindings: {}", e))?;

    for rb in rbs.items {
        let meta = rb.metadata;
        let role_ref = rb.role_ref;
        let subjects: Vec<RbacSubject> = rb
            .subjects
            .unwrap_or_default()
            .into_iter()
            .map(|s| RbacSubject {
                kind: s.kind,
                name: s.name,
                namespace: s.namespace,
            })
            .collect();

        bindings.push(RbacBinding {
            name: meta.name.unwrap_or_default(),
            namespace: meta.namespace,
            kind: "RoleBinding".to_string(),
            role_kind: role_ref.kind,
            role_name: role_ref.name,
            subjects,
        });
    }

    bindings.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(bindings)
}
