use super::context::get_client;
use super::metrics::{get_node_metrics, get_pod_metrics};
use super::security::scan_security;
use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HealthComponent {
    pub name: String,
    pub score: u32, // 0-100
    pub status: String, // "healthy", "warning", "critical"
    pub details: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Recommendation {
    pub priority: String, // "critical", "high", "medium", "low"
    pub category: String, // "security", "cost", "reliability", "performance"
    pub title: String,
    pub description: String,
    pub action: String,
    pub impact: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClusterHealthScore {
    pub overall_score: u32,
    pub overall_status: String,
    pub components: Vec<HealthComponent>,
    pub recommendations: Vec<Recommendation>,
    pub pod_count: usize,
    pub node_count: usize,
    pub namespace: String,
}

#[tauri::command]
pub async fn get_cluster_health(
    context: String,
    namespace: String,
) -> Result<ClusterHealthScore, String> {
    let client = get_client(&context).await?;

    // Run all checks in parallel
    let security_future = scan_security(context.clone(), namespace.clone());
    let node_metrics_future = get_node_metrics(context.clone());
    let pod_metrics_future = get_pod_metrics(context.clone(), namespace.clone());

    let node_api: Api<Node> = Api::all(client.clone());
    let pod_api: Api<Pod> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), &namespace)
    };

    let node_lp = ListParams::default();
    let pod_lp = ListParams::default();
    let (security_result, node_metrics_result, pod_metrics_result, nodes_result, pods_result) = tokio::join!(
        security_future,
        node_metrics_future,
        pod_metrics_future,
        node_api.list(&node_lp),
        pod_api.list(&pod_lp),
    );

    let mut components = Vec::new();
    let mut recommendations = Vec::new();

    // 1. Security Score
    let security_score = if let Ok(sec) = &security_result {
        let s = sec.summary.score;
        let mut details = Vec::new();
        if sec.summary.critical > 0 { details.push(format!("{} critical findings", sec.summary.critical)); }
        if sec.summary.high > 0 { details.push(format!("{} high findings", sec.summary.high)); }
        if sec.summary.medium > 0 { details.push(format!("{} medium findings", sec.summary.medium)); }
        if details.is_empty() { details.push("No security issues found".to_string()); }

        if sec.summary.critical > 0 {
            recommendations.push(Recommendation {
                priority: "critical".to_string(),
                category: "security".to_string(),
                title: "Fix critical security findings".to_string(),
                description: format!("{} critical security issues found in your workloads", sec.summary.critical),
                action: "Review privileged containers, dangerous capabilities, and root-running pods".to_string(),
                impact: "Reduces attack surface and prevents container escape".to_string(),
            });
        }
        if sec.summary.high > 0 {
            recommendations.push(Recommendation {
                priority: "high".to_string(),
                category: "security".to_string(),
                title: "Address high-severity security issues".to_string(),
                description: format!("{} high-severity findings need attention", sec.summary.high),
                action: "Set runAsNonRoot, drop capabilities, add network policies".to_string(),
                impact: "Improves overall security posture".to_string(),
            });
        }

        components.push(HealthComponent {
            name: "Security".to_string(),
            score: s,
            status: if s >= 80 { "healthy" } else if s >= 50 { "warning" } else { "critical" }.to_string(),
            details,
        });
        s
    } else {
        components.push(HealthComponent {
            name: "Security".to_string(),
            score: 50,
            status: "warning".to_string(),
            details: vec!["Unable to run security scan".to_string()],
        });
        50
    };

    // 2. Node Health
    let node_score = if let Ok(nodes) = &nodes_result {
        let total = nodes.items.len();
        let mut unhealthy = 0;
        let mut details = Vec::new();

        for node in &nodes.items {
            let name = node.metadata.name.as_deref().unwrap_or("");
            if let Some(status) = &node.status {
                if let Some(conditions) = &status.conditions {
                    for cond in conditions {
                        if cond.type_ == "Ready" && cond.status != "True" {
                            unhealthy += 1;
                            details.push(format!("Node {} is not ready", name));
                        }
                        if (cond.type_ == "MemoryPressure" || cond.type_ == "DiskPressure" || cond.type_ == "PIDPressure")
                            && cond.status == "True" {
                            details.push(format!("Node {} has {}", name, cond.type_));
                        }
                    }
                }
            }
        }

        if unhealthy > 0 {
            recommendations.push(Recommendation {
                priority: "critical".to_string(),
                category: "reliability".to_string(),
                title: format!("{} node(s) not ready", unhealthy),
                description: "Nodes in NotReady state cannot schedule new pods".to_string(),
                action: "Check node logs, kubelet status, and cloud provider health".to_string(),
                impact: "Restores cluster capacity and workload availability".to_string(),
            });
        }

        let s = if total == 0 { 0 } else { ((total - unhealthy) * 100 / total) as u32 };
        if details.is_empty() { details.push(format!("All {} nodes healthy", total)); }

        components.push(HealthComponent {
            name: "Node Health".to_string(),
            score: s,
            status: if s >= 90 { "healthy" } else if s >= 50 { "warning" } else { "critical" }.to_string(),
            details,
        });
        s
    } else {
        50
    };

    // 3. Resource Pressure (CPU/Memory utilization)
    let resource_score = if let Ok(node_metrics) = &node_metrics_result {
        let mut details = Vec::new();
        let mut max_cpu_pct = 0.0f64;
        let mut max_mem_pct = 0.0f64;

        for nm in node_metrics {
            if nm.cpu_percent > max_cpu_pct { max_cpu_pct = nm.cpu_percent; }
            if nm.memory_percent > max_mem_pct { max_mem_pct = nm.memory_percent; }

            if nm.cpu_percent > 90.0 {
                details.push(format!("Node {} CPU at {:.0}%", nm.name, nm.cpu_percent));
            }
            if nm.memory_percent > 90.0 {
                details.push(format!("Node {} memory at {:.0}%", nm.name, nm.memory_percent));
            }
        }

        if max_cpu_pct > 85.0 {
            recommendations.push(Recommendation {
                priority: "high".to_string(),
                category: "performance".to_string(),
                title: "High CPU utilization".to_string(),
                description: format!("Peak node CPU usage is {:.0}%", max_cpu_pct),
                action: "Scale up nodes, optimize workloads, or enable HPA".to_string(),
                impact: "Prevents CPU throttling and application latency".to_string(),
            });
        }
        if max_mem_pct > 85.0 {
            recommendations.push(Recommendation {
                priority: "high".to_string(),
                category: "performance".to_string(),
                title: "High memory utilization".to_string(),
                description: format!("Peak node memory usage is {:.0}%", max_mem_pct),
                action: "Scale up nodes or optimize memory-heavy workloads".to_string(),
                impact: "Prevents OOM kills and pod evictions".to_string(),
            });
        }

        let avg_pressure = ((max_cpu_pct + max_mem_pct) / 2.0).min(100.0);
        let s = if avg_pressure <= 70.0 { 100 }
            else if avg_pressure <= 85.0 { (100.0 - (avg_pressure - 70.0) * 2.0) as u32 }
            else { (100.0 - (avg_pressure - 70.0) * 3.0).max(0.0) as u32 };

        if details.is_empty() { details.push("Resource utilization within normal range".to_string()); }

        components.push(HealthComponent {
            name: "Resource Pressure".to_string(),
            score: s,
            status: if s >= 70 { "healthy" } else if s >= 40 { "warning" } else { "critical" }.to_string(),
            details,
        });
        s
    } else {
        components.push(HealthComponent {
            name: "Resource Pressure".to_string(),
            score: 50,
            status: "warning".to_string(),
            details: vec!["Metrics server not available".to_string()],
        });
        50
    };

    // 4. Pod Health (restarts, crash loops)
    let pod_score = if let Ok(pods) = &pods_result {
        let total = pods.items.len();
        let mut not_running = 0;
        let mut high_restarts = 0;
        let mut details = Vec::new();

        let raw_pods: serde_json::Value = serde_json::to_value(&pods.items).unwrap_or(serde_json::Value::Null);

        for (idx, pod) in pods.items.iter().enumerate() {
            let name = pod.metadata.name.as_deref().unwrap_or("");
            let phase = pod.status.as_ref()
                .and_then(|s| s.phase.as_deref())
                .unwrap_or("Unknown");

            if phase != "Running" && phase != "Succeeded" {
                not_running += 1;
                if not_running <= 3 {
                    details.push(format!("Pod {} is {}", name, phase));
                }
            }

            // Check restart counts from raw JSON
            if let Some(pod_json) = raw_pods.as_array().and_then(|a| a.get(idx)) {
                if let Some(statuses) = pod_json.pointer("/status/containerStatuses").and_then(|v| v.as_array()) {
                    for cs in statuses {
                        let restarts = cs.get("restartCount").and_then(|v| v.as_i64()).unwrap_or(0);
                        if restarts > 5 {
                            high_restarts += 1;
                            let cname = cs.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            if high_restarts <= 3 {
                                details.push(format!("{}/{} has {} restarts", name, cname, restarts));
                            }
                        }
                    }
                }
            }
        }

        if high_restarts > 0 {
            recommendations.push(Recommendation {
                priority: "high".to_string(),
                category: "reliability".to_string(),
                title: format!("{} container(s) with high restart counts", high_restarts),
                description: "Frequent restarts indicate crash loops or health check failures".to_string(),
                action: "Check pod logs, adjust resource limits, fix health probes".to_string(),
                impact: "Reduces downtime and improves application stability".to_string(),
            });
        }

        if not_running > 0 {
            recommendations.push(Recommendation {
                priority: if not_running > total / 4 { "critical" } else { "high" }.to_string(),
                category: "reliability".to_string(),
                title: format!("{} pod(s) not running", not_running),
                description: "Pods in Pending/Failed/CrashLoopBackOff state".to_string(),
                action: "Check events, describe pods, review resource constraints".to_string(),
                impact: "Ensures all workloads are serving traffic".to_string(),
            });
        }

        let healthy_pct = if total == 0 { 100.0 } else { ((total - not_running) as f64 / total as f64) * 100.0 };
        let restart_penalty = (high_restarts as u32 * 5).min(30);
        let s = (healthy_pct as u32).saturating_sub(restart_penalty).min(100);

        if details.is_empty() { details.push(format!("All {} pods healthy", total)); }

        components.push(HealthComponent {
            name: "Pod Health".to_string(),
            score: s,
            status: if s >= 80 { "healthy" } else if s >= 50 { "warning" } else { "critical" }.to_string(),
            details,
        });
        s
    } else {
        50
    };

    // 5. Workload Configuration (from pod metrics — requests/limits set)
    let config_score = if let Ok(pm) = &pod_metrics_result {
        let total = pm.len();
        let with_requests = pm.iter().filter(|p| p.cpu_request.is_some() && p.memory_request.is_some()).count();
        let with_limits = pm.iter().filter(|p| p.cpu_limit.is_some() && p.memory_limit.is_some()).count();

        let mut details = Vec::new();
        let no_requests = total - with_requests;
        let no_limits = total - with_limits;

        if no_requests > 0 {
            details.push(format!("{} pods without resource requests", no_requests));
            recommendations.push(Recommendation {
                priority: "medium".to_string(),
                category: "reliability".to_string(),
                title: format!("{} pods missing resource requests", no_requests),
                description: "Pods without requests may be scheduled on overloaded nodes".to_string(),
                action: "Set CPU and memory requests for all containers".to_string(),
                impact: "Improves scheduling decisions and prevents resource contention".to_string(),
            });
        }
        if no_limits > 0 {
            details.push(format!("{} pods without resource limits", no_limits));
        }

        let s = if total == 0 { 100 } else {
            let req_pct = (with_requests * 100 / total) as u32;
            let lim_pct = (with_limits * 100 / total) as u32;
            (req_pct * 60 + lim_pct * 40) / 100
        };

        if details.is_empty() { details.push("All pods have resource requests and limits".to_string()); }

        components.push(HealthComponent {
            name: "Configuration".to_string(),
            score: s,
            status: if s >= 80 { "healthy" } else if s >= 50 { "warning" } else { "critical" }.to_string(),
            details,
        });
        s
    } else {
        50
    };

    // Calculate overall score (weighted average)
    let overall_score = (
        security_score as f64 * 0.25 +
        node_score as f64 * 0.25 +
        resource_score as f64 * 0.15 +
        pod_score as f64 * 0.25 +
        config_score as f64 * 0.10
    ) as u32;

    let overall_status = if overall_score >= 80 { "healthy" }
        else if overall_score >= 50 { "warning" }
        else { "critical" };

    // Sort recommendations by priority
    recommendations.sort_by(|a, b| {
        let prio = |p: &str| match p { "critical" => 0, "high" => 1, "medium" => 2, _ => 3 };
        prio(&a.priority).cmp(&prio(&b.priority))
    });

    let pod_count = pods_result.as_ref().map(|p| p.items.len()).unwrap_or(0);
    let node_count = nodes_result.as_ref().map(|n| n.items.len()).unwrap_or(0);

    Ok(ClusterHealthScore {
        overall_score,
        overall_status: overall_status.to_string(),
        components,
        recommendations,
        pod_count,
        node_count,
        namespace,
    })
}
