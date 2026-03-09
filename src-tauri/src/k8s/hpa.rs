use super::context::get_client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HpaMetricStatus {
    pub metric_name: String,
    pub metric_type: String, // "Resource", "Pods", "Object", "External"
    pub current_value: String,
    pub target_value: String,
    pub current_average: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HpaCondition {
    pub condition_type: String,
    pub status: String,
    pub reason: String,
    pub message: String,
    pub last_transition: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HpaInfo {
    pub name: String,
    pub namespace: String,
    pub target_kind: String,
    pub target_name: String,
    pub min_replicas: i32,
    pub max_replicas: i32,
    pub current_replicas: i32,
    pub desired_replicas: i32,
    pub metrics: Vec<HpaMetricStatus>,
    pub conditions: Vec<HpaCondition>,
    pub last_scale_time: Option<String>,
    pub age: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VpaRecommendation {
    pub container_name: String,
    pub lower_cpu: String,
    pub lower_memory: String,
    pub target_cpu: String,
    pub target_memory: String,
    pub upper_cpu: String,
    pub upper_memory: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VpaInfo {
    pub name: String,
    pub namespace: String,
    pub target_kind: String,
    pub target_name: String,
    pub update_mode: String,
    pub recommendations: Vec<VpaRecommendation>,
    pub age: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AutoscalerInfo {
    pub hpas: Vec<HpaInfo>,
    pub vpas: Vec<VpaInfo>,
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
pub async fn get_autoscalers(
    context: String,
    namespace: String,
) -> Result<AutoscalerInfo, String> {
    let client = get_client(&context).await?;
    let now = chrono::Utc::now();

    // Fetch HPAs via raw API (v2)
    let hpa_url = if namespace == "_all" {
        "/apis/autoscaling/v2/horizontalpodautoscalers".to_string()
    } else {
        format!("/apis/autoscaling/v2/namespaces/{}/horizontalpodautoscalers", namespace)
    };

    let mut hpas = Vec::new();

    let hpa_result: Result<serde_json::Value, _> = client
        .request::<serde_json::Value>(
            http::Request::builder()
                .uri(&hpa_url)
                .body(Vec::new())
                .map_err(|e| format!("{}", e))?,
        )
        .await;

    if let Ok(raw) = hpa_result {
        if let Some(items) = raw.get("items").and_then(|v| v.as_array()) {
            for item in items {
                let name = item.pointer("/metadata/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let ns = item.pointer("/metadata/namespace").and_then(|v| v.as_str()).unwrap_or("").to_string();

                let age = item.pointer("/metadata/creationTimestamp")
                    .and_then(|v| v.as_str())
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|ts| format_age((now - ts.with_timezone(&chrono::Utc)).num_seconds()))
                    .unwrap_or_else(|| "?".to_string());

                let target_kind = item.pointer("/spec/scaleTargetRef/kind").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let target_name = item.pointer("/spec/scaleTargetRef/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let min_replicas = item.pointer("/spec/minReplicas").and_then(|v| v.as_i64()).unwrap_or(1) as i32;
                let max_replicas = item.pointer("/spec/maxReplicas").and_then(|v| v.as_i64()).unwrap_or(1) as i32;
                let current_replicas = item.pointer("/status/currentReplicas").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                let desired_replicas = item.pointer("/status/desiredReplicas").and_then(|v| v.as_i64()).unwrap_or(0) as i32;

                let last_scale_time = item.pointer("/status/lastScaleTime")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                // Parse metrics
                let mut metrics = Vec::new();
                if let Some(current_metrics) = item.pointer("/status/currentMetrics").and_then(|v| v.as_array()) {
                    for m in current_metrics {
                        let metric_type = m.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let (metric_name, current_value, target_value, current_average) = match metric_type.as_str() {
                            "Resource" => {
                                let rname = m.pointer("/resource/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let current = m.pointer("/resource/current/averageUtilization")
                                    .and_then(|v| v.as_i64())
                                    .map(|v| format!("{}%", v))
                                    .or_else(|| m.pointer("/resource/current/averageValue").and_then(|v| v.as_str()).map(|s| s.to_string()))
                                    .unwrap_or_else(|| "-".to_string());
                                // Find matching spec metric for target
                                let target = find_spec_metric_target(item, &rname);
                                let avg = m.pointer("/resource/current/averageValue").and_then(|v| v.as_str()).map(|s| s.to_string());
                                (rname, current, target, avg)
                            }
                            "Pods" => {
                                let mname = m.pointer("/pods/metric/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let current = m.pointer("/pods/current/averageValue").and_then(|v| v.as_str()).unwrap_or("-").to_string();
                                (mname, current, "-".to_string(), None)
                            }
                            _ => {
                                ("unknown".to_string(), "-".to_string(), "-".to_string(), None)
                            }
                        };
                        metrics.push(HpaMetricStatus {
                            metric_name,
                            metric_type,
                            current_value,
                            target_value,
                            current_average,
                        });
                    }
                }

                // Parse conditions
                let mut conditions = Vec::new();
                if let Some(conds) = item.pointer("/status/conditions").and_then(|v| v.as_array()) {
                    for c in conds {
                        conditions.push(HpaCondition {
                            condition_type: c.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            status: c.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            reason: c.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            message: c.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            last_transition: c.get("lastTransitionTime").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        });
                    }
                }

                hpas.push(HpaInfo {
                    name,
                    namespace: ns,
                    target_kind,
                    target_name,
                    min_replicas,
                    max_replicas,
                    current_replicas,
                    desired_replicas,
                    metrics,
                    conditions,
                    last_scale_time,
                    age,
                });
            }
        }
    }

    // Fetch VPAs via raw API
    let mut vpas = Vec::new();
    let vpa_url = if namespace == "_all" {
        "/apis/autoscaling.k8s.io/v1/verticalpodautoscalers".to_string()
    } else {
        format!("/apis/autoscaling.k8s.io/v1/namespaces/{}/verticalpodautoscalers", namespace)
    };

    let vpa_result: Result<serde_json::Value, _> = client
        .request::<serde_json::Value>(
            http::Request::builder()
                .uri(&vpa_url)
                .body(Vec::new())
                .map_err(|e| format!("{}", e))?,
        )
        .await;

    if let Ok(raw) = vpa_result {
        if let Some(items) = raw.get("items").and_then(|v| v.as_array()) {
            for item in items {
                let name = item.pointer("/metadata/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let ns = item.pointer("/metadata/namespace").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let age = item.pointer("/metadata/creationTimestamp")
                    .and_then(|v| v.as_str())
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|ts| format_age((now - ts.with_timezone(&chrono::Utc)).num_seconds()))
                    .unwrap_or_else(|| "?".to_string());

                let target_kind = item.pointer("/spec/targetRef/kind").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let target_name = item.pointer("/spec/targetRef/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let update_mode = item.pointer("/spec/updatePolicy/updateMode").and_then(|v| v.as_str()).unwrap_or("Auto").to_string();

                let mut recommendations = Vec::new();
                if let Some(recs) = item.pointer("/status/recommendation/containerRecommendations").and_then(|v| v.as_array()) {
                    for rec in recs {
                        let container_name = rec.get("containerName").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        recommendations.push(VpaRecommendation {
                            container_name,
                            lower_cpu: rec.pointer("/lowerBound/cpu").and_then(|v| v.as_str()).unwrap_or("-").to_string(),
                            lower_memory: rec.pointer("/lowerBound/memory").and_then(|v| v.as_str()).unwrap_or("-").to_string(),
                            target_cpu: rec.pointer("/target/cpu").and_then(|v| v.as_str()).unwrap_or("-").to_string(),
                            target_memory: rec.pointer("/target/memory").and_then(|v| v.as_str()).unwrap_or("-").to_string(),
                            upper_cpu: rec.pointer("/upperBound/cpu").and_then(|v| v.as_str()).unwrap_or("-").to_string(),
                            upper_memory: rec.pointer("/upperBound/memory").and_then(|v| v.as_str()).unwrap_or("-").to_string(),
                        });
                    }
                }

                vpas.push(VpaInfo {
                    name,
                    namespace: ns,
                    target_kind,
                    target_name,
                    update_mode,
                    recommendations,
                    age,
                });
            }
        }
    }

    Ok(AutoscalerInfo { hpas, vpas })
}

fn find_spec_metric_target(hpa: &serde_json::Value, resource_name: &str) -> String {
    if let Some(metrics) = hpa.pointer("/spec/metrics").and_then(|v| v.as_array()) {
        for m in metrics {
            if m.get("type").and_then(|v| v.as_str()) == Some("Resource") {
                if m.pointer("/resource/name").and_then(|v| v.as_str()) == Some(resource_name) {
                    if let Some(util) = m.pointer("/resource/target/averageUtilization").and_then(|v| v.as_i64()) {
                        return format!("{}%", util);
                    }
                    if let Some(val) = m.pointer("/resource/target/averageValue").and_then(|v| v.as_str()) {
                        return val.to_string();
                    }
                }
            }
        }
    }
    "-".to_string()
}
