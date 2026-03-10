mod k8s;

use tauri::tray::TrayIconBuilder;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::Manager;

use k8s::benchmark::benchmark_pod;
use k8s::context::{get_current_context, list_contexts, reconnect, switch_context};
use k8s::cost::estimate_cost;
use k8s::describe::describe_resource;
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
use k8s::resources::{apply_resource_yaml, delete_resource, get_dynamic_resource_yaml, get_resource_pods, get_resource_yaml, list_namespaces, list_resources};
use k8s::scale::{scale_resource, rollout_restart};
use k8s::metrics::{get_cluster_summary, get_node_metrics, get_pod_metrics, get_pvc_metrics};
use k8s::security::scan_security;
use k8s::summary::get_cluster_overview;
use k8s::topology::get_topology;
use k8s::traffic::get_traffic_distribution;
use k8s::watcher::{start_watcher, stop_watcher, stop_all_watchers, get_watched_resources};

/// Ensure exec-based auth plugins (gke-gcloud-auth-plugin, aws-iam-authenticator, etc.)
/// are discoverable by inheriting the user's shell PATH.
pub fn inherit_shell_path() {
    #[cfg(not(target_os = "windows"))]
    {
        // Try the user's default shell first, then common shells.
        // Use -l (login) without -i (interactive) to avoid prompts/hangs.
        let shells = ["zsh", "bash", "sh"];
        let mut resolved = false;
        for shell in &shells {
            if let Ok(output) = std::process::Command::new(shell)
                .args(["-l", "-c", "echo $PATH"])
                .env("TERM", "dumb")
                .output()
            {
                if output.status.success() {
                    if let Ok(path) = String::from_utf8(output.stdout) {
                        let path = path.trim();
                        if !path.is_empty() && path.contains('/') {
                            std::env::set_var("PATH", path);
                            resolved = true;
                            break;
                        }
                    }
                }
            }
        }

        // Append well-known cloud SDK / tool paths as fallback
        if let Ok(current_path) = std::env::var("PATH") {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/unknown".to_string());
            let mut extra_paths = vec![
                format!("{}/google-cloud-sdk/bin", home),
                format!("{}/Downloads/google-cloud-sdk/bin", home),
                format!("{}/Desktop/google-cloud-sdk/bin", home),
                format!("{}/.config/gcloud/bin", home),
                "/usr/local/bin".to_string(),
                "/opt/homebrew/bin".to_string(),
                "/opt/homebrew/sbin".to_string(),
                "/usr/local/google-cloud-sdk/bin".to_string(),
                "/snap/google-cloud-cli/current/bin".to_string(),
                format!("{}/.local/bin", home),
                format!("{}/.cargo/bin", home),
                "/usr/local/sbin".to_string(),
            ];

            // Dynamically find gcloud SDK path by asking gcloud itself
            if let Ok(output) = std::process::Command::new("gcloud")
                .args(["info", "--format=value(installation.sdk_root)"])
                .output()
            {
                if let Ok(sdk_root) = String::from_utf8(output.stdout) {
                    let sdk_bin = format!("{}/bin", sdk_root.trim());
                    if !sdk_bin.is_empty() && sdk_root.trim().contains('/') {
                        extra_paths.insert(0, sdk_bin);
                    }
                }
            }

            // Also locate specific auth plugins directly via `which` in inherited PATH
            for plugin in &["gke-gcloud-auth-plugin", "aws-iam-authenticator", "kubelogin"] {
                if let Ok(output) = std::process::Command::new("which")
                    .arg(plugin)
                    .output()
                {
                    if let Ok(path_str) = String::from_utf8(output.stdout) {
                        if let Some(parent) = std::path::Path::new(path_str.trim()).parent() {
                            let dir = parent.to_string_lossy().to_string();
                            if !dir.is_empty() && !extra_paths.contains(&dir) {
                                extra_paths.insert(0, dir);
                            }
                        }
                    }
                }
            }

            let mut path = current_path.clone();
            for extra in &extra_paths {
                if std::path::Path::new(extra).exists() && !current_path.contains(extra.as_str()) {
                    path.push(':');
                    path.push_str(extra);
                }
            }
            if path != current_path {
                std::env::set_var("PATH", &path);
            }
        }

        if !resolved {
            eprintln!("[r3x] Warning: Could not inherit shell PATH. Cloud auth plugins may not be found.");
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
            reconnect,
            list_namespaces,
            list_resources,
            get_resource_yaml,
            get_dynamic_resource_yaml,
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
            describe_resource,
            start_watcher,
            stop_watcher,
            stop_all_watchers,
            get_watched_resources,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
