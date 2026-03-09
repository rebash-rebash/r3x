use super::context::get_client;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Namespace, Pod, Service};
use k8s_openapi::api::networking::v1::Ingress;
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkloadCount {
    pub kind: String,
    pub total: usize,
    pub ready: usize,
    pub not_ready: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PodStatusBreakdown {
    pub running: usize,
    pub pending: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub unknown: usize,
    pub total: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecentEvent {
    pub event_type: String,
    pub reason: String,
    pub message: String,
    pub object: String,
    pub last_seen: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClusterSummary {
    pub namespace_count: usize,
    pub workloads: Vec<WorkloadCount>,
    pub pod_status: PodStatusBreakdown,
    pub recent_warnings: Vec<RecentEvent>,
}

#[tauri::command]
pub async fn get_cluster_overview(
    context: String,
    namespace: String,
) -> Result<ClusterSummary, String> {
    let client = get_client(&context).await?;

    // Count namespaces
    let ns_api: Api<Namespace> = Api::all(client.clone());
    let ns_lp = ListParams::default();
    let ns_count = ns_api.list(&ns_lp).await.map(|l| l.items.len()).unwrap_or(0);

    // Helper macro for namespaced or all
    macro_rules! api {
        ($type:ty) => {
            if namespace == "_all" {
                Api::<$type>::all(client.clone())
            } else {
                Api::<$type>::namespaced(client.clone(), &namespace)
            }
        };
    }

    let pod_api = api!(Pod);
    let dep_api = api!(Deployment);
    let sts_api = api!(StatefulSet);
    let ds_api = api!(DaemonSet);
    let rs_api = api!(ReplicaSet);
    let job_api = api!(Job);
    let cj_api = api!(CronJob);
    let svc_api = api!(Service);
    let ing_api = api!(Ingress);

    let lp1 = ListParams::default();
    let lp2 = ListParams::default();
    let lp3 = ListParams::default();
    let lp4 = ListParams::default();
    let lp5 = ListParams::default();
    let lp6 = ListParams::default();
    let lp7 = ListParams::default();
    let lp8 = ListParams::default();
    let lp9 = ListParams::default();

    // Fetch all workload types in parallel
    let (pods_r, deps_r, sts_r, ds_r, rs_r, jobs_r, cj_r, svc_r, ing_r) = tokio::join!(
        pod_api.list(&lp1),
        dep_api.list(&lp2),
        sts_api.list(&lp3),
        ds_api.list(&lp4),
        rs_api.list(&lp5),
        job_api.list(&lp6),
        cj_api.list(&lp7),
        svc_api.list(&lp8),
        ing_api.list(&lp9),
    );

    let mut workloads = Vec::new();

    // Pods
    let pods = pods_r.map(|l| l.items).unwrap_or_default();
    let mut pod_status = PodStatusBreakdown {
        running: 0, pending: 0, succeeded: 0, failed: 0, unknown: 0, total: pods.len(),
    };
    for pod in &pods {
        match pod.status.as_ref().and_then(|s| s.phase.as_deref()).unwrap_or("Unknown") {
            "Running" => pod_status.running += 1,
            "Pending" => pod_status.pending += 1,
            "Succeeded" => pod_status.succeeded += 1,
            "Failed" => pod_status.failed += 1,
            _ => pod_status.unknown += 1,
        }
    }
    workloads.push(WorkloadCount {
        kind: "Pods".to_string(),
        total: pods.len(),
        ready: pod_status.running,
        not_ready: pod_status.total - pod_status.running - pod_status.succeeded,
    });

    // Deployments
    let deps = deps_r.map(|l| l.items).unwrap_or_default();
    let dep_ready = deps.iter().filter(|d| {
        let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        let ready = d.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
        ready >= desired
    }).count();
    workloads.push(WorkloadCount {
        kind: "Deployments".to_string(),
        total: deps.len(),
        ready: dep_ready,
        not_ready: deps.len() - dep_ready,
    });

    // StatefulSets
    let sts = sts_r.map(|l| l.items).unwrap_or_default();
    let sts_ready = sts.iter().filter(|s| {
        let desired = s.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(1);
        let ready = s.status.as_ref().and_then(|st| st.ready_replicas).unwrap_or(0);
        ready >= desired
    }).count();
    workloads.push(WorkloadCount {
        kind: "StatefulSets".to_string(),
        total: sts.len(),
        ready: sts_ready,
        not_ready: sts.len() - sts_ready,
    });

    // DaemonSets
    let ds = ds_r.map(|l| l.items).unwrap_or_default();
    let ds_ready = ds.iter().filter(|d| {
        let desired = d.status.as_ref().map(|s| s.desired_number_scheduled).unwrap_or(0);
        let ready = d.status.as_ref().map(|s| s.number_ready).unwrap_or(0);
        ready >= desired
    }).count();
    workloads.push(WorkloadCount {
        kind: "DaemonSets".to_string(),
        total: ds.len(),
        ready: ds_ready,
        not_ready: ds.len() - ds_ready,
    });

    // ReplicaSets
    let rs = rs_r.map(|l| l.items).unwrap_or_default();
    // Only count non-zero-replica ReplicaSets (active ones)
    let active_rs: Vec<_> = rs.iter().filter(|r| {
        r.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0) > 0
    }).collect();
    let rs_ready = active_rs.iter().filter(|r| {
        let desired = r.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
        let ready = r.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
        ready >= desired
    }).count();
    workloads.push(WorkloadCount {
        kind: "ReplicaSets".to_string(),
        total: active_rs.len(),
        ready: rs_ready,
        not_ready: active_rs.len() - rs_ready,
    });

    // Jobs
    let jobs = jobs_r.map(|l| l.items).unwrap_or_default();
    let jobs_succeeded = jobs.iter().filter(|j| {
        j.status.as_ref().and_then(|s| s.succeeded).unwrap_or(0) > 0
    }).count();
    let jobs_active = jobs.iter().filter(|j| {
        j.status.as_ref().and_then(|s| s.active).unwrap_or(0) > 0
    }).count();
    workloads.push(WorkloadCount {
        kind: "Jobs".to_string(),
        total: jobs.len(),
        ready: jobs_succeeded,
        not_ready: jobs_active,
    });

    // CronJobs
    let cjs = cj_r.map(|l| l.items).unwrap_or_default();
    let cj_active = cjs.iter().filter(|c| {
        !c.spec.as_ref().and_then(|s| s.suspend).unwrap_or(false)
    }).count();
    workloads.push(WorkloadCount {
        kind: "CronJobs".to_string(),
        total: cjs.len(),
        ready: cj_active,
        not_ready: cjs.len() - cj_active,
    });

    // Services
    let svcs = svc_r.map(|l| l.items).unwrap_or_default();
    workloads.push(WorkloadCount {
        kind: "Services".to_string(),
        total: svcs.len(),
        ready: svcs.len(),
        not_ready: 0,
    });

    // Ingresses
    let ings = ing_r.map(|l| l.items).unwrap_or_default();
    workloads.push(WorkloadCount {
        kind: "Ingresses".to_string(),
        total: ings.len(),
        ready: ings.len(),
        not_ready: 0,
    });

    // Recent warning events
    let mut recent_warnings = Vec::new();
    let events_url = if namespace == "_all" {
        "/api/v1/events?limit=50".to_string()
    } else {
        format!("/api/v1/namespaces/{}/events?limit=50", namespace)
    };

    if let Ok(raw) = client.request::<serde_json::Value>(
        http::Request::builder().uri(&events_url).body(Vec::new()).unwrap(),
    ).await {
        if let Some(items) = raw.get("items").and_then(|v| v.as_array()) {
            for item in items.iter().rev().take(20) {
                let etype = item.get("type").and_then(|v| v.as_str()).unwrap_or("Normal");
                if etype != "Warning" { continue; }
                let reason = item.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let message = item.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let kind = item.pointer("/involvedObject/kind").and_then(|v| v.as_str()).unwrap_or("");
                let name = item.pointer("/involvedObject/name").and_then(|v| v.as_str()).unwrap_or("");
                let last_seen = item.get("lastTimestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();
                recent_warnings.push(RecentEvent {
                    event_type: etype.to_string(),
                    reason,
                    message: if message.len() > 120 { format!("{}...", &message[..120]) } else { message },
                    object: format!("{}/{}", kind, name),
                    last_seen,
                });
                if recent_warnings.len() >= 10 { break; }
            }
        }
    }

    Ok(ClusterSummary {
        namespace_count: ns_count,
        workloads,
        pod_status,
        recent_warnings,
    })
}
