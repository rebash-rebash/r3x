import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

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
  { key: "persistentvolumeclaims", label: "PVCs", icon: "💾" },
  { key: "nodes", label: "Nodes", icon: "🖥" },
] as const;

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
  } catch (e: any) {
    setError(e.toString());
  } finally {
    setLoading(false);
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
    setLoading(true);
    setError(null);
    setResourceMetrics({});
    setActiveCrd(null);
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
