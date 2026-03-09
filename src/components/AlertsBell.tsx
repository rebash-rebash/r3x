import { createSignal, Show, For } from "solid-js";
import {
  activeAlerts,
  ClusterAlert,
  dismissAlert,
  dismissAllAlerts,
} from "../stores/k8s";

export default function AlertsBell() {
  const [showDropdown, setShowDropdown] = createSignal(false);

  const criticalCount = () => activeAlerts().filter(a => a.severity === "critical").length;
  const totalCount = () => activeAlerts().length;

  function toggleDropdown(e: MouseEvent) {
    e.stopPropagation();
    setShowDropdown(!showDropdown());
  }

  function handleDismiss(e: MouseEvent, id: string) {
    e.stopPropagation();
    dismissAlert(id);
  }

  function handleDismissAll(e: MouseEvent) {
    e.stopPropagation();
    dismissAllAlerts();
  }

  // Close dropdown when clicking outside
  function handleOverlayClick() {
    setShowDropdown(false);
  }

  return (
    <div class="alerts-bell-wrapper">
      <button
        class={`alerts-bell-btn ${criticalCount() > 0 ? "has-critical" : totalCount() > 0 ? "has-warning" : ""}`}
        onClick={toggleDropdown}
        title={`${totalCount()} alert${totalCount() !== 1 ? "s" : ""}`}
      >
        <span class="bell-icon">&#x1F514;</span>
        <Show when={totalCount() > 0}>
          <span class={`alert-badge ${criticalCount() > 0 ? "critical" : "warning"}`}>
            {totalCount()}
          </span>
        </Show>
      </button>

      <Show when={showDropdown()}>
        <div class="alerts-overlay" onClick={handleOverlayClick} />
        <div class="alerts-dropdown">
          <div class="alerts-dropdown-header">
            <span class="alerts-title">Cluster Alerts</span>
            <Show when={totalCount() > 0}>
              <button class="alerts-dismiss-all" onClick={handleDismissAll}>
                Clear All
              </button>
            </Show>
          </div>
          <div class="alerts-dropdown-body">
            <Show when={activeAlerts().length === 0}>
              <div class="alerts-empty">No active alerts</div>
            </Show>
            <For each={activeAlerts()}>
              {(alert: ClusterAlert) => (
                <div class={`alert-item alert-${alert.severity}`}>
                  <div class="alert-item-header">
                    <span class={`alert-severity-dot ${alert.severity}`} />
                    <Show when={alert.reason === "LogError"}>
                      <span class="alert-log-badge">LOG</span>
                    </Show>
                    <Show when={alert.reason === "BenchmarkDone" || alert.reason === "BenchmarkError"}>
                      <span class="alert-log-badge" style={alert.reason === "BenchmarkDone" ? { background: "#4a9" } : undefined}>BENCH</span>
                    </Show>
                    <span class="alert-item-title">{["LogError", "BenchmarkDone", "BenchmarkError"].includes(alert.reason || "") ? alert.title : alert.reason}</span>
                    <Show when={alert.count > 1}>
                      <span class="alert-count">x{alert.count}</span>
                    </Show>
                    <Show when={alert.timestamp}>
                      <span class="alert-time">{alert.timestamp}</span>
                    </Show>
                    <button
                      class="alert-dismiss-btn"
                      onClick={(e) => handleDismiss(e, alert.id)}
                      title="Dismiss"
                    >
                      x
                    </button>
                  </div>
                  <div class="alert-item-resource">
                    {alert.resource}
                    <Show when={alert.namespace}>
                      <span class="alert-ns">{alert.namespace}</span>
                    </Show>
                  </div>
                  <Show when={alert.message}>
                    <div class="alert-item-message">{alert.message}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
