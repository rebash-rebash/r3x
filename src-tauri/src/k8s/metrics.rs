use super::context::get_client;
use k8s_openapi::api::core::v1::{Node, PersistentVolumeClaim, Pod};
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};

// Metrics API types (metrics.k8s.io/v1beta1)
// These are not in k8s-openapi, so we define them manually and use raw API calls.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PodMetrics {
    pub name: String,
    pub namespace: String,
    pub containers: Vec<ContainerMetrics>,
    pub cpu_total: String,
    pub memory_total: String,
    // % of requests
    pub cpu_percent: Option<f64>,
    pub memory_percent: Option<f64>,
    // % of limits
    pub cpu_limit_percent: Option<f64>,
    pub memory_limit_percent: Option<f64>,
    // Formatted request/limit strings
    pub cpu_request: Option<String>,
    pub memory_request: Option<String>,
    pub cpu_limit: Option<String>,
    pub memory_limit: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContainerMetrics {
    pub name: String,
    pub cpu: String,
    pub memory: String,
    pub cpu_millicores: u64,
    pub memory_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NodeMetrics {
    pub name: String,
    pub cpu: String,
    pub memory: String,
    pub cpu_millicores: u64,
    pub memory_bytes: u64,
    pub cpu_capacity: u64,
    pub memory_capacity: u64,
    pub cpu_percent: f64,
    pub memory_percent: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClusterMetricsSummary {
    pub node_metrics: Vec<NodeMetrics>,
    pub total_cpu_millicores: u64,
    pub total_memory_bytes: u64,
    pub total_cpu_capacity: u64,
    pub total_memory_capacity: u64,
    pub cpu_percent: f64,
    pub memory_percent: f64,
    pub pod_count: usize,
    pub node_count: usize,
}

fn parse_cpu(cpu_str: &str) -> u64 {
    if let Some(n) = cpu_str.strip_suffix('n') {
        n.parse::<u64>().unwrap_or(0) / 1_000_000 // nanocores -> millicores
    } else if let Some(u) = cpu_str.strip_suffix('u') {
        u.parse::<u64>().unwrap_or(0) / 1_000 // microcores -> millicores
    } else if let Some(m) = cpu_str.strip_suffix('m') {
        m.parse::<u64>().unwrap_or(0)
    } else {
        // Plain number = cores
        let cores: f64 = cpu_str.parse().unwrap_or(0.0);
        (cores * 1000.0) as u64
    }
}

fn parse_memory(mem_str: &str) -> u64 {
    if let Some(ki) = mem_str.strip_suffix("Ki") {
        ki.parse::<u64>().unwrap_or(0) * 1024
    } else if let Some(mi) = mem_str.strip_suffix("Mi") {
        mi.parse::<u64>().unwrap_or(0) * 1024 * 1024
    } else if let Some(gi) = mem_str.strip_suffix("Gi") {
        gi.parse::<u64>().unwrap_or(0) * 1024 * 1024 * 1024
    } else if let Some(k) = mem_str.strip_suffix('K') {
        k.parse::<u64>().unwrap_or(0) * 1000
    } else if let Some(m) = mem_str.strip_suffix('M') {
        m.parse::<u64>().unwrap_or(0) * 1_000_000
    } else if let Some(g) = mem_str.strip_suffix('G') {
        g.parse::<u64>().unwrap_or(0) * 1_000_000_000
    } else {
        mem_str.parse::<u64>().unwrap_or(0)
    }
}

fn format_cpu(millicores: u64) -> String {
    if millicores >= 1000 {
        format!("{:.1} cores", millicores as f64 / 1000.0)
    } else {
        format!("{}m", millicores)
    }
}

fn format_memory(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} Gi", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.0} Mi", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.0} Ki", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

#[tauri::command]
pub async fn get_pod_metrics(
    context: String,
    namespace: String,
) -> Result<Vec<PodMetrics>, String> {
    let client = get_client(&context).await?;

    // Fetch pod metrics via raw API
    let url = if namespace == "_all" {
        "/apis/metrics.k8s.io/v1beta1/pods".to_string()
    } else {
        format!("/apis/metrics.k8s.io/v1beta1/namespaces/{}/pods", namespace)
    };

    let raw: serde_json::Value = client
        .request::<serde_json::Value>(
            http::Request::builder()
                .uri(&url)
                .body(Vec::new())
                .map_err(|e| format!("Failed to build request: {}", e))?,
        )
        .await
        .map_err(|e| format!("Metrics API not available: {}. Is metrics-server installed?", e))?;

    let items = raw
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or("Invalid metrics response")?;

    // Also fetch pod specs to get resource requests/limits for percentage calc
    let pod_api: Api<Pod> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), &namespace)
    };
    let pods = pod_api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list pods: {}", e))?;

    // Build a map of pod -> (requests_cpu, requests_mem, limits_cpu, limits_mem)
    let mut pod_resources: std::collections::HashMap<String, (u64, u64, u64, u64)> =
        std::collections::HashMap::new();
    for pod in &pods.items {
        let key = format!(
            "{}/{}",
            pod.metadata.namespace.as_deref().unwrap_or("default"),
            pod.metadata.name.as_deref().unwrap_or("")
        );
        let mut req_cpu = 0u64;
        let mut req_mem = 0u64;
        let mut lim_cpu = 0u64;
        let mut lim_mem = 0u64;
        if let Some(spec) = &pod.spec {
            for container in &spec.containers {
                if let Some(resources) = &container.resources {
                    if let Some(requests) = &resources.requests {
                        if let Some(cpu) = requests.get("cpu") {
                            req_cpu += parse_cpu(&cpu.0);
                        }
                        if let Some(mem) = requests.get("memory") {
                            req_mem += parse_memory(&mem.0);
                        }
                    }
                    if let Some(limits) = &resources.limits {
                        if let Some(cpu) = limits.get("cpu") {
                            lim_cpu += parse_cpu(&cpu.0);
                        }
                        if let Some(mem) = limits.get("memory") {
                            lim_mem += parse_memory(&mem.0);
                        }
                    }
                }
            }
        }
        pod_resources.insert(key, (req_cpu, req_mem, lim_cpu, lim_mem));
    }

    let mut metrics = Vec::new();
    for item in items {
        let name = item
            .pointer("/metadata/name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let ns = item
            .pointer("/metadata/namespace")
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();

        let mut containers = Vec::new();
        let mut total_cpu_mc = 0u64;
        let mut total_mem_b = 0u64;

        if let Some(cs) = item.get("containers").and_then(|v| v.as_array()) {
            for c in cs {
                let cname = c
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let cpu_str = c
                    .pointer("/usage/cpu")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0");
                let mem_str = c
                    .pointer("/usage/memory")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0");

                let cpu_mc = parse_cpu(cpu_str);
                let mem_b = parse_memory(mem_str);
                total_cpu_mc += cpu_mc;
                total_mem_b += mem_b;

                containers.push(ContainerMetrics {
                    name: cname,
                    cpu: format_cpu(cpu_mc),
                    memory: format_memory(mem_b),
                    cpu_millicores: cpu_mc,
                    memory_bytes: mem_b,
                });
            }
        }

        let key = format!("{}/{}", ns, name);
        let (req_cpu, req_mem, lim_cpu, lim_mem) =
            pod_resources.get(&key).copied().unwrap_or((0, 0, 0, 0));

        let cpu_pct = if req_cpu > 0 {
            Some((total_cpu_mc as f64 / req_cpu as f64) * 100.0)
        } else {
            None
        };
        let mem_pct = if req_mem > 0 {
            Some((total_mem_b as f64 / req_mem as f64) * 100.0)
        } else {
            None
        };
        let cpu_lim_pct = if lim_cpu > 0 {
            Some((total_cpu_mc as f64 / lim_cpu as f64) * 100.0)
        } else {
            None
        };
        let mem_lim_pct = if lim_mem > 0 {
            Some((total_mem_b as f64 / lim_mem as f64) * 100.0)
        } else {
            None
        };

        metrics.push(PodMetrics {
            name,
            namespace: ns,
            containers,
            cpu_total: format_cpu(total_cpu_mc),
            memory_total: format_memory(total_mem_b),
            cpu_percent: cpu_pct,
            memory_percent: mem_pct,
            cpu_limit_percent: cpu_lim_pct,
            memory_limit_percent: mem_lim_pct,
            cpu_request: if req_cpu > 0 { Some(format_cpu(req_cpu)) } else { None },
            memory_request: if req_mem > 0 { Some(format_memory(req_mem)) } else { None },
            cpu_limit: if lim_cpu > 0 { Some(format_cpu(lim_cpu)) } else { None },
            memory_limit: if lim_mem > 0 { Some(format_memory(lim_mem)) } else { None },
        });
    }

    Ok(metrics)
}

#[tauri::command]
pub async fn get_node_metrics(context: String) -> Result<Vec<NodeMetrics>, String> {
    let client = get_client(&context).await?;

    // Fetch node metrics
    let raw: serde_json::Value = client
        .request::<serde_json::Value>(
            http::Request::builder()
                .uri("/apis/metrics.k8s.io/v1beta1/nodes")
                .body(Vec::new())
                .map_err(|e| format!("Failed to build request: {}", e))?,
        )
        .await
        .map_err(|e| format!("Metrics API not available: {}. Is metrics-server installed?", e))?;

    let items = raw
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or("Invalid metrics response")?;

    // Get node capacity info
    use k8s_openapi::api::core::v1::Node;
    let node_api: Api<Node> = Api::all(client.clone());
    let nodes = node_api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list nodes: {}", e))?;

    let mut node_capacity: std::collections::HashMap<String, (u64, u64)> =
        std::collections::HashMap::new();
    for node in &nodes.items {
        let name = node.metadata.name.as_deref().unwrap_or("").to_string();
        if let Some(status) = &node.status {
            if let Some(allocatable) = &status.allocatable {
                let cpu = allocatable
                    .get("cpu")
                    .map(|q| parse_cpu(&q.0))
                    .unwrap_or(0);
                let mem = allocatable
                    .get("memory")
                    .map(|q| parse_memory(&q.0))
                    .unwrap_or(0);
                node_capacity.insert(name, (cpu, mem));
            }
        }
    }

    let mut metrics = Vec::new();
    for item in items {
        let name = item
            .pointer("/metadata/name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let cpu_str = item
            .pointer("/usage/cpu")
            .and_then(|v| v.as_str())
            .unwrap_or("0");
        let mem_str = item
            .pointer("/usage/memory")
            .and_then(|v| v.as_str())
            .unwrap_or("0");

        let cpu_mc = parse_cpu(cpu_str);
        let mem_b = parse_memory(mem_str);

        let (cap_cpu, cap_mem) = node_capacity.get(&name).copied().unwrap_or((0, 0));

        let cpu_pct = if cap_cpu > 0 {
            (cpu_mc as f64 / cap_cpu as f64) * 100.0
        } else {
            0.0
        };
        let mem_pct = if cap_mem > 0 {
            (mem_b as f64 / cap_mem as f64) * 100.0
        } else {
            0.0
        };

        metrics.push(NodeMetrics {
            name,
            cpu: format_cpu(cpu_mc),
            memory: format_memory(mem_b),
            cpu_millicores: cpu_mc,
            memory_bytes: mem_b,
            cpu_capacity: cap_cpu,
            memory_capacity: cap_mem,
            cpu_percent: cpu_pct,
            memory_percent: mem_pct,
        });
    }

    Ok(metrics)
}

#[tauri::command]
pub async fn get_cluster_summary(context: String, namespace: String) -> Result<ClusterMetricsSummary, String> {
    let (node_metrics, pod_metrics) = tokio::try_join!(
        get_node_metrics(context.clone()),
        get_pod_metrics(context, namespace)
    )?;

    let total_cpu: u64 = node_metrics.iter().map(|n| n.cpu_millicores).sum();
    let total_mem: u64 = node_metrics.iter().map(|n| n.memory_bytes).sum();
    let total_cpu_cap: u64 = node_metrics.iter().map(|n| n.cpu_capacity).sum();
    let total_mem_cap: u64 = node_metrics.iter().map(|n| n.memory_capacity).sum();

    let cpu_pct = if total_cpu_cap > 0 {
        (total_cpu as f64 / total_cpu_cap as f64) * 100.0
    } else {
        0.0
    };
    let mem_pct = if total_mem_cap > 0 {
        (total_mem as f64 / total_mem_cap as f64) * 100.0
    } else {
        0.0
    };

    Ok(ClusterMetricsSummary {
        node_count: node_metrics.len(),
        pod_count: pod_metrics.len(),
        node_metrics,
        total_cpu_millicores: total_cpu,
        total_memory_bytes: total_mem,
        total_cpu_capacity: total_cpu_cap,
        total_memory_capacity: total_mem_cap,
        cpu_percent: cpu_pct,
        memory_percent: mem_pct,
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PvcMetrics {
    pub name: String,
    pub namespace: String,
    pub capacity: String,
    pub capacity_bytes: u64,
    pub used_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    pub used_percent: Option<f64>,
    pub used_formatted: Option<String>,
    pub available_formatted: Option<String>,
    pub pod_name: Option<String>,
    pub volume_name: Option<String>,
}

#[tauri::command]
pub async fn get_pvc_metrics(
    context: String,
    namespace: String,
) -> Result<Vec<PvcMetrics>, String> {
    let client = get_client(&context).await?;

    // 1. List PVCs
    let pvc_api: Api<PersistentVolumeClaim> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), &namespace)
    };
    let pvcs = pvc_api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list PVCs: {}", e))?;

    // 2. List nodes to query kubelet stats
    let node_api: Api<Node> = Api::all(client.clone());
    let nodes = node_api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list nodes: {}", e))?;

    // 3. Query kubelet stats from each node for volume usage
    // Map: "namespace/pvc-name" -> (used_bytes, capacity_bytes, available_bytes, pod_name)
    let mut volume_usage: std::collections::HashMap<String, (u64, u64, u64, String)> =
        std::collections::HashMap::new();

    for node in &nodes.items {
        let node_name = node.metadata.name.as_deref().unwrap_or("");
        if node_name.is_empty() {
            continue;
        }

        let url = format!("/api/v1/nodes/{}/proxy/stats/summary", node_name);
        let stats: Result<serde_json::Value, _> = client
            .request::<serde_json::Value>(
                http::Request::builder()
                    .uri(&url)
                    .body(Vec::new())
                    .map_err(|e| format!("Failed to build request: {}", e))?,
            )
            .await;

        let stats = match stats {
            Ok(s) => s,
            Err(_) => continue, // Skip nodes where stats are unavailable
        };

        if let Some(pods) = stats.get("pods").and_then(|v| v.as_array()) {
            for pod in pods {
                let pod_ns = pod
                    .pointer("/podRef/namespace")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let pod_name = pod
                    .pointer("/podRef/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if let Some(volumes) = pod.get("volume").and_then(|v| v.as_array()) {
                    for vol in volumes {
                        if let Some(pvc_ref) = vol.get("pvcRef") {
                            let pvc_name = pvc_ref
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let pvc_ns = pvc_ref
                                .get("namespace")
                                .and_then(|v| v.as_str())
                                .unwrap_or(pod_ns);

                            let used = vol
                                .get("usedBytes")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let capacity = vol
                                .get("capacityBytes")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let available = vol
                                .get("availableBytes")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);

                            let key = format!("{}/{}", pvc_ns, pvc_name);
                            volume_usage
                                .insert(key, (used, capacity, available, pod_name.to_string()));
                        }
                    }
                }
            }
        }
    }

    // 4. Build PVC metrics
    let mut metrics = Vec::new();
    for pvc in &pvcs.items {
        let name = pvc.metadata.name.as_deref().unwrap_or("").to_string();
        let ns = pvc
            .metadata
            .namespace
            .as_deref()
            .unwrap_or("default")
            .to_string();

        // Get capacity from PVC status (actual bound capacity)
        let capacity_str = pvc
            .status
            .as_ref()
            .and_then(|s| s.capacity.as_ref())
            .and_then(|c| c.get("storage"))
            .map(|q| q.0.clone())
            .or_else(|| {
                // Fallback to requested capacity
                pvc.spec
                    .as_ref()
                    .and_then(|s| s.resources.as_ref())
                    .and_then(|r| r.requests.as_ref())
                    .and_then(|req| req.get("storage"))
                    .map(|q| q.0.clone())
            })
            .unwrap_or_else(|| "-".to_string());

        let capacity_bytes = parse_memory(&capacity_str);

        let key = format!("{}/{}", ns, name);
        let usage = volume_usage.get(&key);

        let pv_name = pvc
            .spec
            .as_ref()
            .and_then(|s| s.volume_name.clone());

        let (final_cap_str, final_cap_bytes, used_bytes, available_bytes, used_pct, used_fmt, avail_fmt, pod_name) =
            if let Some(&(used, kubelet_cap, avail, ref pname)) = usage {
                // Use kubelet's capacityBytes (actual filesystem capacity) for consistent display
                // This ensures Capacity = Used + Available and % is accurate
                let effective_cap = if kubelet_cap > 0 { kubelet_cap } else { capacity_bytes };
                let pct = if effective_cap > 0 {
                    Some((used as f64 / effective_cap as f64) * 100.0)
                } else {
                    None
                };
                (
                    if kubelet_cap > 0 { format_memory(kubelet_cap) } else { capacity_str.clone() },
                    effective_cap,
                    Some(used),
                    Some(avail),
                    pct,
                    Some(format_memory(used)),
                    Some(format_memory(avail)),
                    Some(pname.clone()),
                )
            } else {
                (capacity_str.clone(), capacity_bytes, None, None, None, None, None, None)
            };

        metrics.push(PvcMetrics {
            name,
            namespace: ns,
            capacity: final_cap_str,
            capacity_bytes: final_cap_bytes,
            used_bytes,
            available_bytes,
            used_percent: used_pct,
            used_formatted: used_fmt,
            available_formatted: avail_fmt,
            pod_name,
            volume_name: pv_name,
        });
    }

    Ok(metrics)
}
