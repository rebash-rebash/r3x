import { createSignal, createEffect, Show, For, onCleanup } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  selectedResource,
  setSelectedResource,
  getResourceYaml,
  getPodLogs,
  getPodContainers,
  activeResourceKind,
  activeContext,
  deleteResource,
  activeNamespace,
  loadResources,
  scaleResource,
  streamPodLogs,
  rolloutRestart,
  ContainerMetricsInfo,
  PodMetricsInfo,
  K8sResource,
  getResourcePods,
  NodeInfo,
  getNodeDetails,
  K8sEvent,
} from "../stores/k8s";
import Terminal from "./Terminal";

type DetailTab = "yaml" | "containers" | "pods" | "logs" | "labels" | "exec" | "describe" | "events" | "benchmark";

export default function DetailPanel() {
  const [activeTab, setActiveTab] = createSignal<DetailTab>("yaml");
  const [yaml, setYaml] = createSignal("");
  const [logs, setLogs] = createSignal<string[]>([]);
  const [containers, setContainers] = createSignal<string[]>([]);
  const [selectedContainer, setSelectedContainer] = createSignal<string>("");
  const [logFilter, setLogFilter] = createSignal("");
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [replicaCount, setReplicaCount] = createSignal<number>(0);
  const [scaling, setScaling] = createSignal(false);
  const [restarting, setRestarting] = createSignal(false);
  const [streaming, setStreaming] = createSignal(false);
  const [execTabs, setExecTabs] = createSignal<number[]>([1]);
  const [activeExecTab, setActiveExecTab] = createSignal(1);
  const [editing, setEditing] = createSignal(false);
  const [editYaml, setEditYaml] = createSignal("");
  const [applyError, setApplyError] = createSignal("");
  const [applying, setApplying] = createSignal(false);
  const [containerMetrics, setContainerMetrics] = createSignal<Record<string, ContainerMetricsInfo>>({});
  const [resourcePods, setResourcePods] = createSignal<K8sResource[]>([]);
  const [podMetricsMap, setPodMetricsMap] = createSignal<Record<string, PodMetricsInfo>>({});
  const [parentResource, setParentResource] = createSignal<K8sResource | null>(null);
  const [nodeInfo, setNodeInfo] = createSignal<NodeInfo | null>(null);
  const [nodeAction, setNodeAction] = createSignal("");
  const [confirmDrain, setConfirmDrain] = createSignal(false);
  const [resourceEvents, setResourceEvents] = createSignal<K8sEvent[]>([]);
  const [eventsLoading, setEventsLoading] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [benchmarkResult, setBenchmarkResult] = createSignal<any>(null);
  const [benchmarking, setBenchmarking] = createSignal(false);
  const [benchmarkProgress, setBenchmarkProgress] = createSignal<{ sample: number; total: number } | null>(null);
  const [benchmarkDuration, setBenchmarkDuration] = createSignal(60);
  const [benchmarkInterval, setBenchmarkInterval] = createSignal(5);
  let execTabCounter = 1;
  let unlistenStream: (() => void) | null = null;

  const resource = () => selectedResource();
  const isPod = () => resource()?.kind === "Pod";
  const isWorkload = () => {
    const k = resource()?.kind;
    return k === "Deployment" || k === "StatefulSet" || k === "DaemonSet" || k === "ReplicaSet";
  };
  const isNode = () => resource()?.kind === "Node";
  const isRestartable = () => {
    const k = resource()?.kind;
    return k === "Deployment" || k === "StatefulSet" || k === "DaemonSet";
  };
  const isScalable = () => {
    const k = resource()?.kind;
    return k === "Deployment" || k === "StatefulSet";
  };

  createEffect(async () => {
    const res = resource();
    if (!res) return;

    setDetailLoading(true);
    setResourcePods([]);
    const workloadKinds = ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"];
    setActiveTab(res.kind === "Pod" ? "containers" : workloadKinds.includes(res.kind) ? "pods" : res.kind === "Node" ? "describe" : "yaml");
    setNodeInfo(null);
    setNodeAction("");
    setConfirmDrain(false);
    setYaml("");
    setLogs([]);
    setEditing(false);
    setApplyError("");
    setConfirmDelete(false);
    setStreaming(false);
    setExecTabs([1]);
    setActiveExecTab(1);
    execTabCounter = 1;
    if (unlistenStream) { unlistenStream(); unlistenStream = null; }

    try {
      const y = await getResourceYaml(
        res.namespace || "default",
        res.kind,
        res.name
      );
      setYaml(y);

      // Extract replica count for scalable resources
      if (isScalable()) {
        const match = y.match(/replicas:\s*(\d+)/);
        if (match) setReplicaCount(parseInt(match[1]));
      }
    } catch (e: any) {
      setYaml(`# Error loading YAML:\n# ${e}`);
    }

    if (isPod()) {
      try {
        const c = await getPodContainers(res.namespace || "default", res.name);
        setContainers(c);
        if (c.length > 0) setSelectedContainer(c[0]);
      } catch {
        setContainers([]);
      }
      // Fetch per-container metrics
      const ctx = activeContext();
      if (ctx) {
        invoke<PodMetricsInfo[]>("get_pod_metrics", {
          context: ctx,
          namespace: res.namespace || "default",
        })
          .then((metrics) => {
            const podM = metrics.find((m) => m.name === res.name);
            if (podM) {
              const map: Record<string, ContainerMetricsInfo> = {};
              for (const cm of podM.containers) {
                map[cm.name] = cm;
              }
              setContainerMetrics(map);
            }
          })
          .catch(() => {});
      }
    }

    // Fetch pods for workload resources
    if (isWorkload()) {
      try {
        const pods = await getResourcePods(res.namespace || "default", res.kind, res.name);
        setResourcePods(pods);
      } catch {
        setResourcePods([]);
      }
      // Fetch pod metrics for workload pods
      const ctx = activeContext();
      if (ctx) {
        invoke<PodMetricsInfo[]>("get_pod_metrics", {
          context: ctx,
          namespace: res.namespace || "default",
        })
          .then((metrics) => {
            const map: Record<string, PodMetricsInfo> = {};
            for (const m of metrics) {
              map[m.name] = m;
            }
            setPodMetricsMap(map);
          })
          .catch(() => {});
      }
    }

    // Fetch node details
    if (isNode()) {
      try {
        const info = await getNodeDetails(res.name);
        setNodeInfo(info);
      } catch {
        setNodeInfo(null);
      }
    }

    setDetailLoading(false);
  });

  async function handleCordon() {
    const res = resource();
    const ctx = activeContext();
    if (!res || !ctx) return;
    setNodeAction("cordoning");
    try {
      await invoke<string>("cordon_node", { context: ctx, name: res.name });
      const info = await getNodeDetails(res.name);
      setNodeInfo(info);
      loadResources();
    } catch (e: any) {
      alert(`Cordon failed: ${e}`);
    }
    setNodeAction("");
  }

  async function handleUncordon() {
    const res = resource();
    const ctx = activeContext();
    if (!res || !ctx) return;
    setNodeAction("uncordoning");
    try {
      await invoke<string>("uncordon_node", { context: ctx, name: res.name });
      const info = await getNodeDetails(res.name);
      setNodeInfo(info);
      loadResources();
    } catch (e: any) {
      alert(`Uncordon failed: ${e}`);
    }
    setNodeAction("");
  }

  async function handleDrain() {
    const res = resource();
    const ctx = activeContext();
    if (!res || !ctx) return;
    setNodeAction("draining");
    try {
      const result = await invoke<string>("drain_node", {
        context: ctx,
        name: res.name,
        ignoreDaemonsets: true,
      });
      alert(result);
      const info = await getNodeDetails(res.name);
      setNodeInfo(info);
      loadResources();
    } catch (e: any) {
      alert(`Drain failed: ${e}`);
    }
    setNodeAction("");
    setConfirmDrain(false);
  }

  async function loadResourceEvents() {
    const res = resource();
    const ctx = activeContext();
    if (!res || !ctx) return;
    setEventsLoading(true);
    try {
      const allEvents = await invoke<K8sEvent[]>("list_events", {
        context: ctx,
        namespace: res.namespace || "_all",
      });
      // Filter events related to this resource
      const filtered = allEvents.filter(
        (ev) => ev.name === res.name && ev.kind === res.kind
      );
      setResourceEvents(filtered);
    } catch {
      setResourceEvents([]);
    }
    setEventsLoading(false);
  }

  async function loadLogs() {
    const res = resource();
    if (!res || !isPod()) return;

    setDetailLoading(true);
    try {
      const l = await getPodLogs(
        res.namespace || "default",
        res.name,
        selectedContainer() || undefined,
        200
      );
      setLogs(l);
    } catch (e: any) {
      setLogs([`[ERROR] ${e}`]);
    }
    setDetailLoading(false);
  }

  createEffect(() => {
    if (activeTab() === "logs" && isPod()) {
      loadLogs();
    }
    if (activeTab() === "events") {
      loadResourceEvents();
    }
  });

  const filteredLogs = () => {
    const filter = logFilter().toLowerCase();
    if (!filter) return logs();
    return logs().filter((l) => l.toLowerCase().includes(filter));
  };

  async function handleScale(newReplicas: number) {
    const res = resource();
    if (!res || !isScalable()) return;
    setScaling(true);
    try {
      await scaleResource(res.namespace || "default", res.kind, res.name, newReplicas);
      setReplicaCount(newReplicas);
      loadResources();
    } catch (e: any) {
      alert(`Scale failed: ${e}`);
    }
    setScaling(false);
  }

  function exportLogs() {
    const res = resource();
    const logLines = filteredLogs();
    if (!res || logLines.length === 0) return;
    const content = logLines.join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${res.name}-${selectedContainer() || "all"}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function toggleStreaming() {
    const res = resource();
    if (!res || !isPod()) return;

    if (streaming()) {
      if (unlistenStream) { unlistenStream(); unlistenStream = null; }
      setStreaming(false);
      return;
    }

    try {
      const eventName = await streamPodLogs(
        res.namespace || "default",
        res.name,
        selectedContainer() || undefined
      );
      const unlisten = await listen<string>(eventName, (event) => {
        setLogs((prev) => [...prev.slice(-500), event.payload]);
      });
      unlistenStream = unlisten;
      setStreaming(true);
    } catch (e: any) {
      setLogs((prev) => [...prev, `[ERROR] ${e}`]);
    }
  }

  async function handleApply() {
    const ctx = activeContext();
    if (!ctx) return;
    setApplying(true);
    setApplyError("");
    try {
      await invoke<string>("apply_resource_yaml", {
        context: ctx,
        yamlContent: editYaml(),
      });
      setEditing(false);
      // Reload YAML to reflect changes
      const res = resource();
      if (res) {
        const y = await getResourceYaml(res.namespace || "default", res.kind, res.name);
        setYaml(y);
      }
      loadResources();
    } catch (e: any) {
      setApplyError(String(e));
    }
    setApplying(false);
  }

  async function handleDelete() {
    const res = resource();
    if (!res) return;
    try {
      await deleteResource(res.namespace || "default", res.kind, res.name);
      setSelectedResource(null);
      loadResources();
    } catch (e: any) {
      alert(`Delete failed: ${e}`);
    }
  }

  // Keyboard shortcuts for node operations
  function handleKeyboardShortcut(e: KeyboardEvent) {
    // Don't trigger if typing in an input/textarea
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!resource()) return;

    if (isNode()) {
      if (e.key === "c" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); handleCordon(); }
      if (e.key === "u" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); handleUncordon(); }
      if (e.key === "r" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setConfirmDrain(true); }
      if (e.key === "d" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setActiveTab("describe"); }
      if (e.key === "y" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setActiveTab("yaml"); }
      if (e.key === "e" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setActiveTab("yaml");
        setEditYaml(yaml());
        setApplyError("");
        setEditing(true);
      }
    }
  }

  createEffect(() => {
    if (resource()) {
      document.addEventListener("keydown", handleKeyboardShortcut);
    } else {
      document.removeEventListener("keydown", handleKeyboardShortcut);
    }
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyboardShortcut);
  });

  return (
    <Show when={resource()}>
      <div class={`detail-panel ${activeTab() === "exec" ? "detail-panel-exec" : ""}`}>
        <div class="detail-header">
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <Show when={parentResource() && isPod()}>
              <button
                class="action-btn"
                style={{ padding: "2px 8px", "font-size": "11px" }}
                onClick={() => {
                  const parent = parentResource();
                  setParentResource(null);
                  if (parent) setSelectedResource(parent);
                }}
              >
                ← {parentResource()!.kind}
              </button>
            </Show>
            <h3>{resource()!.name}</h3>
            <span style={{ "font-size": "11px", color: "var(--text-muted)" }}>
              {resource()!.kind}
            </span>
          </div>

          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <div class="detail-tabs">
              <button
                class={`detail-tab ${activeTab() === "yaml" ? "active" : ""}`}
                onClick={() => setActiveTab("yaml")}
              >
                YAML
              </button>
              <Show when={isWorkload()}>
                <button
                  class={`detail-tab ${activeTab() === "pods" ? "active" : ""}`}
                  onClick={() => setActiveTab("pods")}
                >
                  Pods
                </button>
              </Show>
              <Show when={isPod()}>
                <button
                  class={`detail-tab ${activeTab() === "containers" ? "active" : ""}`}
                  onClick={() => setActiveTab("containers")}
                >
                  Containers
                </button>
                <button
                  class={`detail-tab ${activeTab() === "logs" ? "active" : ""}`}
                  onClick={() => setActiveTab("logs")}
                >
                  Logs
                </button>
                <button
                  class={`detail-tab ${activeTab() === "exec" ? "active" : ""}`}
                  onClick={() => setActiveTab("exec")}
                >
                  Exec
                </button>
              </Show>
              <Show when={isNode()}>
                <button
                  class={`detail-tab ${activeTab() === "describe" ? "active" : ""}`}
                  onClick={() => setActiveTab("describe")}
                >
                  Describe
                </button>
              </Show>
              <button
                class={`detail-tab ${activeTab() === "labels" ? "active" : ""}`}
                onClick={() => setActiveTab("labels")}
              >
                Labels
              </button>
              <button
                class={`detail-tab ${activeTab() === "events" ? "active" : ""}`}
                onClick={() => setActiveTab("events")}
              >
                Events
              </button>
              <Show when={isPod()}>
                <button
                  class={`detail-tab ${activeTab() === "benchmark" ? "active" : ""}`}
                  onClick={() => setActiveTab("benchmark")}
                >
                  Benchmark
                </button>
              </Show>
            </div>

            <Show when={isNode()}>
              <button
                class="action-btn"
                disabled={!!nodeAction()}
                onClick={handleCordon}
                title="Cordon (c)"
              >
                {nodeAction() === "cordoning" ? "..." : "Cordon"}
              </button>
              <button
                class="action-btn"
                disabled={!!nodeAction()}
                onClick={handleUncordon}
                title="Uncordon (u)"
              >
                {nodeAction() === "uncordoning" ? "..." : "Uncordon"}
              </button>
              <Show when={!confirmDrain()}>
                <button
                  class="action-btn danger"
                  disabled={!!nodeAction()}
                  onClick={() => setConfirmDrain(true)}
                  title="Drain (r)"
                >
                  Drain
                </button>
              </Show>
              <Show when={confirmDrain()}>
                <button
                  class="action-btn danger"
                  disabled={!!nodeAction()}
                  onClick={handleDrain}
                >
                  {nodeAction() === "draining" ? "Draining..." : "Confirm Drain"}
                </button>
                <button class="action-btn" onClick={() => setConfirmDrain(false)}>
                  Cancel
                </button>
              </Show>
            </Show>

            <Show when={isScalable()}>
              <div class="scale-controls">
                <button
                  class="action-btn"
                  disabled={scaling() || replicaCount() <= 0}
                  onClick={() => handleScale(replicaCount() - 1)}
                >
                  -
                </button>
                <span class="replica-count">{replicaCount()}</span>
                <button
                  class="action-btn"
                  disabled={scaling()}
                  onClick={() => handleScale(replicaCount() + 1)}
                >
                  +
                </button>
              </div>
            </Show>

            <Show when={isRestartable()}>
              <button
                class="action-btn"
                disabled={restarting()}
                onClick={async () => {
                  const res = resource();
                  if (!res) return;
                  setRestarting(true);
                  try {
                    await rolloutRestart(res.namespace || "default", res.kind, res.name);
                    loadResources();
                  } catch (e: any) {
                    alert(`Restart failed: ${e}`);
                  }
                  setRestarting(false);
                }}
              >
                {restarting() ? "Restarting..." : "Restart"}
              </button>
            </Show>

            <Show when={!confirmDelete()}>
              <button
                class="action-btn danger"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            </Show>
            <Show when={confirmDelete()}>
              <button class="action-btn danger" onClick={handleDelete}>
                Confirm Delete
              </button>
              <button class="action-btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </Show>

            <button class="detail-close" onClick={() => setSelectedResource(null)}>
              ×
            </button>
          </div>
        </div>

        <div class="detail-content">
          <Show when={detailLoading()}>
            <div class="loading-overlay">
              <span class="spinner" />
              Loading...
            </div>
          </Show>

          <Show when={!detailLoading() && activeTab() === "yaml"}>
            <div class="yaml-toolbar">
              <Show when={!editing()}>
                <button class="action-btn" onClick={() => { setEditYaml(yaml()); setApplyError(""); setEditing(true); }}>
                  Edit
                </button>
                <button class="action-btn" onClick={() => { navigator.clipboard.writeText(yaml()); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                  {copied() ? "Copied!" : "Copy"}
                </button>
              </Show>
              <Show when={editing()}>
                <button class="action-btn" disabled={applying()} onClick={handleApply}>
                  {applying() ? "Applying..." : "Apply"}
                </button>
                <button class="action-btn" onClick={() => { setEditing(false); setApplyError(""); }}>
                  Cancel
                </button>
              </Show>
            </div>
            <Show when={applyError()}>
              <div class="apply-error">{applyError()}</div>
            </Show>
            <Show when={!editing()}>
              <pre class="yaml-viewer">{yaml()}</pre>
            </Show>
            <Show when={editing()}>
              <textarea
                class="yaml-editor"
                value={editYaml()}
                onInput={(e) => setEditYaml(e.currentTarget.value)}
                spellcheck={false}
              />
            </Show>
          </Show>

          <Show when={!detailLoading() && activeTab() === "pods" && isWorkload()}>
            {(() => {
              function pctColor(pct: number | null | undefined): string {
                if (pct == null) return "var(--text-muted)";
                if (pct > 90) return "var(--danger)";
                if (pct > 70) return "var(--warning)";
                if (pct > 50) return "var(--accent)";
                return "var(--success)";
              }
              function fmtPct(pct: number | null | undefined): string {
                if (pct == null) return "-";
                return `${pct.toFixed(0)}%`;
              }

              return (
                <div style={{ padding: "8px" }}>
                  <div class="resource-count" style={{ "margin-bottom": "8px" }}>
                    {resourcePods().length} pod{resourcePods().length !== 1 ? "s" : ""}
                  </div>
                  <table class="resource-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Ready</th>
                        <th>Status</th>
                        <th>Restarts</th>
                        <th>CPU</th>
                        <th>MEM</th>
                        <th>%CPU/R</th>
                        <th>%CPU/L</th>
                        <th>%MEM/R</th>
                        <th>%MEM/L</th>
                        <th>IP</th>
                        <th>Node</th>
                        <th>Age</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={resourcePods()}>
                        {(pod) => {
                          const statuses: any[] = pod.extra?.status?.containerStatuses || [];
                          const readyCount = statuses.filter((c: any) => c.ready).length;
                          const totalCount = statuses.length;
                          const ready = totalCount > 0 ? `${readyCount}/${totalCount}` : "-";
                          const restarts = statuses.reduce((sum: number, c: any) => sum + (c.restartCount || 0), 0);
                          const podIP = pod.extra?.status?.podIP || "-";
                          const nodeName = pod.extra?.spec?.nodeName || "-";
                          const statusStr = pod.status || "-";
                          const statusLower = statusStr.toLowerCase();
                          const pm = podMetricsMap()[pod.name];

                          let sClass = "";
                          if (["running", "active"].includes(statusLower)) sClass = "status-running";
                          else if (["pending", "containercreating"].includes(statusLower)) sClass = "status-pending";
                          else if (["failed", "error", "crashloopbackoff"].includes(statusLower)) sClass = "status-failed";
                          else if (["succeeded", "completed"].includes(statusLower)) sClass = "status-succeeded";

                          let readyClass = "";
                          if (totalCount > 0) {
                            if (readyCount === totalCount) readyClass = "status-running";
                            else if (readyCount === 0) readyClass = "status-failed";
                            else readyClass = "status-pending";
                          }

                          return (
                            <tr
                              style={{ cursor: "pointer" }}
                              onClick={() => {
                                setParentResource(resource()!);
                                setSelectedResource(pod);
                              }}
                            >
                              <td>{pod.name}</td>
                              <td>
                                <span class={`status ${readyClass}`}>{ready}</span>
                              </td>
                              <td>
                                <span class={`status ${sClass}`}>
                                  <span class="status-dot" />
                                  {statusStr}
                                </span>
                              </td>
                              <td style={{ color: restarts > 0 ? "var(--warning)" : "var(--text-secondary)" }}>
                                {restarts}
                              </td>
                              <td class="metrics-cell">{pm ? pm.cpu_total : "-"}</td>
                              <td class="metrics-cell">{pm ? pm.memory_total : "-"}</td>
                              <td class="metrics-cell">
                                <span style={{ color: pctColor(pm?.cpu_percent), "font-weight": "600" }}>
                                  {fmtPct(pm?.cpu_percent)}
                                </span>
                              </td>
                              <td class="metrics-cell">
                                <span style={{ color: pctColor(pm?.cpu_limit_percent), "font-weight": "600" }}>
                                  {fmtPct(pm?.cpu_limit_percent)}
                                </span>
                              </td>
                              <td class="metrics-cell">
                                <span style={{ color: pctColor(pm?.memory_percent), "font-weight": "600" }}>
                                  {fmtPct(pm?.memory_percent)}
                                </span>
                              </td>
                              <td class="metrics-cell">
                                <span style={{ color: pctColor(pm?.memory_limit_percent), "font-weight": "600" }}>
                                  {fmtPct(pm?.memory_limit_percent)}
                                </span>
                              </td>
                              <td style={{ "font-size": "11px", color: "var(--text-secondary)" }}>
                                {podIP}
                              </td>
                              <td style={{ "font-size": "11px", color: "var(--text-secondary)" }}>
                                {nodeName}
                              </td>
                              <td style={{ color: "var(--text-secondary)" }}>
                                {pod.age || "-"}
                              </td>
                            </tr>
                          );
                        }}
                      </For>
                    </tbody>
                  </table>
                  <Show when={resourcePods().length === 0}>
                    <div class="empty-state">
                      <p>No pods found</p>
                    </div>
                  </Show>
                </div>
              );
            })()}
          </Show>

          <Show when={!detailLoading() && activeTab() === "containers" && isPod()}>
            {(() => {
              const extra = resource()!.extra || {};
              const spec = extra.spec || {};
              const status = extra.status || {};
              const containerSpecs: any[] = spec.containers || [];
              const initSpecs: any[] = spec.initContainers || [];
              const containerStatuses: any[] = status.containerStatuses || [];
              const initStatuses: any[] = status.initContainerStatuses || [];
              function getContainerStatus(name: string, statuses: any[]): { state: string; stateClass: string; ready: boolean; restarts: number; started: string } {
                const cs = statuses.find((s: any) => s.name === name);
                if (!cs) return { state: "Unknown", stateClass: "", ready: false, restarts: 0, started: "-" };
                const restarts = cs.restartCount || 0;
                const ready = cs.ready || false;
                const stateObj = cs.state || {};
                let state = "Unknown";
                let stateClass = "";
                if (stateObj.running) {
                  state = "Running";
                  stateClass = "status-running";
                } else if (stateObj.waiting) {
                  state = stateObj.waiting.reason || "Waiting";
                  stateClass = "status-pending";
                } else if (stateObj.terminated) {
                  state = stateObj.terminated.reason || "Terminated";
                  stateClass = stateObj.terminated.exitCode === 0 ? "status-succeeded" : "status-failed";
                }
                const started = cs.startedAt || stateObj.running?.startedAt || "-";
                return { state, stateClass, ready, restarts, started };
              }

              function formatPorts(ports: any[]): string {
                if (!ports || ports.length === 0) return "-";
                return ports.map((p: any) => `${p.containerPort}/${p.protocol || "TCP"}`).join(", ");
              }

              function formatResources(res: any): { cpu: string; mem: string } {
                if (!res) return { cpu: "-", mem: "-" };
                return {
                  cpu: res.cpu || "-",
                  mem: res.memory || "-",
                };
              }

              const allContainers = [
                ...initSpecs.map((c: any) => ({ ...c, _init: true })),
                ...containerSpecs.map((c: any) => ({ ...c, _init: false })),
              ];

              return (
                <div style={{ padding: "8px" }}>
                  <table class="resource-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Image</th>
                        <th>Ready</th>
                        <th>State</th>
                        <th>Restarts</th>
                        <th>CPU</th>
                        <th>MEM</th>
                        <th>Ports</th>
                        <th>CPU Req</th>
                        <th>CPU Lim</th>
                        <th>Mem Req</th>
                        <th>Mem Lim</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={allContainers}>
                        {(c) => {
                          const isInit = c._init;
                          const statuses = isInit ? initStatuses : containerStatuses;
                          const cs = getContainerStatus(c.name, statuses);
                          const req = formatResources(c.resources?.requests);
                          const lim = formatResources(c.resources?.limits);
                          const cm = containerMetrics()[c.name];

                          return (
                            <tr>
                              <td>
                                {c.name}
                                {isInit && (
                                  <span style={{ "font-size": "9px", "margin-left": "4px", color: "var(--text-muted)", "text-transform": "uppercase" }}>
                                    init
                                  </span>
                                )}
                              </td>
                              <td style={{ "font-size": "11px", color: "var(--text-secondary)", "max-width": "200px", overflow: "hidden", "text-overflow": "ellipsis" }}>
                                {c.image || "-"}
                              </td>
                              <td>
                                <span style={{ color: cs.ready ? "var(--success)" : "var(--text-muted)" }}>
                                  {cs.ready ? "true" : "false"}
                                </span>
                              </td>
                              <td>
                                <span class={`status ${cs.stateClass}`}>
                                  <span class="status-dot" />
                                  {cs.state}
                                </span>
                              </td>
                              <td style={{ color: cs.restarts > 0 ? "var(--warning)" : "var(--text-secondary)" }}>
                                {cs.restarts}
                              </td>
                              <td class="metrics-cell" style={{ color: "var(--accent)", "font-weight": "600" }}>
                                {cm ? cm.cpu : "-"}
                              </td>
                              <td class="metrics-cell" style={{ color: "var(--info)", "font-weight": "600" }}>
                                {cm ? cm.memory : "-"}
                              </td>
                              <td style={{ "font-size": "11px", color: "var(--text-secondary)" }}>
                                {formatPorts(c.ports)}
                              </td>
                              <td class="metrics-cell">{req.cpu}</td>
                              <td class="metrics-cell">{lim.cpu}</td>
                              <td class="metrics-cell">{req.mem}</td>
                              <td class="metrics-cell">{lim.mem}</td>
                            </tr>
                          );
                        }}
                      </For>
                    </tbody>
                  </table>
                  <Show when={allContainers.length === 0}>
                    <div class="empty-state">
                      <p>No containers found</p>
                    </div>
                  </Show>
                </div>
              );
            })()}
          </Show>

          <Show when={!detailLoading() && activeTab() === "logs"}>
            <div class="log-controls">
              <Show when={containers().length > 1}>
                <select
                  value={selectedContainer()}
                  onChange={(e) => {
                    setSelectedContainer(e.currentTarget.value);
                    loadLogs();
                  }}
                >
                  <For each={containers()}>
                    {(c) => <option value={c}>{c}</option>}
                  </For>
                </select>
              </Show>
              <input
                type="text"
                placeholder="Filter logs..."
                value={logFilter()}
                onInput={(e) => setLogFilter(e.currentTarget.value)}
              />
              <button class="action-btn" onClick={loadLogs}>
                Refresh
              </button>
              <button
                class={`action-btn ${streaming() ? "streaming-active" : ""}`}
                onClick={toggleStreaming}
              >
                {streaming() ? "Stop Stream" : "Stream"}
              </button>
              <button class="action-btn" onClick={exportLogs} title="Download logs">
                Export
              </button>
            </div>
            <div class="log-viewer">
              <For each={filteredLogs()}>
                {(line) => {
                  const parts = line.split(" ");
                  const timestamp = parts[0] || "";
                  const message = parts.slice(1).join(" ");
                  return (
                    <div class="log-line">
                      <span class="log-timestamp">{timestamp}</span>
                      <span class="log-message">{message}</span>
                    </div>
                  );
                }}
              </For>
              <Show when={filteredLogs().length === 0}>
                <div class="empty-state">
                  <p>No logs available</p>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={!detailLoading() && activeTab() === "labels"}>
            <div style={{ padding: "12px 16px" }}>
              <table class="resource-table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={Object.entries(resource()!.labels || {})}>
                    {([key, value]) => (
                      <tr>
                        <td>{key}</td>
                        <td>{value}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={Object.keys(resource()!.labels || {}).length === 0}>
                <div class="empty-state">
                  <p>No labels</p>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={activeTab() === "events"}>
            <div style={{ padding: "8px" }}>
              <Show when={eventsLoading()}>
                <div class="loading-overlay">
                  <span class="spinner" />
                  Loading events...
                </div>
              </Show>
              <Show when={!eventsLoading()}>
                <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "8px" }}>
                  <span class="resource-count">
                    {resourceEvents().length} event{resourceEvents().length !== 1 ? "s" : ""}
                  </span>
                  <button class="action-btn" onClick={loadResourceEvents}>Refresh</button>
                </div>
                <Show when={resourceEvents().length > 0}>
                  <table class="resource-table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Reason</th>
                        <th>Message</th>
                        <th>Count</th>
                        <th>Last Seen</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={resourceEvents()}>
                        {(ev) => (
                          <tr>
                            <td>
                              <span class={ev.event_type === "Warning" ? "event-warning" : "event-normal"}>
                                {ev.event_type || "-"}
                              </span>
                            </td>
                            <td>{ev.reason || "-"}</td>
                            <td class="event-message">{ev.message || "-"}</td>
                            <td>{ev.count || "-"}</td>
                            <td style={{ color: "var(--text-secondary)" }}>{ev.last_seen || "-"}</td>
                            <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>{ev.source || "-"}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
                <Show when={resourceEvents().length === 0}>
                  <div class="empty-state">
                    <p>No events for this resource</p>
                  </div>
                </Show>
              </Show>
            </div>
          </Show>

          <Show when={!detailLoading() && activeTab() === "describe" && isNode() && nodeInfo()}>
            {(() => {
              const info = nodeInfo()!;
              const statusColor = info.status.includes("Ready") && !info.status.includes("NotReady")
                ? "var(--success)"
                : "var(--danger)";
              const isCordonedNow = info.status.includes("SchedulingDisabled");

              return (
                <div style={{ padding: "12px 16px", overflow: "auto" }}>
                  <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "16px" }}>
                    <div>
                      <h4 style={{ margin: "0 0 8px", color: "var(--text-secondary)", "font-size": "11px", "text-transform": "uppercase" }}>General</h4>
                      <table class="resource-table">
                        <tbody>
                          <tr><td style={{ color: "var(--text-muted)", width: "140px" }}>Status</td><td><span style={{ color: statusColor, "font-weight": "600" }}>{info.status}</span></td></tr>
                          <tr><td style={{ color: "var(--text-muted)" }}>Roles</td><td>{info.roles.join(", ")}</td></tr>
                          <tr><td style={{ color: "var(--text-muted)" }}>Version</td><td>{info.version}</td></tr>
                          <tr><td style={{ color: "var(--text-muted)" }}>Age</td><td>{info.age}</td></tr>
                          <tr><td style={{ color: "var(--text-muted)" }}>Internal IP</td><td>{info.internal_ip}</td></tr>
                          <tr><td style={{ color: "var(--text-muted)" }}>External IP</td><td>{info.external_ip}</td></tr>
                          <tr><td style={{ color: "var(--text-muted)" }}>Schedulable</td><td><span style={{ color: isCordonedNow ? "var(--danger)" : "var(--success)" }}>{isCordonedNow ? "No (Cordoned)" : "Yes"}</span></td></tr>
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <h4 style={{ margin: "0 0 8px", color: "var(--text-secondary)", "font-size": "11px", "text-transform": "uppercase" }}>System</h4>
                      <table class="resource-table">
                        <tbody>
                          <tr><td style={{ color: "var(--text-muted)", width: "140px" }}>OS</td><td>{info.os}</td></tr>
                          <tr><td style={{ color: "var(--text-muted)" }}>Architecture</td><td>{info.arch}</td></tr>
                          <tr><td style={{ color: "var(--text-muted)" }}>Kernel</td><td>{info.kernel_version}</td></tr>
                          <tr><td style={{ color: "var(--text-muted)" }}>Runtime</td><td>{info.container_runtime}</td></tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <h4 style={{ margin: "16px 0 8px", color: "var(--text-secondary)", "font-size": "11px", "text-transform": "uppercase" }}>Capacity / Allocatable</h4>
                  <table class="resource-table">
                    <thead>
                      <tr><th>Resource</th><th>Capacity</th><th>Allocatable</th></tr>
                    </thead>
                    <tbody>
                      <tr><td>CPU</td><td>{info.cpu_capacity}</td><td>{info.cpu_allocatable}</td></tr>
                      <tr><td>Memory</td><td>{info.memory_capacity}</td><td>{info.memory_allocatable}</td></tr>
                      <tr><td>Pods</td><td>{info.pods_capacity}</td><td>{info.pods_allocatable}</td></tr>
                    </tbody>
                  </table>

                  <h4 style={{ margin: "16px 0 8px", color: "var(--text-secondary)", "font-size": "11px", "text-transform": "uppercase" }}>Conditions</h4>
                  <table class="resource-table">
                    <thead>
                      <tr><th>Type</th><th>Status</th><th>Reason</th><th>Message</th><th>Last Transition</th></tr>
                    </thead>
                    <tbody>
                      <For each={info.conditions}>
                        {(cond) => (
                          <tr>
                            <td>{cond.condition_type}</td>
                            <td>
                              <span style={{ color: cond.status === "True" && cond.condition_type === "Ready" ? "var(--success)" : cond.status === "True" && cond.condition_type !== "Ready" ? "var(--danger)" : "var(--text-secondary)" }}>
                                {cond.status}
                              </span>
                            </td>
                            <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>{cond.reason || "-"}</td>
                            <td style={{ color: "var(--text-secondary)", "font-size": "11px", "max-width": "300px", overflow: "hidden", "text-overflow": "ellipsis" }}>{cond.message || "-"}</td>
                            <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>{cond.last_transition || "-"}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </Show>

          <Show when={activeTab() === "exec" && isPod()}>
            <div class="exec-tab-bar">
              <For each={execTabs()}>
                {(tabId) => (
                  <button
                    class={`exec-tab ${activeExecTab() === tabId ? "active" : ""}`}
                    onClick={() => setActiveExecTab(tabId)}
                  >
                    Shell {tabId}
                    <Show when={execTabs().length > 1}>
                      <span
                        class="exec-tab-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExecTabs((prev) => prev.filter((t) => t !== tabId));
                          if (activeExecTab() === tabId) {
                            setActiveExecTab(execTabs()[0] || 1);
                          }
                        }}
                      >
                        x
                      </span>
                    </Show>
                  </button>
                )}
              </For>
              <button
                class="exec-tab-add"
                onClick={() => {
                  execTabCounter++;
                  setExecTabs((prev) => [...prev, execTabCounter]);
                  setActiveExecTab(execTabCounter);
                }}
              >
                +
              </button>
            </div>
            <For each={execTabs()}>
              {(tabId) => (
                <div style={{ display: activeExecTab() === tabId ? "block" : "none" }}>
                  <Terminal
                    namespace={resource()!.namespace || "default"}
                    podName={resource()!.name}
                    container={selectedContainer() || undefined}
                    context={activeContext()}
                    active={activeTab() === "exec" && activeExecTab() === tabId}
                  />
                </div>
              )}
            </For>
          </Show>

          <Show when={activeTab() === "benchmark" && isPod()}>
            <div style={{ padding: "12px 16px" }}>
              <Show when={!benchmarking() && !benchmarkResult()}>
                <div class="benchmark-config">
                  <p style={{ color: "var(--text-secondary)", "font-size": "12px", "margin-bottom": "12px" }}>
                    Collect metrics samples over time to recommend optimal CPU/Memory requests and limits.
                  </p>
                  <div style={{ display: "flex", gap: "16px", "align-items": "flex-end", "margin-bottom": "12px" }}>
                    <div class="benchmark-field">
                      <label>Duration (seconds)</label>
                      <select value={benchmarkDuration()} onChange={(e) => setBenchmarkDuration(parseInt(e.currentTarget.value))}>
                        <option value="30">30s (quick)</option>
                        <option value="60">60s (default)</option>
                        <option value="120">2 min</option>
                        <option value="300">5 min</option>
                        <option value="600">10 min</option>
                      </select>
                    </div>
                    <div class="benchmark-field">
                      <label>Interval (seconds)</label>
                      <select value={benchmarkInterval()} onChange={(e) => setBenchmarkInterval(parseInt(e.currentTarget.value))}>
                        <option value="3">3s</option>
                        <option value="5">5s (default)</option>
                        <option value="10">10s</option>
                        <option value="15">15s</option>
                      </select>
                    </div>
                    <button
                      class="action-btn"
                      style={{ padding: "6px 16px" }}
                      onClick={async () => {
                        const res = resource();
                        const ctx = activeContext();
                        if (!res || !ctx) return;
                        setBenchmarking(true);
                        setBenchmarkResult(null);
                        setBenchmarkProgress(null);
                        const unlisten = await listen<any>("benchmark-progress", (event) => {
                          setBenchmarkProgress(event.payload);
                        });
                        try {
                          const result = await invoke<any>("benchmark_pod", {
                            context: ctx,
                            namespace: res.namespace || "default",
                            podName: res.name,
                            durationSecs: benchmarkDuration(),
                            intervalSecs: benchmarkInterval(),
                          });
                          setBenchmarkResult(result);
                        } catch (e: any) {
                          alert(`Benchmark failed: ${e}`);
                        }
                        unlisten();
                        setBenchmarking(false);
                        setBenchmarkProgress(null);
                      }}
                    >
                      Start Benchmark
                    </button>
                  </div>
                  <div style={{ "font-size": "11px", color: "var(--text-muted)" }}>
                    Samples: ~{Math.floor(benchmarkDuration() / benchmarkInterval())} | Requires metrics-server
                  </div>
                </div>
              </Show>

              <Show when={benchmarking()}>
                <div class="benchmark-progress">
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "8px" }}>
                    <span class="spinner" />
                    <span style={{ "font-weight": "600" }}>Benchmarking...</span>
                  </div>
                  <Show when={benchmarkProgress()}>
                    <div style={{ "margin-bottom": "8px" }}>
                      Sample {benchmarkProgress()!.sample} / {benchmarkProgress()!.total}
                    </div>
                    <div class="usage-bar" style={{ height: "8px" }}>
                      <div
                        class="usage-fill"
                        style={{
                          width: `${(benchmarkProgress()!.sample / benchmarkProgress()!.total) * 100}%`,
                          background: "var(--accent)",
                        }}
                      />
                    </div>
                  </Show>
                  <div style={{ "font-size": "11px", color: "var(--text-muted)", "margin-top": "8px" }}>
                    Collecting metrics every {benchmarkInterval()}s for {benchmarkDuration()}s...
                  </div>
                </div>
              </Show>

              <Show when={!benchmarking() && benchmarkResult()}>
                {(() => {
                  const result = benchmarkResult()!;

                  function pctColor(pct: number): string {
                    if (pct > 90) return "var(--danger)";
                    if (pct > 70) return "var(--warning)";
                    if (pct > 50) return "var(--accent)";
                    return "var(--success)";
                  }

                  function diffTag(current: number, recommended: number): any {
                    if (current === 0) return <span class="bench-tag bench-tag-warn">Not Set</span>;
                    const pct = ((recommended - current) / current) * 100;
                    if (Math.abs(pct) < 10) return <span class="bench-tag bench-tag-ok">OK</span>;
                    if (pct > 0) return <span class="bench-tag bench-tag-warn">+{pct.toFixed(0)}%</span>;
                    return <span class="bench-tag bench-tag-save">{pct.toFixed(0)}%</span>;
                  }

                  return (
                    <div>
                      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "12px" }}>
                        <div>
                          <span style={{ "font-weight": "600" }}>Benchmark Results</span>
                          <span style={{ color: "var(--text-muted)", "font-size": "11px", "margin-left": "8px" }}>
                            {result.total_samples} samples over {result.duration_secs}s (every {result.interval_secs}s)
                          </span>
                        </div>
                        <button class="action-btn" onClick={() => setBenchmarkResult(null)}>
                          New Benchmark
                        </button>
                      </div>

                      <For each={result.containers}>
                        {(container: any) => (
                          <div style={{ "margin-bottom": "20px" }}>
                            <h4 style={{ "font-size": "12px", color: "var(--accent)", "margin-bottom": "8px" }}>
                              Container: {container.name}
                              <span style={{ color: "var(--text-muted)", "font-weight": "400", "margin-left": "8px" }}>
                                ({container.samples} samples)
                              </span>
                            </h4>

                            <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "12px", "margin-bottom": "12px" }}>
                              <div>
                                <h5 style={{ "font-size": "11px", color: "var(--text-secondary)", "text-transform": "uppercase", "margin-bottom": "6px" }}>
                                  CPU Statistics (millicores)
                                </h5>
                                <table class="resource-table">
                                  <tbody>
                                    <tr><td style={{ color: "var(--text-muted)", width: "60px" }}>Avg</td><td style={{ "font-weight": "600" }}>{container.cpu_avg_fmt}</td></tr>
                                    <tr><td style={{ color: "var(--text-muted)" }}>P50</td><td>{container.cpu_p50_fmt}</td></tr>
                                    <tr><td style={{ color: "var(--text-muted)" }}>P95</td><td style={{ color: "var(--warning)" }}>{container.cpu_p95_fmt}</td></tr>
                                    <tr><td style={{ color: "var(--text-muted)" }}>P99</td><td style={{ color: "var(--danger)" }}>{container.cpu_p99_fmt}</td></tr>
                                    <tr><td style={{ color: "var(--text-muted)" }}>Max</td><td>{container.cpu_max_fmt}</td></tr>
                                  </tbody>
                                </table>
                              </div>
                              <div>
                                <h5 style={{ "font-size": "11px", color: "var(--text-secondary)", "text-transform": "uppercase", "margin-bottom": "6px" }}>
                                  Memory Statistics
                                </h5>
                                <table class="resource-table">
                                  <tbody>
                                    <tr><td style={{ color: "var(--text-muted)", width: "60px" }}>Avg</td><td style={{ "font-weight": "600" }}>{container.mem_avg_fmt}</td></tr>
                                    <tr><td style={{ color: "var(--text-muted)" }}>P50</td><td>{container.mem_p50_fmt}</td></tr>
                                    <tr><td style={{ color: "var(--text-muted)" }}>P95</td><td style={{ color: "var(--warning)" }}>{container.mem_p95_fmt}</td></tr>
                                    <tr><td style={{ color: "var(--text-muted)" }}>P99</td><td style={{ color: "var(--danger)" }}>{container.mem_p99_fmt}</td></tr>
                                    <tr><td style={{ color: "var(--text-muted)" }}>Max</td><td>{container.mem_max_fmt}</td></tr>
                                  </tbody>
                                </table>
                              </div>
                            </div>

                            <h5 style={{ "font-size": "11px", color: "var(--text-secondary)", "text-transform": "uppercase", "margin-bottom": "6px" }}>
                              Recommendations
                            </h5>
                            <table class="resource-table">
                              <thead>
                                <tr>
                                  <th>Resource</th>
                                  <th>Current</th>
                                  <th>Recommended</th>
                                  <th>Diff</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td style={{ color: "var(--text-muted)" }}>CPU Request</td>
                                  <td>{container.current_cpu_request || <span style={{ color: "var(--text-muted)" }}>Not set</span>}</td>
                                  <td style={{ color: "var(--accent)", "font-weight": "600" }}>{container.rec_cpu_request}</td>
                                  <td>{diffTag(container.current_cpu_request_mc, container.rec_cpu_request_mc)}</td>
                                </tr>
                                <tr>
                                  <td style={{ color: "var(--text-muted)" }}>CPU Limit</td>
                                  <td>{container.current_cpu_limit || <span style={{ color: "var(--text-muted)" }}>Not set</span>}</td>
                                  <td style={{ color: "var(--accent)", "font-weight": "600" }}>{container.rec_cpu_limit}</td>
                                  <td>{diffTag(container.current_cpu_limit_mc, container.rec_cpu_limit_mc)}</td>
                                </tr>
                                <tr>
                                  <td style={{ color: "var(--text-muted)" }}>Memory Request</td>
                                  <td>{container.current_mem_request || <span style={{ color: "var(--text-muted)" }}>Not set</span>}</td>
                                  <td style={{ color: "var(--info)", "font-weight": "600" }}>{container.rec_mem_request}</td>
                                  <td>{diffTag(container.current_mem_request_bytes, container.rec_mem_request_bytes)}</td>
                                </tr>
                                <tr>
                                  <td style={{ color: "var(--text-muted)" }}>Memory Limit</td>
                                  <td>{container.current_mem_limit || <span style={{ color: "var(--text-muted)" }}>Not set</span>}</td>
                                  <td style={{ color: "var(--info)", "font-weight": "600" }}>{container.rec_mem_limit}</td>
                                  <td>{diffTag(container.current_mem_limit_bytes, container.rec_mem_limit_bytes)}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        )}
                      </For>

                      <div style={{ "font-size": "11px", color: "var(--text-muted)", "border-top": "1px solid var(--border)", "padding-top": "8px", "margin-top": "8px" }}>
                        {"Request = P50 + 20% (min: avg) | Limit = P99 + 25% (min: max, always >= request) | Longer benchmarks give more accurate results"}
                      </div>
                    </div>
                  );
                })()}
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
