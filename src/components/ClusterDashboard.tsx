import { Show, For } from "solid-js";
import {
  clusterMetrics,
  clusterOverview,
  overviewLoading,
  showDashboard,
  setShowDashboard,
  loadClusterOverview,
  setActiveResourceKind,
  setSelectedResource,
  loadResources,
} from "../stores/k8s";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}Ki`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}Mi`;
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}Gi`;
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)}Ti`;
}

function formatCpu(millicores: number): string {
  if (millicores < 1000) return `${millicores}m`;
  return `${(millicores / 1000).toFixed(1)} cores`;
}

function pctColor(pct: number): string {
  if (pct > 90) return "var(--status-error)";
  if (pct > 70) return "var(--status-warning)";
  if (pct > 50) return "var(--accent)";
  return "var(--status-running)";
}

// SVG Donut chart component
function DonutChart(props: { value: number; total: number; color: string; label: string; centerText: string; totalLabel?: string; size?: number }) {
  const r = 38;
  const circumference = 2 * Math.PI * r;

  const filled = () => props.total > 0 ? (props.value / props.total) * circumference : 0;
  const gap = () => circumference - filled();
  const size = () => props.size || 100;

  return (
    <div style={{ "text-align": "center" }}>
      <svg width={size()} height={size()} viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--bg-tertiary)" stroke-width="8" />
        <circle cx="50" cy="50" r={r} fill="none"
          style={{
            stroke: props.color,
            "stroke-width": "8",
            "stroke-dasharray": `${filled()} ${gap()}`,
            "stroke-linecap": "round",
            transform: "rotate(-90deg)",
            "transform-origin": "50px 50px",
          }}
        />
        <text x="50" y="46" text-anchor="middle" fill="var(--text-primary)" font-size="18" font-weight="700">{props.centerText}</text>
        <text x="50" y="62" text-anchor="middle" fill="var(--text-secondary)" font-size="9">{props.totalLabel || `of ${props.total}`}</text>
      </svg>
      <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-top": "2px" }}>{props.label}</div>
    </div>
  );
}

// Pod status pie chart
function PodPieChart(props: { running: number; pending: number; failed: number; succeeded: number; unknown: number }) {
  const total = () => props.running + props.pending + props.failed + props.succeeded + props.unknown;

  const r = 38;
  const circumference = 2 * Math.PI * r;

  const segments = () => {
    const t = total();
    if (t === 0) return [];
    const raw = [
      { value: props.running, color: "var(--status-running)", label: "Running" },
      { value: props.succeeded, color: "#6c757d", label: "Succeeded" },
      { value: props.pending, color: "var(--status-warning)", label: "Pending" },
      { value: props.failed, color: "var(--status-error)", label: "Failed" },
      { value: props.unknown, color: "var(--text-muted)", label: "Unknown" },
    ].filter(s => s.value > 0);
    let accum = 0;
    return raw.map(seg => {
      const pct = seg.value / t;
      const dashArray = `${circumference * pct} ${circumference * (1 - pct)}`;
      const rotation = -90 + (accum / t) * 360;
      accum += seg.value;
      return { ...seg, dashArray, rotation };
    });
  };

  return (
    <Show when={total() > 0}>
      <div style={{ "text-align": "center" }}>
        <svg width="120" height="120" viewBox="0 0 100 100">
          <For each={segments()}>
            {(seg) => (
              <circle cx="50" cy="50" r={r} fill="none" stroke={seg.color} stroke-width="10"
                stroke-dasharray={seg.dashArray} transform={`rotate(${seg.rotation} 50 50)`} />
            )}
          </For>
          <text x="50" y="46" text-anchor="middle" fill="var(--text-primary)" font-size="20" font-weight="700">{total()}</text>
          <text x="50" y="60" text-anchor="middle" fill="var(--text-secondary)" font-size="9">pods</text>
        </svg>
        <div style={{ display: "flex", "justify-content": "center", gap: "10px", "flex-wrap": "wrap", "margin-top": "4px" }}>
          <For each={segments()}>
            {(seg) => (
              <div style={{ display: "flex", "align-items": "center", gap: "4px", "font-size": "10px" }}>
                <span style={{ width: "8px", height: "8px", "border-radius": "50%", background: seg.color, display: "inline-block" }} />
                <span style={{ color: "var(--text-secondary)" }}>{seg.label}: {seg.value}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

function kindToResourceKey(kind: string): string {
  const map: Record<string, string> = {
    "Pods": "pods", "Deployments": "deployments", "StatefulSets": "statefulsets",
    "DaemonSets": "daemonsets", "ReplicaSets": "replicasets", "Jobs": "jobs",
    "CronJobs": "cronjobs", "Services": "services", "Ingresses": "ingresses",
  };
  return map[kind] || "pods";
}

export default function ClusterDashboard() {
  return (
    <Show when={showDashboard()}>
      <div class="view-panel" style={{ overflow: "auto" }}>
        <div class="view-panel-header">
          <h2 style={{ "font-size": "15px", "font-weight": "600" }}>Cluster Dashboard</h2>
          <button class="action-btn" onClick={() => loadClusterOverview()} disabled={overviewLoading()}>
            {overviewLoading() ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div class="view-panel-content" style={{ "overflow-y": "auto", padding: "16px" }}>
          <Show when={overviewLoading() && !clusterOverview()}>
            <div style={{ padding: "40px", "text-align": "center", color: "var(--text-secondary)" }}>
              Loading cluster overview...
            </div>
          </Show>

          <Show when={clusterOverview()}>
            {(() => {
              const overview = clusterOverview()!;
              const metrics = clusterMetrics();

              return (
                <div>
                  {/* Top row: CPU, Memory, Pod Status pie charts */}
                  <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px", "margin-bottom": "20px" }}>
                    {/* CPU Usage */}
                    <div style={{ background: "var(--bg-secondary)", "border-radius": "8px", padding: "16px", "text-align": "center" }}>
                      <Show when={metrics} fallback={
                        <div style={{ padding: "20px", color: "var(--text-secondary)", "font-size": "12px" }}>Metrics unavailable</div>
                      }>
                        {(() => {
                          const m = metrics!;
                          return (
                            <>
                              <div style={{ "font-size": "11px", "font-weight": "600", color: "var(--text-secondary)", "text-transform": "uppercase", "margin-bottom": "8px" }}>CPU Usage</div>
                              <DonutChart
                                value={m.total_cpu_millicores}
                                total={m.total_cpu_capacity}
                                color={pctColor(m.cpu_percent)}
                                label={`${formatCpu(m.total_cpu_millicores)} / ${formatCpu(m.total_cpu_capacity)}`}
                                centerText={`${m.cpu_percent.toFixed(0)}%`}
                                totalLabel={`of ${formatCpu(m.total_cpu_capacity)}`}
                                size={120}
                              />
                            </>
                          );
                        })()}
                      </Show>
                    </div>

                    {/* Memory Usage */}
                    <div style={{ background: "var(--bg-secondary)", "border-radius": "8px", padding: "16px", "text-align": "center" }}>
                      <Show when={metrics} fallback={
                        <div style={{ padding: "20px", color: "var(--text-secondary)", "font-size": "12px" }}>Metrics unavailable</div>
                      }>
                        {(() => {
                          const m = metrics!;
                          return (
                            <>
                              <div style={{ "font-size": "11px", "font-weight": "600", color: "var(--text-secondary)", "text-transform": "uppercase", "margin-bottom": "8px" }}>Memory Usage</div>
                              <DonutChart
                                value={m.total_memory_bytes}
                                total={m.total_memory_capacity}
                                color={pctColor(m.memory_percent)}
                                label={`${formatBytes(m.total_memory_bytes)} / ${formatBytes(m.total_memory_capacity)}`}
                                centerText={`${m.memory_percent.toFixed(0)}%`}
                                totalLabel={`of ${formatBytes(m.total_memory_capacity)}`}
                                size={120}
                              />
                            </>
                          );
                        })()}
                      </Show>
                    </div>

                    {/* Pod Status Pie */}
                    <div style={{ background: "var(--bg-secondary)", "border-radius": "8px", padding: "16px", "text-align": "center" }}>
                      <div style={{ "font-size": "11px", "font-weight": "600", color: "var(--text-secondary)", "text-transform": "uppercase", "margin-bottom": "8px" }}>Pod Status</div>
                      <PodPieChart
                        running={overview.pod_status.running}
                        pending={overview.pod_status.pending}
                        failed={overview.pod_status.failed}
                        succeeded={overview.pod_status.succeeded}
                        unknown={overview.pod_status.unknown}
                      />
                    </div>
                  </div>

                  {/* Workload Summary Grid */}
                  <h3 style={{ "font-size": "13px", "font-weight": "600", "margin-bottom": "10px", color: "var(--text-secondary)", "text-transform": "uppercase" }}>
                    Workloads
                  </h3>
                  <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px", "margin-bottom": "20px" }}>
                    <For each={overview.workloads}>
                      {(wl) => (
                        <div
                          style={{
                            background: "var(--bg-secondary)", "border-radius": "8px", padding: "12px",
                            cursor: "pointer", transition: "border-color 0.15s",
                            border: `1px solid ${wl.not_ready > 0 ? "var(--status-warning)44" : "var(--border-color)"}`,
                          }}
                          onClick={() => {
                            setShowDashboard(false);
                            setActiveResourceKind(kindToResourceKey(wl.kind));
                            setSelectedResource(null);
                            loadResources();
                          }}
                        >
                          <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "6px" }}>
                            <span style={{ "font-size": "11px", color: "var(--text-secondary)", "font-weight": "500" }}>{wl.kind}</span>
                            <span style={{ "font-size": "18px", "font-weight": "700" }}>{wl.total}</span>
                          </div>
                          <div style={{ display: "flex", gap: "8px", "font-size": "10px" }}>
                            <span style={{ color: "var(--status-running)" }}>{wl.ready} ready</span>
                            <Show when={wl.not_ready > 0}>
                              <span style={{ color: "var(--status-warning)" }}>{wl.not_ready} not ready</span>
                            </Show>
                          </div>
                          {/* Mini progress bar */}
                          <div style={{ height: "3px", background: "var(--bg-tertiary)", "border-radius": "2px", "margin-top": "6px" }}>
                            <div style={{
                              height: "100%", "border-radius": "2px",
                              width: `${wl.total > 0 ? (wl.ready / wl.total) * 100 : 100}%`,
                              background: wl.not_ready > 0 ? "var(--status-warning)" : "var(--status-running)",
                            }} />
                          </div>
                        </div>
                      )}
                    </For>
                  </div>

                  {/* Node Utilization */}
                  <Show when={metrics && metrics.node_metrics.length > 0}>
                    <h3 style={{ "font-size": "13px", "font-weight": "600", "margin-bottom": "10px", color: "var(--text-secondary)", "text-transform": "uppercase" }}>
                      Nodes ({metrics!.node_count})
                    </h3>
                    <div style={{ "margin-bottom": "20px" }}>
                      <table class="resource-table">
                        <thead>
                          <tr>
                            <th>Node</th>
                            <th>CPU</th>
                            <th style={{ width: "120px" }}>CPU %</th>
                            <th>Memory</th>
                            <th style={{ width: "120px" }}>MEM %</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={metrics!.node_metrics}>
                            {(node) => (
                              <tr>
                                <td style={{ "font-weight": "500" }}>{node.name}</td>
                                <td class="metrics-cell">{node.cpu}</td>
                                <td>
                                  <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                                    <div style={{ flex: 1, height: "5px", background: "var(--bg-tertiary)", "border-radius": "3px" }}>
                                      <div style={{ height: "100%", "border-radius": "3px", width: `${Math.min(node.cpu_percent, 100)}%`, background: pctColor(node.cpu_percent) }} />
                                    </div>
                                    <span style={{ color: pctColor(node.cpu_percent), "font-weight": "600", "font-size": "11px", "min-width": "35px", "text-align": "right" }}>
                                      {node.cpu_percent.toFixed(0)}%
                                    </span>
                                  </div>
                                </td>
                                <td class="metrics-cell">{node.memory}</td>
                                <td>
                                  <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                                    <div style={{ flex: 1, height: "5px", background: "var(--bg-tertiary)", "border-radius": "3px" }}>
                                      <div style={{ height: "100%", "border-radius": "3px", width: `${Math.min(node.memory_percent, 100)}%`, background: pctColor(node.memory_percent) }} />
                                    </div>
                                    <span style={{ color: pctColor(node.memory_percent), "font-weight": "600", "font-size": "11px", "min-width": "35px", "text-align": "right" }}>
                                      {node.memory_percent.toFixed(0)}%
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>

                  {/* Recent Warning Events */}
                  <Show when={overview.recent_warnings.length > 0}>
                    <h3 style={{ "font-size": "13px", "font-weight": "600", "margin-bottom": "10px", color: "var(--status-warning)", "text-transform": "uppercase" }}>
                      Recent Warnings ({overview.recent_warnings.length})
                    </h3>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                      <For each={overview.recent_warnings}>
                        {(ev) => (
                          <div style={{
                            background: "var(--bg-secondary)", "border-radius": "6px", padding: "8px 12px",
                            "border-left": "3px solid var(--status-warning)", "font-size": "11px",
                          }}>
                            <div style={{ display: "flex", "justify-content": "space-between", "margin-bottom": "2px" }}>
                              <span style={{ "font-weight": "600" }}>{ev.reason}</span>
                              <span style={{ color: "var(--text-muted)", "font-size": "10px" }}>{ev.object}</span>
                            </div>
                            <div style={{ color: "var(--text-secondary)" }}>{ev.message}</div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <div style={{ "font-size": "10px", color: "var(--text-muted)", "margin-top": "16px", "text-align": "center" }}>
                    {overview.namespace_count} namespaces · Click any workload card to navigate
                  </div>
                </div>
              );
            })()}
          </Show>
        </div>
      </div>
    </Show>
  );
}
