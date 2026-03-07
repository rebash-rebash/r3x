use super::context::get_client;
use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

fn parse_cpu(cpu_str: &str) -> u64 {
    if let Some(n) = cpu_str.strip_suffix('n') {
        n.parse::<u64>().unwrap_or(0) / 1_000_000
    } else if let Some(u) = cpu_str.strip_suffix('u') {
        u.parse::<u64>().unwrap_or(0) / 1_000
    } else if let Some(m) = cpu_str.strip_suffix('m') {
        m.parse::<u64>().unwrap_or(0)
    } else {
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
        format!("{:.1}", millicores as f64 / 1000.0)
    } else {
        format!("{}m", millicores)
    }
}

fn format_memory(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1}Gi", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.0}Mi", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.0}Ki", bytes as f64 / 1024.0)
    } else {
        format!("{}B", bytes)
    }
}

fn percentile(sorted: &[u64], pct: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((pct / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContainerBenchmark {
    pub name: String,
    pub samples: usize,
    // Current settings
    pub current_cpu_request: Option<String>,
    pub current_cpu_limit: Option<String>,
    pub current_mem_request: Option<String>,
    pub current_mem_limit: Option<String>,
    // Stats - CPU (millicores)
    pub cpu_avg: u64,
    pub cpu_p50: u64,
    pub cpu_p95: u64,
    pub cpu_p99: u64,
    pub cpu_max: u64,
    pub cpu_min: u64,
    // Stats - Memory (bytes)
    pub mem_avg: u64,
    pub mem_p50: u64,
    pub mem_p95: u64,
    pub mem_p99: u64,
    pub mem_max: u64,
    pub mem_min: u64,
    // Formatted stats
    pub cpu_avg_fmt: String,
    pub cpu_p50_fmt: String,
    pub cpu_p95_fmt: String,
    pub cpu_p99_fmt: String,
    pub cpu_max_fmt: String,
    pub mem_avg_fmt: String,
    pub mem_p50_fmt: String,
    pub mem_p95_fmt: String,
    pub mem_p99_fmt: String,
    pub mem_max_fmt: String,
    // Recommendations
    pub rec_cpu_request: String,
    pub rec_cpu_limit: String,
    pub rec_mem_request: String,
    pub rec_mem_limit: String,
    // Raw recommendation values for comparison
    pub rec_cpu_request_mc: u64,
    pub rec_cpu_limit_mc: u64,
    pub rec_mem_request_bytes: u64,
    pub rec_mem_limit_bytes: u64,
    // Current raw values
    pub current_cpu_request_mc: u64,
    pub current_cpu_limit_mc: u64,
    pub current_mem_request_bytes: u64,
    pub current_mem_limit_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BenchmarkResult {
    pub pod_name: String,
    pub namespace: String,
    pub duration_secs: u64,
    pub interval_secs: u64,
    pub total_samples: usize,
    pub containers: Vec<ContainerBenchmark>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BenchmarkProgress {
    pub sample: usize,
    pub total: usize,
    pub elapsed_secs: u64,
    pub duration_secs: u64,
}

#[tauri::command]
pub async fn benchmark_pod(
    app: AppHandle,
    context: String,
    namespace: String,
    pod_name: String,
    duration_secs: u64,
    interval_secs: u64,
) -> Result<BenchmarkResult, String> {
    let client = get_client(&context).await?;

    // Fetch pod spec for current requests/limits
    let pod_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let pod = pod_api
        .get(&pod_name)
        .await
        .map_err(|e| format!("Failed to get pod: {}", e))?;

    // Build per-container resource map: name -> (req_cpu, req_mem, lim_cpu, lim_mem)
    let mut container_resources: HashMap<String, (u64, u64, u64, u64, Option<String>, Option<String>, Option<String>, Option<String>)> = HashMap::new();
    if let Some(spec) = &pod.spec {
        for c in &spec.containers {
            let mut req_cpu = 0u64;
            let mut req_mem = 0u64;
            let mut lim_cpu = 0u64;
            let mut lim_mem = 0u64;
            let mut req_cpu_str = None;
            let mut req_mem_str = None;
            let mut lim_cpu_str = None;
            let mut lim_mem_str = None;
            if let Some(res) = &c.resources {
                if let Some(requests) = &res.requests {
                    if let Some(cpu) = requests.get("cpu") {
                        req_cpu = parse_cpu(&cpu.0);
                        req_cpu_str = Some(cpu.0.clone());
                    }
                    if let Some(mem) = requests.get("memory") {
                        req_mem = parse_memory(&mem.0);
                        req_mem_str = Some(mem.0.clone());
                    }
                }
                if let Some(limits) = &res.limits {
                    if let Some(cpu) = limits.get("cpu") {
                        lim_cpu = parse_cpu(&cpu.0);
                        lim_cpu_str = Some(cpu.0.clone());
                    }
                    if let Some(mem) = limits.get("memory") {
                        lim_mem = parse_memory(&mem.0);
                        lim_mem_str = Some(mem.0.clone());
                    }
                }
            }
            container_resources.insert(
                c.name.clone(),
                (req_cpu, req_mem, lim_cpu, lim_mem, req_cpu_str, req_mem_str, lim_cpu_str, lim_mem_str),
            );
        }
    }

    // Collect samples
    let total_samples = (duration_secs / interval_secs).max(1) as usize;
    // container_name -> Vec<(cpu_mc, mem_bytes)>
    let mut samples: HashMap<String, Vec<(u64, u64)>> = HashMap::new();

    let metrics_url = format!(
        "/apis/metrics.k8s.io/v1beta1/namespaces/{}/pods/{}",
        namespace, pod_name
    );

    for i in 0..total_samples {
        // Emit progress
        let _ = app.emit(
            "benchmark-progress",
            BenchmarkProgress {
                sample: i + 1,
                total: total_samples,
                elapsed_secs: i as u64 * interval_secs,
                duration_secs,
            },
        );

        // Fetch metrics for this specific pod
        let raw: serde_json::Value = client
            .request::<serde_json::Value>(
                http::Request::builder()
                    .uri(&metrics_url)
                    .body(Vec::new())
                    .map_err(|e| format!("Failed to build request: {}", e))?,
            )
            .await
            .map_err(|e| format!("Metrics API error (sample {}): {}", i + 1, e))?;

        if let Some(containers) = raw.get("containers").and_then(|v| v.as_array()) {
            for c in containers {
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

                samples.entry(cname).or_default().push((cpu_mc, mem_b));
            }
        }

        // Wait for next interval (skip on last sample)
        if i < total_samples - 1 {
            tokio::time::sleep(tokio::time::Duration::from_secs(interval_secs)).await;
        }
    }

    // Compute statistics
    let mut container_benchmarks = Vec::new();

    for (name, data) in &samples {
        let n = data.len();
        if n == 0 {
            continue;
        }

        let mut cpus: Vec<u64> = data.iter().map(|(c, _)| *c).collect();
        let mut mems: Vec<u64> = data.iter().map(|(_, m)| *m).collect();
        cpus.sort();
        mems.sort();

        let cpu_sum: u64 = cpus.iter().sum();
        let mem_sum: u64 = mems.iter().sum();
        let cpu_avg = cpu_sum / n as u64;
        let mem_avg = mem_sum / n as u64;
        let cpu_min = cpus[0];
        let cpu_max = cpus[n - 1];
        let mem_min = mems[0];
        let mem_max = mems[n - 1];
        let cpu_p50 = percentile(&cpus, 50.0);
        let cpu_p95 = percentile(&cpus, 95.0);
        let cpu_p99 = percentile(&cpus, 99.0);
        let mem_p50 = percentile(&mems, 50.0);
        let mem_p95 = percentile(&mems, 95.0);
        let mem_p99 = percentile(&mems, 99.0);

        // Recommendations:
        // Request = P50 + 20% headroom (minimum = average)
        // Limit = P99 + 25% headroom (minimum = max observed)
        // Constraint: limit >= request always
        let rec_cpu_req = ((cpu_p50 as f64 * 1.2).ceil() as u64).max(cpu_avg);
        let rec_cpu_lim = ((cpu_p99 as f64 * 1.25).ceil() as u64).max(cpu_max).max(rec_cpu_req);
        let rec_mem_req = ((mem_p50 as f64 * 1.2).ceil() as u64).max(mem_avg);
        let rec_mem_lim = ((mem_p99 as f64 * 1.25).ceil() as u64).max(mem_max).max(rec_mem_req);

        let (req_cpu, req_mem, lim_cpu, lim_mem, req_cpu_str, req_mem_str, lim_cpu_str, lim_mem_str) =
            container_resources
                .get(name)
                .cloned()
                .unwrap_or((0, 0, 0, 0, None, None, None, None));

        container_benchmarks.push(ContainerBenchmark {
            name: name.clone(),
            samples: n,
            current_cpu_request: req_cpu_str,
            current_cpu_limit: lim_cpu_str,
            current_mem_request: req_mem_str,
            current_mem_limit: lim_mem_str,
            cpu_avg,
            cpu_p50,
            cpu_p95,
            cpu_p99,
            cpu_max,
            cpu_min,
            mem_avg,
            mem_p50,
            mem_p95,
            mem_p99,
            mem_max,
            mem_min,
            cpu_avg_fmt: format_cpu(cpu_avg),
            cpu_p50_fmt: format_cpu(cpu_p50),
            cpu_p95_fmt: format_cpu(cpu_p95),
            cpu_p99_fmt: format_cpu(cpu_p99),
            cpu_max_fmt: format_cpu(cpu_max),
            mem_avg_fmt: format_memory(mem_avg),
            mem_p50_fmt: format_memory(mem_p50),
            mem_p95_fmt: format_memory(mem_p95),
            mem_p99_fmt: format_memory(mem_p99),
            mem_max_fmt: format_memory(mem_max),
            rec_cpu_request: format_cpu(rec_cpu_req),
            rec_cpu_limit: format_cpu(rec_cpu_lim),
            rec_mem_request: format_memory(rec_mem_req),
            rec_mem_limit: format_memory(rec_mem_lim),
            rec_cpu_request_mc: rec_cpu_req,
            rec_cpu_limit_mc: rec_cpu_lim,
            rec_mem_request_bytes: rec_mem_req,
            rec_mem_limit_bytes: rec_mem_lim,
            current_cpu_request_mc: req_cpu,
            current_cpu_limit_mc: lim_cpu,
            current_mem_request_bytes: req_mem,
            current_mem_limit_bytes: lim_mem,
        });
    }

    container_benchmarks.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(BenchmarkResult {
        pod_name: pod_name.clone(),
        namespace: namespace.clone(),
        duration_secs,
        interval_secs,
        total_samples,
        containers: container_benchmarks,
    })
}
