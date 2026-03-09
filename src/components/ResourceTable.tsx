import { createSignal, createMemo, For, Show } from "solid-js";
import {
  resources,
  loading,
  activeResourceKind,
  selectedResource,
  setSelectedResource,
  K8sResource,
  resourceMetrics,
  pvcMetrics,
} from "../stores/k8s";
import { searchQuery } from "../stores/k8s";

export default function ResourceTable() {
  const [sortColumn, setSortColumn] = createSignal<string>("");
  const [sortDir, setSortDir] = createSignal<"asc" | "desc">("asc");

  function toggleSort(col: string) {
    if (sortColumn() === col) {
      setSortDir(sortDir() === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(col);
      setSortDir("asc");
    }
  }

  function sortIndicator(col: string): string {
    if (sortColumn() !== col) return "";
    return sortDir() === "asc" ? " ▲" : " ▼";
  }

  const filteredResources = createMemo(() => {
    const query = searchQuery().toLowerCase();
    const all = resources();
    if (!query) return all;
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        (r.namespace && r.namespace.toLowerCase().includes(query)) ||
        (r.status && r.status.toLowerCase().includes(query))
    );
  });

  // Parse age string to seconds for sorting (e.g., "3d", "5h", "10m", "30s")
  function parseAge(age: string): number {
    if (!age || age === "-") return Infinity;
    let total = 0;
    const parts = age.match(/(\d+)([dhms])/g);
    if (!parts) return Infinity;
    for (const p of parts) {
      const m = p.match(/(\d+)([dhms])/);
      if (!m) continue;
      const val = parseInt(m[1]);
      switch (m[2]) {
        case "d": total += val * 86400; break;
        case "h": total += val * 3600; break;
        case "m": total += val * 60; break;
        case "s": total += val; break;
      }
    }
    return total;
  }

  const sortedResources = createMemo(() => {
    const col = sortColumn();
    const dir = sortDir();
    const list = [...filteredResources()];
    if (!col) return list;

    const metrics = resourceMetrics();
    const pvcs = pvcMetrics();

    list.sort((a, b) => {
      let cmp = 0;
      switch (col) {
        case "name": cmp = a.name.localeCompare(b.name); break;
        case "namespace": cmp = (a.namespace || "").localeCompare(b.namespace || ""); break;
        case "status": cmp = (a.status || "").localeCompare(b.status || ""); break;
        case "age": cmp = parseAge(a.age || "") - parseAge(b.age || ""); break;
        case "ready": cmp = getReady(a).localeCompare(getReady(b)); break;
        case "restarts": cmp = getRestarts(a) - getRestarts(b); break;
        case "ip": cmp = getPodIP(a).localeCompare(getPodIP(b)); break;
        case "node": cmp = getNodeName(a).localeCompare(getNodeName(b)); break;
        case "roles": cmp = getNodeRoles(a).localeCompare(getNodeRoles(b)); break;
        case "version": cmp = getNodeVersion(a).localeCompare(getNodeVersion(b)); break;
        case "cpu": {
          const ma = metrics[metricsKey(a)];
          const mb = metrics[metricsKey(b)];
          cmp = (ma?.cpu_percent ?? -1) - (mb?.cpu_percent ?? -1);
          break;
        }
        case "mem": {
          const ma = metrics[metricsKey(a)];
          const mb = metrics[metricsKey(b)];
          cmp = (ma?.memory_percent ?? -1) - (mb?.memory_percent ?? -1);
          break;
        }
        case "pvc_used_pct": {
          const pa = pvcs[pvcKey(a)];
          const pb = pvcs[pvcKey(b)];
          cmp = (pa?.used_percent ?? -1) - (pb?.used_percent ?? -1);
          break;
        }
        default: cmp = 0;
      }
      return dir === "asc" ? cmp : -cmp;
    });
    return list;
  });

  const isPods = () => activeResourceKind() === "pods";
  const isNodes = () => activeResourceKind() === "nodes";
  const isPvcs = () => activeResourceKind() === "persistentvolumeclaims";
  const isPvs = () => activeResourceKind() === "persistentvolumes";
  const showNamespace = () => !isNodes() && !isPvs();
  const showMetrics = () => isPods() || isNodes();

  function metricsKey(r: K8sResource): string {
    if (r.kind === "Node") return r.name;
    return `${r.namespace || "default"}/${r.name}`;
  }

  // Extract pod-specific fields from extra
  function getReady(r: K8sResource): string {
    const statuses = r.extra?.status?.containerStatuses;
    if (!Array.isArray(statuses) || statuses.length === 0) return "-";
    const ready = statuses.filter((c: any) => c.ready).length;
    return `${ready}/${statuses.length}`;
  }

  function getRestarts(r: K8sResource): number {
    const statuses = r.extra?.status?.containerStatuses;
    if (!Array.isArray(statuses)) return 0;
    return statuses.reduce((sum: number, c: any) => sum + (c.restartCount || 0), 0);
  }

  function getPodIP(r: K8sResource): string {
    return r.extra?.status?.podIP || "-";
  }

  function getNodeName(r: K8sResource): string {
    return r.extra?.spec?.nodeName || "-";
  }

  // Extract node-specific fields from extra
  function getNodeRoles(r: K8sResource): string {
    const labels = r.labels || {};
    const roles: string[] = [];
    for (const key of Object.keys(labels)) {
      if (key.startsWith("node-role.kubernetes.io/")) {
        roles.push(key.replace("node-role.kubernetes.io/", ""));
      }
    }
    return roles.length > 0 ? roles.join(",") : "<none>";
  }

  function getNodeVersion(r: K8sResource): string {
    return r.extra?.status?.nodeInfo?.kubeletVersion || "-";
  }

  // PVC helpers
  function getPvcCapacity(r: K8sResource): string {
    return r.extra?.status?.capacity?.storage || r.extra?.spec?.resources?.requests?.storage || "-";
  }

  function getPvcAccessModes(r: K8sResource): string {
    const modes: string[] = r.extra?.spec?.accessModes || [];
    return modes.map((m: string) => m.replace("ReadWrite", "RW").replace("ReadOnly", "RO").replace("Once", "O").replace("Many", "M")).join(",") || "-";
  }

  function getPvcStorageClass(r: K8sResource): string {
    return r.extra?.spec?.storageClassName || "-";
  }

  function getPvcVolumeName(r: K8sResource): string {
    return r.extra?.spec?.volumeName || "-";
  }

  function pvcKey(r: K8sResource): string {
    return `${r.namespace || "default"}/${r.name}`;
  }

  // PV helpers (like k9s)
  function getPvCapacity(r: K8sResource): string {
    return r.extra?.spec?.capacity?.storage || "-";
  }

  function getPvAccessModes(r: K8sResource): string {
    const modes: string[] = r.extra?.spec?.accessModes || [];
    return modes.map((m: string) =>
      m === "ReadWriteOnce" ? "RWO" :
      m === "ReadOnlyMany" ? "ROX" :
      m === "ReadWriteMany" ? "RWX" :
      m === "ReadWriteOncePod" ? "RWOP" : m
    ).join(",") || "-";
  }

  function getPvReclaimPolicy(r: K8sResource): string {
    return r.extra?.spec?.persistentVolumeReclaimPolicy || "-";
  }

  function getPvClaim(r: K8sResource): string {
    const ref = r.extra?.spec?.claimRef;
    if (!ref) return "-";
    return `${ref.namespace || ""}/${ref.name || ""}`;
  }

  function getPvStorageClass(r: K8sResource): string {
    return r.extra?.spec?.storageClassName || "-";
  }

  function getPvVolumeMode(r: K8sResource): string {
    return r.extra?.spec?.volumeMode || "Filesystem";
  }

  function getPvReason(r: K8sResource): string {
    return r.extra?.status?.reason || "-";
  }

  function statusClass(status: string | null): string {
    if (!status) return "";
    const s = status.toLowerCase().replace(/\s/g, "");
    if (["running", "active", "bound"].includes(s)) return "status-running";
    if (s === "ready") return "status-ready";
    if (["pending", "containercreating", "terminating"].includes(s)) return "status-pending";
    if (["failed", "error", "crashloopbackoff", "imagepullbackoff", "notready"].includes(s))
      return "status-failed";
    if (["succeeded", "completed"].includes(s)) return "status-succeeded";
    if (/^\d+\/\d+$/.test(s)) {
      const [ready, total] = s.split("/").map(Number);
      if (ready === total) return "status-running";
      if (ready === 0) return "status-failed";
      return "status-pending";
    }
    return "";
  }

  // Color for utilization percentage numbers
  function pctColor(pct: number | undefined): string {
    if (pct === undefined) return "var(--text-muted)";
    if (pct > 90) return "var(--danger)";
    if (pct > 70) return "var(--warning)";
    if (pct > 50) return "var(--accent)";
    return "var(--success)";
  }

  function fmtPct(pct: number | undefined): string {
    if (pct === undefined) return "-";
    return `${pct.toFixed(0)}%`;
  }

  function handleRowClick(resource: K8sResource) {
    if (selectedResource()?.name === resource.name && selectedResource()?.namespace === resource.namespace) {
      setSelectedResource(null);
    } else {
      setSelectedResource(resource);
    }
  }

  function handleKeyDown(e: KeyboardEvent, resource: K8sResource, index: number) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleRowClick(resource);
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = document.querySelector(`[data-row-index="${index + 1}"]`) as HTMLElement;
      next?.focus();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = document.querySelector(`[data-row-index="${index - 1}"]`) as HTMLElement;
      prev?.focus();
    }
  }

  return (
    <div class="content">
      <Show when={loading()}>
        <div class="loading-overlay">
          <span class="spinner" />
          Loading resources...
        </div>
      </Show>

      <Show when={!loading() && filteredResources().length === 0}>
        <div class="empty-state">
          <span class="icon">∅</span>
          <p>No resources found</p>
        </div>
      </Show>

      <Show when={!loading() && filteredResources().length > 0}>
        <div class="resource-count">
          {filteredResources().length} resource{filteredResources().length !== 1 ? "s" : ""}
        </div>
        <table class="resource-table">
          <thead>
            <tr>
              <th class="sortable" onClick={() => toggleSort("name")}>Name{sortIndicator("name")}</th>
              <Show when={showNamespace()}>
                <th class="sortable" onClick={() => toggleSort("namespace")}>Namespace{sortIndicator("namespace")}</th>
              </Show>
              <Show when={isPods()}>
                <th class="sortable" onClick={() => toggleSort("ready")}>Ready{sortIndicator("ready")}</th>
              </Show>
              <th class="sortable" onClick={() => toggleSort("status")}>Status{sortIndicator("status")}</th>
              <Show when={isPods()}>
                <th class="sortable" onClick={() => toggleSort("restarts")}>Restarts{sortIndicator("restarts")}</th>
              </Show>
              <Show when={showMetrics()}>
                <th class="sortable" onClick={() => toggleSort("cpu")}>CPU{sortIndicator("cpu")}</th>
                <th class="sortable" onClick={() => toggleSort("mem")}>MEM{sortIndicator("mem")}</th>
                <Show when={isPods()}>
                  <th>%CPU/R</th>
                  <th>%CPU/L</th>
                  <th>%MEM/R</th>
                  <th>%MEM/L</th>
                </Show>
                <Show when={isNodes()}>
                  <th>%CPU</th>
                  <th>%MEM</th>
                </Show>
              </Show>
              <Show when={isPods()}>
                <th class="sortable" onClick={() => toggleSort("ip")}>IP{sortIndicator("ip")}</th>
                <th class="sortable" onClick={() => toggleSort("node")}>Node{sortIndicator("node")}</th>
              </Show>
              <Show when={isNodes()}>
                <th class="sortable" onClick={() => toggleSort("roles")}>Roles{sortIndicator("roles")}</th>
                <th class="sortable" onClick={() => toggleSort("version")}>Version{sortIndicator("version")}</th>
              </Show>
              <Show when={isPvs()}>
                <th>Capacity</th>
                <th>Access Modes</th>
                <th>Reclaim Policy</th>
                <th>Claim</th>
                <th>StorageClass</th>
                <th>Volume Mode</th>
                <th>Reason</th>
              </Show>
              <Show when={isPvcs()}>
                <th>Capacity</th>
                <th>Used</th>
                <th>Available</th>
                <th class="sortable" onClick={() => toggleSort("pvc_used_pct")}>%Used{sortIndicator("pvc_used_pct")}</th>
                <th>Access Modes</th>
                <th>StorageClass</th>
                <th>Volume</th>
                <th>Pod</th>
              </Show>
              <th class="sortable" onClick={() => toggleSort("age")}>Age{sortIndicator("age")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={sortedResources()}>
              {(resource, index) => {
                const m = () => resourceMetrics()[metricsKey(resource)];
                return (
                  <tr
                    class={selectedResource()?.name === resource.name && selectedResource()?.namespace === resource.namespace ? "selected" : ""}
                    onClick={() => handleRowClick(resource)}
                    onKeyDown={(e) => handleKeyDown(e, resource, index())}
                    tabIndex={0}
                    data-row-index={index()}
                  >
                    <td>{resource.name}</td>
                    <Show when={showNamespace()}>
                      <td style={{ color: "var(--text-secondary)" }}>
                        {resource.namespace || "-"}
                      </td>
                    </Show>
                    <Show when={isPods()}>
                      <td>
                        <span class={`status ${statusClass(getReady(resource))}`}>
                          {getReady(resource)}
                        </span>
                      </td>
                    </Show>
                    <td>
                      <span class={`status ${statusClass(resource.status)}`}>
                        <span class="status-dot" />
                        {resource.status || "-"}
                      </span>
                    </td>
                    <Show when={isPods()}>
                      <td style={{ color: getRestarts(resource) > 0 ? "var(--warning)" : "var(--text-secondary)" }}>
                        {getRestarts(resource)}
                      </td>
                    </Show>
                    <Show when={showMetrics()}>
                      <td class="metrics-cell">
                        {m() ? m()!.cpu : "-"}
                      </td>
                      <td class="metrics-cell">
                        {m() ? m()!.memory : "-"}
                      </td>
                      <Show when={isPods()}>
                        <td class="metrics-cell">
                          <span style={{ color: pctColor(m()?.cpu_percent), "font-weight": "600" }}>
                            {fmtPct(m()?.cpu_percent)}
                          </span>
                        </td>
                        <td class="metrics-cell">
                          <span style={{ color: pctColor(m()?.cpu_limit_percent), "font-weight": "600" }}>
                            {fmtPct(m()?.cpu_limit_percent)}
                          </span>
                        </td>
                        <td class="metrics-cell">
                          <span style={{ color: pctColor(m()?.memory_percent), "font-weight": "600" }}>
                            {fmtPct(m()?.memory_percent)}
                          </span>
                        </td>
                        <td class="metrics-cell">
                          <span style={{ color: pctColor(m()?.memory_limit_percent), "font-weight": "600" }}>
                            {fmtPct(m()?.memory_limit_percent)}
                          </span>
                        </td>
                      </Show>
                      <Show when={isNodes()}>
                        <td class="metrics-cell">
                          <span style={{ color: pctColor(m()?.cpu_percent), "font-weight": "600" }}>
                            {fmtPct(m()?.cpu_percent)}
                          </span>
                        </td>
                        <td class="metrics-cell">
                          <span style={{ color: pctColor(m()?.memory_percent), "font-weight": "600" }}>
                            {fmtPct(m()?.memory_percent)}
                          </span>
                        </td>
                      </Show>
                    </Show>
                    <Show when={isPods()}>
                      <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>
                        {getPodIP(resource)}
                      </td>
                      <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>
                        {getNodeName(resource)}
                      </td>
                    </Show>
                    <Show when={isNodes()}>
                      <td style={{ color: "var(--text-secondary)" }}>
                        {getNodeRoles(resource)}
                      </td>
                      <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>
                        {getNodeVersion(resource)}
                      </td>
                    </Show>
                    <Show when={isPvs()}>
                      <td class="metrics-cell">{getPvCapacity(resource)}</td>
                      <td style={{ "font-size": "11px", color: "var(--text-secondary)" }}>{getPvAccessModes(resource)}</td>
                      <td style={{ "font-size": "11px", color: "var(--text-secondary)" }}>{getPvReclaimPolicy(resource)}</td>
                      <td style={{ "font-size": "11px", color: "var(--text-secondary)", "max-width": "200px", overflow: "hidden", "text-overflow": "ellipsis" }}>{getPvClaim(resource)}</td>
                      <td style={{ "font-size": "11px", color: "var(--text-secondary)" }}>{getPvStorageClass(resource)}</td>
                      <td style={{ "font-size": "11px", color: "var(--text-secondary)" }}>{getPvVolumeMode(resource)}</td>
                      <td style={{ "font-size": "11px", color: "var(--text-muted)" }}>{getPvReason(resource)}</td>
                    </Show>
                    <Show when={isPvcs()}>
                      {(() => {
                        const pm = pvcMetrics()[pvcKey(resource)];
                        return (
                          <>
                            <td class="metrics-cell">{pm?.capacity || getPvcCapacity(resource)}</td>
                            <td class="metrics-cell">{pm?.used_formatted || "-"}</td>
                            <td class="metrics-cell">{pm?.available_formatted || "-"}</td>
                            <td class="metrics-cell">
                              <span style={{ color: pctColor(pm?.used_percent ?? undefined), "font-weight": "600" }}>
                                {pm?.used_percent != null ? `${pm.used_percent.toFixed(0)}%` : "-"}
                              </span>
                            </td>
                            <td style={{ "font-size": "11px", color: "var(--text-secondary)" }}>
                              {getPvcAccessModes(resource)}
                            </td>
                            <td style={{ "font-size": "11px", color: "var(--text-secondary)" }}>
                              {getPvcStorageClass(resource)}
                            </td>
                            <td style={{ "font-size": "11px", color: "var(--text-secondary)", "max-width": "150px", overflow: "hidden", "text-overflow": "ellipsis" }}>
                              {getPvcVolumeName(resource)}
                            </td>
                            <td style={{ "font-size": "11px", color: "var(--text-secondary)" }}>
                              {pm?.pod_name || "-"}
                            </td>
                          </>
                        );
                      })()}
                    </Show>
                    <td style={{ color: "var(--text-secondary)" }}>
                      {resource.age || "-"}
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
