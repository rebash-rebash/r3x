use super::context::get_client;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContainerCost {
    pub name: String,
    pub cpu_request: String,
    pub memory_request: String,
    pub cpu_request_cores: f64,
    pub memory_request_gb: f64,
    pub cpu_monthly: f64,
    pub memory_monthly: f64,
    pub total_monthly: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PodCost {
    pub pod_name: String,
    pub containers: Vec<ContainerCost>,
    pub total_monthly: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderPricing {
    pub provider: String,
    pub tier: String, // "on-demand", "spot", "committed-1yr", "committed-3yr"
    pub cpu_hourly: f64,
    pub memory_gb_hourly: f64,
    pub total_monthly: f64,
    pub savings_pct: f64, // vs on-demand
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CostEstimation {
    pub workload_name: String,
    pub workload_kind: String,
    pub namespace: String,
    pub pod_count: usize,
    pub replica_count: i32,
    pub total_cpu_cores: f64,
    pub total_memory_gb: f64,
    pub total_cpu_request_fmt: String,
    pub total_memory_request_fmt: String,
    pub providers: Vec<ProviderPricing>,
    pub pods: Vec<PodCost>,
    pub selected_provider: String,
}

const HOURS_PER_MONTH: f64 = 730.0; // average

// Pricing tiers per provider (approximate, per vCPU-hour and per GB-hour)
struct CloudPricing {
    name: &'static str,
    tier: &'static str,
    cpu_hourly: f64,
    mem_gb_hourly: f64,
    savings_pct: f64, // vs on-demand baseline
}

const PROVIDERS: &[CloudPricing] = &[
    // GCP / GKE
    CloudPricing { name: "GKE", tier: "on-demand",     cpu_hourly: 0.031611, mem_gb_hourly: 0.004237, savings_pct: 0.0 },
    CloudPricing { name: "GKE", tier: "spot",           cpu_hourly: 0.006322, mem_gb_hourly: 0.000847, savings_pct: 80.0 },
    CloudPricing { name: "GKE", tier: "committed-1yr",  cpu_hourly: 0.019899, mem_gb_hourly: 0.002669, savings_pct: 37.0 },
    CloudPricing { name: "GKE", tier: "committed-3yr",  cpu_hourly: 0.014261, mem_gb_hourly: 0.001911, savings_pct: 55.0 },
    // AWS / EKS
    CloudPricing { name: "EKS", tier: "on-demand",     cpu_hourly: 0.04048,  mem_gb_hourly: 0.004464, savings_pct: 0.0 },
    CloudPricing { name: "EKS", tier: "spot",           cpu_hourly: 0.01214,  mem_gb_hourly: 0.001339, savings_pct: 70.0 },
    CloudPricing { name: "EKS", tier: "savings-1yr",    cpu_hourly: 0.02551,  mem_gb_hourly: 0.002813, savings_pct: 37.0 },
    CloudPricing { name: "EKS", tier: "savings-3yr",    cpu_hourly: 0.01619,  mem_gb_hourly: 0.001786, savings_pct: 60.0 },
    // Azure / AKS
    CloudPricing { name: "AKS", tier: "on-demand",     cpu_hourly: 0.04,     mem_gb_hourly: 0.005,    savings_pct: 0.0 },
    CloudPricing { name: "AKS", tier: "spot",           cpu_hourly: 0.008,    mem_gb_hourly: 0.001,    savings_pct: 80.0 },
    CloudPricing { name: "AKS", tier: "reserved-1yr",   cpu_hourly: 0.02480,  mem_gb_hourly: 0.003100, savings_pct: 38.0 },
    CloudPricing { name: "AKS", tier: "reserved-3yr",   cpu_hourly: 0.01560,  mem_gb_hourly: 0.001950, savings_pct: 61.0 },
];

fn parse_cpu_cores(cpu_str: &str) -> f64 {
    if let Some(n) = cpu_str.strip_suffix('n') {
        n.parse::<f64>().unwrap_or(0.0) / 1_000_000_000.0
    } else if let Some(u) = cpu_str.strip_suffix('u') {
        u.parse::<f64>().unwrap_or(0.0) / 1_000_000.0
    } else if let Some(m) = cpu_str.strip_suffix('m') {
        m.parse::<f64>().unwrap_or(0.0) / 1000.0
    } else {
        cpu_str.parse::<f64>().unwrap_or(0.0)
    }
}

fn parse_memory_gb(mem_str: &str) -> f64 {
    let bytes = if let Some(ki) = mem_str.strip_suffix("Ki") {
        ki.parse::<f64>().unwrap_or(0.0) * 1024.0
    } else if let Some(mi) = mem_str.strip_suffix("Mi") {
        mi.parse::<f64>().unwrap_or(0.0) * 1024.0 * 1024.0
    } else if let Some(gi) = mem_str.strip_suffix("Gi") {
        gi.parse::<f64>().unwrap_or(0.0) * 1024.0 * 1024.0 * 1024.0
    } else if let Some(k) = mem_str.strip_suffix('K') {
        k.parse::<f64>().unwrap_or(0.0) * 1000.0
    } else if let Some(m) = mem_str.strip_suffix('M') {
        m.parse::<f64>().unwrap_or(0.0) * 1_000_000.0
    } else if let Some(g) = mem_str.strip_suffix('G') {
        g.parse::<f64>().unwrap_or(0.0) * 1_000_000_000.0
    } else {
        mem_str.parse::<f64>().unwrap_or(0.0)
    };
    bytes / (1024.0 * 1024.0 * 1024.0)
}

fn format_cpu(cores: f64) -> String {
    let mc = (cores * 1000.0).round() as u64;
    if mc >= 1000 {
        format!("{:.1} cores", cores)
    } else {
        format!("{}m", mc)
    }
}

fn format_memory(gb: f64) -> String {
    if gb >= 1.0 {
        format!("{:.1} Gi", gb)
    } else {
        let mi = gb * 1024.0;
        if mi >= 1.0 {
            format!("{:.0} Mi", mi)
        } else {
            format!("{:.0} Ki", gb * 1024.0 * 1024.0)
        }
    }
}

fn get_selector(labels: Option<BTreeMap<String, String>>) -> String {
    labels
        .unwrap_or_default()
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(",")
}

#[tauri::command]
pub async fn estimate_cost(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<CostEstimation, String> {
    let client = get_client(&context).await?;

    // Get replica count and selector
    let (label_selector, replica_count) = match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            let replicas = res.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            let sel = get_selector(res.spec.and_then(|s| s.selector.match_labels));
            (sel, replicas)
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            let replicas = res.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            let sel = get_selector(res.spec.and_then(|s| s.selector.match_labels));
            (sel, replicas)
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            let sel = get_selector(res.spec.and_then(|s| s.selector.match_labels));
            (sel, 0) // DaemonSets run on all nodes
        }
        "ReplicaSet" => {
            let api: Api<ReplicaSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            let replicas = res.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            let sel = get_selector(res.spec.and_then(|s| s.selector.match_labels));
            (sel, replicas)
        }
        _ => return Err(format!("Unsupported kind: {}", kind)),
    };

    if label_selector.is_empty() {
        return Err("No label selector found".to_string());
    }

    let pod_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let pods = pod_api
        .list(&ListParams::default().labels(&label_selector))
        .await
        .map_err(|e| format!("Failed to list pods: {}", e))?;

    let mut total_cpu_cores = 0.0f64;
    let mut total_memory_gb = 0.0f64;
    let mut pod_costs = Vec::new();

    // Use GKE as default for per-pod breakdown
    let default_pricing = &PROVIDERS[0];

    for pod in &pods.items {
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        let mut container_costs = Vec::new();
        let mut pod_total = 0.0f64;

        if let Some(spec) = &pod.spec {
            for c in &spec.containers {
                let mut cpu_req_str = "0".to_string();
                let mut mem_req_str = "0".to_string();
                let mut cpu_cores = 0.0f64;
                let mut mem_gb = 0.0f64;

                if let Some(res) = &c.resources {
                    if let Some(requests) = &res.requests {
                        if let Some(cpu) = requests.get("cpu") {
                            cpu_req_str = cpu.0.clone();
                            cpu_cores = parse_cpu_cores(&cpu.0);
                        }
                        if let Some(mem) = requests.get("memory") {
                            mem_req_str = mem.0.clone();
                            mem_gb = parse_memory_gb(&mem.0);
                        }
                    }
                }

                let cpu_monthly = cpu_cores * default_pricing.cpu_hourly * HOURS_PER_MONTH;
                let mem_monthly = mem_gb * default_pricing.mem_gb_hourly * HOURS_PER_MONTH;
                let total = cpu_monthly + mem_monthly;
                pod_total += total;

                total_cpu_cores += cpu_cores;
                total_memory_gb += mem_gb;

                container_costs.push(ContainerCost {
                    name: c.name.clone(),
                    cpu_request: cpu_req_str,
                    memory_request: mem_req_str,
                    cpu_request_cores: cpu_cores,
                    memory_request_gb: mem_gb,
                    cpu_monthly,
                    memory_monthly: mem_monthly,
                    total_monthly: total,
                });
            }
        }

        pod_costs.push(PodCost {
            pod_name,
            containers: container_costs,
            total_monthly: pod_total,
        });
    }

    // Calculate per-provider totals
    let providers: Vec<ProviderPricing> = PROVIDERS
        .iter()
        .map(|p| {
            let cpu_cost = total_cpu_cores * p.cpu_hourly * HOURS_PER_MONTH;
            let mem_cost = total_memory_gb * p.mem_gb_hourly * HOURS_PER_MONTH;
            ProviderPricing {
                provider: p.name.to_string(),
                tier: p.tier.to_string(),
                cpu_hourly: p.cpu_hourly,
                memory_gb_hourly: p.mem_gb_hourly,
                total_monthly: cpu_cost + mem_cost,
                savings_pct: p.savings_pct,
            }
        })
        .collect();

    Ok(CostEstimation {
        workload_name: name,
        workload_kind: kind,
        namespace,
        pod_count: pods.items.len(),
        replica_count,
        total_cpu_cores,
        total_memory_gb,
        total_cpu_request_fmt: format_cpu(total_cpu_cores),
        total_memory_request_fmt: format_memory(total_memory_gb),
        providers,
        pods: pod_costs,
        selected_provider: "GKE (GCP)".to_string(),
    })
}
