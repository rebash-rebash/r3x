import { Show, For } from "solid-js";
import {
  healthScore,
  healthLoading,
  showHealthPanel,
  loadClusterHealth,
} from "../stores/k8s";

function scoreColor(score: number): string {
  if (score >= 80) return "var(--status-running)";
  if (score >= 50) return "var(--status-warning)";
  return "var(--status-error)";
}

function statusIcon(status: string): string {
  if (status === "healthy") return "✓";
  if (status === "warning") return "!";
  return "✕";
}

function prioColor(priority: string): string {
  if (priority === "critical") return "var(--status-error)";
  if (priority === "high") return "#e67e22";
  if (priority === "medium") return "var(--status-warning)";
  return "var(--text-secondary)";
}

function categoryIcon(category: string): string {
  if (category === "security") return "S";
  if (category === "reliability") return "R";
  if (category === "performance") return "P";
  if (category === "cost") return "$";
  return "?";
}

export default function HealthPanel() {
  return (
    <Show when={showHealthPanel()}>
      <div class="view-panel" style={{ overflow: "auto" }}>
        <div class="view-panel-header">
          <h2>Cluster Health Score</h2>
          <button class="action-btn" onClick={() => loadClusterHealth()} disabled={healthLoading()}>
            {healthLoading() ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <div class="view-panel-content">
          <Show when={healthLoading()}>
            <div style={{ padding: "40px", "text-align": "center", color: "var(--text-secondary)" }}>
              Analyzing cluster health...
            </div>
          </Show>

          <Show when={healthScore() && !healthLoading()}>
            {(() => {
              const data = healthScore()!;
              return (
                <div>
                  {/* Overall Score */}
                  <div style={{ "text-align": "center", "margin-bottom": "24px" }}>
                    <div style={{
                      width: "120px", height: "120px", "border-radius": "50%",
                      border: `4px solid ${scoreColor(data.overall_score)}`,
                      display: "inline-flex", "align-items": "center", "justify-content": "center",
                      "flex-direction": "column", margin: "0 auto",
                    }}>
                      <div style={{ "font-size": "36px", "font-weight": "700", color: scoreColor(data.overall_score) }}>
                        {data.overall_score}
                      </div>
                      <div style={{ "font-size": "11px", color: "var(--text-secondary)" }}>/ 100</div>
                    </div>
                    <div style={{ "margin-top": "8px", "font-size": "13px", color: "var(--text-secondary)" }}>
                      {data.pod_count} pods · {data.node_count} nodes · {data.namespace === "_all" ? "all namespaces" : data.namespace}
                    </div>
                  </div>

                  {/* Component Scores */}
                  <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px", "margin-bottom": "24px" }}>
                    <For each={data.components}>
                      {(comp) => (
                        <div style={{
                          background: "var(--bg-secondary)", "border-radius": "8px",
                          padding: "12px", border: `1px solid ${scoreColor(comp.score)}33`,
                        }}>
                          <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-bottom": "8px" }}>
                            <span style={{
                              width: "20px", height: "20px", "border-radius": "50%",
                              background: `${scoreColor(comp.score)}22`, color: scoreColor(comp.score),
                              display: "inline-flex", "align-items": "center", "justify-content": "center",
                              "font-size": "11px", "font-weight": "600",
                            }}>
                              {statusIcon(comp.status)}
                            </span>
                            <span style={{ "font-size": "12px", "font-weight": "600" }}>{comp.name}</span>
                          </div>
                          <div style={{ "font-size": "24px", "font-weight": "700", color: scoreColor(comp.score) }}>
                            {comp.score}
                          </div>
                          <div style={{ height: "3px", background: "var(--bg-tertiary)", "border-radius": "2px", "margin-top": "6px" }}>
                            <div style={{ height: "100%", width: `${comp.score}%`, background: scoreColor(comp.score), "border-radius": "2px" }} />
                          </div>
                          <div style={{ "margin-top": "6px" }}>
                            <For each={comp.details.slice(0, 2)}>
                              {(d) => <div style={{ "font-size": "10px", color: "var(--text-secondary)", "margin-top": "2px" }}>{d}</div>}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>

                  {/* Recommendations */}
                  <Show when={data.recommendations.length > 0}>
                    <h3 style={{ "font-size": "14px", "font-weight": "600", "margin-bottom": "12px" }}>
                      Smart Recommendations ({data.recommendations.length})
                    </h3>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                      <For each={data.recommendations}>
                        {(rec) => (
                          <div style={{
                            background: "var(--bg-secondary)", "border-radius": "6px",
                            padding: "12px", "border-left": `3px solid ${prioColor(rec.priority)}`,
                          }}>
                            <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "4px" }}>
                              <span style={{
                                "font-size": "9px", "font-weight": "600", padding: "2px 6px",
                                "border-radius": "3px", background: `${prioColor(rec.priority)}22`,
                                color: prioColor(rec.priority), "text-transform": "uppercase",
                              }}>
                                {rec.priority}
                              </span>
                              <span style={{
                                "font-size": "9px", "font-weight": "500", padding: "2px 6px",
                                "border-radius": "3px", background: "var(--bg-tertiary)",
                                color: "var(--text-secondary)",
                              }}>
                                {categoryIcon(rec.category)} {rec.category}
                              </span>
                              <span style={{ "font-size": "12px", "font-weight": "600" }}>{rec.title}</span>
                            </div>
                            <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-bottom": "4px" }}>
                              {rec.description}
                            </div>
                            <div style={{ "font-size": "11px" }}>
                              <span style={{ color: "var(--accent)" }}>Action:</span> {rec.action}
                            </div>
                            <div style={{ "font-size": "10px", color: "var(--text-secondary)", "margin-top": "2px" }}>
                              Impact: {rec.impact}
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={data.recommendations.length === 0}>
                    <div style={{ padding: "20px", "text-align": "center", color: "var(--status-running)", "font-size": "13px" }}>
                      No recommendations — cluster looks healthy!
                    </div>
                  </Show>
                </div>
              );
            })()}
          </Show>
        </div>
      </div>
    </Show>
  );
}
