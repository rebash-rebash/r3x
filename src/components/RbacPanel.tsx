import { createSignal, Show, For, createMemo } from "solid-js";
import {
  rbacBindings,
  showRbacPanel,
  setShowRbacPanel,
  rbacLoading,
  loadRbac,
} from "../stores/k8s";

export default function RbacPanel() {
  const [filterKind, setFilterKind] = createSignal("all");
  const [searchQuery, setSearchQuery] = createSignal("");

  const filtered = createMemo(() => {
    let list = rbacBindings();
    const kind = filterKind();
    if (kind !== "all") {
      list = list.filter((b) => b.kind === kind);
    }
    const q = searchQuery().toLowerCase();
    if (q) {
      list = list.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          b.role_name.toLowerCase().includes(q) ||
          b.subjects.some((s) => s.name.toLowerCase().includes(q))
      );
    }
    return list;
  });

  return (
    <Show when={showRbacPanel()}>
      <div class="view-panel">
        <div class="view-panel-header">
          <h2>RBAC Bindings</h2>
          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <select
              value={filterKind()}
              onChange={(e) => setFilterKind(e.currentTarget.value)}
              style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border)", color: "var(--text-primary)", padding: "4px 8px", "border-radius": "4px", "font-size": "11px" }}
            >
              <option value="all">All Types</option>
              <option value="ClusterRoleBinding">ClusterRoleBinding</option>
              <option value="RoleBinding">RoleBinding</option>
            </select>
            <input
              type="text"
              placeholder="Search bindings, roles, subjects..."
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border)", color: "var(--text-primary)", padding: "4px 8px", "border-radius": "4px", "font-size": "11px", width: "250px" }}
            />
            <span class="badge">{filtered().length} bindings</span>
            <button class="action-btn" onClick={() => loadRbac()} disabled={rbacLoading()}>
              {rbacLoading() ? "Loading..." : "Refresh"}
            </button>
            <button class="action-btn" onClick={() => setShowRbacPanel(false)}>Close</button>
          </div>
        </div>
        <div class="view-panel-content">
          <Show when={rbacLoading()}>
            <div class="loading-overlay">
              <span class="spinner" />
              Loading RBAC bindings...
            </div>
          </Show>
          <Show when={!rbacLoading()}>
            <Show when={filtered().length === 0}>
              <div class="empty-state">
                <p>No RBAC bindings found</p>
              </div>
            </Show>
            <Show when={filtered().length > 0}>
              <table class="resource-table">
                <thead>
                  <tr>
                    <th>Binding</th>
                    <th>Type</th>
                    <th>Namespace</th>
                    <th>Role</th>
                    <th>Subjects</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={filtered()}>
                    {(binding) => (
                      <tr>
                        <td>{binding.name}</td>
                        <td>
                          <span class="finding-category">
                            {binding.kind === "ClusterRoleBinding" ? "CRB" : "RB"}
                          </span>
                        </td>
                        <td style={{ color: "var(--text-secondary)" }}>
                          {binding.namespace || "-"}
                        </td>
                        <td>
                          <span style={{ color: "var(--accent)" }}>{binding.role_kind}:</span>{" "}
                          {binding.role_name}
                        </td>
                        <td style={{ "max-width": "300px" }}>
                          <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
                            <For each={binding.subjects}>
                              {(subj) => (
                                <span class="rbac-subject-tag">
                                  <span class="rbac-kind">{subj.kind[0]}</span>
                                  {subj.name}
                                  <Show when={subj.namespace}>
                                    <span style={{ color: "var(--text-muted)", "font-size": "10px" }}>
                                      ({subj.namespace})
                                    </span>
                                  </Show>
                                </span>
                              )}
                            </For>
                          </div>
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
