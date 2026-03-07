import { Show, For } from "solid-js";
import {
  helmReleases,
  showHelmPanel,
  setShowHelmPanel,
  helmLoading,
  loadHelmReleases,
} from "../stores/k8s";

export default function HelmPanel() {
  return (
    <Show when={showHelmPanel()}>
      <div class="view-panel">
        <div class="view-panel-header">
          <h2>Helm Releases</h2>
          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <span class="badge">{helmReleases().length} releases</span>
            <button class="action-btn" onClick={() => loadHelmReleases()} disabled={helmLoading()}>
              {helmLoading() ? "Loading..." : "Refresh"}
            </button>
            <button class="action-btn" onClick={() => setShowHelmPanel(false)}>Close</button>
          </div>
        </div>
        <div class="view-panel-content">
          <Show when={helmLoading()}>
            <div class="loading-overlay">
              <span class="spinner" />
              Loading Helm releases...
            </div>
          </Show>
          <Show when={!helmLoading()}>
            <Show when={helmReleases().length === 0}>
              <div class="empty-state">
                <p>No Helm releases found</p>
              </div>
            </Show>
            <Show when={helmReleases().length > 0}>
              <table class="resource-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Namespace</th>
                    <th>Revision</th>
                    <th>Status</th>
                    <th>Chart</th>
                    <th>App Version</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={helmReleases()}>
                    {(rel) => (
                      <tr>
                        <td>{rel.name}</td>
                        <td style={{ color: "var(--text-secondary)" }}>{rel.namespace}</td>
                        <td>{rel.revision}</td>
                        <td>
                          <span class={`status ${rel.status === "deployed" ? "status-running" : rel.status === "failed" ? "status-failed" : "status-pending"}`}>
                            <span class="status-dot" />
                            {rel.status}
                          </span>
                        </td>
                        <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>{rel.chart}</td>
                        <td>{rel.app_version}</td>
                        <td style={{ color: "var(--text-secondary)", "font-size": "11px", "max-width": "200px", overflow: "hidden", "text-overflow": "ellipsis" }}>
                          {rel.updated}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  );
}
