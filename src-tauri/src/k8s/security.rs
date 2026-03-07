use super::context::get_client;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityFinding {
    pub severity: String,    // "critical", "high", "medium", "low"
    pub category: String,    // "privilege", "resource", "network", "image", "config"
    pub title: String,
    pub description: String,
    pub resource_kind: String,
    pub resource_name: String,
    pub namespace: String,
    pub remediation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityScanResult {
    pub findings: Vec<SecurityFinding>,
    pub summary: SecuritySummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecuritySummary {
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
    pub total_resources_scanned: u32,
    pub score: u32, // 0-100, higher is better
}

#[tauri::command]
pub async fn scan_security(
    context: String,
    namespace: String,
) -> Result<SecurityScanResult, String> {
    let client = get_client(&context).await?;
    let mut findings: Vec<SecurityFinding> = Vec::new();

    // Scan pods
    let pod_api: Api<Pod> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), &namespace)
    };

    let pods = pod_api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("Failed to list pods: {}", e))?;

    let total_resources = pods.items.len() as u32;

    for pod in &pods.items {
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        let pod_ns = pod.metadata.namespace.clone().unwrap_or_else(|| "default".into());

        if let Some(spec) = &pod.spec {
            // Check host network
            if spec.host_network == Some(true) {
                findings.push(SecurityFinding {
                    severity: "high".into(),
                    category: "network".into(),
                    title: "Host network enabled".into(),
                    description: format!("Pod '{}' uses host network, exposing all host ports", pod_name),
                    resource_kind: "Pod".into(),
                    resource_name: pod_name.clone(),
                    namespace: pod_ns.clone(),
                    remediation: "Set spec.hostNetwork to false unless absolutely required".into(),
                });
            }

            // Check host PID
            if spec.host_pid == Some(true) {
                findings.push(SecurityFinding {
                    severity: "high".into(),
                    category: "privilege".into(),
                    title: "Host PID namespace shared".into(),
                    description: format!("Pod '{}' shares host PID namespace", pod_name),
                    resource_kind: "Pod".into(),
                    resource_name: pod_name.clone(),
                    namespace: pod_ns.clone(),
                    remediation: "Set spec.hostPID to false".into(),
                });
            }

            // Check host IPC
            if spec.host_ipc == Some(true) {
                findings.push(SecurityFinding {
                    severity: "medium".into(),
                    category: "privilege".into(),
                    title: "Host IPC namespace shared".into(),
                    description: format!("Pod '{}' shares host IPC namespace", pod_name),
                    resource_kind: "Pod".into(),
                    resource_name: pod_name.clone(),
                    namespace: pod_ns.clone(),
                    remediation: "Set spec.hostIPC to false".into(),
                });
            }

            for container in &spec.containers {
                let cname = &container.name;

                // Check privileged containers
                if let Some(sc) = &container.security_context {
                    if sc.privileged == Some(true) {
                        findings.push(SecurityFinding {
                            severity: "critical".into(),
                            category: "privilege".into(),
                            title: "Privileged container".into(),
                            description: format!(
                                "Container '{}' in pod '{}' runs in privileged mode",
                                cname, pod_name
                            ),
                            resource_kind: "Pod".into(),
                            resource_name: pod_name.clone(),
                            namespace: pod_ns.clone(),
                            remediation: "Set securityContext.privileged to false".into(),
                        });
                    }

                    // Check run as root
                    if sc.run_as_user == Some(0) {
                        findings.push(SecurityFinding {
                            severity: "high".into(),
                            category: "privilege".into(),
                            title: "Running as root (UID 0)".into(),
                            description: format!(
                                "Container '{}' in pod '{}' runs as root user",
                                cname, pod_name
                            ),
                            resource_kind: "Pod".into(),
                            resource_name: pod_name.clone(),
                            namespace: pod_ns.clone(),
                            remediation: "Set securityContext.runAsNonRoot to true and specify a non-root runAsUser".into(),
                        });
                    }

                    // Check allow privilege escalation
                    if sc.allow_privilege_escalation == Some(true) {
                        findings.push(SecurityFinding {
                            severity: "high".into(),
                            category: "privilege".into(),
                            title: "Privilege escalation allowed".into(),
                            description: format!(
                                "Container '{}' in pod '{}' allows privilege escalation",
                                cname, pod_name
                            ),
                            resource_kind: "Pod".into(),
                            resource_name: pod_name.clone(),
                            namespace: pod_ns.clone(),
                            remediation: "Set securityContext.allowPrivilegeEscalation to false".into(),
                        });
                    }

                    // Check read-only root filesystem
                    if sc.read_only_root_filesystem != Some(true) {
                        findings.push(SecurityFinding {
                            severity: "low".into(),
                            category: "config".into(),
                            title: "Writable root filesystem".into(),
                            description: format!(
                                "Container '{}' in pod '{}' has a writable root filesystem",
                                cname, pod_name
                            ),
                            resource_kind: "Pod".into(),
                            resource_name: pod_name.clone(),
                            namespace: pod_ns.clone(),
                            remediation: "Set securityContext.readOnlyRootFilesystem to true".into(),
                        });
                    }

                    // Check capabilities
                    if let Some(caps) = &sc.capabilities {
                        if let Some(adds) = &caps.add {
                            for cap in adds {
                                if cap == "SYS_ADMIN" || cap == "ALL" {
                                    findings.push(SecurityFinding {
                                        severity: "critical".into(),
                                        category: "privilege".into(),
                                        title: format!("Dangerous capability: {}", cap),
                                        description: format!(
                                            "Container '{}' in pod '{}' has {} capability",
                                            cname, pod_name, cap
                                        ),
                                        resource_kind: "Pod".into(),
                                        resource_name: pod_name.clone(),
                                        namespace: pod_ns.clone(),
                                        remediation: "Remove dangerous capabilities and use minimal set".into(),
                                    });
                                } else if cap == "NET_RAW" || cap == "NET_ADMIN" {
                                    findings.push(SecurityFinding {
                                        severity: "high".into(),
                                        category: "network".into(),
                                        title: format!("Network capability: {}", cap),
                                        description: format!(
                                            "Container '{}' in pod '{}' has {} capability",
                                            cname, pod_name, cap
                                        ),
                                        resource_kind: "Pod".into(),
                                        resource_name: pod_name.clone(),
                                        namespace: pod_ns.clone(),
                                        remediation: "Remove network capabilities unless required".into(),
                                    });
                                }
                            }
                        }
                    }
                } else {
                    // No security context at all
                    findings.push(SecurityFinding {
                        severity: "medium".into(),
                        category: "config".into(),
                        title: "No security context defined".into(),
                        description: format!(
                            "Container '{}' in pod '{}' has no security context",
                            cname, pod_name
                        ),
                        resource_kind: "Pod".into(),
                        resource_name: pod_name.clone(),
                        namespace: pod_ns.clone(),
                        remediation: "Define a securityContext with runAsNonRoot, readOnlyRootFilesystem, and drop ALL capabilities".into(),
                    });
                }

                // Check resource limits
                if let Some(resources) = &container.resources {
                    if resources.limits.is_none() {
                        findings.push(SecurityFinding {
                            severity: "medium".into(),
                            category: "resource".into(),
                            title: "No resource limits".into(),
                            description: format!(
                                "Container '{}' in pod '{}' has no resource limits set",
                                cname, pod_name
                            ),
                            resource_kind: "Pod".into(),
                            resource_name: pod_name.clone(),
                            namespace: pod_ns.clone(),
                            remediation: "Set resources.limits for CPU and memory".into(),
                        });
                    }
                    if resources.requests.is_none() {
                        findings.push(SecurityFinding {
                            severity: "low".into(),
                            category: "resource".into(),
                            title: "No resource requests".into(),
                            description: format!(
                                "Container '{}' in pod '{}' has no resource requests set",
                                cname, pod_name
                            ),
                            resource_kind: "Pod".into(),
                            resource_name: pod_name.clone(),
                            namespace: pod_ns.clone(),
                            remediation: "Set resources.requests for CPU and memory".into(),
                        });
                    }
                } else {
                    findings.push(SecurityFinding {
                        severity: "medium".into(),
                        category: "resource".into(),
                        title: "No resource limits or requests".into(),
                        description: format!(
                            "Container '{}' in pod '{}' has no resource configuration",
                            cname, pod_name
                        ),
                        resource_kind: "Pod".into(),
                        resource_name: pod_name.clone(),
                        namespace: pod_ns.clone(),
                        remediation: "Set resources.limits and resources.requests for CPU and memory".into(),
                    });
                }

                // Check image tag
                if let Some(image) = &container.image {
                    if image.ends_with(":latest") || !image.contains(':') {
                        findings.push(SecurityFinding {
                            severity: "medium".into(),
                            category: "image".into(),
                            title: "Using latest or untagged image".into(),
                            description: format!(
                                "Container '{}' in pod '{}' uses image '{}' without a specific tag",
                                cname, pod_name, image
                            ),
                            resource_kind: "Pod".into(),
                            resource_name: pod_name.clone(),
                            namespace: pod_ns.clone(),
                            remediation: "Use a specific image tag or digest instead of :latest".into(),
                        });
                    }
                }

                // Check liveness/readiness probes
                if container.liveness_probe.is_none() && container.readiness_probe.is_none() {
                    findings.push(SecurityFinding {
                        severity: "low".into(),
                        category: "config".into(),
                        title: "No health probes".into(),
                        description: format!(
                            "Container '{}' in pod '{}' has no liveness or readiness probes",
                            cname, pod_name
                        ),
                        resource_kind: "Pod".into(),
                        resource_name: pod_name.clone(),
                        namespace: pod_ns.clone(),
                        remediation: "Add livenessProbe and readinessProbe for reliability".into(),
                    });
                }
            }

            // Check service account token auto-mount
            if spec.automount_service_account_token != Some(false) {
                // Only flag if using default service account
                if spec.service_account_name.as_deref() == Some("default")
                    || spec.service_account_name.is_none()
                {
                    findings.push(SecurityFinding {
                        severity: "medium".into(),
                        category: "privilege".into(),
                        title: "Default service account with auto-mounted token".into(),
                        description: format!(
                            "Pod '{}' uses the default service account with auto-mounted token",
                            pod_name
                        ),
                        resource_kind: "Pod".into(),
                        resource_name: pod_name.clone(),
                        namespace: pod_ns.clone(),
                        remediation: "Use a dedicated service account or set automountServiceAccountToken to false".into(),
                    });
                }
            }
        }
    }

    // Calculate summary
    let mut critical = 0u32;
    let mut high = 0u32;
    let mut medium = 0u32;
    let mut low = 0u32;

    for f in &findings {
        match f.severity.as_str() {
            "critical" => critical += 1,
            "high" => high += 1,
            "medium" => medium += 1,
            "low" => low += 1,
            _ => {}
        }
    }

    // Score: 100 = perfect, deduct points per finding
    let weighted = critical * 10 + high * 5 + medium * 2 + low;
    let max_possible = total_resources.max(1) * 20; // rough scale
    let score = if weighted >= max_possible {
        0
    } else {
        ((max_possible - weighted) * 100 / max_possible).min(100)
    };

    Ok(SecurityScanResult {
        findings,
        summary: SecuritySummary {
            critical,
            high,
            medium,
            low,
            total_resources_scanned: total_resources,
            score,
        },
    })
}
