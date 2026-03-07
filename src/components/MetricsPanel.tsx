import { createSignal, createMemo, Show, For } from "solid-js";
import {
  clusterMetrics,
  podMetrics,
  metricsLoading,
  showMetricsPanel,
  setShowMetricsPanel,
  loadClusterMetrics,
} from "../stores/k8s";

type MetricsTab = "overview" | "nodes" | "pods";

export default function MetricsPanel() {
  const [activeTab, setActiveTab] = createSignal<MetricsTab>("overview");
  const [podFilter, setPodFilter] = createSignal("");
  const [sortBy, setSortBy] = createSignal<"cpu" | "memory" | "name">("cpu");

  const sortedPods = createMemo(() => {
    const q = podFilter().toLowerCase();
    let pods = podMetrics();
    if (q) {
      pods = pods.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.namespace.toLowerCase().includes(q)
      );
    }
    const s = sortBy();
    return [...pods].sort((a, b) => {
      if (s === "cpu") return (b.containers.reduce((sum, c) => sum + c.cpu_millicores, 0)) - (a.containers.reduce((sum, c) => sum + c.cpu_millicores, 0));
      if (s === "memory") return (b.containers.reduce((sum, c) => sum + c.memory_bytes, 0)) - (a.containers.reduce((sum, c) => sum + c.memory_bytes, 0));
      return a.name.localeCompare(b.name);
    });
  });

  function UsageBar(props: { percent: number; color?: string }) {
    const clampedPct = () => Math.min(Math.max(props.percent, 0), 100);
    const barColor = () => {
      const p = clampedPct();
      if (p > 90) return "var(--danger)";
      if (p > 70) return "var(--warning)";
      return props.color || "var(--accent)";
    };
    return (
      <div class="usage-bar">
        <div
          class="usage-bar-fill"
          style={{ width: `${clampedPct()}%`, background: barColor() }}
        />
        <span class="usage-bar-label">{clampedPct().toFixed(1)}%</span>
      </div>
    );
  }

  function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} Gi`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} Mi`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} Ki`;
    return `${bytes} B`;
  }

  function formatCpu(mc: number): string {
    if (mc >= 1000) return `${(mc / 1000).toFixed(1)} cores`;
    return `${mc}m`;
  }

  return (
    <Show when={showMetricsPanel()}>
      <div class="metrics-panel">
        <div class="detail-header">
          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
            <h3>Resource Utilization</h3>
          </div>
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <div class="detail-tabs">
              <button
                class={`detail-tab ${activeTab() === "overview" ? "active" : ""}`}
                onClick={() => setActiveTab("overview")}
              >
                Overview
              </button>
              <button
                class={`detail-tab ${activeTab() === "nodes" ? "active" : ""}`}
                onClick={() => setActiveTab("nodes")}
              >
                Nodes
              </button>
              <button
                class={`detail-tab ${activeTab() === "pods" ? "active" : ""}`}
                onClick={() => setActiveTab("pods")}
              >
                Pods
              </button>
            </div>
            <button class="action-btn" onClick={loadClusterMetrics}>
              Refresh
            </button>
            <button class="detail-close" onClick={() => setShowMetricsPanel(false)}>
              x
            </button>
          </div>
        </div>

        <div class="detail-content">
          <Show when={metricsLoading()}>
            <div class="loading-overlay">
              <span class="spinner" />
              Loading metrics...
            </div>
          </Show>

          {/* Overview tab */}
          <Show when={!metricsLoading() && activeTab() === "overview" && clusterMetrics()}>
            <div class="metrics-overview">
              <div class="metrics-card">
                <div class="metrics-card-title">Cluster CPU</div>
                <div class="metrics-card-value">
                  {formatCpu(clusterMetrics()!.total_cpu_millicores)}
                  <span class="metrics-card-cap">
                    / {formatCpu(clusterMetrics()!.total_cpu_capacity)}
                  </span>
                </div>
                <UsageBar percent={clusterMetrics()!.cpu_percent} />
              </div>

              <div class="metrics-card">
                <div class="metrics-card-title">Cluster Memory</div>
                <div class="metrics-card-value">
                  {formatBytes(clusterMetrics()!.total_memory_bytes)}
                  <span class="metrics-card-cap">
                    / {formatBytes(clusterMetrics()!.total_memory_capacity)}
                  </span>
                </div>
                <UsageBar percent={clusterMetrics()!.memory_percent} color="var(--info)" />
              </div>

              <div class="metrics-card metrics-card-sm">
                <div class="metrics-card-title">Nodes</div>
                <div class="metrics-card-value">{clusterMetrics()!.node_count}</div>
              </div>

              <div class="metrics-card metrics-card-sm">
                <div class="metrics-card-title">Pods</div>
                <div class="metrics-card-value">{clusterMetrics()!.pod_count}</div>
              </div>
            </div>
          </Show>

          {/* Nodes tab */}
          <Show when={!metricsLoading() && activeTab() === "nodes" && clusterMetrics()}>
            <div style={{ padding: "8px" }}>
              <table class="resource-table">
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>CPU Usage</th>
                    <th>CPU %</th>
                    <th>Memory Usage</th>
                    <th>Memory %</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={clusterMetrics()!.node_metrics}>
                    {(node) => (
                      <tr>
                        <td>{node.name}</td>
                        <td>
                          {node.cpu}
                          <span style={{ color: "var(--text-muted)", "font-size": "11px" }}>
                            {" "}/ {formatCpu(node.cpu_capacity)}
                          </span>
                        </td>
                        <td style={{ width: "150px" }}>
                          <UsageBar percent={node.cpu_percent} />
                        </td>
                        <td>
                          {node.memory}
                          <span style={{ color: "var(--text-muted)", "font-size": "11px" }}>
                            {" "}/ {formatBytes(node.memory_capacity)}
                          </span>
                        </td>
                        <td style={{ width: "150px" }}>
                          <UsageBar percent={node.memory_percent} color="var(--info)" />
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>

          {/* Pods tab */}
          <Show when={!metricsLoading() && activeTab() === "pods"}>
            <div class="metrics-pod-controls">
              <input
                type="text"
                placeholder="Filter pods..."
                value={podFilter()}
                onInput={(e) => setPodFilter(e.currentTarget.value)}
                style={{ "font-size": "12px", padding: "4px 8px", width: "180px" }}
              />
              <select
                value={sortBy()}
                onChange={(e) => setSortBy(e.currentTarget.value as any)}
                style={{ "font-size": "12px" }}
              >
                <option value="cpu">Sort: CPU (high first)</option>
                <option value="memory">Sort: Memory (high first)</option>
                <option value="name">Sort: Name</option>
              </select>
              <span style={{ "font-size": "11px", color: "var(--text-muted)" }}>
                {sortedPods().length} pods
              </span>
            </div>
            <div style={{ padding: "0 8px 8px" }}>
              <table class="resource-table">
                <thead>
                  <tr>
                    <th>Pod</th>
                    <th>Namespace</th>
                    <th>CPU</th>
                    <th>Memory</th>
                    <th>CPU %</th>
                    <th>Mem %</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={sortedPods()}>
                    {(pod) => (
                      <tr>
                        <td>{pod.name}</td>
                        <td style={{ color: "var(--text-secondary)" }}>{pod.namespace}</td>
                        <td>{pod.cpu_total}</td>
                        <td>{pod.memory_total}</td>
                        <td>
                          <Show when={pod.cpu_percent !== null} fallback="-">
                            <UsageBar percent={pod.cpu_percent!} />
                          </Show>
                        </td>
                        <td>
                          <Show when={pod.memory_percent !== null} fallback="-">
                            <UsageBar percent={pod.memory_percent!} color="var(--info)" />
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={sortedPods().length === 0}>
                <div class="empty-state">
                  <p>No pod metrics available</p>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
