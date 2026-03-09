use super::context::get_client;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PodTraffic {
    pub pod_name: String,
    pub namespace: String,
    pub node: String,
    pub age: String,
    // Live rate (bytes/sec) — computed from two snapshots
    pub rx_rate: f64,
    pub tx_rate: f64,
    pub rx_rate_fmt: String,
    pub tx_rate_fmt: String,
    pub total_rate: f64,
    pub total_rate_fmt: String,
    pub pct_of_total: f64,
    // Cumulative totals (lifetime)
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_fmt: String,
    pub tx_fmt: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrafficDistribution {
    pub workload_name: String,
    pub workload_kind: String,
    pub namespace: String,
    pub pod_count: usize,
    pub total_rx_rate: f64,
    pub total_tx_rate: f64,
    pub total_rx_rate_fmt: String,
    pub total_tx_rate_fmt: String,
    pub pods: Vec<PodTraffic>,
    pub balance_score: f64,
    pub sample_interval_secs: f64,
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1_000_000_000 {
        format!("{:.1} GB", bytes as f64 / 1_000_000_000.0)
    } else if bytes >= 1_000_000 {
        format!("{:.1} MB", bytes as f64 / 1_000_000.0)
    } else if bytes >= 1_000 {
        format!("{:.1} KB", bytes as f64 / 1_000.0)
    } else {
        format!("{} B", bytes)
    }
}

fn format_rate(bytes_per_sec: f64) -> String {
    if bytes_per_sec >= 1_000_000_000.0 {
        format!("{:.1} GB/s", bytes_per_sec / 1_000_000_000.0)
    } else if bytes_per_sec >= 1_000_000.0 {
        format!("{:.1} MB/s", bytes_per_sec / 1_000_000.0)
    } else if bytes_per_sec >= 1_000.0 {
        format!("{:.1} KB/s", bytes_per_sec / 1_000.0)
    } else {
        format!("{:.0} B/s", bytes_per_sec)
    }
}

fn format_age(seconds: i64) -> String {
    if seconds < 0 {
        return "?".to_string();
    }
    let days = seconds / 86400;
    let hours = (seconds % 86400) / 3600;
    let mins = (seconds % 3600) / 60;
    if days > 0 {
        format!("{}d{}h", days, hours)
    } else if hours > 0 {
        format!("{}h{}m", hours, mins)
    } else {
        format!("{}m", mins)
    }
}

fn get_workload_selector_sync(
    labels: Option<BTreeMap<String, String>>,
) -> String {
    labels
        .unwrap_or_default()
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(",")
}

/// Fetch network stats for pods from their nodes. Returns: (pod_name, namespace, node, rx_bytes, tx_bytes)
async fn fetch_pod_network_stats(
    client: &kube::Client,
    node_pods: &HashMap<String, Vec<(String, String)>>,
) -> Vec<(String, String, String, u64, u64)> {
    let mut handles = Vec::new();
    for (node_name, pod_list) in node_pods {
        let c = client.clone();
        let nn = node_name.clone();
        let pl = pod_list.clone();
        handles.push(tokio::spawn(async move {
            let stats_url = format!("/api/v1/nodes/{}/proxy/stats/summary", nn);
            let req = match http::Request::builder()
                .uri(&stats_url)
                .body(Vec::new())
            {
                Ok(r) => r,
                Err(_) => return Vec::new(),
            };
            let stats: serde_json::Value = match c.request(req).await {
                Ok(s) => s,
                Err(_) => return Vec::new(),
            };

            let mut results: Vec<(String, String, String, u64, u64)> = Vec::new();
            if let Some(pod_stats) = stats.get("pods").and_then(|p| p.as_array()) {
                for ps in pod_stats {
                    let ps_name = ps
                        .get("podRef")
                        .and_then(|r| r.get("name"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("");
                    let ps_ns = ps
                        .get("podRef")
                        .and_then(|r| r.get("namespace"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("");

                    for (pn, pns) in &pl {
                        if ps_name == pn && ps_ns == pns {
                            let rx = ps
                                .get("network")
                                .and_then(|n| n.get("rxBytes"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let tx = ps
                                .get("network")
                                .and_then(|n| n.get("txBytes"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            results.push((pn.clone(), pns.clone(), nn.clone(), rx, tx));
                        }
                    }
                }
            }
            results
        }));
    }

    let mut all = Vec::new();
    for handle in handles {
        if let Ok(results) = handle.await {
            all.extend(results);
        }
    }
    all
}

#[tauri::command]
pub async fn get_traffic_distribution(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<TrafficDistribution, String> {
    let client = get_client(&context).await?;

    // Get the workload's label selector
    let label_selector = match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_workload_selector_sync(res.spec.and_then(|s| s.selector.match_labels))
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_workload_selector_sync(res.spec.and_then(|s| s.selector.match_labels))
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_workload_selector_sync(res.spec.and_then(|s| s.selector.match_labels))
        }
        "ReplicaSet" => {
            let api: Api<ReplicaSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_workload_selector_sync(res.spec.and_then(|s| s.selector.match_labels))
        }
        _ => return Err(format!("Unsupported kind: {}", kind)),
    };

    if label_selector.is_empty() {
        return Err("No label selector found".to_string());
    }

    // List pods matching the selector
    let pod_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let pods = pod_api
        .list(&ListParams::default().labels(&label_selector))
        .await
        .map_err(|e| format!("Failed to list pods: {}", e))?;

    // Build pod info: node, age
    let now = chrono::Utc::now();
    let mut pod_info: HashMap<String, (String, String)> = HashMap::new(); // pod_name -> (node, age)
    let mut node_pods: HashMap<String, Vec<(String, String)>> = HashMap::new();

    for pod in &pods.items {
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        let pod_ns = pod.metadata.namespace.clone().unwrap_or_default();
        let node_name = pod
            .spec
            .as_ref()
            .and_then(|s| s.node_name.clone())
            .unwrap_or_default();

        let age = pod
            .metadata
            .creation_timestamp
            .as_ref()
            .map(|ts| {
                let age_secs = (now - ts.0).num_seconds();
                format_age(age_secs)
            })
            .unwrap_or_else(|| "?".to_string());

        pod_info.insert(pod_name.clone(), (node_name.clone(), age));
        if !node_name.is_empty() {
            node_pods.entry(node_name).or_default().push((pod_name, pod_ns));
        }
    }

    // Take snapshot 1
    let snap1 = fetch_pod_network_stats(&client, &node_pods).await;
    let t1 = std::time::Instant::now();

    // Wait 3 seconds for delta
    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

    // Take snapshot 2
    let snap2 = fetch_pod_network_stats(&client, &node_pods).await;
    let elapsed = t1.elapsed().as_secs_f64();

    // Build snapshot 1 map: pod_name -> (rx, tx)
    let snap1_map: HashMap<String, (u64, u64)> = snap1
        .iter()
        .map(|(pn, _, _, rx, tx)| (pn.clone(), (*rx, *tx)))
        .collect();

    // Compute rates from deltas
    let mut pod_traffics: Vec<PodTraffic> = Vec::new();
    let mut grand_total_rate: f64 = 0.0;

    for (pod_name, pod_ns, node, rx2, tx2) in &snap2 {
        let (rx1, tx1) = snap1_map.get(pod_name).copied().unwrap_or((*rx2, *tx2));
        let rx_delta = rx2.saturating_sub(rx1);
        let tx_delta = tx2.saturating_sub(tx1);

        let rx_rate = rx_delta as f64 / elapsed;
        let tx_rate = tx_delta as f64 / elapsed;
        let total_rate = rx_rate + tx_rate;
        grand_total_rate += total_rate;

        let (_, age) = pod_info.get(pod_name).cloned().unwrap_or_default();

        pod_traffics.push(PodTraffic {
            pod_name: pod_name.clone(),
            namespace: pod_ns.clone(),
            node: node.clone(),
            age,
            rx_rate,
            tx_rate,
            rx_rate_fmt: format_rate(rx_rate),
            tx_rate_fmt: format_rate(tx_rate),
            total_rate,
            total_rate_fmt: format_rate(total_rate),
            pct_of_total: 0.0,
            rx_bytes: *rx2,
            tx_bytes: *tx2,
            rx_fmt: format_bytes(*rx2),
            tx_fmt: format_bytes(*tx2),
        });
    }

    // Compute percentages based on live rate
    if grand_total_rate > 0.0 {
        for pt in &mut pod_traffics {
            pt.pct_of_total = (pt.total_rate / grand_total_rate) * 100.0;
        }
    }

    // Sort by rate descending
    pod_traffics.sort_by(|a, b| b.total_rate.partial_cmp(&a.total_rate).unwrap_or(std::cmp::Ordering::Equal));

    // Compute balance score based on live rate
    let balance_score = if pod_traffics.len() <= 1 {
        100.0
    } else {
        let mean = grand_total_rate / pod_traffics.len() as f64;
        if mean == 0.0 {
            100.0
        } else {
            let variance: f64 = pod_traffics
                .iter()
                .map(|p| (p.total_rate - mean).powi(2))
                .sum::<f64>()
                / pod_traffics.len() as f64;
            let cv = variance.sqrt() / mean;
            ((1.0 - cv.min(1.0)) * 100.0).max(0.0)
        }
    };

    let total_rx_rate: f64 = pod_traffics.iter().map(|p| p.rx_rate).sum();
    let total_tx_rate: f64 = pod_traffics.iter().map(|p| p.tx_rate).sum();

    Ok(TrafficDistribution {
        workload_name: name,
        workload_kind: kind,
        namespace,
        pod_count: pod_traffics.len(),
        total_rx_rate,
        total_tx_rate,
        total_rx_rate_fmt: format_rate(total_rx_rate),
        total_tx_rate_fmt: format_rate(total_tx_rate),
        pods: pod_traffics,
        balance_score,
        sample_interval_secs: elapsed,
    })
}
