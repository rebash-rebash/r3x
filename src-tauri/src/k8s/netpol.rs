use super::context::get_client;
use k8s_openapi::api::networking::v1::NetworkPolicy;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NetpolRule {
    pub direction: String, // "ingress" or "egress"
    pub peer_kind: String, // "pod", "namespace", "cidr", "all"
    pub peer_label: String, // display label
    pub ports: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NetpolInfo {
    pub name: String,
    pub namespace: String,
    pub pod_selector: String,
    pub matched_pods: Vec<String>,
    pub policy_types: Vec<String>,
    pub rules: Vec<NetpolRule>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NetpolEdge {
    pub from_id: String,
    pub to_id: String,
    pub policy_name: String,
    pub ports: Vec<String>,
    pub direction: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NetpolNode {
    pub id: String,
    pub label: String,
    pub kind: String, // "pod", "namespace", "external"
    pub namespace: String,
    pub has_netpol: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NetpolGraph {
    pub policies: Vec<NetpolInfo>,
    pub nodes: Vec<NetpolNode>,
    pub edges: Vec<NetpolEdge>,
    pub unprotected_pods: Vec<String>,
    pub total_policies: usize,
}

fn labels_to_selector(labels: &HashMap<String, String>) -> String {
    labels.iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(", ")
}

fn labels_match(pod_labels: &HashMap<String, String>, selector: &HashMap<String, String>) -> bool {
    selector.iter().all(|(k, v)| pod_labels.get(k) == Some(v))
}

#[tauri::command]
pub async fn get_network_policies(
    context: String,
    namespace: String,
) -> Result<NetpolGraph, String> {
    let client = get_client(&context).await?;

    let np_api: Api<NetworkPolicy> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), &namespace)
    };

    let netpols = np_api.list(&ListParams::default()).await
        .map_err(|e| format!("Failed to list NetworkPolicies: {}", e))?;

    // Get all pods for matching
    let pod_api: Api<Pod> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), &namespace)
    };
    let pods = pod_api.list(&ListParams::default()).await
        .map_err(|e| format!("Failed to list pods: {}", e))?;

    let pod_labels_map: HashMap<String, HashMap<String, String>> = pods.items.iter()
        .filter_map(|p| {
            let name = p.metadata.name.as_deref()?;
            let ns = p.metadata.namespace.as_deref().unwrap_or("default");
            let labels: HashMap<String, String> = p.metadata.labels.as_ref()
                .map(|l| l.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();
            Some((format!("{}/{}", ns, name), labels))
        })
        .collect();

    let mut policies = Vec::new();
    let mut nodes_map: HashMap<String, NetpolNode> = HashMap::new();
    let mut edges = Vec::new();
    let mut protected_pods: HashSet<String> = HashSet::new();

    // Add all pods as nodes
    for pod in &pods.items {
        let name = pod.metadata.name.as_deref().unwrap_or("");
        let ns = pod.metadata.namespace.as_deref().unwrap_or("default");
        let id = format!("{}/{}", ns, name);
        nodes_map.insert(id.clone(), NetpolNode {
            id: id.clone(),
            label: name.to_string(),
            kind: "pod".to_string(),
            namespace: ns.to_string(),
            has_netpol: false,
        });
    }

    for np in &netpols.items {
        let np_name = np.metadata.name.as_deref().unwrap_or("").to_string();
        let np_ns = np.metadata.namespace.as_deref().unwrap_or("default").to_string();

        let spec = match &np.spec {
            Some(s) => s,
            None => continue,
        };

        // Pod selector
        let selector_labels: HashMap<String, String> = spec.pod_selector.match_labels
            .as_ref()
            .map(|l| l.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        let pod_selector_str = if selector_labels.is_empty() {
            "(all pods)".to_string()
        } else {
            labels_to_selector(&selector_labels)
        };

        // Find matched pods
        let matched_pods: Vec<String> = pod_labels_map.iter()
            .filter(|(key, labels)| {
                let pod_ns = key.split('/').next().unwrap_or("");
                pod_ns == np_ns && (selector_labels.is_empty() || labels_match(labels, &selector_labels))
            })
            .map(|(key, _)| key.clone())
            .collect();

        for p in &matched_pods {
            protected_pods.insert(p.clone());
            if let Some(node) = nodes_map.get_mut(p) {
                node.has_netpol = true;
            }
        }

        let policy_types: Vec<String> = spec.policy_types.clone().unwrap_or_default();
        let mut rules = Vec::new();

        // Ingress rules
        if let Some(ingress_rules) = &spec.ingress {
            for rule in ingress_rules {
                let ports: Vec<String> = rule.ports.as_ref()
                    .map(|ps| ps.iter().map(|p| {
                        let proto = p.protocol.as_deref().unwrap_or("TCP");
                        match &p.port {
                            Some(port) => {
                            let port_str = serde_json::to_value(port).ok()
                                .and_then(|v| v.as_i64().map(|i| i.to_string()).or_else(|| v.as_str().map(|s| s.to_string())))
                                .unwrap_or_else(|| format!("{:?}", port));
                            format!("{}/{}", port_str, proto)
                        }
                            None => proto.to_string(),
                        }
                    }).collect())
                    .unwrap_or_default();

                if let Some(from) = &rule.from {
                    for peer in from {
                        let (peer_kind, peer_label, peer_id) = parse_peer(peer, &np_ns);
                        rules.push(NetpolRule {
                            direction: "ingress".to_string(),
                            peer_kind: peer_kind.clone(),
                            peer_label: peer_label.clone(),
                            ports: ports.clone(),
                        });

                        // Add edge from peer to matched pods
                        if !nodes_map.contains_key(&peer_id) {
                            nodes_map.insert(peer_id.clone(), NetpolNode {
                                id: peer_id.clone(),
                                label: peer_label.clone(),
                                kind: peer_kind.clone(),
                                namespace: np_ns.clone(),
                                has_netpol: false,
                            });
                        }
                        for mp in &matched_pods {
                            edges.push(NetpolEdge {
                                from_id: peer_id.clone(),
                                to_id: mp.clone(),
                                policy_name: np_name.clone(),
                                ports: ports.clone(),
                                direction: "ingress".to_string(),
                            });
                        }
                    }
                } else {
                    rules.push(NetpolRule {
                        direction: "ingress".to_string(),
                        peer_kind: "all".to_string(),
                        peer_label: "all sources".to_string(),
                        ports: ports.clone(),
                    });
                }
            }
        }

        // Egress rules
        if let Some(egress_rules) = &spec.egress {
            for rule in egress_rules {
                let ports: Vec<String> = rule.ports.as_ref()
                    .map(|ps| ps.iter().map(|p| {
                        let proto = p.protocol.as_deref().unwrap_or("TCP");
                        match &p.port {
                            Some(port) => {
                            let port_str = serde_json::to_value(port).ok()
                                .and_then(|v| v.as_i64().map(|i| i.to_string()).or_else(|| v.as_str().map(|s| s.to_string())))
                                .unwrap_or_else(|| format!("{:?}", port));
                            format!("{}/{}", port_str, proto)
                        }
                            None => proto.to_string(),
                        }
                    }).collect())
                    .unwrap_or_default();

                if let Some(to) = &rule.to {
                    for peer in to {
                        let (peer_kind, peer_label, peer_id) = parse_peer(peer, &np_ns);
                        rules.push(NetpolRule {
                            direction: "egress".to_string(),
                            peer_kind: peer_kind.clone(),
                            peer_label: peer_label.clone(),
                            ports: ports.clone(),
                        });

                        if !nodes_map.contains_key(&peer_id) {
                            nodes_map.insert(peer_id.clone(), NetpolNode {
                                id: peer_id.clone(),
                                label: peer_label.clone(),
                                kind: peer_kind.clone(),
                                namespace: np_ns.clone(),
                                has_netpol: false,
                            });
                        }
                        for mp in &matched_pods {
                            edges.push(NetpolEdge {
                                from_id: mp.clone(),
                                to_id: peer_id.clone(),
                                policy_name: np_name.clone(),
                                ports: ports.clone(),
                                direction: "egress".to_string(),
                            });
                        }
                    }
                } else {
                    rules.push(NetpolRule {
                        direction: "egress".to_string(),
                        peer_kind: "all".to_string(),
                        peer_label: "all destinations".to_string(),
                        ports: ports.clone(),
                    });
                }
            }
        }

        policies.push(NetpolInfo {
            name: np_name,
            namespace: np_ns,
            pod_selector: pod_selector_str,
            matched_pods: matched_pods.iter().map(|p| p.split('/').last().unwrap_or("").to_string()).collect(),
            policy_types,
            rules,
        });
    }

    let total_policies = policies.len();

    // Find unprotected pods
    let unprotected_pods: Vec<String> = pod_labels_map.keys()
        .filter(|k| !protected_pods.contains(*k))
        .cloned()
        .collect();

    Ok(NetpolGraph {
        policies,
        nodes: nodes_map.into_values().collect(),
        edges,
        unprotected_pods,
        total_policies,
    })
}

fn parse_peer(
    peer: &k8s_openapi::api::networking::v1::NetworkPolicyPeer,
    default_ns: &str,
) -> (String, String, String) {
    if let Some(pod_sel) = &peer.pod_selector {
        let labels: HashMap<String, String> = pod_sel.match_labels.as_ref()
            .map(|l| l.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        let label = if labels.is_empty() {
            "all pods".to_string()
        } else {
            labels_to_selector(&labels)
        };
        let ns = peer.namespace_selector.as_ref()
            .and_then(|ns_sel| ns_sel.match_labels.as_ref())
            .and_then(|l| l.get("kubernetes.io/metadata.name").or_else(|| l.values().next()))
            .map(|s| s.as_str())
            .unwrap_or(default_ns);
        let id = format!("selector:{}/{}", ns, label);
        ("pod".to_string(), label, id)
    } else if let Some(ns_sel) = &peer.namespace_selector {
        let labels: HashMap<String, String> = ns_sel.match_labels.as_ref()
            .map(|l| l.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        let label = if labels.is_empty() {
            "all namespaces".to_string()
        } else {
            labels_to_selector(&labels)
        };
        let id = format!("ns:{}", label);
        ("namespace".to_string(), label, id)
    } else if let Some(ip_block) = &peer.ip_block {
        let cidr = &ip_block.cidr;
        let id = format!("cidr:{}", cidr);
        ("external".to_string(), cidr.clone(), id)
    } else {
        ("all".to_string(), "all".to_string(), "all".to_string())
    }
}
