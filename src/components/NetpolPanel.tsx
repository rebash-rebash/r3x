import { createSignal, Show, For } from "solid-js";
import {
  getNetworkPolicies,
  NetpolGraph,
  activeNamespace,
  showNetpolPanel,
} from "../stores/k8s";

export default function NetpolPanel() {
  const [data, setData] = createSignal<NetpolGraph | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [viewMode, setViewMode] = createSignal<"policies" | "graph">("policies");
  const [loaded, setLoaded] = createSignal(false);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const result = await getNetworkPolicies(activeNamespace());
      setData(result);
      setLoaded(true);
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setLoading(false);
    }
  }

  return (
    <Show when={showNetpolPanel()}>
      {(() => {
        if (!loaded()) load();
        return (
          <div class="view-panel" style={{ overflow: "auto" }}>
            <div class="view-panel-header">
              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <h2>Network Policies</h2>
                <button
                  class={`action-btn ${viewMode() === "policies" ? "active" : ""}`}
                  onClick={() => setViewMode("policies")}
                >Policies</button>
                <button
                  class={`action-btn ${viewMode() === "graph" ? "active" : ""}`}
                  onClick={() => setViewMode("graph")}
                >Graph</button>
              </div>
              <button class="action-btn" onClick={load} disabled={loading()}>
                {loading() ? "Loading..." : "Refresh"}
              </button>
            </div>

            <div class="view-panel-content">
              <Show when={error()}>
                <div style={{ padding: "12px", color: "var(--status-error)", "font-size": "12px" }}>
                  {error()}
                </div>
              </Show>

              <Show when={loading()}>
                <div style={{ padding: "40px", "text-align": "center", color: "var(--text-secondary)" }}>
                  Analyzing network policies...
                </div>
              </Show>

              <Show when={data() && !loading()}>
                {(() => {
                  const d = data()!;
                  return (
                    <div>
                      {/* Summary */}
                      <div style={{ display: "grid", "grid-template-columns": "repeat(3, 1fr)", gap: "12px", "margin-bottom": "20px" }}>
                        <div style={{ background: "var(--bg-secondary)", padding: "12px", "border-radius": "6px", "text-align": "center" }}>
                          <div style={{ "font-size": "24px", "font-weight": "700", color: "var(--accent)" }}>{d.total_policies}</div>
                          <div style={{ "font-size": "11px", color: "var(--text-secondary)" }}>Policies</div>
                        </div>
                        <div style={{ background: "var(--bg-secondary)", padding: "12px", "border-radius": "6px", "text-align": "center" }}>
                          <div style={{ "font-size": "24px", "font-weight": "700", color: "var(--status-running)" }}>{d.nodes.filter(n => n.has_netpol).length}</div>
                          <div style={{ "font-size": "11px", color: "var(--text-secondary)" }}>Protected Pods</div>
                        </div>
                        <div style={{ background: "var(--bg-secondary)", padding: "12px", "border-radius": "6px", "text-align": "center" }}>
                          <div style={{ "font-size": "24px", "font-weight": "700", color: d.unprotected_pods.length > 0 ? "var(--status-warning)" : "var(--status-running)" }}>
                            {d.unprotected_pods.length}
                          </div>
                          <div style={{ "font-size": "11px", color: "var(--text-secondary)" }}>Unprotected Pods</div>
                        </div>
                      </div>

                      <Show when={viewMode() === "policies"}>
                        <For each={d.policies}>
                          {(pol) => (
                            <div style={{
                              background: "var(--bg-secondary)", "border-radius": "6px",
                              padding: "12px", "margin-bottom": "12px",
                              border: "1px solid var(--border-color)",
                            }}>
                              <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "8px" }}>
                                <span style={{ "font-weight": "600", "font-size": "13px" }}>{pol.name}</span>
                                <span style={{ "font-size": "10px", color: "var(--text-secondary)" }}>{pol.namespace}</span>
                                <For each={pol.policy_types}>
                                  {(pt) => (
                                    <span style={{
                                      "font-size": "9px", padding: "1px 5px", "border-radius": "3px",
                                      background: pt === "Ingress" ? "#3498db33" : "#e74c3c33",
                                      color: pt === "Ingress" ? "#3498db" : "#e74c3c",
                                    }}>{pt}</span>
                                  )}
                                </For>
                              </div>
                              <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-bottom": "6px" }}>
                                Selector: <code style={{ color: "var(--accent)" }}>{pol.pod_selector}</code>
                                {" "} · Matches: {pol.matched_pods.length} pod(s)
                              </div>
                              <Show when={pol.rules.length > 0}>
                                <div style={{ "font-size": "11px" }}>
                                  <For each={pol.rules}>
                                    {(rule) => (
                                      <div style={{
                                        display: "flex", "align-items": "center", gap: "6px",
                                        padding: "3px 0", "border-bottom": "1px solid var(--bg-tertiary)",
                                      }}>
                                        <span style={{
                                          "font-size": "9px", "font-weight": "600", padding: "1px 4px",
                                          "border-radius": "2px",
                                          background: rule.direction === "ingress" ? "#3498db22" : "#e74c3c22",
                                          color: rule.direction === "ingress" ? "#3498db" : "#e74c3c",
                                          width: "50px", "text-align": "center",
                                        }}>{rule.direction === "ingress" ? "INGRESS" : "EGRESS"}</span>
                                        <span style={{ color: "var(--text-secondary)" }}>
                                          {rule.direction === "ingress" ? "from" : "to"}
                                        </span>
                                        <span style={{ color: "var(--text-primary)" }}>{rule.peer_label}</span>
                                        <Show when={rule.ports.length > 0}>
                                          <span style={{ color: "var(--text-secondary)" }}>on</span>
                                          <span style={{ color: "var(--accent)" }}>{rule.ports.join(", ")}</span>
                                        </Show>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                        <Show when={d.policies.length === 0}>
                          <div style={{ padding: "20px", "text-align": "center", color: "var(--text-secondary)" }}>
                            No network policies found in this namespace
                          </div>
                        </Show>
                      </Show>

                      <Show when={viewMode() === "graph"}>
                        <Show when={d.edges.length > 0}>
                          <div style={{ "font-size": "12px", "margin-bottom": "12px", color: "var(--text-secondary)" }}>
                            {d.edges.length} connection rules
                          </div>
                          <For each={d.edges}>
                            {(edge) => (
                              <div style={{
                                display: "flex", "align-items": "center", gap: "8px",
                                padding: "6px 8px", "margin-bottom": "4px",
                                background: "var(--bg-secondary)", "border-radius": "4px",
                                "font-size": "11px",
                              }}>
                                <span style={{
                                  padding: "2px 6px", "border-radius": "3px",
                                  background: "var(--accent)22", color: "var(--accent)",
                                  "max-width": "180px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
                                }}>{edge.from_id.split('/').pop()}</span>
                                <span style={{ color: edge.direction === "ingress" ? "#3498db" : "#e74c3c" }}>
                                  {edge.direction === "ingress" ? "→" : "→"}
                                </span>
                                <span style={{
                                  padding: "2px 6px", "border-radius": "3px",
                                  background: "var(--status-running)22", color: "var(--status-running)",
                                  "max-width": "180px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
                                }}>{edge.to_id.split('/').pop()}</span>
                                <Show when={edge.ports.length > 0}>
                                  <span style={{ color: "var(--text-secondary)", "font-size": "10px" }}>
                                    [{edge.ports.join(", ")}]
                                  </span>
                                </Show>
                                <span style={{ "margin-left": "auto", "font-size": "9px", color: "var(--text-secondary)" }}>
                                  {edge.policy_name}
                                </span>
                              </div>
                            )}
                          </For>
                        </Show>
                        <Show when={d.edges.length === 0}>
                          <div style={{ padding: "20px", "text-align": "center", color: "var(--text-secondary)" }}>
                            No edges to display. Network policies may have empty rules or no matching peers.
                          </div>
                        </Show>

                        <Show when={d.unprotected_pods.length > 0}>
                          <div style={{ "margin-top": "16px" }}>
                            <h3 style={{ "font-size": "12px", "font-weight": "600", "margin-bottom": "8px", color: "var(--status-warning)" }}>
                              Unprotected Pods ({d.unprotected_pods.length})
                            </h3>
                            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
                              <For each={d.unprotected_pods.slice(0, 50)}>
                                {(pod) => (
                                  <span style={{
                                    "font-size": "10px", padding: "2px 6px", "border-radius": "3px",
                                    background: "var(--status-warning)15", color: "var(--status-warning)",
                                    border: "1px solid var(--status-warning)33",
                                  }}>{pod.split('/').pop()}</span>
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>
                      </Show>
                    </div>
                  );
                })()}
              </Show>
            </div>
          </div>
        );
      })()}
    </Show>
  );
}
