use super::context::get_client;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use kube::api::{Api, ListParams, PostParams};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JobRun {
    pub name: String,
    pub namespace: String,
    pub status: String, // "Running", "Succeeded", "Failed"
    pub start_time: Option<String>,
    pub completion_time: Option<String>,
    pub duration_secs: Option<i64>,
    pub completions: String, // "1/1", "0/3"
    pub parallelism: i32,
    pub active: i32,
    pub succeeded: i32,
    pub failed: i32,
    pub age: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CronJobDetail {
    pub name: String,
    pub namespace: String,
    pub schedule: String,
    pub suspend: bool,
    pub active_count: i32,
    pub last_schedule_time: Option<String>,
    pub last_successful_time: Option<String>,
    pub concurrency_policy: String,
    pub jobs: Vec<JobRun>,
    pub age: String,
}

fn format_age(seconds: i64) -> String {
    if seconds < 0 { return "?".to_string(); }
    let days = seconds / 86400;
    let hours = (seconds % 86400) / 3600;
    let mins = (seconds % 3600) / 60;
    if days > 0 { format!("{}d{}h", days, hours) }
    else if hours > 0 { format!("{}h{}m", hours, mins) }
    else { format!("{}m", mins) }
}

#[tauri::command]
pub async fn get_cronjob_detail(
    context: String,
    namespace: String,
    name: String,
) -> Result<CronJobDetail, String> {
    let client = get_client(&context).await?;
    let now = chrono::Utc::now();

    let cj_api: Api<CronJob> = Api::namespaced(client.clone(), &namespace);
    let cj = cj_api.get(&name).await.map_err(|e| format!("{}", e))?;

    let schedule = cj.spec.as_ref()
        .map(|s| s.schedule.clone())
        .unwrap_or_default();
    let suspend = cj.spec.as_ref()
        .and_then(|s| s.suspend)
        .unwrap_or(false);
    let concurrency_policy = cj.spec.as_ref()
        .and_then(|s| s.concurrency_policy.clone())
        .unwrap_or_else(|| "Allow".to_string());
    let active_count = cj.status.as_ref()
        .and_then(|s| s.active.as_ref())
        .map(|a| a.len() as i32)
        .unwrap_or(0);
    let last_schedule_time = cj.status.as_ref()
        .and_then(|s| s.last_schedule_time.as_ref())
        .map(|t| t.0.to_rfc3339());
    let last_successful_time = cj.status.as_ref()
        .and_then(|s| s.last_successful_time.as_ref())
        .map(|t| t.0.to_rfc3339());

    let age = cj.metadata.creation_timestamp.as_ref()
        .map(|ts| format_age((now - ts.0).num_seconds()))
        .unwrap_or_else(|| "?".to_string());

    // Find jobs owned by this CronJob
    let job_api: Api<Job> = Api::namespaced(client.clone(), &namespace);
    let jobs = job_api.list(&ListParams::default()).await.map_err(|e| format!("{}", e))?;

    let mut job_runs: Vec<JobRun> = Vec::new();

    for job in &jobs.items {
        // Check if owned by this CronJob
        let is_owned = job.metadata.owner_references.as_ref()
            .map(|refs| refs.iter().any(|r| r.kind == "CronJob" && r.name == name))
            .unwrap_or(false);

        if !is_owned { continue; }

        let job_name = job.metadata.name.clone().unwrap_or_default();
        let job_ns = job.metadata.namespace.clone().unwrap_or_default();

        let start_time = job.status.as_ref()
            .and_then(|s| s.start_time.as_ref())
            .map(|t| t.0.to_rfc3339());
        let completion_time = job.status.as_ref()
            .and_then(|s| s.completion_time.as_ref())
            .map(|t| t.0.to_rfc3339());

        let duration_secs = match (&start_time, &completion_time) {
            (Some(s), Some(c)) => {
                let start = chrono::DateTime::parse_from_rfc3339(s).ok();
                let end = chrono::DateTime::parse_from_rfc3339(c).ok();
                match (start, end) {
                    (Some(s), Some(e)) => Some((e - s).num_seconds()),
                    _ => None,
                }
            }
            _ => None,
        };

        let active = job.status.as_ref().and_then(|s| s.active).unwrap_or(0);
        let succeeded = job.status.as_ref().and_then(|s| s.succeeded).unwrap_or(0);
        let failed = job.status.as_ref().and_then(|s| s.failed).unwrap_or(0);

        let desired = job.spec.as_ref().and_then(|s| s.completions).unwrap_or(1);
        let parallelism = job.spec.as_ref().and_then(|s| s.parallelism).unwrap_or(1);

        let status = if active > 0 { "Running" }
            else if succeeded >= desired { "Succeeded" }
            else if failed > 0 { "Failed" }
            else { "Unknown" };

        let job_age = job.metadata.creation_timestamp.as_ref()
            .map(|ts| format_age((now - ts.0).num_seconds()))
            .unwrap_or_else(|| "?".to_string());

        job_runs.push(JobRun {
            name: job_name,
            namespace: job_ns,
            status: status.to_string(),
            start_time,
            completion_time,
            duration_secs,
            completions: format!("{}/{}", succeeded, desired),
            parallelism,
            active,
            succeeded,
            failed,
            age: job_age,
        });
    }

    // Sort by start_time descending
    job_runs.sort_by(|a, b| {
        let a_time = a.start_time.as_deref().unwrap_or("");
        let b_time = b.start_time.as_deref().unwrap_or("");
        b_time.cmp(a_time)
    });

    Ok(CronJobDetail {
        name,
        namespace,
        schedule,
        suspend,
        active_count,
        last_schedule_time,
        last_successful_time,
        concurrency_policy,
        jobs: job_runs,
        age,
    })
}

#[tauri::command]
pub async fn trigger_cronjob(
    context: String,
    namespace: String,
    name: String,
) -> Result<String, String> {
    let client = get_client(&context).await?;

    // Get the CronJob to extract its job template
    let cj_api: Api<CronJob> = Api::namespaced(client.clone(), &namespace);
    let cj = cj_api.get(&name).await.map_err(|e| format!("{}", e))?;

    let job_template = cj.spec.as_ref()
        .map(|s| s.job_template.clone())
        .ok_or_else(|| "No job template found".to_string())?;

    // Create a Job from the template
    let job_name = format!("{}-manual-{}", name, chrono::Utc::now().format("%s"));

    let mut labels = job_template.metadata
        .as_ref()
        .and_then(|m| m.labels.clone())
        .unwrap_or_default();
    labels.insert("r3x-triggered".to_string(), "manual".to_string());

    let mut annotations = BTreeMap::new();
    annotations.insert("cronjob.kubernetes.io/instantiate".to_string(), "manual".to_string());

    let job = Job {
        metadata: kube::api::ObjectMeta {
            name: Some(job_name.clone()),
            namespace: Some(namespace.clone()),
            labels: Some(labels),
            annotations: Some(annotations),
            owner_references: Some(vec![k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference {
                api_version: "batch/v1".to_string(),
                kind: "CronJob".to_string(),
                name: name.clone(),
                uid: cj.metadata.uid.clone().unwrap_or_default(),
                controller: Some(false),
                block_owner_deletion: Some(false),
            }]),
            ..Default::default()
        },
        spec: job_template.spec,
        ..Default::default()
    };

    let job_api: Api<Job> = Api::namespaced(client, &namespace);
    job_api.create(&PostParams::default(), &job)
        .await
        .map_err(|e| format!("Failed to create job: {}", e))?;

    Ok(job_name)
}
