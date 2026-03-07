import { Show, For, createSignal, createMemo } from "solid-js";
import {
  securityResults,
  securityScanning,
  showSecurityPanel,
  setShowSecurityPanel,
  runSecurityScan,
  type SecurityFinding,
} from "../stores/k8s";

export default function SecurityPanel() {
  const [filterSeverity, setFilterSeverity] = createSignal<string>("all");
  const [filterCategory, setFilterCategory] = createSignal<string>("all");
  const [expandedIndex, setExpandedIndex] = createSignal<number | null>(null);

  const filteredFindings = createMemo(() => {
    const results = securityResults();
    if (!results) return [];
    return results.findings.filter((f) => {
      if (filterSeverity() !== "all" && f.severity !== filterSeverity()) return false;
      if (filterCategory() !== "all" && f.category !== filterCategory()) return false;
      return true;
    });
  });

  const scoreColor = createMemo(() => {
    const results = securityResults();
    if (!results) return "var(--text-muted)";
    const s = results.summary.score;
    if (s >= 80) return "var(--success)";
    if (s >= 50) return "var(--warning)";
    return "var(--danger)";
  });

  const scoreLabel = createMemo(() => {
    const results = securityResults();
    if (!results) return "";
    const s = results.summary.score;
    if (s >= 80) return "Good";
    if (s >= 50) return "Fair";
    if (s >= 20) return "Poor";
    return "Critical";
  });

  function severityIcon(severity: string) {
    switch (severity) {
      case "critical": return "!!";
      case "high": return "!";
      case "medium": return "~";
      case "low": return "-";
      default: return "?";
    }
  }

  function categoryIcon(category: string) {
    switch (category) {
      case "privilege": return "KEY";
      case "resource": return "CPU";
      case "network": return "NET";
      case "image": return "IMG";
      case "config": return "CFG";
      default: return "???";
    }
  }

  return (
    <Show when={showSecurityPanel()}>
      <div class="security-panel">
        <div class="security-header">
          <div class="security-header-left">
            <h3>Security Scan</h3>
            <span class="badge rebash-badge">Powered by Rebash</span>
          </div>
          <div class="security-header-right">
            <button
              class="action-btn"
              onClick={() => runSecurityScan()}
              disabled={securityScanning()}
            >
              {securityScanning() ? "Scanning..." : "Re-scan"}
            </button>
            <button
              class="detail-close"
              onClick={() => setShowSecurityPanel(false)}
            >
              x
            </button>
          </div>
        </div>

        <Show when={securityScanning()}>
          <div class="loading-overlay">
            <span class="spinner" />
            Scanning for misconfigurations...
          </div>
        </Show>

        <Show when={securityResults() && !securityScanning()}>
          {/* Score + Summary */}
          <div class="security-summary">
            <div class="security-score" style={{ color: scoreColor() }}>
              <div class="score-number">{securityResults()!.summary.score}</div>
              <div class="score-label">{scoreLabel()}</div>
            </div>
            <div class="security-stats">
              <div class="stat critical">
                <span class="stat-count">{securityResults()!.summary.critical}</span>
                <span class="stat-label">Critical</span>
              </div>
              <div class="stat high">
                <span class="stat-count">{securityResults()!.summary.high}</span>
                <span class="stat-label">High</span>
              </div>
              <div class="stat medium">
                <span class="stat-count">{securityResults()!.summary.medium}</span>
                <span class="stat-label">Medium</span>
              </div>
              <div class="stat low">
                <span class="stat-count">{securityResults()!.summary.low}</span>
                <span class="stat-label">Low</span>
              </div>
              <div class="stat scanned">
                <span class="stat-count">{securityResults()!.summary.total_resources_scanned}</span>
                <span class="stat-label">Scanned</span>
              </div>
            </div>
          </div>

          {/* Filters */}
          <div class="security-filters">
            <select
              value={filterSeverity()}
              onChange={(e) => setFilterSeverity(e.currentTarget.value)}
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <select
              value={filterCategory()}
              onChange={(e) => setFilterCategory(e.currentTarget.value)}
            >
              <option value="all">All Categories</option>
              <option value="privilege">Privilege</option>
              <option value="resource">Resource</option>
              <option value="network">Network</option>
              <option value="image">Image</option>
              <option value="config">Config</option>
            </select>
            <span class="findings-count">
              {filteredFindings().length} finding{filteredFindings().length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Findings List */}
          <div class="security-findings">
            <Show
              when={filteredFindings().length > 0}
              fallback={
                <div class="empty-state">
                  <span class="icon">OK</span>
                  <span>No findings match the current filters</span>
                </div>
              }
            >
              <For each={filteredFindings()}>
                {(finding, idx) => (
                  <div
                    class={`finding-item severity-${finding.severity}`}
                    onClick={() =>
                      setExpandedIndex(expandedIndex() === idx() ? null : idx())
                    }
                  >
                    <div class="finding-row">
                      <span class={`severity-badge ${finding.severity}`}>
                        {severityIcon(finding.severity)}
                      </span>
                      <span class="finding-category">{categoryIcon(finding.category)}</span>
                      <span class="finding-title">{finding.title}</span>
                      <span class="finding-resource">
                        {finding.namespace}/{finding.resource_name}
                      </span>
                    </div>
                    <Show when={expandedIndex() === idx()}>
                      <div class="finding-detail">
                        <div class="finding-description">{finding.description}</div>
                        <div class="finding-remediation">
                          <strong>Fix:</strong> {finding.remediation}
                        </div>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}
