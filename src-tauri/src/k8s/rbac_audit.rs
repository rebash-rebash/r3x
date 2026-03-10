use super::context::get_client;
use k8s_openapi::api::rbac::v1::{
    ClusterRole, ClusterRoleBinding, Role, RoleBinding,
};
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// --- Data structures ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RbacAuditFinding {
    pub severity: String,    // "critical", "high", "medium", "low"
    pub category: String,    // "wildcard", "cluster-admin", "escalation", "cross-namespace", "tenant-isolation", "service-account"
    pub title: String,
    pub description: String,
    pub binding_name: String,
    pub binding_kind: String, // "ClusterRoleBinding" or "RoleBinding"
    pub role_name: String,
    pub subjects: Vec<String>, // human-readable subject list
    pub namespace: Option<String>,
    pub remediation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RbacAuditSummary {
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
    pub total_roles_scanned: u32,
    pub total_bindings_scanned: u32,
    pub score: u32, // 0-100, higher is better
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RbacAuditResult {
    pub findings: Vec<RbacAuditFinding>,
    pub summary: RbacAuditSummary,
}

// --- Internal helpers ---

/// Dangerous verbs that enable privilege escalation
const ESCALATION_VERBS: &[&str] = &["escalate", "bind", "impersonate"];

/// Sensitive resource types
const SENSITIVE_RESOURCES: &[&str] = &[
    "secrets", "pods/exec", "pods/attach", "serviceaccounts/token",
    "tokenreviews", "certificatesigningrequests",
];

/// Format a subject for display
fn format_subject(kind: &str, name: &str, ns: &Option<String>) -> String {
    match ns {
        Some(n) => format!("{}:{}/{}", kind, n, name),
        None => format!("{}:{}", kind, name),
    }
}

/// Check if a rule has wildcard access
fn has_wildcard(items: &[String]) -> bool {
    items.iter().any(|i| i == "*")
}

/// Collect all rules from a Role/ClusterRole
#[derive(Debug, Clone)]
struct ResolvedRole {
    name: String,
    #[allow(dead_code)]
    is_cluster_role: bool,
    #[allow(dead_code)]
    namespace: Option<String>,
    rules: Vec<RuleInfo>,
}

#[derive(Debug, Clone)]
struct RuleInfo {
    api_groups: Vec<String>,
    resources: Vec<String>,
    verbs: Vec<String>,
    resource_names: Vec<String>,
}

#[tauri::command]
pub async fn audit_rbac(
    context: String,
    namespace: String,
) -> Result<RbacAuditResult, String> {
    let client = get_client(&context).await?;
    let mut findings: Vec<RbacAuditFinding> = Vec::new();

    // Fetch all RBAC resources in parallel
    let cr_api: Api<ClusterRole> = Api::all(client.clone());
    let crb_api: Api<ClusterRoleBinding> = Api::all(client.clone());
    let r_api: Api<Role> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), &namespace)
    };
    let rb_api: Api<RoleBinding> = if namespace == "_all" {
        Api::all(client.clone())
    } else {
        Api::namespaced(client.clone(), &namespace)
    };

    let lp = ListParams::default();
    let (cluster_roles_res, cluster_bindings_res, roles_res, role_bindings_res) = tokio::join!(
        cr_api.list(&lp),
        crb_api.list(&lp),
        r_api.list(&lp),
        rb_api.list(&lp),
    );

    let cluster_roles = cluster_roles_res
        .map_err(|e| format!("Failed to list ClusterRoles: {}", e))?;
    let cluster_bindings = cluster_bindings_res
        .map_err(|e| format!("Failed to list ClusterRoleBindings: {}", e))?;
    let roles = roles_res
        .map_err(|e| format!("Failed to list Roles: {}", e))?;
    let role_bindings = role_bindings_res
        .map_err(|e| format!("Failed to list RoleBindings: {}", e))?;

    // Build role lookup maps
    let mut cr_map: HashMap<String, ResolvedRole> = HashMap::new();
    for cr in &cluster_roles.items {
        let name = cr.metadata.name.clone().unwrap_or_default();
        let rules = cr.rules.as_ref().map(|rs| {
            rs.iter().map(|r| RuleInfo {
                api_groups: r.api_groups.clone().unwrap_or_default(),
                resources: r.resources.clone().unwrap_or_default(),
                verbs: r.verbs.clone(),
                resource_names: r.resource_names.clone().unwrap_or_default(),
            }).collect()
        }).unwrap_or_default();
        cr_map.insert(name.clone(), ResolvedRole {
            name,
            is_cluster_role: true,
            namespace: None,
            rules,
        });
    }

    let mut r_map: HashMap<(String, String), ResolvedRole> = HashMap::new();
    for r in &roles.items {
        let name = r.metadata.name.clone().unwrap_or_default();
        let ns = r.metadata.namespace.clone().unwrap_or_default();
        let rules = r.rules.as_ref().map(|rs| {
            rs.iter().map(|rule| RuleInfo {
                api_groups: rule.api_groups.clone().unwrap_or_default(),
                resources: rule.resources.clone().unwrap_or_default(),
                verbs: rule.verbs.clone(),
                resource_names: rule.resource_names.clone().unwrap_or_default(),
            }).collect()
        }).unwrap_or_default();
        r_map.insert((ns.clone(), name.clone()), ResolvedRole {
            name,
            is_cluster_role: false,
            namespace: Some(ns),
            rules,
        });
    }

    let total_roles = (cluster_roles.items.len() + roles.items.len()) as u32;
    let total_bindings = (cluster_bindings.items.len() + role_bindings.items.len()) as u32;

    // Track namespace->subjects for cross-namespace analysis
    let mut ns_subject_map: HashMap<String, HashSet<String>> = HashMap::new();

    // --- Analyze ClusterRoleBindings ---
    for crb in &cluster_bindings.items {
        let binding_name = crb.metadata.name.clone().unwrap_or_default();
        let role_name = crb.role_ref.name.clone();
        let subjects: Vec<String> = crb.subjects.as_ref()
            .map(|ss| ss.iter().map(|s| format_subject(&s.kind, &s.name, &s.namespace)).collect())
            .unwrap_or_default();

        if subjects.is_empty() {
            continue;
        }

        // Look up the role
        let resolved = cr_map.get(&role_name);

        // Check 1: cluster-admin exposure
        if role_name == "cluster-admin" {
            // Check for non-system subjects bound to cluster-admin
            let non_system: Vec<&String> = subjects.iter()
                .filter(|s| !s.contains("system:") || s.contains("system:serviceaccount:"))
                .collect();
            if !non_system.is_empty() {
                findings.push(RbacAuditFinding {
                    severity: "critical".into(),
                    category: "cluster-admin".into(),
                    title: "cluster-admin bound to non-system subjects".into(),
                    description: format!(
                        "ClusterRoleBinding '{}' grants cluster-admin to: {}",
                        binding_name,
                        non_system.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
                    ),
                    binding_name: binding_name.clone(),
                    binding_kind: "ClusterRoleBinding".into(),
                    role_name: role_name.clone(),
                    subjects: subjects.clone(),
                    namespace: None,
                    remediation: "Replace cluster-admin with a scoped ClusterRole that grants only necessary permissions. Use namespace-scoped RoleBindings where possible.".into(),
                });
            }
        }

        if let Some(role) = resolved {
            analyze_role_rules(
                role,
                &binding_name,
                "ClusterRoleBinding",
                &subjects,
                &None,
                &mut findings,
            );
        }

        // Track subjects for cross-namespace analysis (CRBs grant across all namespaces)
        for subj in &subjects {
            ns_subject_map.entry("*".into()).or_default().insert(subj.clone());
        }
    }

    // --- Analyze RoleBindings ---
    for rb in &role_bindings.items {
        let binding_name = rb.metadata.name.clone().unwrap_or_default();
        let binding_ns = rb.metadata.namespace.clone();
        let role_name = rb.role_ref.name.clone();
        let role_kind = rb.role_ref.kind.clone();
        let subjects: Vec<String> = rb.subjects.as_ref()
            .map(|ss| ss.iter().map(|s| format_subject(&s.kind, &s.name, &s.namespace)).collect())
            .unwrap_or_default();

        if subjects.is_empty() {
            continue;
        }

        // Resolve role (could reference a ClusterRole via RoleBinding)
        let resolved = if role_kind == "ClusterRole" {
            cr_map.get(&role_name)
        } else {
            let ns = binding_ns.clone().unwrap_or_default();
            r_map.get(&(ns, role_name.clone())).or_else(|| None)
        };

        if let Some(role) = resolved {
            analyze_role_rules(
                role,
                &binding_name,
                "RoleBinding",
                &subjects,
                &binding_ns,
                &mut findings,
            );
        }

        // Check: RoleBinding referencing ClusterRole (potential scope misunderstanding)
        if role_kind == "ClusterRole" && role_name != "admin" && role_name != "edit" && role_name != "view" {
            if let Some(role) = cr_map.get(&role_name) {
                let has_broad = role.rules.iter().any(|r| has_wildcard(&r.verbs) || has_wildcard(&r.resources));
                if has_broad {
                    findings.push(RbacAuditFinding {
                        severity: "medium".into(),
                        category: "cross-namespace".into(),
                        title: "RoleBinding references broad ClusterRole".into(),
                        description: format!(
                            "RoleBinding '{}' in namespace '{}' references ClusterRole '{}' which has wildcard permissions. While scoped to the namespace, this may grant broader access than intended.",
                            binding_name,
                            binding_ns.as_deref().unwrap_or("unknown"),
                            role_name
                        ),
                        binding_name: binding_name.clone(),
                        binding_kind: "RoleBinding".into(),
                        role_name: role_name.clone(),
                        subjects: subjects.clone(),
                        namespace: binding_ns.clone(),
                        remediation: "Create a namespace-scoped Role with only the permissions needed instead of referencing a broad ClusterRole.".into(),
                    });
                }
            }
        }

        // Track namespace subjects
        if let Some(ns) = &binding_ns {
            for subj in &subjects {
                ns_subject_map.entry(ns.clone()).or_default().insert(subj.clone());
            }
        }
    }

    // --- Cross-namespace / multi-tenant analysis ---
    // Find subjects that appear in multiple namespaces (potential tenant isolation breach)
    let mut subject_namespaces: HashMap<String, HashSet<String>> = HashMap::new();
    for (ns, subjects) in &ns_subject_map {
        for subj in subjects {
            subject_namespaces.entry(subj.clone()).or_default().insert(ns.clone());
        }
    }

    for (subject, namespaces) in &subject_namespaces {
        // Skip system accounts
        if subject.starts_with("Group:system:") && !subject.contains("serviceaccount") {
            continue;
        }
        if subject.starts_with("User:system:") {
            continue;
        }

        let has_cluster_wide = namespaces.contains("*");
        let ns_count = namespaces.iter().filter(|n| n.as_str() != "*").count();

        if has_cluster_wide && ns_count > 0 {
            findings.push(RbacAuditFinding {
                severity: "high".into(),
                category: "tenant-isolation".into(),
                title: "Subject has both cluster-wide and namespace-scoped access".into(),
                description: format!(
                    "'{}' has cluster-wide access (via ClusterRoleBinding) AND namespace-scoped bindings in: {}. This may break tenant isolation.",
                    subject,
                    namespaces.iter().filter(|n| n.as_str() != "*").cloned().collect::<Vec<_>>().join(", ")
                ),
                binding_name: "multiple".into(),
                binding_kind: "mixed".into(),
                role_name: "multiple".into(),
                subjects: vec![subject.clone()],
                namespace: None,
                remediation: "Review whether this subject truly needs cluster-wide access. Prefer namespace-scoped RoleBindings for tenant isolation.".into(),
            });
        } else if ns_count > 2 {
            findings.push(RbacAuditFinding {
                severity: "medium".into(),
                category: "tenant-isolation".into(),
                title: "Subject spans multiple namespaces".into(),
                description: format!(
                    "'{}' has access to {} namespaces: {}. In multi-tenant clusters, cross-namespace access may break isolation boundaries.",
                    subject,
                    ns_count,
                    namespaces.iter().cloned().collect::<Vec<_>>().join(", ")
                ),
                binding_name: "multiple".into(),
                binding_kind: "RoleBinding".into(),
                role_name: "multiple".into(),
                subjects: vec![subject.clone()],
                namespace: None,
                remediation: "Verify that cross-namespace access is intentional. Use separate service accounts per tenant namespace.".into(),
            });
        }
    }

    // --- Check for service accounts with powerful roles ---
    for crb in &cluster_bindings.items {
        let binding_name = crb.metadata.name.clone().unwrap_or_default();
        let role_name = crb.role_ref.name.clone();

        if let Some(subjects) = &crb.subjects {
            for s in subjects {
                if s.kind == "ServiceAccount" && s.name == "default" {
                    findings.push(RbacAuditFinding {
                        severity: "high".into(),
                        category: "service-account".into(),
                        title: "Default ServiceAccount bound to ClusterRole".into(),
                        description: format!(
                            "The default ServiceAccount in namespace '{}' is bound to ClusterRole '{}' via '{}'. Any pod in that namespace inherits these permissions.",
                            s.namespace.as_deref().unwrap_or("unknown"),
                            role_name,
                            binding_name
                        ),
                        binding_name: binding_name.clone(),
                        binding_kind: "ClusterRoleBinding".into(),
                        role_name: role_name.clone(),
                        subjects: vec![format_subject(&s.kind, &s.name, &s.namespace)],
                        namespace: s.namespace.clone(),
                        remediation: "Create dedicated service accounts for workloads. Never bind roles to the default ServiceAccount.".into(),
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

    let weighted = critical * 10 + high * 5 + medium * 2 + low;
    let max_possible = total_bindings.max(1) * 10;
    let score = if weighted >= max_possible {
        0
    } else {
        ((max_possible - weighted) * 100 / max_possible).min(100)
    };

    Ok(RbacAuditResult {
        findings,
        summary: RbacAuditSummary {
            critical,
            high,
            medium,
            low,
            total_roles_scanned: total_roles,
            total_bindings_scanned: total_bindings,
            score,
        },
    })
}

/// Analyze individual role rules for dangerous patterns
fn analyze_role_rules(
    role: &ResolvedRole,
    binding_name: &str,
    binding_kind: &str,
    subjects: &[String],
    binding_ns: &Option<String>,
    findings: &mut Vec<RbacAuditFinding>,
) {
    let role_name = &role.name;

    for rule in &role.rules {
        let has_wildcard_verbs = has_wildcard(&rule.verbs);
        let has_wildcard_resources = has_wildcard(&rule.resources);
        let has_wildcard_apigroups = has_wildcard(&rule.api_groups);
        let is_scoped_to_names = !rule.resource_names.is_empty();

        // Check: Full wildcard (*.*.*)
        if has_wildcard_verbs && has_wildcard_resources && has_wildcard_apigroups && !is_scoped_to_names {
            findings.push(RbacAuditFinding {
                severity: "critical".into(),
                category: "wildcard".into(),
                title: "Full wildcard permissions (*.*.*)".into(),
                description: format!(
                    "Role '{}' grants all verbs on all resources in all API groups. Binding '{}' ({}) exposes this to: {}",
                    role_name, binding_name, binding_kind,
                    subjects.join(", ")
                ),
                binding_name: binding_name.into(),
                binding_kind: binding_kind.into(),
                role_name: role_name.clone(),
                subjects: subjects.to_vec(),
                namespace: binding_ns.clone(),
                remediation: "Replace wildcard permissions with explicit verbs and resources. Follow the principle of least privilege.".into(),
            });
            continue; // Don't also flag sub-patterns
        }

        // Check: Wildcard verbs on specific resources
        if has_wildcard_verbs && !has_wildcard_resources && !is_scoped_to_names {
            findings.push(RbacAuditFinding {
                severity: "high".into(),
                category: "wildcard".into(),
                title: format!("Wildcard verbs on resources: {}", rule.resources.join(", ")),
                description: format!(
                    "Role '{}' grants all verbs (*) on [{}]. Binding: '{}'",
                    role_name, rule.resources.join(", "), binding_name
                ),
                binding_name: binding_name.into(),
                binding_kind: binding_kind.into(),
                role_name: role_name.clone(),
                subjects: subjects.to_vec(),
                namespace: binding_ns.clone(),
                remediation: "Specify only the verbs needed (get, list, watch, create, update, patch, delete) instead of using '*'.".into(),
            });
        }

        // Check: All resources with specific verbs
        if has_wildcard_resources && !has_wildcard_verbs && !is_scoped_to_names {
            let write_verbs: Vec<&String> = rule.verbs.iter()
                .filter(|v| ["create", "update", "patch", "delete", "deletecollection"].contains(&v.as_str()))
                .collect();
            if !write_verbs.is_empty() {
                findings.push(RbacAuditFinding {
                    severity: "high".into(),
                    category: "wildcard".into(),
                    title: format!("Write access to all resources: {}", write_verbs.iter().map(|v| v.as_str()).collect::<Vec<_>>().join(", ")),
                    description: format!(
                        "Role '{}' grants [{}] on all resources (*). Binding: '{}'",
                        role_name,
                        write_verbs.iter().map(|v| v.as_str()).collect::<Vec<_>>().join(", "),
                        binding_name
                    ),
                    binding_name: binding_name.into(),
                    binding_kind: binding_kind.into(),
                    role_name: role_name.clone(),
                    subjects: subjects.to_vec(),
                    namespace: binding_ns.clone(),
                    remediation: "Limit resource scope to only the specific resources that need write access.".into(),
                });
            }
        }

        // Check: Privilege escalation verbs
        let escalation_verbs: Vec<&String> = rule.verbs.iter()
            .filter(|v| ESCALATION_VERBS.contains(&v.as_str()) || (has_wildcard_verbs))
            .collect();
        let targets_rbac = rule.resources.iter().any(|r|
            ["roles", "clusterroles", "rolebindings", "clusterrolebindings"].contains(&r.as_str())
        ) || has_wildcard_resources;

        if !escalation_verbs.is_empty() && targets_rbac && !has_wildcard_verbs {
            findings.push(RbacAuditFinding {
                severity: "critical".into(),
                category: "escalation".into(),
                title: "Privilege escalation verbs on RBAC resources".into(),
                description: format!(
                    "Role '{}' grants [{}] on RBAC resources [{}]. This allows creating or modifying roles/bindings to escalate privileges. Binding: '{}'",
                    role_name,
                    escalation_verbs.iter().map(|v| v.as_str()).collect::<Vec<_>>().join(", "),
                    rule.resources.join(", "),
                    binding_name
                ),
                binding_name: binding_name.into(),
                binding_kind: binding_kind.into(),
                role_name: role_name.clone(),
                subjects: subjects.to_vec(),
                namespace: binding_ns.clone(),
                remediation: "Remove 'escalate', 'bind', and 'impersonate' verbs. Use aggregated ClusterRoles or admission webhooks to control role changes.".into(),
            });
        }

        // Check: Access to sensitive resources
        for resource in &rule.resources {
            if SENSITIVE_RESOURCES.contains(&resource.as_str()) {
                let write_or_all = has_wildcard_verbs || rule.verbs.iter().any(|v|
                    ["get", "list", "watch", "create", "update", "patch", "delete"].contains(&v.as_str())
                );
                if write_or_all && !is_scoped_to_names {
                    let severity = if ["secrets", "pods/exec", "serviceaccounts/token"].contains(&resource.as_str()) {
                        "high"
                    } else {
                        "medium"
                    };
                    findings.push(RbacAuditFinding {
                        severity: severity.into(),
                        category: "escalation".into(),
                        title: format!("Access to sensitive resource: {}", resource),
                        description: format!(
                            "Role '{}' grants [{}] on '{}'. Binding: '{}'",
                            role_name,
                            rule.verbs.join(", "),
                            resource,
                            binding_name
                        ),
                        binding_name: binding_name.into(),
                        binding_kind: binding_kind.into(),
                        role_name: role_name.clone(),
                        subjects: subjects.to_vec(),
                        namespace: binding_ns.clone(),
                        remediation: format!(
                            "Restrict access to '{}' using resourceNames to limit scope, or remove if not needed.",
                            resource
                        ),
                    });
                }
            }
        }
    }
}
