import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface K8sContext {
  name: string;
  cluster: string;
  user: string;
  namespace: string | null;
  is_active: boolean;
}

export interface NamespaceInfo {
  name: string;
  status: string;
  age: string;
}

export interface K8sResource {
  name: string;
  namespace: string | null;
  kind: string;
  status: string | null;
  age: string | null;
  labels: Record<string, string>;
  extra: any;
}

export const RESOURCE_KINDS = [
  { key: "pods", label: "Pods", icon: "⊙" },
  { key: "deployments", label: "Deployments", icon: "◈" },
  { key: "services", label: "Services", icon: "◉" },
  { key: "statefulsets", label: "StatefulSets", icon: "◆" },
  { key: "daemonsets", label: "DaemonSets", icon: "◇" },
  { key: "replicasets", label: "ReplicaSets", icon: "◫" },
  { key: "jobs", label: "Jobs", icon: "▶" },
  { key: "cronjobs", label: "CronJobs", icon: "⏱" },
  { key: "configmaps", label: "ConfigMaps", icon: "⚙" },
  { key: "secrets", label: "Secrets", icon: "🔒" },
  { key: "ingresses", label: "Ingresses", icon: "⇄" },
  { key: "networkpolicies", label: "NetworkPolicies", icon: "🛡" },
  { key: "serviceaccounts", label: "ServiceAccounts", icon: "👤" },
  { key: "persistentvolumes", label: "PVs", icon: "🗄" },
  { key: "persistentvolumeclaims", label: "PVCs", icon: "💾" },
  { key: "nodes", label: "Nodes", icon: "🖥" },
] as const;

// API Resource discovery
export interface ApiResourceInfo {
  name: string;       // plural e.g. "pods"
  kind: string;       // e.g. "Pod"
  group: string;      // e.g. "", "apps"
  version: string;    // e.g. "v1"
  scope: string;      // "Namespaced" or "Cluster"
  short_names: string[];
  api_version: string;
  verbs: string[];
}

// Global state
const [contexts, setContexts] = createSignal<K8sContext[]>([]);
const [activeContext, setActiveContext] = createSignal<string>("");
const [namespaces, setNamespaces] = createSignal<NamespaceInfo[]>([]);
const [activeNamespace, setActiveNamespace] = createSignal<string>("_all");
const [activeResourceKind, setActiveResourceKind] = createSignal<string>("pods");
const [resources, setResources] = createSignal<K8sResource[]>([]);
const [selectedResource, setSelectedResource] = createSignal<K8sResource | null>(null);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
const [connected, setConnected] = createSignal(false);
const [apiResources, setApiResources] = createSignal<ApiResourceInfo[]>([]);
const [activeApiResource, setActiveApiResource] = createSignal<ApiResourceInfo | null>(null);

export {
  contexts,
  activeContext,
  namespaces,
  activeNamespace,
  activeResourceKind,
  resources,
  selectedResource,
  loading,
  error,
  connected,
  setActiveNamespace,
  setActiveResourceKind,
  setSelectedResource,
  apiResources,
  activeApiResource,
  setActiveApiResource,
};

export async function initialize() {
  try {
    setLoading(true);
    setError(null);

    // 1. Load contexts from kubeconfig
    const ctxs = await invoke<K8sContext[]>("list_contexts");
    setContexts(ctxs);

    const active = ctxs.find((c) => c.is_active);
    if (!active) {
      setError("No active context found in kubeconfig");
      return;
    }

    // 2. Connect to the active context (creates + caches client)
    setActiveContext(active.name);
    await invoke<string>("switch_context", { contextName: active.name });
    setConnected(true);

    // 3. Load namespaces, resources, and CRDs in parallel
    await Promise.all([loadNamespaces(), loadResources(), loadCrds()]);
    // 4. Discover all API resources in background (non-blocking)
    loadApiResources();
    // 5. Start polling for critical alerts
    startAlertPolling();
    // 6. Load dashboard overview in background
    loadClusterOverview();
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setLoading(false);
  }
}

export async function loadApiResources() {
  try {
    const ctx = activeContext();
    if (!ctx) return;
    const result = await invoke<ApiResourceInfo[]>("discover_api_resources", { context: ctx });
    console.log(`[r3x] Discovered ${result.length} API resources`);
    setApiResources(result);
  } catch (e: any) {
    console.warn("[r3x] API discovery failed:", e);
    setApiResources([]);
  }
}

export async function switchContext(contextName: string) {
  try {
    setLoading(true);
    setError(null);
    setConnected(false);
    await invoke<string>("switch_context", { contextName });
    setActiveContext(contextName);
    setConnected(true);
    // Load namespaces, resources, and CRDs in parallel
    await Promise.all([loadNamespaces(), loadResources(), loadCrds()]);
    loadApiResources();
    startAlertPolling();
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setLoading(false);
  }
}

export async function loadNamespaces() {
  try {
    const ctx = activeContext();
    if (!ctx) return;
    const nss = await invoke<NamespaceInfo[]>("list_namespaces", { context: ctx });
    setNamespaces(nss);
  } catch (e: any) {
    setError(e.toString());
  }
}

// Inline metrics map: key -> { cpu, memory }
export interface InlineMetrics {
  cpu: string;
  memory: string;
  cpu_percent?: number;
  memory_percent?: number;
  cpu_limit_percent?: number;
  memory_limit_percent?: number;
  cpu_request?: string;
  memory_request?: string;
  cpu_limit?: string;
  memory_limit?: string;
}

const [resourceMetrics, setResourceMetrics] = createSignal<Record<string, InlineMetrics>>({});
const [pvcMetrics, setPvcMetrics] = createSignal<Record<string, PvcMetricsInfo>>({});
export { resourceMetrics, pvcMetrics };

export async function loadResources() {
  try {
    // If currently viewing a CRD, reload via custom resources
    const crd = activeCrd();
    if (crd && activeResourceKind().startsWith("crd:")) {
      await loadCustomResources(crd);
      return;
    }

    // If viewing a dynamically discovered resource, use list_dynamic_resources
    const dynRes = activeApiResource();
    if (dynRes && activeResourceKind().startsWith("api:")) {
      setLoading(true);
      setError(null);
      setResourceMetrics({});
      const ctx = activeContext();
      if (!ctx) return;
      const ns = activeNamespace();
      const lf = labelFilter();
      const res = await invoke<K8sResource[]>("list_dynamic_resources", {
        context: ctx,
        namespace: ns,
        group: dynRes.group,
        version: dynRes.version,
        plural: dynRes.name,
        kind: dynRes.kind,
        scope: dynRes.scope,
        labelSelector: lf || null,
      });
      setResources(res);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setResourceMetrics({});
    setActiveCrd(null);
    setActiveApiResource(null);
    const ctx = activeContext();
    if (!ctx) return;
    const kind = activeResourceKind();
    const ns = activeNamespace();
    const lf = labelFilter();
    const res = await invoke<K8sResource[]>("list_resources", {
      context: ctx,
      namespace: ns,
      kind,
      labelSelector: lf || null,
    });
    setResources(res);

    // Fetch metrics in background for pods and nodes
    if (kind === "pods") {
      invoke<PodMetricsInfo[]>("get_pod_metrics", { context: ctx, namespace: ns })
        .then((metrics) => {
          const map: Record<string, InlineMetrics> = {};
          for (const m of metrics) {
            map[`${m.namespace}/${m.name}`] = {
              cpu: m.cpu_total,
              memory: m.memory_total,
              cpu_percent: m.cpu_percent ?? undefined,
              memory_percent: m.memory_percent ?? undefined,
              cpu_limit_percent: m.cpu_limit_percent ?? undefined,
              memory_limit_percent: m.memory_limit_percent ?? undefined,
              cpu_request: m.cpu_request ?? undefined,
              memory_request: m.memory_request ?? undefined,
              cpu_limit: m.cpu_limit ?? undefined,
              memory_limit: m.memory_limit ?? undefined,
            };
          }
          setResourceMetrics(map);
        })
        .catch(() => {}); // silently fail if metrics-server not available
    } else if (kind === "nodes") {
      invoke<NodeMetricsInfo[]>("get_node_metrics", { context: ctx })
        .then((metrics) => {
          const map: Record<string, InlineMetrics> = {};
          for (const m of metrics) {
            map[m.name] = {
              cpu: m.cpu,
              memory: m.memory,
              cpu_percent: m.cpu_percent,
              memory_percent: m.memory_percent,
            };
          }
          setResourceMetrics(map);
        })
        .catch(() => {});
    } else if (kind === "persistentvolumeclaims") {
      setPvcMetrics({});
      invoke<PvcMetricsInfo[]>("get_pvc_metrics", { context: ctx, namespace: ns })
        .then((metrics) => {
          const map: Record<string, PvcMetricsInfo> = {};
          for (const m of metrics) {
            map[`${m.namespace}/${m.name}`] = m;
          }
          setPvcMetrics(map);
        })
        .catch(() => {});
    }
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setLoading(false);
  }
}

// CRD support
export interface CrdInfo {
  name: string;
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: string;
  short_names: string[];
  category: string | null;
}

const [crds, setCrds] = createSignal<CrdInfo[]>([]);
const [activeCrd, setActiveCrd] = createSignal<CrdInfo | null>(null);
export { crds, activeCrd, setActiveCrd };

export async function loadCrds() {
  try {
    const ctx = activeContext();
    if (!ctx) return;
    const result = await invoke<CrdInfo[]>("list_crds", { context: ctx });
    setCrds(result);
  } catch {
    setCrds([]);
  }
}

export async function loadCustomResources(crd: CrdInfo) {
  try {
    setLoading(true);
    setError(null);
    setResourceMetrics({});
    setActiveCrd(crd);
    setActiveResourceKind(`crd:${crd.plural}.${crd.group}`);
    const ctx = activeContext();
    if (!ctx) return;
    const ns = activeNamespace();
    const res = await invoke<K8sResource[]>("list_custom_resources", {
      context: ctx,
      group: crd.group,
      version: crd.version,
      plural: crd.plural,
      kind: crd.kind,
      scope: crd.scope,
      namespace: ns,
    });
    setResources(res);
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setLoading(false);
  }
}

export async function getResourceYaml(
  namespace: string,
  kind: string,
  name: string
): Promise<string> {
  const ctx = activeContext();
  return invoke<string>("get_resource_yaml", { context: ctx, namespace, kind, name });
}

export async function getPodLogs(
  namespace: string,
  podName: string,
  container?: string,
  tailLines?: number
): Promise<string[]> {
  const ctx = activeContext();
  return invoke<string[]>("get_pod_logs", {
    context: ctx,
    namespace,
    podName,
    container: container || null,
    tailLines: tailLines || 100,
  });
}

export async function getPodContainers(
  namespace: string,
  podName: string
): Promise<string[]> {
  const ctx = activeContext();
  return invoke<string[]>("get_pod_containers", {
    context: ctx,
    namespace,
    podName,
  });
}

// Security scanning
export interface SecurityFinding {
  severity: string;
  category: string;
  title: string;
  description: string;
  resource_kind: string;
  resource_name: string;
  namespace: string;
  remediation: string;
}

export interface SecuritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total_resources_scanned: number;
  score: number;
}

export interface SecurityScanResult {
  findings: SecurityFinding[];
  summary: SecuritySummary;
}

const [securityResults, setSecurityResults] = createSignal<SecurityScanResult | null>(null);
const [securityScanning, setSecurityScanning] = createSignal(false);
const [showSecurityPanel, setShowSecurityPanel] = createSignal(false);

export {
  securityResults,
  securityScanning,
  showSecurityPanel,
  setShowSecurityPanel,
};

export async function runSecurityScan() {
  try {
    setSecurityScanning(true);
    const ctx = activeContext();
    if (!ctx) return;
    const result = await invoke<SecurityScanResult>("scan_security", {
      context: ctx,
      namespace: activeNamespace(),
    });
    setSecurityResults(result);
    setShowSecurityPanel(true);
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setSecurityScanning(false);
  }
}

// Topology
export interface TopoNode {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  status: string | null;
  children: TopoNode[];
}

const [topologyData, setTopologyData] = createSignal<TopoNode[]>([]);
const [topologyLoading, setTopologyLoading] = createSignal(false);
const [showTopologyPanel, setShowTopologyPanel] = createSignal(false);

export {
  topologyData,
  topologyLoading,
  showTopologyPanel,
  setShowTopologyPanel,
};

export async function loadTopology() {
  try {
    setTopologyLoading(true);
    const ctx = activeContext();
    if (!ctx) return;
    const result = await invoke<TopoNode[]>("get_topology", {
      context: ctx,
      namespace: activeNamespace(),
    });
    setTopologyData(result);
    setShowTopologyPanel(true);
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setTopologyLoading(false);
  }
}

export async function deleteResource(
  namespace: string,
  kind: string,
  name: string
): Promise<string> {
  const ctx = activeContext();
  return invoke<string>("delete_resource", { context: ctx, namespace, kind, name });
}

// Scaling
export async function scaleResource(
  namespace: string,
  kind: string,
  name: string,
  replicas: number
): Promise<string> {
  const ctx = activeContext();
  return invoke<string>("scale_resource", { context: ctx, namespace, kind, name, replicas });
}

// Rollout restart
export async function rolloutRestart(
  namespace: string,
  kind: string,
  name: string
): Promise<string> {
  const ctx = activeContext();
  return invoke<string>("rollout_restart", { context: ctx, namespace, kind, name });
}

// Events
export interface K8sEvent {
  kind: string | null;
  name: string | null;
  namespace: string | null;
  reason: string | null;
  message: string | null;
  event_type: string | null;
  count: number | null;
  first_seen: string | null;
  last_seen: string | null;
  source: string | null;
}

const [events, setEvents] = createSignal<K8sEvent[]>([]);
const [eventsLoading, setEventsLoading] = createSignal(false);
const [showEventsPanel, setShowEventsPanel] = createSignal(false);

export { events, eventsLoading, showEventsPanel, setShowEventsPanel };

export async function loadEvents() {
  try {
    setEventsLoading(true);
    const ctx = activeContext();
    if (!ctx) return;
    const result = await invoke<K8sEvent[]>("list_events", {
      context: ctx,
      namespace: activeNamespace(),
    });
    setEvents(result);
    setShowEventsPanel(true);
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setEventsLoading(false);
  }
}

// Node details
export interface NodeInfo {
  name: string;
  status: string;
  roles: string[];
  version: string;
  os: string;
  arch: string;
  container_runtime: string;
  kernel_version: string;
  cpu_capacity: string;
  memory_capacity: string;
  pods_capacity: string;
  cpu_allocatable: string;
  memory_allocatable: string;
  pods_allocatable: string;
  conditions: { condition_type: string; status: string; reason: string | null; message: string | null; last_transition: string | null }[];
  age: string;
  internal_ip: string;
  external_ip: string;
}

export async function getNodeDetails(name: string): Promise<NodeInfo> {
  const ctx = activeContext();
  return invoke<NodeInfo>("get_node_details", { context: ctx, name });
}

// Port forwarding
export interface ContainerPort {
  container_name: string;
  port: number;
  protocol: string;
  name: string | null;
}

export interface PortForwardSession {
  id: string;
  namespace: string;
  pod_name: string;
  local_port: number;
  remote_port: number;
  status: string;
}

const [portForwards, setPortForwards] = createSignal<PortForwardSession[]>([]);
const [showPortForwardPanel, setShowPortForwardPanel] = createSignal(false);

export { portForwards, showPortForwardPanel, setShowPortForwardPanel };

export async function getPodPorts(namespace: string, podName: string): Promise<ContainerPort[]> {
  const ctx = activeContext();
  return invoke<ContainerPort[]>("get_pod_ports", { context: ctx, namespace, podName });
}

export async function refreshPortForwards() {
  const result = await invoke<PortForwardSession[]>("list_port_forwards");
  setPortForwards(result);
}

export async function startPortForward(
  namespace: string,
  podName: string,
  localPort: number,
  remotePort: number
): Promise<PortForwardSession> {
  const ctx = activeContext();
  const session = await invoke<PortForwardSession>("start_port_forward", {
    context: ctx,
    namespace,
    podName,
    localPort,
    remotePort,
  });
  setPortForwards((prev) => [...prev, session]);
  return session;
}

export async function stopPortForward(sessionId: string) {
  await invoke<string>("stop_port_forward", { sessionId });
  setPortForwards((prev) => prev.filter((p) => p.id !== sessionId));
}

// Resource pods (for workload detail)
export async function getResourcePods(
  namespace: string,
  kind: string,
  name: string
): Promise<K8sResource[]> {
  const ctx = activeContext();
  if (!ctx) return [];
  return invoke<K8sResource[]>("get_resource_pods", {
    context: ctx,
    namespace,
    kind,
    name,
  });
}

// Metrics
export interface ContainerMetricsInfo {
  name: string;
  cpu: string;
  memory: string;
  cpu_millicores: number;
  memory_bytes: number;
}

export interface PodMetricsInfo {
  name: string;
  namespace: string;
  containers: ContainerMetricsInfo[];
  cpu_total: string;
  memory_total: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  cpu_limit_percent: number | null;
  memory_limit_percent: number | null;
  cpu_request: string | null;
  memory_request: string | null;
  cpu_limit: string | null;
  memory_limit: string | null;
}

export interface PvcMetricsInfo {
  name: string;
  namespace: string;
  capacity: string;
  capacity_bytes: number;
  used_bytes: number | null;
  available_bytes: number | null;
  used_percent: number | null;
  used_formatted: string | null;
  available_formatted: string | null;
  pod_name: string | null;
  volume_name: string | null;
}

export interface NodeMetricsInfo {
  name: string;
  cpu: string;
  memory: string;
  cpu_millicores: number;
  memory_bytes: number;
  cpu_capacity: number;
  memory_capacity: number;
  cpu_percent: number;
  memory_percent: number;
}

export interface ClusterMetricsSummary {
  node_metrics: NodeMetricsInfo[];
  total_cpu_millicores: number;
  total_memory_bytes: number;
  total_cpu_capacity: number;
  total_memory_capacity: number;
  cpu_percent: number;
  memory_percent: number;
  pod_count: number;
  node_count: number;
}

const [clusterMetrics, setClusterMetrics] = createSignal<ClusterMetricsSummary | null>(null);
const [podMetrics, setPodMetrics] = createSignal<PodMetricsInfo[]>([]);
const [metricsLoading, setMetricsLoading] = createSignal(false);
const [showMetricsPanel, setShowMetricsPanel] = createSignal(false);

export { clusterMetrics, podMetrics, metricsLoading, showMetricsPanel, setShowMetricsPanel };

export async function loadClusterMetrics() {
  try {
    setMetricsLoading(true);
    const ctx = activeContext();
    if (!ctx) return;
    const [summary, pods] = await Promise.all([
      invoke<ClusterMetricsSummary>("get_cluster_summary", {
        context: ctx,
        namespace: activeNamespace(),
      }),
      invoke<PodMetricsInfo[]>("get_pod_metrics", {
        context: ctx,
        namespace: activeNamespace(),
      }),
    ]);
    setClusterMetrics(summary);
    setPodMetrics(pods);
    setShowMetricsPanel(true);
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setMetricsLoading(false);
  }
}

// Auto-refresh
const [autoRefresh, setAutoRefresh] = createSignal(false);
const [autoRefreshSecs, setAutoRefreshSecs] = createSignal(10);
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

export { autoRefresh, autoRefreshSecs, setAutoRefresh, setAutoRefreshSecs };

export function startAutoRefresh() {
  stopAutoRefresh();
  setAutoRefresh(true);
  autoRefreshTimer = setInterval(() => {
    loadResources();
  }, autoRefreshSecs() * 1000);
}

export function stopAutoRefresh() {
  setAutoRefresh(false);
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

export function toggleAutoRefresh() {
  if (autoRefresh()) {
    stopAutoRefresh();
  } else {
    startAutoRefresh();
  }
}

// Label filtering
const [labelFilter, setLabelFilter] = createSignal("");
export { labelFilter, setLabelFilter };

const [searchQuery, setSearchQuery] = createSignal("");
export { searchQuery, setSearchQuery };

// Helm releases
export interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
}

const [helmReleases, setHelmReleases] = createSignal<HelmRelease[]>([]);
const [helmLoading, setHelmLoading] = createSignal(false);
const [showHelmPanel, setShowHelmPanel] = createSignal(false);

export { helmReleases, helmLoading, showHelmPanel, setShowHelmPanel };

export async function loadHelmReleases() {
  try {
    setHelmLoading(true);
    const ctx = activeContext();
    if (!ctx) return;
    const result = await invoke<HelmRelease[]>("list_helm_releases", {
      context: ctx,
      namespace: activeNamespace(),
    });
    setHelmReleases(result);
    setShowHelmPanel(true);
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setHelmLoading(false);
  }
}

// RBAC
export interface RbacBinding {
  name: string;
  namespace: string | null;
  kind: string;
  role_kind: string;
  role_name: string;
  subjects: RbacSubject[];
}

export interface RbacSubject {
  kind: string;
  name: string;
  namespace: string | null;
}

const [rbacBindings, setRbacBindings] = createSignal<RbacBinding[]>([]);
const [rbacLoading, setRbacLoading] = createSignal(false);
const [showRbacPanel, setShowRbacPanel] = createSignal(false);

export { rbacBindings, rbacLoading, showRbacPanel, setShowRbacPanel };

export async function loadRbac() {
  try {
    setRbacLoading(true);
    const ctx = activeContext();
    if (!ctx) return;
    const result = await invoke<RbacBinding[]>("list_rbac_bindings", {
      context: ctx,
      namespace: activeNamespace(),
    });
    setRbacBindings(result);
    setShowRbacPanel(true);
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setRbacLoading(false);
  }
}

// Alerts - critical cluster events
export interface ClusterAlert {
  id: string;
  severity: "critical" | "warning";
  title: string;
  message: string;
  resource: string;
  namespace: string | null;
  timestamp: string | null;
  reason: string | null;
  count: number;
}

const CRITICAL_REASONS = new Set([
  "CrashLoopBackOff", "OOMKilled", "OOMKilling", "Failed", "FailedScheduling",
  "FailedMount", "FailedAttachVolume", "Evicted", "BackOff", "Unhealthy",
  "NodeNotReady", "FailedCreate", "FailedSync", "DeadlineExceeded",
  "FreeDiskSpaceFailed", "InsufficientMemory", "InsufficientCPU",
]);

const WARNING_REASONS = new Set([
  "FailedPullImage", "ImagePullBackOff", "ErrImagePull", "Killing",
  "Preempting", "ExceededGracePeriod", "ContainerGCFailed",
  "FailedToUpdateEndpoint", "NetworkNotReady",
]);

const [alerts, setAlerts] = createSignal<ClusterAlert[]>([]);
const [alertsDismissed, setAlertsDismissed] = createSignal<Set<string>>(new Set());
let alertsUnlisten: UnlistenFn | null = null;

export { alerts, alertsDismissed, setAlertsDismissed };

export function activeAlerts() {
  const dismissed = alertsDismissed();
  return alerts().filter(a => !dismissed.has(a.id));
}

function eventToAlert(ev: K8sEvent): ClusterAlert | null {
  if (ev.event_type !== "Warning") return null;
  const reason = ev.reason || "";
  let severity: "critical" | "warning" = "warning";
  if (CRITICAL_REASONS.has(reason)) {
    severity = "critical";
  } else if (WARNING_REASONS.has(reason)) {
    severity = "warning";
  } else {
    return null;
  }

  // Filter out events older than 1 hour
  const lastSeen = ev.last_seen ? new Date(ev.last_seen) : null;
  if (lastSeen) {
    const ageMs = Date.now() - lastSeen.getTime();
    if (ageMs > 60 * 60 * 1000) return null;
  }

  // Format display timestamp (show relative time)
  let displayTime: string | null = null;
  if (lastSeen && !isNaN(lastSeen.getTime())) {
    const ageMin = Math.floor((Date.now() - lastSeen.getTime()) / 60000);
    if (ageMin < 1) displayTime = "just now";
    else if (ageMin < 60) displayTime = `${ageMin}m ago`;
    else displayTime = `${Math.floor(ageMin / 60)}h ago`;
  }

  const id = `${ev.namespace || ""}/${ev.kind || ""}/${ev.name || ""}/${reason}`;
  return {
    id,
    severity,
    title: `${reason}: ${ev.kind || ""}/${ev.name || ""}`,
    message: ev.message || "",
    resource: `${ev.kind || ""}/${ev.name || ""}`,
    namespace: ev.namespace || null,
    timestamp: displayTime,
    reason,
    count: ev.count || 1,
  };
}

function sortAlerts(list: ClusterAlert[]): ClusterAlert[] {
  return list.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return b.count - a.count;
  }).slice(0, 50);
}

export async function loadAlerts() {
  try {
    const ctx = activeContext();
    if (!ctx) return;
    const evts = await invoke<K8sEvent[]>("list_events", {
      context: ctx,
      namespace: "_all",
    });

    const newAlerts: ClusterAlert[] = [];
    for (const ev of evts) {
      const alert = eventToAlert(ev);
      if (alert) newAlerts.push(alert);
    }

    setAlerts(sortAlerts(newAlerts));
  } catch {
    // silently fail - alerts are non-critical
  }
}

export async function startAlertPolling() {
  stopAlertPolling();
  // 1. Load existing alerts
  loadAlerts();

  // 2. Start live event watcher
  const ctx = activeContext();
  if (!ctx) return;

  try {
    await invoke("watch_events", { context: ctx });
    alertsUnlisten = await listen<K8sEvent>("cluster-alert", (event) => {
      const alert = eventToAlert(event.payload);
      if (!alert) return;

      setAlerts(prev => {
        // Update existing alert or add new one
        const existing = prev.findIndex(a => a.id === alert.id);
        let updated: ClusterAlert[];
        if (existing >= 0) {
          updated = [...prev];
          updated[existing] = { ...alert, count: Math.max(alert.count, prev[existing].count) };
        } else {
          updated = [alert, ...prev];
        }
        return sortAlerts(updated);
      });
    });
    console.log("[r3x] Live event watcher started");
  } catch (e) {
    console.warn("[r3x] Live watch failed, falling back to polling:", e);
    // Fallback: poll every 30s if watch fails
    const timer = setInterval(loadAlerts, 30000);
    alertsUnlisten = () => clearInterval(timer);
  }
}

export function stopAlertPolling() {
  if (alertsUnlisten) {
    alertsUnlisten();
    alertsUnlisten = null;
  }
}

export function dismissAlert(id: string) {
  setAlertsDismissed(prev => new Set([...prev, id]));
}

export function dismissAllAlerts() {
  setAlertsDismissed(new Set(alerts().map(a => a.id)));
}

const LOG_ERROR_PATTERN = /\b(ERROR|FATAL|PANIC|CRIT(ICAL)?)\b/i;

export function pushLogAlert(pod: string, container: string, namespace: string, message: string) {
  if (!LOG_ERROR_PATTERN.test(message)) return;

  const id = `log/${namespace}/${pod}/${container}/${message.slice(0, 80)}`;
  const existing = alerts();
  const idx = existing.findIndex(a => a.id === id);
  if (idx >= 0) {
    // Bump count for duplicate
    const updated = [...existing];
    updated[idx] = { ...updated[idx], count: updated[idx].count + 1 };
    setAlerts(updated);
    return;
  }

  const alert: ClusterAlert = {
    id,
    severity: "critical",
    title: `Log error in ${pod}`,
    message: message.length > 200 ? message.slice(0, 200) + "…" : message,
    resource: `Pod/${pod}`,
    namespace,
    timestamp: "just now",
    reason: "LogError",
    count: 1,
  };
  setAlerts(sortAlerts([alert, ...existing]));
}

// Workload aggregated logs
export interface WorkloadLogLine {
  pod: string;
  container: string;
  timestamp: string;
  message: string;
}

export async function getWorkloadLogs(
  namespace: string,
  kind: string,
  name: string,
  tailLines?: number
): Promise<WorkloadLogLine[]> {
  const ctx = activeContext();
  return invoke<WorkloadLogLine[]>("get_workload_logs", {
    context: ctx,
    namespace,
    kind,
    name,
    tailLines: tailLines || 50,
  });
}

// Workload log streaming
export async function streamWorkloadLogs(
  namespace: string,
  kind: string,
  name: string
): Promise<string> {
  const ctx = activeContext();
  return invoke<string>("stream_workload_logs", {
    context: ctx,
    namespace,
    kind,
    name,
  });
}

// Traffic distribution
export interface PodTraffic {
  pod_name: string;
  namespace: string;
  node: string;
  age: string;
  rx_rate: number;
  tx_rate: number;
  rx_rate_fmt: string;
  tx_rate_fmt: string;
  total_rate: number;
  total_rate_fmt: string;
  pct_of_total: number;
  rx_bytes: number;
  tx_bytes: number;
  rx_fmt: string;
  tx_fmt: string;
}

export interface TrafficDistribution {
  workload_name: string;
  workload_kind: string;
  namespace: string;
  pod_count: number;
  total_rx_rate: number;
  total_tx_rate: number;
  total_rx_rate_fmt: string;
  total_tx_rate_fmt: string;
  pods: PodTraffic[];
  balance_score: number;
  sample_interval_secs: number;
}

export async function getTrafficDistribution(
  namespace: string,
  kind: string,
  name: string
): Promise<TrafficDistribution> {
  const ctx = activeContext();
  return invoke<TrafficDistribution>("get_traffic_distribution", {
    context: ctx,
    namespace,
    kind,
    name,
  });
}

// Restart history
export interface RestartEvent {
  pod_name: string;
  container: string;
  namespace: string;
  reason: string;
  exit_code: number;
  finished_at: string | null;
  started_at: string | null;
  message: string | null;
  source: string;
}

export interface ContainerRestartInfo {
  name: string;
  restart_count: number;
  current_state: string;
  current_ready: boolean;
  last_reason: string | null;
  last_exit_code: number | null;
  last_finished_at: string | null;
}

export interface PodRestartInfo {
  pod_name: string;
  namespace: string;
  node: string;
  age: string;
  total_restarts: number;
  containers: ContainerRestartInfo[];
}

export interface RestartHistory {
  workload_name: string;
  workload_kind: string;
  namespace: string;
  total_restarts: number;
  pod_count: number;
  pods: PodRestartInfo[];
  timeline: RestartEvent[];
}

export async function getRestartHistory(
  namespace: string,
  kind: string,
  name: string
): Promise<RestartHistory> {
  const ctx = activeContext();
  return invoke<RestartHistory>("get_restart_history", {
    context: ctx,
    namespace,
    kind,
    name,
  });
}

// Cost estimation
export interface ContainerCost {
  name: string;
  cpu_request: string;
  memory_request: string;
  cpu_request_cores: number;
  memory_request_gb: number;
  cpu_monthly: number;
  memory_monthly: number;
  total_monthly: number;
}

export interface PodCost {
  pod_name: string;
  containers: ContainerCost[];
  total_monthly: number;
}

export interface ProviderPricing {
  provider: string;
  tier: string;
  cpu_hourly: number;
  memory_gb_hourly: number;
  total_monthly: number;
  savings_pct: number;
}

export interface CostEstimation {
  workload_name: string;
  workload_kind: string;
  namespace: string;
  pod_count: number;
  replica_count: number;
  total_cpu_cores: number;
  total_memory_gb: number;
  total_cpu_request_fmt: string;
  total_memory_request_fmt: string;
  providers: ProviderPricing[];
  pods: PodCost[];
  selected_provider: string;
}

export async function estimateCost(
  namespace: string,
  kind: string,
  name: string
): Promise<CostEstimation> {
  const ctx = activeContext();
  return invoke<CostEstimation>("estimate_cost", {
    context: ctx,
    namespace,
    kind,
    name,
  });
}

// Image scanning
export interface ImageFinding {
  severity: string;
  title: string;
  description: string;
}

export interface CveDetail {
  id: string;
  severity: string;
  pkg_name: string;
  installed_version: string;
  fixed_version: string;
  title: string;
}

export interface CveSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  total: number;
  top_cves: CveDetail[];
}

export interface UniqueImage {
  image: string;
  registry: string;
  repository: string;
  tag: string;
  used_by: string[];
  pod_count: number;
  findings: ImageFinding[];
  risk_score: number;
  cve_summary: CveSummary | null;
  trivy_scanned: boolean;
  trivy_error: string | null;
}

export interface ImageScanResult {
  workload_name: string;
  workload_kind: string;
  namespace: string;
  total_images: number;
  unique_images: number;
  total_findings: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  images: UniqueImage[];
  overall_risk: number;
  trivy_available: boolean;
}

export async function scanImages(
  namespace: string,
  kind: string,
  name: string
): Promise<ImageScanResult> {
  const ctx = activeContext();
  return invoke<ImageScanResult>("scan_images", {
    context: ctx,
    namespace,
    kind,
    name,
  });
}

// HPA/VPA Autoscalers
export interface HpaMetricStatus {
  metric_name: string;
  metric_type: string;
  current_value: string;
  target_value: string;
  current_average: string | null;
}

export interface HpaCondition {
  condition_type: string;
  status: string;
  reason: string;
  message: string;
  last_transition: string;
}

export interface HpaInfo {
  name: string;
  namespace: string;
  target_kind: string;
  target_name: string;
  min_replicas: number;
  max_replicas: number;
  current_replicas: number;
  desired_replicas: number;
  metrics: HpaMetricStatus[];
  conditions: HpaCondition[];
  last_scale_time: string | null;
  age: string;
}

export interface VpaRecommendation {
  container_name: string;
  lower_cpu: string;
  lower_memory: string;
  target_cpu: string;
  target_memory: string;
  upper_cpu: string;
  upper_memory: string;
}

export interface VpaInfo {
  name: string;
  namespace: string;
  target_kind: string;
  target_name: string;
  update_mode: string;
  recommendations: VpaRecommendation[];
  age: string;
}

export interface AutoscalerInfo {
  hpas: HpaInfo[];
  vpas: VpaInfo[];
}

export async function getAutoscalers(namespace: string): Promise<AutoscalerInfo> {
  const ctx = activeContext();
  return invoke<AutoscalerInfo>("get_autoscalers", { context: ctx, namespace });
}

// CronJob detail & trigger
export interface JobRun {
  name: string;
  namespace: string;
  status: string;
  start_time: string | null;
  completion_time: string | null;
  duration_secs: number | null;
  completions: string;
  parallelism: number;
  active: number;
  succeeded: number;
  failed: number;
  age: string;
}

export interface CronJobDetail {
  name: string;
  namespace: string;
  schedule: string;
  suspend: boolean;
  active_count: number;
  last_schedule_time: string | null;
  last_successful_time: string | null;
  concurrency_policy: string;
  jobs: JobRun[];
  age: string;
}

export async function getCronJobDetail(
  namespace: string,
  name: string
): Promise<CronJobDetail> {
  const ctx = activeContext();
  return invoke<CronJobDetail>("get_cronjob_detail", { context: ctx, namespace, name });
}

export async function triggerCronJob(
  namespace: string,
  name: string
): Promise<string> {
  const ctx = activeContext();
  return invoke<string>("trigger_cronjob", { context: ctx, namespace, name });
}

// ConfigMap/Secret diff
export interface DiffLine {
  line_type: string;
  content: string;
  old_line: number | null;
  new_line: number | null;
}

export interface DiffResult {
  resource_name: string;
  resource_kind: string;
  namespace: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
  has_changes: boolean;
}

export async function diffResources(
  namespace: string,
  kind: string,
  name1: string,
  name2: string
): Promise<DiffResult> {
  const ctx = activeContext();
  return invoke<DiffResult>("diff_resources", { context: ctx, namespace, kind, name1, name2 });
}

export async function diffYaml(
  oldYaml: string,
  newYaml: string,
  resourceName: string,
  resourceKind: string,
  namespace: string
): Promise<DiffResult> {
  return invoke<DiffResult>("diff_yaml", {
    oldYaml, newYaml, resourceName, resourceKind, namespace,
  });
}

// Network Policy Visualization
export interface NetpolRule {
  direction: string;
  peer_kind: string;
  peer_label: string;
  ports: string[];
}

export interface NetpolInfo {
  name: string;
  namespace: string;
  pod_selector: string;
  matched_pods: string[];
  policy_types: string[];
  rules: NetpolRule[];
}

export interface NetpolEdge {
  from_id: string;
  to_id: string;
  policy_name: string;
  ports: string[];
  direction: string;
}

export interface NetpolNode {
  id: string;
  label: string;
  kind: string;
  namespace: string;
  has_netpol: boolean;
}

export interface NetpolGraph {
  policies: NetpolInfo[];
  nodes: NetpolNode[];
  edges: NetpolEdge[];
  unprotected_pods: string[];
  total_policies: number;
}

export async function getNetworkPolicies(namespace: string): Promise<NetpolGraph> {
  const ctx = activeContext();
  return invoke<NetpolGraph>("get_network_policies", { context: ctx, namespace });
}

// Cluster Health Score
export interface HealthComponent {
  name: string;
  score: number;
  status: string;
  details: string[];
}

export interface Recommendation {
  priority: string;
  category: string;
  title: string;
  description: string;
  action: string;
  impact: string;
}

export interface ClusterHealthScore {
  overall_score: number;
  overall_status: string;
  components: HealthComponent[];
  recommendations: Recommendation[];
  pod_count: number;
  node_count: number;
  namespace: string;
}

const [healthScore, setHealthScore] = createSignal<ClusterHealthScore | null>(null);
const [healthLoading, setHealthLoading] = createSignal(false);
const [showHealthPanel, setShowHealthPanel] = createSignal(false);

export { healthScore, healthLoading, showHealthPanel, setShowHealthPanel };

const [showNetpolPanel, setShowNetpolPanel] = createSignal(false);
export { showNetpolPanel, setShowNetpolPanel };

// Cluster Overview (Dashboard)
export interface WorkloadCount {
  kind: string;
  total: number;
  ready: number;
  not_ready: number;
}

export interface PodStatusBreakdown {
  running: number;
  pending: number;
  succeeded: number;
  failed: number;
  unknown: number;
  total: number;
}

export interface RecentEvent {
  event_type: string;
  reason: string;
  message: string;
  object: string;
  last_seen: string;
}

export interface ClusterOverview {
  namespace_count: number;
  workloads: WorkloadCount[];
  pod_status: PodStatusBreakdown;
  recent_warnings: RecentEvent[];
}

const [clusterOverview, setClusterOverview] = createSignal<ClusterOverview | null>(null);
const [overviewLoading, setOverviewLoading] = createSignal(false);
const [showDashboard, setShowDashboard] = createSignal(true); // Show by default

export { clusterOverview, overviewLoading, showDashboard, setShowDashboard };

// Close all view panels — ensures only one panel is visible at a time
export function closeAllViewPanels() {
  setShowDashboard(false);
  setShowTopologyPanel(false);
  setShowMetricsPanel(false);
  setShowHelmPanel(false);
  setShowRbacPanel(false);
  setShowHealthPanel(false);
  setShowNetpolPanel(false);
  setShowEventsPanel(false);
  setShowSecurityPanel(false);
  setActiveResourceKind("");
}

export async function loadClusterOverview() {
  try {
    setOverviewLoading(true);
    const ctx = activeContext();
    if (!ctx) return;
    const [overview, metrics] = await Promise.all([
      invoke<ClusterOverview>("get_cluster_overview", {
        context: ctx,
        namespace: activeNamespace(),
      }),
      invoke<ClusterMetricsSummary>("get_cluster_summary", {
        context: ctx,
        namespace: activeNamespace(),
      }).catch(() => null),
    ]);
    setClusterOverview(overview);
    if (metrics) setClusterMetrics(metrics);
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setOverviewLoading(false);
  }
}

export async function loadClusterHealth() {
  try {
    setHealthLoading(true);
    const ctx = activeContext();
    if (!ctx) return;
    const result = await invoke<ClusterHealthScore>("get_cluster_health", {
      context: ctx,
      namespace: activeNamespace(),
    });
    setHealthScore(result);
    setShowHealthPanel(true);
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setHealthLoading(false);
  }
}

// Namespace favorites (persisted in localStorage)
const FAVORITES_KEY = "r3x-ns-favorites";

function loadFavorites(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
  } catch {
    return [];
  }
}

const [favoriteNamespaces, setFavoriteNamespaces] = createSignal<string[]>(loadFavorites());
export { favoriteNamespaces };

export function toggleFavoriteNamespace(ns: string) {
  setFavoriteNamespaces(prev => {
    const updated = prev.includes(ns)
      ? prev.filter(n => n !== ns)
      : [...prev, ns];
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(updated));
    return updated;
  });
}

export function isFavoriteNamespace(ns: string): boolean {
  return favoriteNamespaces().includes(ns);
}

// Benchmark - global state so it persists across panel navigation
export interface BenchmarkProgress {
  bench_id: string;
  sample: number;
  total: number;
  elapsed_secs: number;
  duration_secs: number;
}

const [benchmarkResult, setBenchmarkResult] = createSignal<any>(null);
const [benchmarking, setBenchmarking] = createSignal(false);
const [benchmarkProgress, setBenchmarkProgress] = createSignal<BenchmarkProgress | null>(null);
const [benchmarkDuration, setBenchmarkDuration] = createSignal(60);
const [benchmarkInterval, setBenchmarkInterval] = createSignal(5);
const [benchmarkPodName, setBenchmarkPodName] = createSignal("");
let benchmarkProgressUnlisten: UnlistenFn | null = null;
let benchmarkCompleteUnlisten: UnlistenFn | null = null;
let benchmarkErrorUnlisten: UnlistenFn | null = null;

export {
  benchmarkResult, setBenchmarkResult,
  benchmarking, setBenchmarking,
  benchmarkProgress, setBenchmarkProgress,
  benchmarkDuration, setBenchmarkDuration,
  benchmarkInterval, setBenchmarkInterval,
  benchmarkPodName, setBenchmarkPodName,
};

export async function startBenchmark(namespace: string, podName: string) {
  const ctx = activeContext();
  if (!ctx) return;

  setBenchmarking(true);
  setBenchmarkResult(null);
  setBenchmarkProgress(null);
  setBenchmarkPodName(podName);

  // Clean up previous listeners
  if (benchmarkProgressUnlisten) benchmarkProgressUnlisten();
  if (benchmarkCompleteUnlisten) benchmarkCompleteUnlisten();
  if (benchmarkErrorUnlisten) benchmarkErrorUnlisten();

  benchmarkProgressUnlisten = await listen<BenchmarkProgress>("benchmark-progress", (event) => {
    setBenchmarkProgress(event.payload);
  });

  benchmarkCompleteUnlisten = await listen<any>("benchmark-complete", (event) => {
    setBenchmarkResult(event.payload);
    setBenchmarking(false);
    setBenchmarkProgress(null);
    cleanupBenchmarkListeners();
    // Push alert notification so user knows it's done
    const alert: ClusterAlert = {
      id: `benchmark-done-${Date.now()}`,
      severity: "warning",
      title: `Benchmark complete: ${podName}`,
      message: `${event.payload.total_samples} samples collected over ${event.payload.duration_secs}s`,
      resource: `Pod/${podName}`,
      namespace,
      timestamp: "just now",
      reason: "BenchmarkDone",
      count: 1,
    };
    setAlerts(prev => [alert, ...prev].slice(0, 50));
  });

  benchmarkErrorUnlisten = await listen<any>("benchmark-error", (event) => {
    setBenchmarking(false);
    setBenchmarkProgress(null);
    cleanupBenchmarkListeners();
    const alert: ClusterAlert = {
      id: `benchmark-err-${Date.now()}`,
      severity: "critical",
      title: `Benchmark failed: ${podName}`,
      message: event.payload.error,
      resource: `Pod/${podName}`,
      namespace,
      timestamp: "just now",
      reason: "BenchmarkError",
      count: 1,
    };
    setAlerts(prev => [alert, ...prev].slice(0, 50));
  });

  try {
    await invoke<string>("benchmark_pod", {
      context: ctx,
      namespace,
      podName,
      durationSecs: benchmarkDuration(),
      intervalSecs: benchmarkInterval(),
    });
  } catch (e: any) {
    setBenchmarking(false);
    cleanupBenchmarkListeners();
  }
}

function cleanupBenchmarkListeners() {
  if (benchmarkProgressUnlisten) { benchmarkProgressUnlisten(); benchmarkProgressUnlisten = null; }
  if (benchmarkCompleteUnlisten) { benchmarkCompleteUnlisten(); benchmarkCompleteUnlisten = null; }
  if (benchmarkErrorUnlisten) { benchmarkErrorUnlisten(); benchmarkErrorUnlisten = null; }
}

// Log streaming
export async function streamPodLogs(
  namespace: string,
  podName: string,
  container?: string
): Promise<string> {
  const ctx = activeContext();
  const eventName = `log-stream-${namespace}-${podName}`;
  await invoke("stream_pod_logs", {
    context: ctx,
    namespace,
    podName,
    container: container || null,
  });
  return eventName;
}
