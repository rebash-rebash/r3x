use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: String,
    pub updated: String,
    pub status: String,
    pub chart: String,
    pub app_version: String,
}

#[tauri::command]
pub async fn list_helm_releases(
    _context: String,
    namespace: String,
) -> Result<Vec<HelmRelease>, String> {
    let mut cmd = Command::new("helm");
    cmd.args(["list", "--output", "json"]);

    if namespace == "_all" {
        cmd.arg("--all-namespaces");
    } else {
        cmd.args(["--namespace", &namespace]);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run helm: {}. Is helm installed?", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("helm list failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() || stdout.trim() == "[]" {
        return Ok(Vec::new());
    }

    #[derive(Deserialize)]
    struct HelmJson {
        name: Option<String>,
        namespace: Option<String>,
        revision: Option<String>,
        updated: Option<String>,
        status: Option<String>,
        chart: Option<String>,
        app_version: Option<String>,
    }

    let releases: Vec<HelmJson> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse helm output: {}", e))?;

    Ok(releases
        .into_iter()
        .map(|r| HelmRelease {
            name: r.name.unwrap_or_default(),
            namespace: r.namespace.unwrap_or_default(),
            revision: r.revision.unwrap_or_default(),
            updated: r.updated.unwrap_or_default(),
            status: r.status.unwrap_or_default(),
            chart: r.chart.unwrap_or_default(),
            app_version: r.app_version.unwrap_or_default(),
        })
        .collect())
}
