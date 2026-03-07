mod k8s;

use k8s::benchmark::benchmark_pod;
use k8s::context::{get_current_context, list_contexts, switch_context};
use k8s::crds::{list_crds, list_custom_resources};
use k8s::events::list_events;
use k8s::exec::exec_pod;
use k8s::helm::list_helm_releases;
use k8s::logs::{get_pod_containers, get_pod_logs, stream_pod_logs};
use k8s::nodes::{cordon_node, drain_node, get_node_details, uncordon_node};
use k8s::portforward::{get_pod_ports, list_port_forwards, start_port_forward, stop_port_forward};
use k8s::rbac::list_rbac_bindings;
use k8s::resources::{apply_resource_yaml, delete_resource, get_resource_pods, get_resource_yaml, list_namespaces, list_resources};
use k8s::scale::{scale_resource, rollout_restart};
use k8s::metrics::{get_cluster_summary, get_node_metrics, get_pod_metrics, get_pvc_metrics};
use k8s::security::scan_security;
use k8s::topology::get_topology;

/// Ensure exec-based auth plugins (gke-gcloud-auth-plugin, aws-iam-authenticator, etc.)
/// are discoverable by inheriting the user's shell PATH.
fn inherit_shell_path() {
    if let Ok(output) = std::process::Command::new("zsh")
        .args(["-li", "-c", "echo $PATH"])
        .output()
    {
        if let Ok(path) = String::from_utf8(output.stdout) {
            let path = path.trim();
            if !path.is_empty() {
                std::env::set_var("PATH", path);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    inherit_shell_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_contexts,
            get_current_context,
            switch_context,
            list_namespaces,
            list_resources,
            get_resource_yaml,
            delete_resource,
            get_pod_logs,
            stream_pod_logs,
            get_pod_containers,
            scan_security,
            get_topology,
            exec_pod,
            scale_resource,
            list_events,
            get_node_details,
            start_port_forward,
            stop_port_forward,
            list_port_forwards,
            get_pod_ports,
            get_pod_metrics,
            get_node_metrics,
            get_cluster_summary,
            get_resource_pods,
            apply_resource_yaml,
            get_pvc_metrics,
            cordon_node,
            uncordon_node,
            drain_node,
            list_crds,
            list_custom_resources,
            rollout_restart,
            benchmark_pod,
            list_helm_releases,
            list_rbac_bindings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
