mod k8s;

use tauri::tray::TrayIconBuilder;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::Manager;

use k8s::benchmark::benchmark_pod;
use k8s::context::{get_current_context, list_contexts, switch_context};
use k8s::cost::estimate_cost;
use k8s::cronjob::{get_cronjob_detail, trigger_cronjob};
use k8s::diff::{diff_resources, diff_yaml};
use k8s::health::get_cluster_health;
use k8s::hpa::get_autoscalers;
use k8s::netpol::get_network_policies;
use k8s::crds::{list_crds, list_custom_resources};
use k8s::discovery::{discover_api_resources, list_dynamic_resources};
use k8s::events::{list_events, watch_events};
use k8s::exec::exec_pod;
use k8s::helm::list_helm_releases;
use k8s::images::scan_images;
use k8s::logs::{get_pod_containers, get_pod_logs, get_workload_logs, stream_pod_logs, stream_workload_logs};
use k8s::nodes::{cordon_node, drain_node, get_node_details, uncordon_node};
use k8s::portforward::{get_pod_ports, list_port_forwards, start_port_forward, stop_port_forward};
use k8s::rbac::list_rbac_bindings;
use k8s::restarts::get_restart_history;
use k8s::resources::{apply_resource_yaml, delete_resource, get_resource_pods, get_resource_yaml, list_namespaces, list_resources};
use k8s::scale::{scale_resource, rollout_restart};
use k8s::metrics::{get_cluster_summary, get_node_metrics, get_pod_metrics, get_pvc_metrics};
use k8s::security::scan_security;
use k8s::summary::get_cluster_overview;
use k8s::topology::get_topology;
use k8s::traffic::get_traffic_distribution;

/// Ensure exec-based auth plugins (gke-gcloud-auth-plugin, aws-iam-authenticator, etc.)
/// are discoverable by inheriting the user's shell PATH.
fn inherit_shell_path() {
    #[cfg(not(target_os = "windows"))]
    {
        // Try the user's default shell, falling back through common shells
        let shells = ["zsh", "bash", "sh"];
        for shell in &shells {
            if let Ok(output) = std::process::Command::new(shell)
                .args(["-li", "-c", "echo $PATH"])
                .output()
            {
                if let Ok(path) = String::from_utf8(output.stdout) {
                    let path = path.trim();
                    if !path.is_empty() {
                        std::env::set_var("PATH", path);
                        return;
                    }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, PATH is inherited from the system environment automatically.
        // No special handling needed.
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    inherit_shell_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Build tray menu
            let show = MenuItemBuilder::with_id("show", "Show r3x").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&quit)
                .build()?;

            // Create tray icon
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("r3x — Kubernetes Cockpit")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide to tray on close instead of quitting
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
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
            discover_api_resources,
            list_dynamic_resources,
            watch_events,
            get_workload_logs,
            stream_workload_logs,
            get_traffic_distribution,
            get_restart_history,
            estimate_cost,
            scan_images,
            get_autoscalers,
            get_cronjob_detail,
            trigger_cronjob,
            diff_resources,
            diff_yaml,
            get_network_policies,
            get_cluster_health,
            get_cluster_overview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
