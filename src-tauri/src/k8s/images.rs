use super::context::get_client;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageFinding {
    pub severity: String, // "critical", "high", "medium", "low", "info"
    pub title: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CveSummary {
    pub critical: usize,
    pub high: usize,
    pub medium: usize,
    pub low: usize,
    pub unknown: usize,
    pub total: usize,
    pub top_cves: Vec<CveDetail>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CveDetail {
    pub id: String,
    pub severity: String,
    pub pkg_name: String,
    pub installed_version: String,
    pub fixed_version: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContainerImageInfo {
    pub container_name: String,
    pub image: String,
    pub image_id: String,
    pub registry: String,
    pub repository: String,
    pub tag: String,
    pub pull_policy: String,
    pub pod_name: String,
    pub findings: Vec<ImageFinding>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UniqueImage {
    pub image: String,
    pub registry: String,
    pub repository: String,
    pub tag: String,
    pub used_by: Vec<String>,
    pub pod_count: usize,
    pub findings: Vec<ImageFinding>,
    pub risk_score: u32,
    pub cve_summary: Option<CveSummary>,
    pub trivy_scanned: bool,
    pub trivy_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageScanResult {
    pub workload_name: String,
    pub workload_kind: String,
    pub namespace: String,
    pub total_images: usize,
    pub unique_images: usize,
    pub total_findings: usize,
    pub critical_count: usize,
    pub high_count: usize,
    pub medium_count: usize,
    pub low_count: usize,
    pub images: Vec<UniqueImage>,
    pub all_containers: Vec<ContainerImageInfo>,
    pub overall_risk: u32,
    pub trivy_available: bool,
}

fn parse_image(full_image: &str) -> (String, String, String) {
    let (image_ref, tag) = if let Some(at_idx) = full_image.rfind('@') {
        (&full_image[..at_idx], full_image[at_idx + 1..].to_string())
    } else if let Some(colon_idx) = full_image.rfind(':') {
        let after_colon = &full_image[colon_idx + 1..];
        if after_colon.contains('/') {
            (full_image, "latest".to_string())
        } else {
            (&full_image[..colon_idx], after_colon.to_string())
        }
    } else {
        (full_image, "latest".to_string())
    };

    let parts: Vec<&str> = image_ref.split('/').collect();
    let (registry, repository) = if parts.len() >= 3 {
        (parts[0].to_string(), parts[1..].join("/"))
    } else if parts.len() == 2 {
        if parts[0].contains('.') || parts[0].contains(':') {
            (parts[0].to_string(), parts[1].to_string())
        } else {
            ("docker.io".to_string(), image_ref.to_string())
        }
    } else {
        ("docker.io".to_string(), format!("library/{}", image_ref))
    };

    (registry, repository, tag)
}

fn analyze_image(image: &str, tag: &str, pull_policy: &str, registry: &str) -> Vec<ImageFinding> {
    let mut findings = Vec::new();

    if tag == "latest" {
        findings.push(ImageFinding {
            severity: "high".to_string(),
            title: "Using :latest tag".to_string(),
            description: "Mutable tag — deployments are non-reproducible. Pin to a specific version or digest.".to_string(),
        });
    }

    if tag.is_empty() {
        findings.push(ImageFinding {
            severity: "high".to_string(),
            title: "No image tag specified".to_string(),
            description: "Defaults to :latest. Always specify an explicit tag.".to_string(),
        });
    }

    if pull_policy == "Never" {
        findings.push(ImageFinding {
            severity: "medium".to_string(),
            title: "Pull policy: Never".to_string(),
            description: "Image will never be pulled. Ensure it exists on all nodes.".to_string(),
        });
    }

    let image_lower = image.to_lowercase();
    let known_deprecated = [
        ("python:2", "Python 2 is end-of-life"),
        ("node:8", "Node.js 8 is end-of-life"),
        ("node:10", "Node.js 10 is end-of-life"),
        ("node:12", "Node.js 12 is end-of-life"),
        ("node:14", "Node.js 14 is end-of-life"),
        ("node:15", "Node.js 15 is end-of-life"),
        ("ubuntu:14", "Ubuntu 14.04 is end-of-life"),
        ("ubuntu:16", "Ubuntu 16.04 is end-of-life"),
        ("ubuntu:18", "Ubuntu 18.04 end of standard support"),
        ("debian:8", "Debian 8 is end-of-life"),
        ("debian:9", "Debian 9 is end-of-life"),
        ("centos:6", "CentOS 6 is end-of-life"),
        ("centos:7", "CentOS 7 is end-of-life"),
        ("centos:8", "CentOS 8 is end-of-life"),
        ("alpine:3.12", "Alpine 3.12 is unsupported"),
        ("alpine:3.13", "Alpine 3.13 is unsupported"),
    ];

    for (pattern, msg) in &known_deprecated {
        if image_lower.contains(pattern) || format!("{}:{}", image_lower, tag).contains(pattern) {
            findings.push(ImageFinding {
                severity: "critical".to_string(),
                title: "End-of-life base image".to_string(),
                description: format!("{}. Upgrade to a supported version.", msg),
            });
            break;
        }
    }

    if registry == "docker.io" {
        findings.push(ImageFinding {
            severity: "info".to_string(),
            title: "Docker Hub registry".to_string(),
            description: "Consider a private registry for production to avoid rate limits.".to_string(),
        });
    }

    let _ = pull_policy; // suppress warning
    findings
}

/// Resolve trivy binary — check common paths
fn find_trivy() -> Option<String> {
    // Try PATH first
    if let Ok(output) = std::process::Command::new("which")
        .arg("trivy")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }

    // Check common locations
    for path in &[
        "/opt/homebrew/bin/trivy",
        "/usr/local/bin/trivy",
        "/usr/bin/trivy",
    ] {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    None
}

/// Run trivy on a single image and parse results
async fn trivy_scan_image(trivy_path: &str, image: &str) -> Result<CveSummary, String> {
    let tp = trivy_path.to_string();
    let img = image.to_string();

    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new(&tp)
            .args([
                "image",
                "--format", "json",
                "--quiet",
                "--severity", "CRITICAL,HIGH,MEDIUM,LOW",
                "--timeout", "120s",
                "--skip-db-update",
                &img,
            ])
            .output()
            .map_err(|e| format!("Failed to run trivy: {}", e))?;

        if !output.status.success() {
            // Try again with DB update if first attempt failed
            let output2 = std::process::Command::new(&tp)
                .args([
                    "image",
                    "--format", "json",
                    "--quiet",
                    "--severity", "CRITICAL,HIGH,MEDIUM,LOW",
                    "--timeout", "180s",
                    &img,
                ])
                .output()
                .map_err(|e| format!("Failed to run trivy: {}", e))?;

            if !output2.status.success() {
                let stderr = String::from_utf8_lossy(&output2.stderr);
                return Err(format!("Trivy scan failed: {}", stderr.chars().take(200).collect::<String>()));
            }
            return parse_trivy_json(&output2.stdout);
        }

        parse_trivy_json(&output.stdout)
    })
    .await
    .map_err(|e| format!("Trivy task failed: {}", e))?
}

fn parse_trivy_json(data: &[u8]) -> Result<CveSummary, String> {
    let json: serde_json::Value = serde_json::from_slice(data)
        .map_err(|e| format!("Failed to parse trivy JSON: {}", e))?;

    let mut critical = 0usize;
    let mut high = 0usize;
    let mut medium = 0usize;
    let mut low = 0usize;
    let mut unknown = 0usize;
    let mut all_cves: Vec<CveDetail> = Vec::new();

    // Trivy JSON: { "Results": [ { "Vulnerabilities": [...] } ] }
    let results = json.get("Results")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();

    for result in &results {
        let vulns = result.get("Vulnerabilities")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for vuln in &vulns {
            let severity = vuln.get("Severity")
                .and_then(|s| s.as_str())
                .unwrap_or("UNKNOWN")
                .to_uppercase();

            match severity.as_str() {
                "CRITICAL" => critical += 1,
                "HIGH" => high += 1,
                "MEDIUM" => medium += 1,
                "LOW" => low += 1,
                _ => unknown += 1,
            }

            let cve_id = vuln.get("VulnerabilityID")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let pkg_name = vuln.get("PkgName")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let installed = vuln.get("InstalledVersion")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let fixed = vuln.get("FixedVersion")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let title = vuln.get("Title")
                .and_then(|s| s.as_str())
                .unwrap_or_else(|| {
                    vuln.get("Description")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                })
                .to_string();

            all_cves.push(CveDetail {
                id: cve_id,
                severity: severity.to_lowercase(),
                pkg_name,
                installed_version: installed,
                fixed_version: fixed,
                title: if title.len() > 120 {
                    format!("{}...", &title[..120])
                } else {
                    title
                },
            });
        }
    }

    let total = critical + high + medium + low + unknown;

    // Sort: critical first, then high, etc. Keep top 20
    all_cves.sort_by(|a, b| {
        let sev_order = |s: &str| match s {
            "critical" => 0,
            "high" => 1,
            "medium" => 2,
            "low" => 3,
            _ => 4,
        };
        sev_order(&a.severity).cmp(&sev_order(&b.severity))
    });
    all_cves.truncate(20);

    Ok(CveSummary {
        critical,
        high,
        medium,
        low,
        unknown,
        total,
        top_cves: all_cves,
    })
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
pub async fn scan_images(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<ImageScanResult, String> {
    let client = get_client(&context).await?;

    let label_selector = match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_selector(res.spec.and_then(|s| s.selector.match_labels))
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_selector(res.spec.and_then(|s| s.selector.match_labels))
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_selector(res.spec.and_then(|s| s.selector.match_labels))
        }
        "ReplicaSet" => {
            let api: Api<ReplicaSet> = Api::namespaced(client.clone(), &namespace);
            let res = api.get(&name).await.map_err(|e| format!("{}", e))?;
            get_selector(res.spec.and_then(|s| s.selector.match_labels))
        }
        "Pod" => {
            let pod_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
            let pod = pod_api.get(&name).await.map_err(|e| format!("{}", e))?;
            return build_scan_result(&name, &kind, &namespace, &[pod]).await;
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

    build_scan_result(&name, &kind, &namespace, &pods.items).await
}

async fn build_scan_result(
    workload_name: &str,
    workload_kind: &str,
    namespace: &str,
    pods: &[Pod],
) -> Result<ImageScanResult, String> {
    let mut all_containers = Vec::new();
    let mut image_map: HashMap<String, UniqueImage> = HashMap::new();

    for pod in pods {
        let pod_name = pod.metadata.name.clone().unwrap_or_default();

        let raw: serde_json::Value =
            serde_json::to_value(pod).unwrap_or(serde_json::Value::Null);
        let status_obj = raw.get("status").cloned().unwrap_or(serde_json::Value::Null);
        let container_statuses = status_obj
            .get("containerStatuses")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let image_id_map: HashMap<String, String> = container_statuses
            .iter()
            .filter_map(|cs| {
                let name = cs.get("name")?.as_str()?.to_string();
                let id = cs.get("imageID")?.as_str()?.to_string();
                Some((name, id))
            })
            .collect();

        if let Some(spec) = &pod.spec {
            for c in &spec.containers {
                let image = c.image.clone().unwrap_or_default();
                let (registry, repository, tag) = parse_image(&image);
                let pull_policy = c.image_pull_policy.clone().unwrap_or_else(|| "IfNotPresent".to_string());
                let image_id = image_id_map.get(&c.name).cloned().unwrap_or_default();
                let findings = analyze_image(&image, &tag, &pull_policy, &registry);

                all_containers.push(ContainerImageInfo {
                    container_name: c.name.clone(),
                    image: image.clone(),
                    image_id,
                    registry: registry.clone(),
                    repository: repository.clone(),
                    tag: tag.clone(),
                    pull_policy,
                    pod_name: pod_name.clone(),
                    findings: findings.clone(),
                });

                let entry = image_map.entry(image.clone()).or_insert_with(|| UniqueImage {
                    image: image.clone(),
                    registry: registry.clone(),
                    repository: repository.clone(),
                    tag: tag.clone(),
                    used_by: Vec::new(),
                    pod_count: 0,
                    findings: findings.clone(),
                    risk_score: 0,
                    cve_summary: None,
                    trivy_scanned: false,
                    trivy_error: None,
                });
                if !entry.used_by.contains(&c.name) {
                    entry.used_by.push(c.name.clone());
                }
                entry.pod_count += 1;
            }

            if let Some(init_containers) = &spec.init_containers {
                for c in init_containers {
                    let image = c.image.clone().unwrap_or_default();
                    let (registry, repository, tag) = parse_image(&image);
                    let pull_policy = c.image_pull_policy.clone().unwrap_or_else(|| "IfNotPresent".to_string());
                    let findings = analyze_image(&image, &tag, &pull_policy, &registry);

                    all_containers.push(ContainerImageInfo {
                        container_name: format!("{} (init)", c.name),
                        image: image.clone(),
                        image_id: String::new(),
                        registry: registry.clone(),
                        repository: repository.clone(),
                        tag: tag.clone(),
                        pull_policy,
                        pod_name: pod_name.clone(),
                        findings: findings.clone(),
                    });

                    let entry = image_map.entry(image.clone()).or_insert_with(|| UniqueImage {
                        image: image.clone(),
                        registry: registry.clone(),
                        repository: repository.clone(),
                        tag: tag.clone(),
                        used_by: Vec::new(),
                        pod_count: 0,
                        findings: findings.clone(),
                        risk_score: 0,
                        cve_summary: None,
                        trivy_scanned: false,
                        trivy_error: None,
                    });
                    let init_name = format!("{} (init)", c.name);
                    if !entry.used_by.contains(&init_name) {
                        entry.used_by.push(init_name);
                    }
                    entry.pod_count += 1;
                }
            }
        }
    }

    // Run Trivy scans on unique images in parallel
    let trivy_path = find_trivy();
    let trivy_available = trivy_path.is_some();

    if let Some(ref tp) = trivy_path {
        let unique_images: Vec<String> = image_map.keys().cloned().collect();
        let mut handles = Vec::new();

        for img in unique_images {
            let tp_clone = tp.clone();
            let img_clone = img.clone();
            handles.push(tokio::spawn(async move {
                let result = trivy_scan_image(&tp_clone, &img_clone).await;
                (img_clone, result)
            }));
        }

        for handle in handles {
            if let Ok((img, result)) = handle.await {
                if let Some(entry) = image_map.get_mut(&img) {
                    match result {
                        Ok(summary) => {
                            entry.trivy_scanned = true;
                            entry.cve_summary = Some(summary);
                        }
                        Err(e) => {
                            entry.trivy_scanned = false;
                            entry.trivy_error = Some(e);
                        }
                    }
                }
            }
        }
    }

    // Calculate risk scores (combine static + CVE findings)
    let mut critical_count = 0usize;
    let mut high_count = 0usize;
    let mut medium_count = 0usize;
    let mut low_count = 0usize;

    let mut images: Vec<UniqueImage> = image_map.into_values().collect();
    for img in &mut images {
        let mut score = 0u32;

        // Static findings
        for f in &img.findings {
            match f.severity.as_str() {
                "critical" => score += 30,
                "high" => score += 20,
                "medium" => score += 8,
                "low" => score += 3,
                _ => {}
            }
        }

        // CVE findings (these are the real ones)
        if let Some(ref cve) = img.cve_summary {
            critical_count += cve.critical;
            high_count += cve.high;
            medium_count += cve.medium;
            low_count += cve.low;

            // Weight CVEs heavily
            score += (cve.critical as u32) * 15;
            score += (cve.high as u32) * 5;
            score += (cve.medium as u32) * 2;
            score += cve.low as u32;
        } else {
            // Only count static findings if no trivy data
            for f in &img.findings {
                match f.severity.as_str() {
                    "critical" => critical_count += 1,
                    "high" => high_count += 1,
                    "medium" => medium_count += 1,
                    "low" => low_count += 1,
                    _ => {}
                }
            }
        }

        img.risk_score = score.min(100);
    }

    images.sort_by(|a, b| b.risk_score.cmp(&a.risk_score));

    let total_findings = critical_count + high_count + medium_count + low_count;
    let overall_risk = images.iter().map(|i| i.risk_score).max().unwrap_or(0);

    Ok(ImageScanResult {
        workload_name: workload_name.to_string(),
        workload_kind: workload_kind.to_string(),
        namespace: namespace.to_string(),
        total_images: all_containers.len(),
        unique_images: images.len(),
        total_findings,
        critical_count,
        high_count,
        medium_count,
        low_count,
        images,
        all_containers,
        overall_risk,
        trivy_available,
    })
}
