import { Show, For } from "solid-js";
import {
  clusterMetrics,
  metricsLoading,
  showMetricsPanel,
  setShowMetricsPanel,
  loadClusterMetrics,
} from "../stores/k8s";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}Ki`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}Gi`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}Ti`;
}

function formatCpu(millicores: number): string {
  if (millicores < 1000) return `${millicores}m`;
  return `${(millicores / 1000).toFixed(1)}`;
}

function pctColor(pct: number): string {
  if (pct > 90) return "var(--danger)";
  if (pct > 70) return "var(--warning)";
  if (pct > 50) return "var(--accent)";
  return "var(--success)";
}

export default function ClusterDashboard() {
  return (
    <Show when={showMetricsPanel()}>
      <div class="view-panel">
        <div class="view-panel-header">
          <h2>Cluster Dashboard</h2>
          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <button class="action-btn" onClick={() => loadClusterMetrics()}>
              {metricsLoading() ? "Refreshing..." : "Refresh"}
            </button>
            <button class="action-btn" onClick={() => setShowMetricsPanel(false)}>Close</button>
          </div>
        </div>
        <div class="view-panel-content">
          <Show when={metricsLoading() && !clusterMetrics()}>
            <div class="loading-overlay">
              <span class="spinner" />
              Loading cluster metrics...
            </div>
          </Show>

          <Show when={clusterMetrics()}>
            {(summary) => (
              <>
                <div class="dashboard-cards">
                  <div class="dashboard-card">
                    <div class="card-label">Nodes</div>
                    <div class="card-value">{summary().node_count}</div>
                  </div>
                  <div class="dashboard-card">
                    <div class="card-label">Pods</div>
                    <div class="card-value">{summary().pod_count}</div>
                  </div>
                  <div class="dashboard-card">
                    <div class="card-label">CPU Usage</div>
                    <div class="card-value" style={{ color: pctColor(summary().cpu_percent) }}>
                      {summary().cpu_percent.toFixed(1)}%
                    </div>
                    <div class="card-sub">
                      {formatCpu(summary().total_cpu_millicores)} / {formatCpu(summary().total_cpu_capacity)}
                    </div>
                    <div class="usage-bar">
                      <div class="usage-fill" style={{ width: `${Math.min(summary().cpu_percent, 100)}%`, background: pctColor(summary().cpu_percent) }} />
                    </div>
                  </div>
                  <div class="dashboard-card">
                    <div class="card-label">Memory Usage</div>
                    <div class="card-value" style={{ color: pctColor(summary().memory_percent) }}>
                      {summary().memory_percent.toFixed(1)}%
                    </div>
                    <div class="card-sub">
                      {formatBytes(summary().total_memory_bytes)} / {formatBytes(summary().total_memory_capacity)}
                    </div>
                    <div class="usage-bar">
                      <div class="usage-fill" style={{ width: `${Math.min(summary().memory_percent, 100)}%`, background: pctColor(summary().memory_percent) }} />
                    </div>
                  </div>
                </div>

                <h3 style={{ margin: "16px 0 8px", "font-size": "13px", color: "var(--text-secondary)" }}>
                  Node Utilization
                </h3>
                <table class="resource-table">
                  <thead>
                    <tr>
                      <th>Node</th>
                      <th>CPU</th>
                      <th>CPU %</th>
                      <th>Memory</th>
                      <th>MEM %</th>
                      <th style={{ width: "200px" }}>CPU Bar</th>
                      <th style={{ width: "200px" }}>MEM Bar</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={summary().node_metrics}>
                      {(node) => (
                        <tr>
                          <td>{node.name}</td>
                          <td class="metrics-cell">{node.cpu}</td>
                          <td class="metrics-cell">
                            <span style={{ color: pctColor(node.cpu_percent), "font-weight": "600" }}>
                              {node.cpu_percent.toFixed(1)}%
                            </span>
                          </td>
                          <td class="metrics-cell">{node.memory}</td>
                          <td class="metrics-cell">
                            <span style={{ color: pctColor(node.memory_percent), "font-weight": "600" }}>
                              {node.memory_percent.toFixed(1)}%
                            </span>
                          </td>
                          <td>
                            <div class="usage-bar" style={{ width: "100%" }}>
                              <div class="usage-fill" style={{ width: `${Math.min(node.cpu_percent, 100)}%`, background: pctColor(node.cpu_percent) }} />
                            </div>
                          </td>
                          <td>
                            <div class="usage-bar" style={{ width: "100%" }}>
                              <div class="usage-fill" style={{ width: `${Math.min(node.memory_percent, 100)}%`, background: pctColor(node.memory_percent) }} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
}
