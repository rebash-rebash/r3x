import { createSignal, createEffect, Show, For } from "solid-js";
import {
  portForwards,
  showPortForwardPanel,
  setShowPortForwardPanel,
  startPortForward,
  stopPortForward,
  selectedResource,
  getPodPorts,
  refreshPortForwards,
  ContainerPort,
} from "../stores/k8s";

export default function PortForwardPanel() {
  const [containerPorts, setContainerPorts] = createSignal<ContainerPort[]>([]);
  const [localPort, setLocalPort] = createSignal("");
  const [selectedPort, setSelectedPort] = createSignal<number | null>(null);
  const [pfError, setPfError] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [customMode, setCustomMode] = createSignal(false);
  const [customRemotePort, setCustomRemotePort] = createSignal("");

  // Auto-detect container ports when panel opens or resource changes
  createEffect(async () => {
    const res = selectedResource();
    if (!showPortForwardPanel() || !res || res.kind !== "Pod") {
      setContainerPorts([]);
      return;
    }
    try {
      const ports = await getPodPorts(res.namespace || "default", res.name);
      setContainerPorts(ports);
      if (ports.length > 0) {
        setSelectedPort(ports[0].port);
        setLocalPort(ports[0].port.toString());
      }
    } catch {
      setContainerPorts([]);
    }
    refreshPortForwards();
  });

  async function handleForward() {
    const res = selectedResource();
    if (!res) return;

    const lp = parseInt(localPort());
    const rp = customMode() ? parseInt(customRemotePort()) : selectedPort();
    if (!lp || !rp || lp < 1 || rp < 1) {
      setPfError("Invalid port numbers");
      return;
    }

    setStarting(true);
    setPfError(null);
    try {
      await startPortForward(res.namespace || "default", res.name, lp, rp);
      setLocalPort("");
      setCustomRemotePort("");
    } catch (e: any) {
      setPfError(e.toString());
    }
    setStarting(false);
  }

  async function handleStop(sessionId: string) {
    try {
      await stopPortForward(sessionId);
    } catch (e: any) {
      setPfError(e.toString());
    }
  }

  function selectContainerPort(port: number) {
    setSelectedPort(port);
    setLocalPort(port.toString());
    setCustomMode(false);
  }

  return (
    <Show when={showPortForwardPanel()}>
      <div class="pf-panel">
        <div class="detail-header">
          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
            <h3>Port Forward</h3>
            <Show when={selectedResource()}>
              <span style={{ "font-size": "11px", color: "var(--text-muted)" }}>
                {selectedResource()!.name}
              </span>
            </Show>
          </div>
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <button class="action-btn" onClick={() => refreshPortForwards()}>
              Refresh
            </button>
            <button class="detail-close" onClick={() => setShowPortForwardPanel(false)}>
              x
            </button>
          </div>
        </div>

        <div class="detail-content" style={{ padding: "12px 16px" }}>
          <Show when={selectedResource()?.kind === "Pod"}>
            {/* Detected container ports */}
            <Show when={containerPorts().length > 0}>
              <div style={{ "margin-bottom": "12px" }}>
                <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-bottom": "6px", "text-transform": "uppercase", "letter-spacing": "0.5px" }}>
                  Container Ports
                </div>
                <div class="pf-port-list">
                  <For each={containerPorts()}>
                    {(cp) => (
                      <button
                        class={`pf-port-btn ${!customMode() && selectedPort() === cp.port ? "active" : ""}`}
                        onClick={() => selectContainerPort(cp.port)}
                      >
                        <span class="pf-port-number">{cp.port}</span>
                        <span class="pf-port-meta">
                          {cp.name || cp.protocol}
                          <span style={{ color: "var(--text-muted)" }}> / {cp.container_name}</span>
                        </span>
                      </button>
                    )}
                  </For>
                  <button
                    class={`pf-port-btn ${customMode() ? "active" : ""}`}
                    onClick={() => setCustomMode(true)}
                  >
                    <span class="pf-port-number">...</span>
                    <span class="pf-port-meta">Custom</span>
                  </button>
                </div>
              </div>
            </Show>

            <Show when={containerPorts().length === 0}>
              <div style={{ "font-size": "12px", color: "var(--text-muted)", "margin-bottom": "8px" }}>
                No exposed ports detected. Enter ports manually:
              </div>
            </Show>

            <div class="pf-form">
              <div class="pf-form-field">
                <label>Local Port</label>
                <input
                  type="number"
                  placeholder="8080"
                  value={localPort()}
                  onInput={(e) => setLocalPort(e.currentTarget.value)}
                />
              </div>
              <span class="pf-arrow">-&gt;</span>
              <div class="pf-form-field">
                <label>Container Port</label>
                <Show when={customMode() || containerPorts().length === 0}>
                  <input
                    type="number"
                    placeholder="80"
                    value={customRemotePort()}
                    onInput={(e) => setCustomRemotePort(e.currentTarget.value)}
                  />
                </Show>
                <Show when={!customMode() && containerPorts().length > 0}>
                  <input type="number" value={selectedPort() || ""} disabled />
                </Show>
              </div>
              <button class="action-btn pf-start-btn" onClick={handleForward} disabled={starting()}>
                {starting() ? "Starting..." : "Forward"}
              </button>
            </div>
          </Show>

          <Show when={!selectedResource() || selectedResource()?.kind !== "Pod"}>
            <p style={{ color: "var(--text-muted)", "font-size": "12px" }}>
              Select a pod to create a port forward
            </p>
          </Show>

          <Show when={pfError()}>
            <div class="error-banner" style={{ "margin-top": "8px", padding: "6px 10px", "font-size": "12px" }}>
              {pfError()}
            </div>
          </Show>

          {/* Active port forwards */}
          <Show when={portForwards().length > 0}>
            <div style={{ "margin-top": "16px" }}>
              <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-bottom": "6px", "text-transform": "uppercase", "letter-spacing": "0.5px" }}>
                Active Forwards
              </div>
              <table class="resource-table">
                <thead>
                  <tr>
                    <th>Pod</th>
                    <th>Namespace</th>
                    <th>Local</th>
                    <th>Remote</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <For each={portForwards()}>
                    {(pf) => (
                      <tr>
                        <td>{pf.pod_name}</td>
                        <td style={{ color: "var(--text-secondary)" }}>{pf.namespace}</td>
                        <td>
                          <span style={{ color: "var(--accent)" }}>localhost:{pf.local_port}</span>
                        </td>
                        <td>{pf.remote_port}</td>
                        <td>
                          <span class="status status-running">
                            <span class="status-dot" />
                            {pf.status}
                          </span>
                        </td>
                        <td>
                          <button
                            class="action-btn danger"
                            style={{ "font-size": "11px", padding: "2px 8px" }}
                            onClick={() => handleStop(pf.id)}
                          >
                            Stop
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
