import { Show, For, createSignal, createMemo } from "solid-js";
import {
  rbacAuditResults,
  rbacAuditRunning,
  showRbacAuditPanel,
  setShowRbacAuditPanel,
  runRbacAudit,
} from "../stores/k8s";

export default function RbacAuditPanel() {
  const [filterSeverity, setFilterSeverity] = createSignal<string>("all");
  const [filterCategory, setFilterCategory] = createSignal<string>("all");
  const [expandedIndex, setExpandedIndex] = createSignal<number | null>(null);

  const filteredFindings = createMemo(() => {
    const results = rbacAuditResults();
    if (!results) return [];
    return results.findings.filter((f) => {
      if (filterSeverity() !== "all" && f.severity !== filterSeverity()) return false;
      if (filterCategory() !== "all" && f.category !== filterCategory()) return false;
      return true;
    });
  });

  const scoreColor = createMemo(() => {
    const results = rbacAuditResults();
    if (!results) return "var(--text-muted)";
    const s = results.summary.score;
    if (s >= 80) return "var(--success)";
    if (s >= 50) return "var(--warning)";
    return "var(--danger)";
  });

  const scoreLabel = createMemo(() => {
    const results = rbacAuditResults();
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
      case "wildcard": return "W*";
      case "cluster-admin": return "CA";
      case "escalation": return "PE";
      case "cross-namespace": return "XN";
      case "tenant-isolation": return "TI";
      case "service-account": return "SA";
      default: return "??";
    }
  }

  function categoryLabel(category: string) {
    switch (category) {
      case "wildcard": return "Wildcard Permissions";
      case "cluster-admin": return "Cluster Admin";
      case "escalation": return "Privilege Escalation";
      case "cross-namespace": return "Cross-Namespace";
      case "tenant-isolation": return "Tenant Isolation";
      case "service-account": return "Service Account";
      default: return category;
    }
  }

  return (
    <Show when={showRbacAuditPanel()}>
      <div class="security-panel">
        <div class="security-header">
          <div class="security-header-left">
            <h3>RBAC Audit</h3>
            <span class="badge rebash-badge">Powered by Rebash</span>
          </div>
          <div class="security-header-right">
            <button
              class="action-btn"
              onClick={() => runRbacAudit()}
              disabled={rbacAuditRunning()}
            >
              {rbacAuditRunning() ? "Auditing..." : "Re-audit"}
            </button>
            <button
              class="detail-close"
              onClick={() => setShowRbacAuditPanel(false)}
            >
              x
            </button>
          </div>
        </div>

        <Show when={rbacAuditRunning()}>
          <div class="loading-overlay">
            <span class="spinner" />
            Analyzing RBAC roles, bindings, and access paths...
          </div>
        </Show>

        <Show when={rbacAuditResults() && !rbacAuditRunning()}>
          {/* Score + Summary */}
          <div class="security-summary">
            <div class="security-score" style={{ color: scoreColor() }}>
              <div class="score-number">{rbacAuditResults()!.summary.score}</div>
              <div class="score-label">{scoreLabel()}</div>
            </div>
            <div class="security-stats">
              <div class="stat critical">
                <span class="stat-count">{rbacAuditResults()!.summary.critical}</span>
                <span class="stat-label">Critical</span>
              </div>
              <div class="stat high">
                <span class="stat-count">{rbacAuditResults()!.summary.high}</span>
                <span class="stat-label">High</span>
              </div>
              <div class="stat medium">
                <span class="stat-count">{rbacAuditResults()!.summary.medium}</span>
                <span class="stat-label">Medium</span>
              </div>
              <div class="stat low">
                <span class="stat-count">{rbacAuditResults()!.summary.low}</span>
                <span class="stat-label">Low</span>
              </div>
              <div class="stat scanned">
                <span class="stat-count">{rbacAuditResults()!.summary.total_roles_scanned}</span>
                <span class="stat-label">Roles</span>
              </div>
              <div class="stat scanned">
                <span class="stat-count">{rbacAuditResults()!.summary.total_bindings_scanned}</span>
                <span class="stat-label">Bindings</span>
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
              <option value="wildcard">Wildcard Permissions</option>
              <option value="cluster-admin">Cluster Admin</option>
              <option value="escalation">Privilege Escalation</option>
              <option value="cross-namespace">Cross-Namespace</option>
              <option value="tenant-isolation">Tenant Isolation</option>
              <option value="service-account">Service Account</option>
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
                  <span>No RBAC findings match the current filters</span>
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
                      <span class="finding-category" title={categoryLabel(finding.category)}>
                        {categoryIcon(finding.category)}
                      </span>
                      <span class="finding-title">{finding.title}</span>
                      <span class="finding-resource">
                        {finding.role_name}
                      </span>
                    </div>
                    <Show when={expandedIndex() === idx()}>
                      <div class="finding-detail">
                        <div class="finding-description">{finding.description}</div>
                        <div class="finding-meta">
                          <div><strong>Binding:</strong> {finding.binding_name} ({finding.binding_kind})</div>
                          <div><strong>Role:</strong> {finding.role_name}</div>
                          <Show when={finding.namespace}>
                            <div><strong>Namespace:</strong> {finding.namespace}</div>
                          </Show>
                          <div><strong>Subjects:</strong> {finding.subjects.join(", ")}</div>
                        </div>
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
