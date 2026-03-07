import { createSignal, createEffect, Show, For } from "solid-js";
import {
  selectedResource,
  setSelectedResource,
  getNodeDetails,
  NodeInfo,
} from "../stores/k8s";

export default function NodeDetailPanel() {
  const [nodeInfo, setNodeInfo] = createSignal<NodeInfo | null>(null);
  const [loading, setLoading] = createSignal(false);

  const isNode = () => selectedResource()?.kind === "Node";

  createEffect(async () => {
    const res = selectedResource();
    if (!res || res.kind !== "Node") {
      setNodeInfo(null);
      return;
    }
    setLoading(true);
    try {
      const info = await getNodeDetails(res.name);
      setNodeInfo(info);
    } catch (e: any) {
      console.error("Failed to load node details:", e);
    }
    setLoading(false);
  });

  return (
    <Show when={isNode() && selectedResource()}>
      <div class="detail-panel" style={{ "max-height": "60vh" }}>
        <div class="detail-header">
          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
            <h3>{selectedResource()!.name}</h3>
            <span style={{ "font-size": "11px", color: "var(--text-muted)" }}>Node</span>
          </div>
          <button class="detail-close" onClick={() => setSelectedResource(null)}>
            x
          </button>
        </div>

        <div class="detail-content">
          <Show when={loading()}>
            <div class="loading-overlay">
              <span class="spinner" />
              Loading node details...
            </div>
          </Show>

          <Show when={!loading() && nodeInfo()}>
            <div class="node-detail-grid">
              <div class="node-section">
                <h4>Overview</h4>
                <table class="resource-table">
                  <tbody>
                    <tr><td>Status</td><td><span class={`status ${nodeInfo()!.status === "Ready" ? "status-running" : "status-failed"}`}><span class="status-dot" />{nodeInfo()!.status}</span></td></tr>
                    <tr><td>Roles</td><td>{nodeInfo()!.roles.join(", ")}</td></tr>
                    <tr><td>Version</td><td>{nodeInfo()!.version}</td></tr>
                    <tr><td>Age</td><td>{nodeInfo()!.age}</td></tr>
                    <tr><td>Internal IP</td><td>{nodeInfo()!.internal_ip}</td></tr>
                    <tr><td>External IP</td><td>{nodeInfo()!.external_ip}</td></tr>
                  </tbody>
                </table>
              </div>

              <div class="node-section">
                <h4>System</h4>
                <table class="resource-table">
                  <tbody>
                    <tr><td>OS</td><td>{nodeInfo()!.os}</td></tr>
                    <tr><td>Architecture</td><td>{nodeInfo()!.arch}</td></tr>
                    <tr><td>Kernel</td><td>{nodeInfo()!.kernel_version}</td></tr>
                    <tr><td>Runtime</td><td>{nodeInfo()!.container_runtime}</td></tr>
                  </tbody>
                </table>
              </div>

              <div class="node-section">
                <h4>Capacity / Allocatable</h4>
                <table class="resource-table">
                  <thead>
                    <tr><th>Resource</th><th>Capacity</th><th>Allocatable</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>CPU</td><td>{nodeInfo()!.cpu_capacity}</td><td>{nodeInfo()!.cpu_allocatable}</td></tr>
                    <tr><td>Memory</td><td>{nodeInfo()!.memory_capacity}</td><td>{nodeInfo()!.memory_allocatable}</td></tr>
                    <tr><td>Pods</td><td>{nodeInfo()!.pods_capacity}</td><td>{nodeInfo()!.pods_allocatable}</td></tr>
                  </tbody>
                </table>
              </div>

              <div class="node-section" style={{ "grid-column": "1 / -1" }}>
                <h4>Conditions</h4>
                <table class="resource-table">
                  <thead>
                    <tr><th>Type</th><th>Status</th><th>Reason</th><th>Message</th><th>Last Transition</th></tr>
                  </thead>
                  <tbody>
                    <For each={nodeInfo()!.conditions}>
                      {(c) => (
                        <tr>
                          <td>{c.condition_type}</td>
                          <td>
                            <span class={c.status === "True" && c.condition_type !== "Ready" ? "event-warning" : c.status === "True" && c.condition_type === "Ready" ? "event-normal" : ""}>
                              {c.status}
                            </span>
                          </td>
                          <td style={{ color: "var(--text-secondary)" }}>{c.reason || "-"}</td>
                          <td class="event-message">{c.message || "-"}</td>
                          <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>{c.last_transition || "-"}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
