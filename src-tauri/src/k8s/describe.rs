use super::context::get_client;
use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct PodDescribe {
    pub name: String,
    pub namespace: String,
    pub node: String,
    pub status: String,
    pub phase: String,
    pub pod_ip: String,
    pub host_ip: String,
    pub qos_class: String,
    pub start_time: String,
    pub labels: Vec<(String, String)>,
    pub annotations: Vec<(String, String)>,
    pub conditions: Vec<PodCondition>,
    pub containers: Vec<ContainerDescribe>,
    pub init_containers: Vec<ContainerDescribe>,
    pub volumes: Vec<VolumeDescribe>,
    pub tolerations: Vec<String>,
    pub service_account: String,
    pub priority_class: String,
    pub restart_policy: String,
    pub dns_policy: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct PodCondition {
    pub condition_type: String,
    pub status: String,
    pub reason: String,
    pub message: String,
    pub last_transition: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ContainerDescribe {
    pub name: String,
    pub image: String,
    pub state: String,
    pub ready: bool,
    pub restart_count: i32,
    pub ports: Vec<String>,
    pub cpu_request: String,
    pub cpu_limit: String,
    pub memory_request: String,
    pub memory_limit: String,
    pub liveness_probe: String,
    pub readiness_probe: String,
    pub startup_probe: String,
    pub env_count: usize,
    pub mounts: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct VolumeDescribe {
    pub name: String,
    pub volume_type: String,
    pub details: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ResourceDescribe {
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub labels: Vec<(String, String)>,
    pub annotations: Vec<(String, String)>,
    pub creation_timestamp: String,
    /// Pod-specific describe info (None for non-pod resources)
    pub pod: Option<PodDescribe>,
}

#[tauri::command]
pub async fn describe_resource(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<ResourceDescribe, String> {
    let client = get_client(&context).await?;

    if kind == "Pod" {
        let api: Api<Pod> = if namespace.is_empty() || namespace == "_all" {
            Api::all(client)
        } else {
            Api::namespaced(client, &namespace)
        };

        let pod = api
            .get(&name)
            .await
            .map_err(|e| format!("Failed to get pod: {}", e))?;

        let meta = pod.metadata.clone();
        let spec = pod.spec.clone().unwrap_or_default();
        let status = pod.status.clone().unwrap_or_default();

        let labels: Vec<(String, String)> = meta
            .labels
            .as_ref()
            .map(|l| l.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();

        let annotations: Vec<(String, String)> = meta
            .annotations
            .as_ref()
            .map(|a| {
                a.iter()
                    .map(|(k, v)| {
                        let display_val = if v.len() > 200 {
                            format!("{}...", &v[..200])
                        } else {
                            v.clone()
                        };
                        (k.clone(), display_val)
                    })
                    .collect()
            })
            .unwrap_or_default();

        let conditions: Vec<PodCondition> = status
            .conditions
            .as_ref()
            .map(|conds| {
                conds
                    .iter()
                    .map(|c| PodCondition {
                        condition_type: c.type_.clone(),
                        status: c.status.clone(),
                        reason: c.reason.clone().unwrap_or_default(),
                        message: c.message.clone().unwrap_or_default(),
                        last_transition: c
                            .last_transition_time
                            .as_ref()
                            .map(|t| t.0.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                            .unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let container_statuses = status.container_statuses.clone().unwrap_or_default();
        let init_container_statuses =
            status.init_container_statuses.clone().unwrap_or_default();

        let containers: Vec<ContainerDescribe> = spec
            .containers
            .iter()
            .map(|c| {
                let cs = container_statuses
                    .iter()
                    .find(|s| s.name == c.name);

                let state = cs
                    .and_then(|s| s.state.as_ref())
                    .map(|st| {
                        if st.running.is_some() {
                            "Running".to_string()
                        } else if let Some(w) = &st.waiting {
                            format!("Waiting: {}", w.reason.as_deref().unwrap_or("Unknown"))
                        } else if let Some(t) = &st.terminated {
                            format!(
                                "Terminated: {}",
                                t.reason.as_deref().unwrap_or("Unknown")
                            )
                        } else {
                            "Unknown".to_string()
                        }
                    })
                    .unwrap_or_else(|| "Unknown".to_string());

                let ports: Vec<String> = c
                    .ports
                    .as_ref()
                    .map(|ps| {
                        ps.iter()
                            .map(|p| {
                                let proto = p.protocol.as_deref().unwrap_or("TCP");
                                match &p.name {
                                    Some(name) => {
                                        format!("{}/{} ({})", p.container_port, proto, name)
                                    }
                                    None => format!("{}/{}", p.container_port, proto),
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                let resources = c.resources.as_ref();
                let cpu_request = resources
                    .and_then(|r| r.requests.as_ref())
                    .and_then(|r| r.get("cpu"))
                    .map(|v| v.0.clone())
                    .unwrap_or_else(|| "-".to_string());
                let cpu_limit = resources
                    .and_then(|r| r.limits.as_ref())
                    .and_then(|r| r.get("cpu"))
                    .map(|v| v.0.clone())
                    .unwrap_or_else(|| "-".to_string());
                let memory_request = resources
                    .and_then(|r| r.requests.as_ref())
                    .and_then(|r| r.get("memory"))
                    .map(|v| v.0.clone())
                    .unwrap_or_else(|| "-".to_string());
                let memory_limit = resources
                    .and_then(|r| r.limits.as_ref())
                    .and_then(|r| r.get("memory"))
                    .map(|v| v.0.clone())
                    .unwrap_or_else(|| "-".to_string());

                let liveness_probe = format_probe(c.liveness_probe.as_ref());
                let readiness_probe = format_probe(c.readiness_probe.as_ref());
                let startup_probe = format_probe(c.startup_probe.as_ref());

                let mounts: Vec<String> = c
                    .volume_mounts
                    .as_ref()
                    .map(|vms| {
                        vms.iter()
                            .map(|vm| {
                                let ro = if vm.read_only.unwrap_or(false) {
                                    " (ro)"
                                } else {
                                    " (rw)"
                                };
                                format!("{} -> {}{}", vm.name, vm.mount_path, ro)
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                ContainerDescribe {
                    name: c.name.clone(),
                    image: c.image.clone().unwrap_or_default(),
                    state,
                    ready: cs.map(|s| s.ready).unwrap_or(false),
                    restart_count: cs.map(|s| s.restart_count).unwrap_or(0),
                    ports,
                    cpu_request,
                    cpu_limit,
                    memory_request,
                    memory_limit,
                    liveness_probe,
                    readiness_probe,
                    startup_probe,
                    env_count: c.env.as_ref().map(|e| e.len()).unwrap_or(0),
                    mounts,
                }
            })
            .collect();

        let init_containers: Vec<ContainerDescribe> = spec
            .init_containers
            .as_ref()
            .map(|ics| {
                ics.iter()
                    .map(|c| {
                        let cs = init_container_statuses
                            .iter()
                            .find(|s| s.name == c.name);

                        let state = cs
                            .and_then(|s| s.state.as_ref())
                            .map(|st| {
                                if st.running.is_some() {
                                    "Running".to_string()
                                } else if let Some(w) = &st.waiting {
                                    format!(
                                        "Waiting: {}",
                                        w.reason.as_deref().unwrap_or("Unknown")
                                    )
                                } else if let Some(t) = &st.terminated {
                                    format!(
                                        "Terminated: {}",
                                        t.reason.as_deref().unwrap_or("Unknown")
                                    )
                                } else {
                                    "Unknown".to_string()
                                }
                            })
                            .unwrap_or_else(|| "Unknown".to_string());

                        ContainerDescribe {
                            name: c.name.clone(),
                            image: c.image.clone().unwrap_or_default(),
                            state,
                            ready: cs.map(|s| s.ready).unwrap_or(false),
                            restart_count: cs.map(|s| s.restart_count).unwrap_or(0),
                            ports: vec![],
                            cpu_request: "-".to_string(),
                            cpu_limit: "-".to_string(),
                            memory_request: "-".to_string(),
                            memory_limit: "-".to_string(),
                            liveness_probe: "-".to_string(),
                            readiness_probe: "-".to_string(),
                            startup_probe: "-".to_string(),
                            env_count: c.env.as_ref().map(|e| e.len()).unwrap_or(0),
                            mounts: vec![],
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        let volumes: Vec<VolumeDescribe> = spec
            .volumes
            .as_ref()
            .map(|vols| {
                vols.iter()
                    .map(|v| {
                        let (vtype, details) = describe_volume(v);
                        VolumeDescribe {
                            name: v.name.clone(),
                            volume_type: vtype,
                            details,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        let tolerations: Vec<String> = spec
            .tolerations
            .as_ref()
            .map(|ts| {
                ts.iter()
                    .map(|t| {
                        let key = t.key.as_deref().unwrap_or("*");
                        let op = t.operator.as_deref().unwrap_or("Equal");
                        let val = t.value.as_deref().unwrap_or("");
                        let effect = t.effect.as_deref().unwrap_or("*");
                        if op == "Exists" {
                            format!("{} op=Exists effect={}", key, effect)
                        } else {
                            format!("{}={} effect={}", key, val, effect)
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        let phase = status
            .phase
            .as_deref()
            .unwrap_or("Unknown")
            .to_string();

        let pod_describe = PodDescribe {
            name: name.clone(),
            namespace: namespace.clone(),
            node: spec.node_name.unwrap_or_else(|| "-".to_string()),
            status: phase.clone(),
            phase,
            pod_ip: status
                .pod_ips
                .as_ref()
                .and_then(|ips| ips.first())
                .map(|ip| ip.ip.clone())
                .or(status.pod_ip)
                .unwrap_or_else(|| "-".to_string()),
            host_ip: status.host_ip.unwrap_or_else(|| "-".to_string()),
            qos_class: status
                .qos_class
                .as_deref()
                .unwrap_or("Unknown")
                .to_string(),
            start_time: status
                .start_time
                .as_ref()
                .map(|t| t.0.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                .unwrap_or_else(|| "-".to_string()),
            labels,
            annotations: annotations.clone(),
            conditions,
            containers,
            init_containers,
            volumes,
            tolerations,
            service_account: spec
                .service_account_name
                .unwrap_or_else(|| "-".to_string()),
            priority_class: spec.priority_class_name.unwrap_or_else(|| "-".to_string()),
            restart_policy: spec
                .restart_policy
                .unwrap_or_else(|| "-".to_string()),
            dns_policy: spec.dns_policy.unwrap_or_else(|| "-".to_string()),
        };

        Ok(ResourceDescribe {
            kind: "Pod".to_string(),
            name: name.clone(),
            namespace: namespace.clone(),
            labels: pod_describe.labels.clone(),
            annotations,
            creation_timestamp: meta
                .creation_timestamp
                .map(|t| t.0.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                .unwrap_or_default(),
            pod: Some(pod_describe),
        })
    } else {
        // For non-pod resources, return basic describe with labels/annotations from YAML
        let yaml_str = super::resources::get_resource_yaml(
            context.clone(),
            namespace.clone(),
            kind.clone(),
            name.clone(),
        )
        .await?;

        // Parse labels and annotations from the YAML
        let doc: serde_yaml::Value =
            serde_yaml::from_str(&yaml_str).unwrap_or(serde_yaml::Value::Null);
        let metadata = &doc["metadata"];

        let labels = parse_yaml_map(&metadata["labels"]);
        let annotations = parse_yaml_map(&metadata["annotations"]);
        let creation = metadata["creationTimestamp"]
            .as_str()
            .unwrap_or("")
            .to_string();

        Ok(ResourceDescribe {
            kind,
            name,
            namespace,
            labels,
            annotations,
            creation_timestamp: creation,
            pod: None,
        })
    }
}

fn format_probe(probe: Option<&k8s_openapi::api::core::v1::Probe>) -> String {
    match probe {
        None => "-".to_string(),
        Some(p) => {
            let action = if let Some(http) = &p.http_get {
                let port = match &http.port {
                    k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => {
                        i.to_string()
                    }
                    k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => {
                        s.clone()
                    }
                };
                format!(
                    "http-get {}:{}{}",
                    http.scheme.as_deref().unwrap_or("HTTP").to_lowercase(),
                    port,
                    http.path.as_deref().unwrap_or("/")
                )
            } else if let Some(tcp) = &p.tcp_socket {
                let port = match &tcp.port {
                    k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => {
                        i.to_string()
                    }
                    k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => {
                        s.clone()
                    }
                };
                format!("tcp-socket :{}", port)
            } else if let Some(exec) = &p.exec {
                let cmd = exec
                    .command
                    .as_ref()
                    .map(|c| c.join(" "))
                    .unwrap_or_default();
                format!("exec [{}]", cmd)
            } else if p.grpc.is_some() {
                "grpc".to_string()
            } else {
                "unknown".to_string()
            };

            let delay = p.initial_delay_seconds.unwrap_or(0);
            let period = p.period_seconds.unwrap_or(10);
            let timeout = p.timeout_seconds.unwrap_or(1);
            format!(
                "{} delay={}s period={}s timeout={}s",
                action, delay, period, timeout
            )
        }
    }
}

fn describe_volume(v: &k8s_openapi::api::core::v1::Volume) -> (String, String) {
    if let Some(cm) = &v.config_map {
        (
            "ConfigMap".to_string(),
            cm.name.clone(),
        )
    } else if let Some(s) = &v.secret {
        ("Secret".to_string(), s.secret_name.clone().unwrap_or_default())
    } else if let Some(pvc) = &v.persistent_volume_claim {
        ("PVC".to_string(), pvc.claim_name.clone())
    } else if v.empty_dir.is_some() {
        ("EmptyDir".to_string(), String::new())
    } else if let Some(hp) = &v.host_path {
        ("HostPath".to_string(), hp.path.clone())
    } else if let Some(dapi) = &v.downward_api {
        let items = dapi
            .items
            .as_ref()
            .map(|items| {
                items
                    .iter()
                    .map(|i| i.path.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        ("DownwardAPI".to_string(), items)
    } else if let Some(proj) = &v.projected {
        let count = proj.sources.as_ref().map(|s| s.len()).unwrap_or(0);
        ("Projected".to_string(), format!("{} sources", count))
    } else if v.csi.is_some() {
        ("CSI".to_string(), String::new())
    } else {
        ("Other".to_string(), String::new())
    }
}

fn parse_yaml_map(val: &serde_yaml::Value) -> Vec<(String, String)> {
    match val.as_mapping() {
        Some(map) => map
            .iter()
            .map(|(k, v)| {
                let key = k.as_str().unwrap_or("").to_string();
                let value = v.as_str().unwrap_or("").to_string();
                let display = if value.len() > 200 {
                    format!("{}...", &value[..200])
                } else {
                    value
                };
                (key, display)
            })
            .collect(),
        None => vec![],
    }
}
