import { createSignal, createEffect, Show, For, onCleanup } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
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
  WorkloadLogLine,
  getWorkloadLogs,
  streamWorkloadLogs,
  pushLogAlert,
  TrafficDistribution,
  getTrafficDistribution,
  benchmarkResult, setBenchmarkResult,
  benchmarking,
  benchmarkProgress,
  benchmarkDuration, setBenchmarkDuration,
  benchmarkInterval, setBenchmarkInterval,
  benchmarkPodName,
  startBenchmark,
  RestartHistory,
  getRestartHistory,
  CostEstimation,
  estimateCost,
  ImageScanResult,
  scanImages,
  AutoscalerInfo,
  getAutoscalers,
  CronJobDetail,
  getCronJobDetail,
  triggerCronJob,
  DiffResult,
  diffResources,
  resources,
  ResourceDescribe,
  describeResource,
  getPodPorts,
  startPortForward,
  stopPortForward,
  refreshPortForwards,
  portForwards,
  ContainerPort as ContainerPortInfo,
} from "../stores/k8s";
import Terminal from "./Terminal";

type DetailTab = "yaml" | "containers" | "pods" | "logs" | "labels" | "exec" | "describe" | "events" | "benchmark" | "traffic" | "restarts" | "cost" | "images" | "hpa" | "cronjob" | "diff";

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
  const [workloadLogs, setWorkloadLogs] = createSignal<WorkloadLogLine[]>([]);
  const [workloadLogFilter, setWorkloadLogFilter] = createSignal("");
  const [workloadLogsLoading, setWorkloadLogsLoading] = createSignal(false);
  const [workloadStreaming, setWorkloadStreaming] = createSignal(false);
  let execTabCounter = 1;
  let unlistenStream: (() => void) | null = null;
  let unlistenWorkloadStream: (() => void) | null = null;
  const [trafficData, setTrafficData] = createSignal<TrafficDistribution | null>(null);
  const [trafficLoading, setTrafficLoading] = createSignal(false);
  const [restartData, setRestartData] = createSignal<RestartHistory | null>(null);
  const [restartLoading, setRestartLoading] = createSignal(false);
  const [costData, setCostData] = createSignal<CostEstimation | null>(null);
  const [costLoading, setCostLoading] = createSignal(false);
  const [imageData, setImageData] = createSignal<ImageScanResult | null>(null);
  const [imageLoading, setImageLoading] = createSignal(false);
  const [hpaData, setHpaData] = createSignal<AutoscalerInfo | null>(null);
  const [hpaLoading, setHpaLoading] = createSignal(false);
  const [cronJobData, setCronJobData] = createSignal<CronJobDetail | null>(null);
  const [cronJobLoading, setCronJobLoading] = createSignal(false);
  const [triggering, setTriggering] = createSignal(false);
  const [diffData, setDiffData] = createSignal<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = createSignal(false);
  const [diffTarget, setDiffTarget] = createSignal("");
  const [describeData, setDescribeData] = createSignal<ResourceDescribe | null>(null);
  const [describeLoading, setDescribeLoading] = createSignal(false);
  const [pfPorts, setPfPorts] = createSignal<ContainerPortInfo[]>([]);
  const [pfLocalPort, setPfLocalPort] = createSignal("");
  const [pfRemotePort, setPfRemotePort] = createSignal<number | null>(null);
  const [pfStarting, setPfStarting] = createSignal(false);
  const [pfError, setPfError] = createSignal<string | null>(null);
  const [showPfPopover, setShowPfPopover] = createSignal(false);
  const [pfPopoverPos, setPfPopoverPos] = createSignal({ top: 0, right: 0 });

  const resource = () => selectedResource();
  const isPod = () => resource()?.kind === "Pod";
  const isWorkload = () => {
    const k = resource()?.kind;
    return k === "Deployment" || k === "StatefulSet" || k === "DaemonSet" || k === "ReplicaSet";
  };
  const isNode = () => resource()?.kind === "Node";
  const isCronJob = () => resource()?.kind === "CronJob";
  const isConfigOrSecret = () => {
    const k = resource()?.kind;
    return k === "ConfigMap" || k === "Secret";
  };
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
    setActiveTab(res.kind === "Pod" ? "containers" : workloadKinds.includes(res.kind) ? "pods" : res.kind === "Node" ? "describe" : res.kind === "CronJob" ? "cronjob" : "yaml");
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
    if (unlistenWorkloadStream) { unlistenWorkloadStream(); unlistenWorkloadStream = null; }
    setWorkloadStreaming(false);
    setWorkloadLogs([]);
    setShowPfPopover(false);

    // Fire all API calls in parallel for speed
    const promises: Promise<any>[] = [];
    const ns = res.namespace || "default";
    const ctx = activeContext();

    // YAML (always needed)
    promises.push(
      getResourceYaml(ns, res.kind, res.name)
        .then((y) => {
          setYaml(y);
          if (isScalable()) {
            const match = y.match(/replicas:\s*(\d+)/);
            if (match) setReplicaCount(parseInt(match[1]));
          }
        })
        .catch((e: any) => { setYaml(`# Error loading YAML:\n# ${e}`); })
    );

    if (isPod()) {
      // Containers
      promises.push(
        getPodContainers(ns, res.name)
          .then((c) => { setContainers(c); if (c.length > 0) setSelectedContainer(c[0]); })
          .catch(() => { setContainers([]); })
      );
      // Container metrics
      if (ctx) {
        promises.push(
          invoke<PodMetricsInfo[]>("get_pod_metrics", { context: ctx, namespace: ns })
            .then((metrics) => {
              const podM = metrics.find((m) => m.name === res.name);
              if (podM) {
                const map: Record<string, ContainerMetricsInfo> = {};
                for (const cm of podM.containers) map[cm.name] = cm;
                setContainerMetrics(map);
              }
            })
            .catch(() => {})
        );
      }
      // Pod ports for port-forward
      promises.push(
        getPodPorts(ns, res.name).then((ports) => { setPfPorts(ports); }).catch(() => { setPfPorts([]); })
      );
      refreshPortForwards();
    }

    if (isWorkload()) {
      // Workload pods
      promises.push(
        getResourcePods(ns, res.kind, res.name).then((pods) => { setResourcePods(pods); }).catch(() => { setResourcePods([]); })
      );
      // Pod metrics for workload
      if (ctx) {
        promises.push(
          invoke<PodMetricsInfo[]>("get_pod_metrics", { context: ctx, namespace: ns })
            .then((metrics) => {
              const map: Record<string, PodMetricsInfo> = {};
              for (const m of metrics) map[m.name] = m;
              setPodMetricsMap(map);
            })
            .catch(() => {})
        );
      }
    }

    if (isNode()) {
      promises.push(
        getNodeDetails(res.name).then((info) => { setNodeInfo(info); }).catch(() => { setNodeInfo(null); })
      );
    }

    setShowPfPopover(false);
    setPfError(null);

    await Promise.all(promises);
    setDetailLoading(false);
  });

  async function loadDescribe() {
    const res = resource();
    if (!res) return;
    setDescribeLoading(true);
    try {
      if (res.kind === "Pod") {
        // Full pod describe via backend
        const data = await describeResource(res.namespace || "default", res.kind, res.name);
        setDescribeData(data);
      } else {
        // For non-pod resources, parse labels/annotations from already-loaded YAML
        // This avoids a second API call (and slow discovery for CRDs)
        const y = yaml();
        if (y && !y.startsWith("# Error")) {
          try {
            const lines = y.split("\n");
            const labels: [string, string][] = [];
            const annotations: [string, string][] = [];
            let creation = "";
            let section = "";
            for (const line of lines) {
              if (/^metadata:/.test(line)) { section = "metadata"; continue; }
              if (/^spec:/.test(line) || /^status:/.test(line) || /^[a-zA-Z]/.test(line)) { section = ""; continue; }
              if (section === "metadata") {
                if (/^\s+labels:/.test(line)) { section = "labels"; continue; }
                if (/^\s+annotations:/.test(line)) { section = "annotations"; continue; }
                const tsMatch = line.match(/^\s+creationTimestamp:\s*['\"]?(.+?)['\"]?\s*$/);
                if (tsMatch) creation = tsMatch[1];
              }
              if (section === "labels") {
                const m = line.match(/^\s{4}(\S+):\s*['\"]?(.*?)['\"]?\s*$/);
                if (m) labels.push([m[1], m[2]]);
                else if (!/^\s{4}/.test(line)) section = "metadata";
              }
              if (section === "annotations") {
                const m = line.match(/^\s{4}(\S+):\s*['\"]?(.*?)['\"]?\s*$/);
                if (m) annotations.push([m[1], m[2].length > 200 ? m[2].slice(0, 200) + "..." : m[2]]);
                else if (!/^\s{4}/.test(line)) section = "metadata";
              }
            }
            setDescribeData({
              kind: res.kind,
              name: res.name,
              namespace: res.namespace || "",
              labels,
              annotations,
              creation_timestamp: creation,
              pod: null,
            });
          } catch {
            // Fallback to backend if parsing fails
            const data = await describeResource(res.namespace || "default", res.kind, res.name);
            setDescribeData(data);
          }
        } else {
          // YAML not loaded yet, fallback to backend
          const data = await describeResource(res.namespace || "default", res.kind, res.name);
          setDescribeData(data);
        }
      }
    } catch {
      setDescribeData(null);
    }
    setDescribeLoading(false);
  }

  async function handlePortForward() {
    const res = resource();
    if (!res) return;
    const lp = parseInt(pfLocalPort());
    const rp = pfRemotePort();
    if (!lp || !rp || lp < 1 || rp < 1) {
      setPfError("Invalid port numbers");
      return;
    }
    setPfStarting(true);
    setPfError(null);
    try {
      await startPortForward(res.namespace || "default", res.name, lp, rp);
      setPfLocalPort("");
      setShowPfPopover(false);
    } catch (e: any) {
      setPfError(e.toString());
    }
    setPfStarting(false);
  }

  // Close port-forward popover on click outside
  function handleGlobalClick(e: MouseEvent) {
    if (!showPfPopover()) return;
    const target = e.target as HTMLElement;
    if (!target.closest(".pf-popover") && !target.closest(".pf-icon-btn")) {
      setShowPfPopover(false);
    }
  }

  createEffect(() => {
    if (showPfPopover()) {
      document.addEventListener("click", handleGlobalClick);
    } else {
      document.removeEventListener("click", handleGlobalClick);
    }
  });

  onCleanup(() => {
    document.removeEventListener("click", handleGlobalClick);
  });

  // Wrap tab switching to also close popover
  function switchTab(tab: DetailTab) {
    setShowPfPopover(false);
    setActiveTab(tab);
    if (tab === "describe") loadDescribe();
  }

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
        fieldSelector: `involvedObject.name=${res.name},involvedObject.kind=${res.kind}`,
      });
      setResourceEvents(allEvents);
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

  async function loadWorkloadLogs() {
    const res = resource();
    if (!res || !isWorkload()) return;
    setWorkloadLogsLoading(true);
    try {
      const lines = await getWorkloadLogs(
        res.namespace || "default",
        res.kind,
        res.name,
        100
      );
      setWorkloadLogs(lines);
    } catch (e: any) {
      setWorkloadLogs([{ pod: "error", container: "", timestamp: "", message: `[ERROR] ${e}` }]);
    }
    setWorkloadLogsLoading(false);
  }

  const filteredWorkloadLogs = () => {
    const filter = workloadLogFilter().toLowerCase();
    if (!filter) return workloadLogs();
    return workloadLogs().filter(
      (l) =>
        l.message.toLowerCase().includes(filter) ||
        l.pod.toLowerCase().includes(filter) ||
        l.container.toLowerCase().includes(filter)
    );
  };

  function exportWorkloadLogs() {
    const res = resource();
    const logLines = filteredWorkloadLogs();
    if (!res || logLines.length === 0) return;
    const content = logLines
      .map((l) => `${l.timestamp} [${l.pod}/${l.container}] ${l.message}`)
      .join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${res.name}-aggregated-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function toggleWorkloadStreaming() {
    const res = resource();
    if (!res || !isWorkload()) return;

    if (workloadStreaming()) {
      if (unlistenWorkloadStream) { unlistenWorkloadStream(); unlistenWorkloadStream = null; }
      setWorkloadStreaming(false);
      return;
    }

    try {
      const eventName = await streamWorkloadLogs(
        res.namespace || "default",
        res.kind,
        res.name
      );
      const unlisten = await listen<WorkloadLogLine>(eventName, (event) => {
        setWorkloadLogs((prev) => [...prev.slice(-500), event.payload]);
        const l = event.payload;
        pushLogAlert(l.pod, l.container, resource()?.namespace || "default", l.message);
      });
      unlistenWorkloadStream = unlisten;
      setWorkloadStreaming(true);
    } catch (e: any) {
      setWorkloadLogs((prev) => [...prev, { pod: "error", container: "", timestamp: "", message: `[ERROR] ${e}` }]);
    }
  }

  async function loadTraffic() {
    const res = resource();
    if (!res || !isWorkload()) return;
    setTrafficLoading(true);
    try {
      const data = await getTrafficDistribution(res.namespace || "default", res.kind, res.name);
      setTrafficData(data);
    } catch (e: any) {
      setTrafficData(null);
    }
    setTrafficLoading(false);
  }

  async function loadRestarts() {
    const res = resource();
    if (!res) return;
    setRestartLoading(true);
    try {
      const data = await getRestartHistory(res.namespace || "default", res.kind, res.name);
      setRestartData(data);
    } catch (e: any) {
      setRestartData(null);
    }
    setRestartLoading(false);
  }

  async function loadCost() {
    const res = resource();
    if (!res || !isWorkload()) return;
    setCostLoading(true);
    try {
      const data = await estimateCost(res.namespace || "default", res.kind, res.name);
      setCostData(data);
    } catch (e: any) {
      setCostData(null);
    }
    setCostLoading(false);
  }

  async function loadImages() {
    const res = resource();
    if (!res) return;
    setImageLoading(true);
    try {
      const data = await scanImages(res.namespace || "default", res.kind, res.name);
      setImageData(data);
    } catch (e: any) {
      setImageData(null);
    }
    setImageLoading(false);
  }

  createEffect(() => {
    if (activeTab() === "logs" && isPod()) {
      loadLogs();
    }
    if (activeTab() === "logs" && isWorkload()) {
      loadWorkloadLogs();
    }
    if (activeTab() === "events") {
      loadResourceEvents();
    }
    if (activeTab() === "traffic" && isWorkload()) {
      loadTraffic();
    }
    if (activeTab() === "restarts") {
      loadRestarts();
    }
    if (activeTab() === "cost" && isWorkload()) {
      loadCost();
    }
    if (activeTab() === "images") {
      loadImages();
    }
    if (activeTab() === "hpa" && isWorkload()) {
      loadHpa();
    }
    if (activeTab() === "cronjob" && isCronJob()) {
      loadCronJob();
    }
  });

  async function loadHpa() {
    const res = resource();
    if (!res) return;
    setHpaLoading(true);
    try {
      const data = await getAutoscalers(res.namespace || "default");
      setHpaData(data);
    } catch {
      setHpaData(null);
    }
    setHpaLoading(false);
  }

  async function loadCronJob() {
    const res = resource();
    if (!res || res.kind !== "CronJob") return;
    setCronJobLoading(true);
    try {
      const data = await getCronJobDetail(res.namespace || "default", res.name);
      setCronJobData(data);
    } catch {
      setCronJobData(null);
    }
    setCronJobLoading(false);
  }

  async function handleTriggerCronJob() {
    const res = resource();
    if (!res) return;
    setTriggering(true);
    try {
      const jobName = await triggerCronJob(res.namespace || "default", res.name);
      alert(`Job created: ${jobName}`);
      await loadCronJob();
    } catch (e: any) {
      alert(`Trigger failed: ${e}`);
    }
    setTriggering(false);
  }

  async function loadDiff() {
    const res = resource();
    const target = diffTarget();
    if (!res || !target) return;
    setDiffLoading(true);
    try {
      const data = await diffResources(res.namespace || "default", res.kind, res.name, target);
      setDiffData(data);
    } catch {
      setDiffData(null);
    }
    setDiffLoading(false);
  }

  function logLevelClass(msg: string): string {
    const upper = msg.toUpperCase();
    if (upper.includes("ERROR") || upper.includes("FATAL") || upper.includes("PANIC") || upper.includes("CRIT")) return "log-level-error";
    if (upper.includes("WARN")) return "log-level-warn";
    if (upper.includes("DEBUG") || upper.includes("TRACE")) return "log-level-debug";
    return "";
  }

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
      await loadResources();
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
        pushLogAlert(res.name, selectedContainer() || "", res.namespace || "default", event.payload);
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
      if (e.key === "d" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); switchTab("describe"); }
      if (e.key === "y" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); switchTab("yaml"); }
      if (e.key === "e" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        switchTab("yaml");
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
                onClick={() => switchTab("yaml")}
              >
                YAML
              </button>
              <Show when={isWorkload()}>
                <button
                  class={`detail-tab ${activeTab() === "pods" ? "active" : ""}`}
                  onClick={() => switchTab("pods")}
                >
                  Pods
                </button>
                <button
                  class={`detail-tab ${activeTab() === "logs" ? "active" : ""}`}
                  onClick={() => switchTab("logs")}
                >
                  Logs
                </button>
                <button
                  class={`detail-tab ${activeTab() === "traffic" ? "active" : ""}`}
                  onClick={() => switchTab("traffic")}
                >
                  Traffic
                </button>
                <button
                  class={`detail-tab ${activeTab() === "cost" ? "active" : ""}`}
                  onClick={() => switchTab("cost")}
                >
                  Cost
                </button>
                <button
                  class={`detail-tab ${activeTab() === "restarts" ? "active" : ""}`}
                  onClick={() => switchTab("restarts")}
                >
                  Restarts
                </button>
                <button
                  class={`detail-tab ${activeTab() === "images" ? "active" : ""}`}
                  onClick={() => switchTab("images")}
                >
                  Images
                </button>
                <button
                  class={`detail-tab ${activeTab() === "hpa" ? "active" : ""}`}
                  onClick={() => switchTab("hpa")}
                >
                  HPA/VPA
                </button>
              </Show>
              <Show when={isCronJob()}>
                <button
                  class={`detail-tab ${activeTab() === "cronjob" ? "active" : ""}`}
                  onClick={() => switchTab("cronjob")}
                >
                  Jobs
                </button>
              </Show>
              <Show when={isConfigOrSecret()}>
                <button
                  class={`detail-tab ${activeTab() === "diff" ? "active" : ""}`}
                  onClick={() => switchTab("diff")}
                >
                  Diff
                </button>
              </Show>
              <Show when={isPod()}>
                <button
                  class={`detail-tab ${activeTab() === "containers" ? "active" : ""}`}
                  onClick={() => switchTab("containers")}
                >
                  Containers
                </button>
                <button
                  class={`detail-tab ${activeTab() === "logs" ? "active" : ""}`}
                  onClick={() => switchTab("logs")}
                >
                  Logs
                </button>
                <button
                  class={`detail-tab ${activeTab() === "exec" ? "active" : ""}`}
                  onClick={() => switchTab("exec")}
                >
                  Exec
                </button>
              </Show>
              <button
                class={`detail-tab ${activeTab() === "describe" ? "active" : ""}`}
                onClick={() => switchTab("describe")}
              >
                Describe
              </button>
              <button
                class={`detail-tab ${activeTab() === "events" ? "active" : ""}`}
                onClick={() => switchTab("events")}
              >
                Events
              </button>
              <Show when={isPod()}>
                <button
                  class={`detail-tab ${activeTab() === "benchmark" ? "active" : ""}`}
                  onClick={() => switchTab("benchmark")}
                >
                  Benchmark
                </button>
                <button
                  class={`detail-tab ${activeTab() === "restarts" ? "active" : ""}`}
                  onClick={() => switchTab("restarts")}
                >
                  Restarts
                </button>
                <button
                  class={`detail-tab ${activeTab() === "images" ? "active" : ""}`}
                  onClick={() => switchTab("images")}
                >
                  Images
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
                    // Wait briefly for K8s to process the rollout
                    await new Promise((r) => setTimeout(r, 1500));
                    await loadResources();
                  } catch (e: any) {
                    alert(`Restart failed: ${e}`);
                  }
                  setRestarting(false);
                }}
              >
                {restarting() ? "Restarting..." : "Restart"}
              </button>
            </Show>

            <Show when={isPod()}>
              <button
                ref={(el) => { (el as any).__pfBtn = true; }}
                class={`action-btn pf-icon-btn ${showPfPopover() ? "active" : ""}`}
                title="Port Forward"
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setPfPopoverPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                  setShowPfPopover(!showPfPopover());
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </button>
              <Show when={showPfPopover()}>
                <div class="pf-popover" style={{ top: `${pfPopoverPos().top}px`, right: `${pfPopoverPos().right}px` }}>
                  <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-bottom": "6px", "text-transform": "uppercase", "letter-spacing": "0.5px" }}>
                    Port Forward — {resource()?.name}
                  </div>
                  <Show when={pfPorts().length > 0}>
                    <div style={{ "margin-bottom": "8px", display: "flex", gap: "4px", "flex-wrap": "wrap" }}>
                      <For each={pfPorts()}>
                        {(cp) => (
                          <button
                            class={`pf-port-chip ${pfRemotePort() === cp.port ? "active" : ""}`}
                            onClick={() => { setPfRemotePort(cp.port); setPfLocalPort(cp.port.toString()); }}
                          >
                            {cp.port}/{cp.protocol} <span style={{ color: "var(--text-muted)", "font-size": "10px" }}>{cp.container_name}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
                    <input
                      type="number"
                      placeholder="Local"
                      value={pfLocalPort()}
                      onInput={(e) => setPfLocalPort(e.currentTarget.value)}
                      style={{ width: "70px", padding: "4px 6px", "border-radius": "4px", border: "1px solid var(--border)", background: "var(--bg-secondary)", color: "var(--text-primary)", "font-size": "12px" }}
                    />
                    <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>→</span>
                    <input
                      type="number"
                      placeholder="Remote"
                      value={pfRemotePort() || ""}
                      onInput={(e) => setPfRemotePort(parseInt(e.currentTarget.value) || null)}
                      style={{ width: "70px", padding: "4px 6px", "border-radius": "4px", border: "1px solid var(--border)", background: "var(--bg-secondary)", color: "var(--text-primary)", "font-size": "12px" }}
                    />
                    <button class="action-btn" disabled={pfStarting()} onClick={handlePortForward} style={{ "font-size": "11px", padding: "4px 10px" }}>
                      {pfStarting() ? "..." : "Forward"}
                    </button>
                  </div>
                  <Show when={pfError()}>
                    <div style={{ color: "var(--danger)", "font-size": "11px", "margin-top": "4px" }}>{pfError()}</div>
                  </Show>
                  <Show when={portForwards().filter(p => p.pod_name === resource()?.name).length > 0}>
                    <div style={{ "margin-top": "8px", "border-top": "1px solid var(--border)", "padding-top": "6px" }}>
                      <For each={portForwards().filter(p => p.pod_name === resource()?.name)}>
                        {(pf) => {
                          const proto = pf.remote_port === 443 || pf.remote_port === 8443 ? "https" : "http";
                          const url = `${proto}://localhost:${pf.local_port}`;
                          return (
                            <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "font-size": "11px", padding: "3px 0" }}>
                              <a class="pf-link" onClick={() => openUrl(url)} title={`Open ${url} in browser`}>
                                {url}
                              </a>
                              <span style={{ color: "var(--text-muted)", margin: "0 6px" }}>→ {pf.remote_port}</span>
                              <button
                                class="action-btn danger"
                                style={{ "font-size": "10px", padding: "1px 6px" }}
                                onClick={async () => { await stopPortForward(pf.id); refreshPortForwards(); }}
                              >
                                Stop
                              </button>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
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

          <Show when={!detailLoading() && activeTab() === "logs" && isPod()}>
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
                    <div class={`log-line ${logLevelClass(message)}`}>
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

          <Show when={!detailLoading() && activeTab() === "logs" && isWorkload()}>
            <div class="log-controls">
              <input
                type="text"
                placeholder="Filter logs (pod, container, message)..."
                value={workloadLogFilter()}
                onInput={(e) => setWorkloadLogFilter(e.currentTarget.value)}
              />
              <button class="action-btn" onClick={loadWorkloadLogs}>
                Refresh
              </button>
              <button
                class={`action-btn ${workloadStreaming() ? "streaming-active" : ""}`}
                onClick={toggleWorkloadStreaming}
              >
                {workloadStreaming() ? "Stop Stream" : "Stream"}
              </button>
              <button class="action-btn" onClick={exportWorkloadLogs} title="Download logs">
                Export
              </button>
              <span class="resource-count" style={{ "margin-left": "auto" }}>
                {filteredWorkloadLogs().length} lines from {new Set(workloadLogs().map(l => l.pod)).size} pod(s)
                {workloadStreaming() ? " (live)" : ""}
              </span>
            </div>
            <Show when={workloadLogsLoading()}>
              <div class="loading-overlay">
                <span class="spinner" />
                Loading logs from all pods...
              </div>
            </Show>
            <div class="log-viewer">
              <For each={filteredWorkloadLogs()}>
                {(line) => {
                  const podHash = line.pod.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
                  const colors = ["#4fc3f7", "#81c784", "#ffb74d", "#f06292", "#ba68c8", "#4dd0e1", "#aed581", "#ff8a65", "#9575cd", "#e57373"];
                  const podColor = colors[podHash % colors.length];
                  return (
                    <div class={`log-line ${logLevelClass(line.message)}`}>
                      <span class="log-timestamp">{line.timestamp}</span>
                      <span class="log-pod-tag" style={{ color: podColor, "font-weight": "600", "margin-right": "6px", "font-size": "11px" }}>
                        [{line.pod}/{line.container}]
                      </span>
                      <span class="log-message">{line.message}</span>
                    </div>
                  );
                }}
              </For>
              <Show when={!workloadLogsLoading() && filteredWorkloadLogs().length === 0}>
                <div class="empty-state">
                  <p>No logs available</p>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={!detailLoading() && activeTab() === "describe" && !isNode()}>
            <Show when={describeLoading()}>
              <div class="loading-overlay"><span class="spinner" /> Loading...</div>
            </Show>
            <Show when={!describeLoading() && describeData()}>
              {(() => {
                const d = describeData()!;
                const pod = d.pod;
                return (
                  <div style={{ padding: "12px 16px", overflow: "auto" }}>
                    {/* General */}
                    <h4 class="describe-section-title">General</h4>
                    <table class="resource-table">
                      <tbody>
                        <tr><td class="describe-label">Kind</td><td>{d.kind}</td></tr>
                        <tr><td class="describe-label">Name</td><td>{d.name}</td></tr>
                        <tr><td class="describe-label">Namespace</td><td>{d.namespace || "-"}</td></tr>
                        <tr><td class="describe-label">Created</td><td>{d.creation_timestamp || "-"}</td></tr>
                        <Show when={pod}>
                          <tr><td class="describe-label">Node</td><td>{pod!.node}</td></tr>
                          <tr><td class="describe-label">Status</td><td><span style={{ color: pod!.status === "Running" ? "var(--success)" : pod!.status === "Failed" ? "var(--danger)" : "var(--warning)", "font-weight": "600" }}>{pod!.status}</span></td></tr>
                          <tr><td class="describe-label">Pod IP</td><td>{pod!.pod_ip}</td></tr>
                          <tr><td class="describe-label">Host IP</td><td>{pod!.host_ip}</td></tr>
                          <tr><td class="describe-label">QoS Class</td><td>{pod!.qos_class}</td></tr>
                          <tr><td class="describe-label">Start Time</td><td>{pod!.start_time}</td></tr>
                          <tr><td class="describe-label">Service Account</td><td>{pod!.service_account}</td></tr>
                          <tr><td class="describe-label">Priority Class</td><td>{pod!.priority_class}</td></tr>
                          <tr><td class="describe-label">Restart Policy</td><td>{pod!.restart_policy}</td></tr>
                          <tr><td class="describe-label">DNS Policy</td><td>{pod!.dns_policy}</td></tr>
                        </Show>
                      </tbody>
                    </table>

                    {/* Labels */}
                    <h4 class="describe-section-title">Labels</h4>
                    <Show when={d.labels.length > 0} fallback={<div class="describe-empty">No labels</div>}>
                      <table class="resource-table">
                        <tbody>
                          <For each={d.labels}>
                            {([key, value]) => (
                              <tr><td class="describe-label">{key}</td><td style={{ "word-break": "break-all" }}>{value}</td></tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </Show>

                    {/* Annotations */}
                    <h4 class="describe-section-title">Annotations</h4>
                    <Show when={d.annotations.length > 0} fallback={<div class="describe-empty">No annotations</div>}>
                      <table class="resource-table">
                        <tbody>
                          <For each={d.annotations}>
                            {([key, value]) => (
                              <tr><td class="describe-label" style={{ "min-width": "200px" }}>{key}</td><td style={{ "word-break": "break-all", "font-size": "11px" }}>{value}</td></tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </Show>

                    {/* Pod-specific sections */}
                    <Show when={pod}>
                      {/* Conditions */}
                      <h4 class="describe-section-title">Conditions</h4>
                      <Show when={pod!.conditions.length > 0} fallback={<div class="describe-empty">No conditions</div>}>
                        <table class="resource-table">
                          <thead><tr><th>Type</th><th>Status</th><th>Reason</th><th>Message</th><th>Last Transition</th></tr></thead>
                          <tbody>
                            <For each={pod!.conditions}>
                              {(cond) => (
                                <tr>
                                  <td>{cond.condition_type}</td>
                                  <td><span style={{ color: cond.status === "True" ? "var(--success)" : "var(--text-muted)" }}>{cond.status}</span></td>
                                  <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>{cond.reason || "-"}</td>
                                  <td style={{ color: "var(--text-secondary)", "font-size": "11px", "max-width": "250px", overflow: "hidden", "text-overflow": "ellipsis" }}>{cond.message || "-"}</td>
                                  <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>{cond.last_transition || "-"}</td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </Show>

                      {/* Init Containers */}
                      <h4 class="describe-section-title">Init Containers ({pod!.init_containers.length})</h4>
                      <Show when={pod!.init_containers.length > 0} fallback={<div class="describe-empty">None</div>}>
                        <For each={pod!.init_containers}>
                          {(c) => (
                            <div class="describe-container-card">
                              <div class="describe-container-name">
                                {c.name}
                                <span style={{ "margin-left": "8px", "font-size": "10px", color: c.ready ? "var(--success)" : "var(--text-muted)" }}>
                                  {c.ready ? "Ready" : "Not Ready"}
                                </span>
                              </div>
                              <table class="resource-table">
                                <tbody>
                                  <tr><td class="describe-label">Image</td><td style={{ "word-break": "break-all" }}>{c.image}</td></tr>
                                  <tr><td class="describe-label">State</td><td><span style={{ color: c.state.startsWith("Running") ? "var(--success)" : c.state.startsWith("Terminated") ? "var(--text-muted)" : "var(--warning)" }}>{c.state}</span></td></tr>
                                  <tr><td class="describe-label">Ready</td><td>{c.ready ? "Yes" : "No"}</td></tr>
                                  <tr><td class="describe-label">Restarts</td><td>{c.restart_count}</td></tr>
                                  <tr><td class="describe-label">Ports</td><td>{c.ports.length > 0 ? c.ports.join(", ") : "None"}</td></tr>
                                  <tr><td class="describe-label">CPU</td><td>request: {c.cpu_request} / limit: {c.cpu_limit}</td></tr>
                                  <tr><td class="describe-label">Memory</td><td>request: {c.memory_request} / limit: {c.memory_limit}</td></tr>
                                  <tr><td class="describe-label">Liveness</td><td style={{ "font-size": "11px" }}>{c.liveness_probe}</td></tr>
                                  <tr><td class="describe-label">Readiness</td><td style={{ "font-size": "11px" }}>{c.readiness_probe}</td></tr>
                                  <tr><td class="describe-label">Startup</td><td style={{ "font-size": "11px" }}>{c.startup_probe}</td></tr>
                                  <tr><td class="describe-label">Env Vars</td><td>{c.env_count} variable{c.env_count !== 1 ? "s" : ""}</td></tr>
                                  <tr><td class="describe-label">Mounts</td><td style={{ "font-size": "11px" }}>{c.mounts.length > 0 ? <For each={c.mounts}>{(m) => <div>{m}</div>}</For> : "None"}</td></tr>
                                </tbody>
                              </table>
                            </div>
                          )}
                        </For>
                      </Show>

                      {/* Containers */}
                      <h4 class="describe-section-title">Containers ({pod!.containers.length})</h4>
                      <For each={pod!.containers}>
                        {(c) => (
                          <div class="describe-container-card">
                            <div class="describe-container-name">
                              {c.name}
                              <span style={{ "margin-left": "8px", "font-size": "10px", color: c.ready ? "var(--success)" : "var(--danger)" }}>
                                {c.ready ? "Ready" : "Not Ready"}
                              </span>
                            </div>
                            <table class="resource-table">
                              <tbody>
                                <tr><td class="describe-label">Image</td><td style={{ "word-break": "break-all" }}>{c.image}</td></tr>
                                <tr><td class="describe-label">State</td><td><span style={{ color: c.state.startsWith("Running") ? "var(--success)" : c.state.startsWith("Waiting") ? "var(--warning)" : "var(--danger)" }}>{c.state}</span></td></tr>
                                <tr><td class="describe-label">Ready</td><td>{c.ready ? "Yes" : "No"}</td></tr>
                                <tr><td class="describe-label">Restarts</td><td>{c.restart_count}</td></tr>
                                <tr><td class="describe-label">Ports</td><td>{c.ports.length > 0 ? c.ports.join(", ") : "None"}</td></tr>
                                <tr><td class="describe-label">CPU</td><td>request: {c.cpu_request} / limit: {c.cpu_limit}</td></tr>
                                <tr><td class="describe-label">Memory</td><td>request: {c.memory_request} / limit: {c.memory_limit}</td></tr>
                                <tr><td class="describe-label">Liveness</td><td style={{ "font-size": "11px" }}>{c.liveness_probe}</td></tr>
                                <tr><td class="describe-label">Readiness</td><td style={{ "font-size": "11px" }}>{c.readiness_probe}</td></tr>
                                <tr><td class="describe-label">Startup</td><td style={{ "font-size": "11px" }}>{c.startup_probe}</td></tr>
                                <tr><td class="describe-label">Env Vars</td><td>{c.env_count} variable{c.env_count !== 1 ? "s" : ""}</td></tr>
                                <tr><td class="describe-label">Mounts</td><td style={{ "font-size": "11px" }}>{c.mounts.length > 0 ? <For each={c.mounts}>{(m) => <div>{m}</div>}</For> : "None"}</td></tr>
                              </tbody>
                            </table>
                          </div>
                        )}
                      </For>

                      {/* Volumes */}
                      <h4 class="describe-section-title">Volumes ({pod!.volumes.length})</h4>
                      <Show when={pod!.volumes.length > 0} fallback={<div class="describe-empty">None</div>}>
                        <table class="resource-table">
                          <thead><tr><th>Name</th><th>Type</th><th>Details</th></tr></thead>
                          <tbody>
                            <For each={pod!.volumes}>
                              {(v) => (
                                <tr>
                                  <td>{v.name}</td>
                                  <td><span class="describe-badge">{v.volume_type}</span></td>
                                  <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>{v.details || "-"}</td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </Show>

                      {/* Tolerations */}
                      <h4 class="describe-section-title">Tolerations ({pod!.tolerations.length})</h4>
                      <Show when={pod!.tolerations.length > 0} fallback={<div class="describe-empty">None</div>}>
                        <div style={{ "font-size": "12px" }}>
                          <For each={pod!.tolerations}>
                            {(t) => <div style={{ padding: "2px 0", color: "var(--text-secondary)" }}>{t}</div>}
                          </For>
                        </div>
                      </Show>
                    </Show>
                  </div>
                );
              })()}
            </Show>
            <Show when={!describeLoading() && !describeData()}>
              <div class="empty-state"><p>Failed to load describe data</p></div>
            </Show>
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

          <Show when={activeTab() === "traffic" && isWorkload()}>
            <div style={{ padding: "12px 16px" }}>
              <Show when={trafficLoading()}>
                <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "20px 0" }}>
                  <span class="spinner" />
                  <span>Sampling live traffic (3s)...</span>
                </div>
              </Show>
              <Show when={!trafficLoading() && !trafficData()}>
                <div style={{ color: "var(--text-muted)", padding: "20px 0", "text-align": "center" }}>
                  No traffic data available. Requires kubelet stats API access.
                </div>
              </Show>
              <Show when={!trafficLoading() && trafficData()}>
                {(() => {
                  const data = trafficData()!;

                  function balanceColor(score: number): string {
                    if (score >= 80) return "var(--success)";
                    if (score >= 50) return "var(--warning)";
                    return "var(--danger)";
                  }

                  const maxRate = Math.max(...data.pods.map(p => p.total_rate), 0.001);

                  return (
                    <div>
                      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "16px" }}>
                        <div>
                          <span style={{ "font-weight": "600" }}>Live Network Throughput</span>
                          <span style={{ color: "var(--text-muted)", "font-size": "11px", "margin-left": "8px" }}>
                            {data.pod_count} pod{data.pod_count !== 1 ? "s" : ""} — sampled over {data.sample_interval_secs.toFixed(1)}s
                          </span>
                        </div>
                        <button class="action-btn" onClick={loadTraffic}>Refresh</button>
                      </div>

                      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr 1fr", gap: "12px", "margin-bottom": "16px" }}>
                        <div style={{ background: "var(--surface)", padding: "10px 12px", "border-radius": "6px", "border": "1px solid var(--border)" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "4px" }}>RX Rate</div>
                          <div style={{ "font-size": "16px", "font-weight": "600", color: "var(--accent)" }}>{data.total_rx_rate_fmt}</div>
                        </div>
                        <div style={{ background: "var(--surface)", padding: "10px 12px", "border-radius": "6px", "border": "1px solid var(--border)" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "4px" }}>TX Rate</div>
                          <div style={{ "font-size": "16px", "font-weight": "600", color: "var(--info)" }}>{data.total_tx_rate_fmt}</div>
                        </div>
                        <div style={{ background: "var(--surface)", padding: "10px 12px", "border-radius": "6px", "border": "1px solid var(--border)" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "4px" }}>Balance Score</div>
                          <div style={{ "font-size": "16px", "font-weight": "600", color: balanceColor(data.balance_score) }}>{data.balance_score.toFixed(0)}%</div>
                        </div>
                      </div>

                      <div style={{ "margin-bottom": "8px" }}>
                        <div style={{ "font-size": "11px", color: "var(--text-secondary)", "text-transform": "uppercase", "margin-bottom": "8px" }}>
                          Per-Pod Throughput
                        </div>
                        <For each={data.pods}>
                          {(pod) => (
                            <div style={{ "margin-bottom": "10px" }}>
                              <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "3px" }}>
                                <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                                  <span style={{ "font-size": "12px", "font-weight": "500" }}>{pod.pod_name}</span>
                                  <span style={{ "font-size": "10px", color: "var(--text-muted)", background: "var(--surface)", padding: "1px 5px", "border-radius": "3px" }}>
                                    {pod.age}
                                  </span>
                                  <span style={{ "font-size": "10px", color: "var(--text-muted)", background: "var(--surface)", padding: "1px 5px", "border-radius": "3px" }}>
                                    {pod.node}
                                  </span>
                                </div>
                                <div style={{ "font-size": "11px", "font-weight": "500" }}>
                                  {pod.pct_of_total.toFixed(1)}% — {pod.total_rate_fmt}
                                </div>
                              </div>
                              <div class="usage-bar" style={{ height: "16px", position: "relative" }}>
                                <div
                                  style={{
                                    position: "absolute",
                                    height: "100%",
                                    width: `${(pod.rx_rate / maxRate) * 100}%`,
                                    background: "var(--accent)",
                                    opacity: "0.8",
                                    "border-radius": "3px 0 0 3px",
                                  }}
                                />
                                <div
                                  style={{
                                    position: "absolute",
                                    height: "100%",
                                    left: `${(pod.rx_rate / maxRate) * 100}%`,
                                    width: `${(pod.tx_rate / maxRate) * 100}%`,
                                    background: "var(--info)",
                                    opacity: "0.8",
                                    "border-radius": "0 3px 3px 0",
                                  }}
                                />
                              </div>
                              <div style={{ display: "flex", gap: "12px", "font-size": "10px", color: "var(--text-muted)", "margin-top": "2px" }}>
                                <span>RX: {pod.rx_rate_fmt}</span>
                                <span>TX: {pod.tx_rate_fmt}</span>
                                <span style={{ "margin-left": "auto", opacity: "0.6" }}>cumulative: {pod.rx_fmt} / {pod.tx_fmt}</span>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>

                      <div style={{ display: "flex", gap: "12px", "font-size": "10px", color: "var(--text-muted)", "border-top": "1px solid var(--border)", "padding-top": "8px" }}>
                        <span style={{ display: "flex", "align-items": "center", gap: "4px" }}>
                          <span style={{ width: "8px", height: "8px", background: "var(--accent)", "border-radius": "2px", display: "inline-block" }} /> RX
                        </span>
                        <span style={{ display: "flex", "align-items": "center", gap: "4px" }}>
                          <span style={{ width: "8px", height: "8px", background: "var(--info)", "border-radius": "2px", display: "inline-block" }} /> TX
                        </span>
                        <span style={{ "margin-left": "auto" }}>
                          Live rates measured over 3s snapshot | Balance: 100% = even
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </Show>
            </div>
          </Show>

          <Show when={activeTab() === "restarts"}>
            <div style={{ padding: "12px 16px" }}>
              <Show when={restartLoading()}>
                <div class="loading-overlay">
                  <span class="spinner" />
                  Loading restart history...
                </div>
              </Show>
              <Show when={!restartLoading() && !restartData()}>
                <div class="empty-state">
                  <p>No restart data available</p>
                </div>
              </Show>
              <Show when={!restartLoading() && restartData()}>
                {(() => {
                  const data = restartData()!;

                  function reasonColor(reason: string): string {
                    if (reason === "OOMKilled") return "var(--danger)";
                    if (reason === "Error" || reason === "ContainerCannotRun") return "var(--danger)";
                    if (reason === "CrashLoopBackOff") return "var(--danger)";
                    if (reason === "Completed") return "var(--success)";
                    return "var(--warning)";
                  }

                  function formatTimeAgo(isoStr: string | null): string {
                    if (!isoStr) return "-";
                    const d = new Date(isoStr);
                    if (isNaN(d.getTime())) return isoStr;
                    const secs = Math.floor((Date.now() - d.getTime()) / 1000);
                    if (secs < 60) return "just now";
                    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
                    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
                    return `${Math.floor(secs / 86400)}d ago`;
                  }

                  return (
                    <div>
                      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "16px" }}>
                        <div>
                          <span style={{ "font-weight": "600" }}>Restart History</span>
                          <span style={{ color: "var(--text-muted)", "font-size": "11px", "margin-left": "8px" }}>
                            {data.pod_count} pod{data.pod_count !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <button class="action-btn" onClick={loadRestarts}>Refresh</button>
                      </div>

                      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "12px", "margin-bottom": "16px" }}>
                        <div style={{ background: "var(--surface)", padding: "10px 12px", "border-radius": "6px", border: "1px solid var(--border)" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "4px" }}>Total Restarts</div>
                          <div style={{ "font-size": "20px", "font-weight": "600", color: data.total_restarts > 0 ? "var(--warning)" : "var(--success)" }}>
                            {data.total_restarts}
                          </div>
                        </div>
                        <div style={{ background: "var(--surface)", padding: "10px 12px", "border-radius": "6px", border: "1px solid var(--border)" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "4px" }}>Pods with Restarts</div>
                          <div style={{ "font-size": "20px", "font-weight": "600", color: "var(--text-primary)" }}>
                            {data.pods.filter(p => p.total_restarts > 0).length} / {data.pod_count}
                          </div>
                        </div>
                      </div>

                      <Show when={data.timeline.length > 0}>
                        <div style={{ "margin-bottom": "16px" }}>
                          <div style={{ "font-size": "11px", color: "var(--text-secondary)", "text-transform": "uppercase", "margin-bottom": "8px" }}>
                            Recent Restart Events
                          </div>
                          <div class="restart-timeline">
                            <For each={data.timeline}>
                              {(evt) => (
                                <div class="restart-timeline-item">
                                  <div class="restart-timeline-dot" style={{ background: reasonColor(evt.reason) }} />
                                  <div class="restart-timeline-content">
                                    <div style={{ display: "flex", "align-items": "center", gap: "6px", "flex-wrap": "wrap" }}>
                                      <span class="restart-reason-badge" style={{ background: reasonColor(evt.reason) }}>
                                        {evt.reason}
                                      </span>
                                      <span style={{ "font-size": "12px", "font-weight": "500" }}>{evt.container}</span>
                                      <span style={{ "font-size": "11px", color: "var(--text-muted)" }}>in {evt.pod_name}</span>
                                      <Show when={evt.exit_code !== 0}>
                                        <span style={{ "font-size": "10px", color: "var(--danger)", background: "var(--surface)", padding: "1px 5px", "border-radius": "3px" }}>
                                          exit: {evt.exit_code}
                                        </span>
                                      </Show>
                                    </div>
                                    <Show when={evt.message}>
                                      <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-top": "2px" }}>
                                        {evt.message!.length > 150 ? evt.message!.slice(0, 150) + "..." : evt.message}
                                      </div>
                                    </Show>
                                    <div style={{ "font-size": "10px", color: "var(--text-muted)", "margin-top": "2px" }}>
                                      {formatTimeAgo(evt.finished_at)}
                                      <Show when={evt.finished_at}>
                                        <span style={{ "margin-left": "8px" }}>{new Date(evt.finished_at!).toLocaleString()}</span>
                                      </Show>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>

                      <div style={{ "font-size": "11px", color: "var(--text-secondary)", "text-transform": "uppercase", "margin-bottom": "8px" }}>
                        Per-Pod Breakdown
                      </div>
                      <table class="resource-table">
                        <thead>
                          <tr>
                            <th>Pod</th>
                            <th>Container</th>
                            <th>Restarts</th>
                            <th>State</th>
                            <th>Last Reason</th>
                            <th>Last Exit</th>
                            <th>Last Restart</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={data.pods}>
                            {(pod) => (
                              <For each={pod.containers}>
                                {(c, idx) => (
                                  <tr>
                                    <td>{idx() === 0 ? pod.pod_name : ""}</td>
                                    <td>{c.name}</td>
                                    <td style={{ color: c.restart_count > 0 ? "var(--warning)" : "var(--text-secondary)", "font-weight": c.restart_count > 0 ? "600" : "400" }}>
                                      {c.restart_count}
                                    </td>
                                    <td>
                                      <span class={`status ${c.current_state === "Running" ? "status-running" : c.current_state === "Waiting" || c.current_state === "CrashLoopBackOff" ? "status-pending" : "status-failed"}`}>
                                        <span class="status-dot" />
                                        {c.current_state}
                                      </span>
                                    </td>
                                    <td>
                                      <Show when={c.last_reason}>
                                        <span style={{ color: reasonColor(c.last_reason!), "font-size": "11px" }}>{c.last_reason}</span>
                                      </Show>
                                      <Show when={!c.last_reason}>
                                        <span style={{ color: "var(--text-muted)" }}>-</span>
                                      </Show>
                                    </td>
                                    <td style={{ color: c.last_exit_code != null && c.last_exit_code !== 0 ? "var(--danger)" : "var(--text-secondary)" }}>
                                      {c.last_exit_code != null ? c.last_exit_code : "-"}
                                    </td>
                                    <td style={{ "font-size": "11px", color: "var(--text-secondary)" }}>
                                      {formatTimeAgo(c.last_finished_at)}
                                    </td>
                                  </tr>
                                )}
                              </For>
                            )}
                          </For>
                        </tbody>
                      </table>

                      <Show when={data.total_restarts === 0}>
                        <div style={{ "text-align": "center", padding: "20px", color: "var(--success)" }}>
                          No restarts recorded — all containers are stable.
                        </div>
                      </Show>
                    </div>
                  );
                })()}
              </Show>
            </div>
          </Show>

          <Show when={activeTab() === "cost" && isWorkload()}>
            <div style={{ padding: "12px 16px" }}>
              <Show when={costLoading()}>
                <div class="loading-overlay">
                  <span class="spinner" />
                  Estimating costs...
                </div>
              </Show>
              <Show when={!costLoading() && !costData()}>
                <div class="empty-state">
                  <p>No cost data available. Ensure pods have CPU/memory requests set.</p>
                </div>
              </Show>
              <Show when={!costLoading() && costData()}>
                {(() => {
                  const data = costData()!;

                  function formatUSD(val: number): string {
                    if (val < 0.01) return "<$0.01";
                    return `$${val.toFixed(2)}`;
                  }

                  return (
                    <div>
                      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "16px" }}>
                        <div>
                          <span style={{ "font-weight": "600" }}>Resource Cost Estimation</span>
                          <span style={{ color: "var(--text-muted)", "font-size": "11px", "margin-left": "8px" }}>
                            {data.pod_count} pod{data.pod_count !== 1 ? "s" : ""} — {data.replica_count > 0 ? `${data.replica_count} replicas` : "DaemonSet"}
                          </span>
                        </div>
                        <button class="action-btn" onClick={loadCost}>Refresh</button>
                      </div>

                      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "12px", "margin-bottom": "16px" }}>
                        <div style={{ background: "var(--surface)", padding: "10px 12px", "border-radius": "6px", border: "1px solid var(--border)" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "4px" }}>Total CPU Requests</div>
                          <div style={{ "font-size": "16px", "font-weight": "600", color: "var(--accent)" }}>{data.total_cpu_request_fmt}</div>
                        </div>
                        <div style={{ background: "var(--surface)", padding: "10px 12px", "border-radius": "6px", border: "1px solid var(--border)" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "4px" }}>Total Memory Requests</div>
                          <div style={{ "font-size": "16px", "font-weight": "600", color: "var(--info)" }}>{data.total_memory_request_fmt}</div>
                        </div>
                      </div>

                      {(() => {
                        // Group providers by name
                        const providerNames = [...new Set(data.providers.map(p => p.provider))];
                        const tierLabel = (t: string) => {
                          const labels: Record<string, string> = {
                            "on-demand": "On-Demand",
                            "spot": "Spot / Preemptible",
                            "committed-1yr": "1yr Committed",
                            "committed-3yr": "3yr Committed",
                            "savings-1yr": "1yr Savings Plan",
                            "savings-3yr": "3yr Savings Plan",
                            "reserved-1yr": "1yr Reserved",
                            "reserved-3yr": "3yr Reserved",
                          };
                          return labels[t] || t;
                        };

                        return (
                          <div>
                            <div style={{ "font-size": "11px", color: "var(--text-secondary)", "text-transform": "uppercase", "margin-bottom": "8px" }}>
                              Monthly Cost Comparison
                            </div>

                            <div style={{ display: "grid", "grid-template-columns": `repeat(${providerNames.length}, 1fr)`, gap: "12px", "margin-bottom": "16px" }}>
                              <For each={providerNames}>
                                {(name) => {
                                  const tiers = data.providers.filter(p => p.provider === name);
                                  return (
                                    <div class="cost-provider-card" style={{ padding: "0" }}>
                                      <div style={{ padding: "10px 12px", "border-bottom": "1px solid var(--border)", "font-weight": "600", "font-size": "12px" }}>
                                        {name}
                                      </div>
                                      <For each={tiers}>
                                        {(tier) => (
                                          <div
                                            style={{
                                              padding: "8px 12px",
                                              display: "flex",
                                              "justify-content": "space-between",
                                              "align-items": "center",
                                              "border-bottom": "1px solid var(--border)",
                                              background: tier.tier === "spot" ? "color-mix(in srgb, var(--success) 5%, transparent)" : "transparent",
                                            }}
                                          >
                                            <div>
                                              <div style={{ "font-size": "11px", "font-weight": "500" }}>
                                                {tierLabel(tier.tier)}
                                              </div>
                                              <Show when={tier.savings_pct > 0}>
                                                <span style={{
                                                  "font-size": "9px",
                                                  "font-weight": "700",
                                                  color: "#fff",
                                                  background: "var(--success)",
                                                  padding: "1px 4px",
                                                  "border-radius": "3px",
                                                  "font-family": "var(--font-mono)",
                                                }}>
                                                  -{tier.savings_pct.toFixed(0)}%
                                                </span>
                                              </Show>
                                            </div>
                                            <div style={{
                                              "font-size": tier.tier === "spot" ? "16px" : "14px",
                                              "font-weight": tier.tier === "spot" ? "700" : "600",
                                              color: tier.tier === "spot" ? "var(--success)" : "var(--accent)",
                                            }}>
                                              {formatUSD(tier.total_monthly)}
                                              <span style={{ "font-size": "10px", color: "var(--text-muted)", "font-weight": "400" }}>/mo</span>
                                            </div>
                                          </div>
                                        )}
                                      </For>
                                    </div>
                                  );
                                }}
                              </For>
                            </div>
                          </div>
                        );
                      })()}

                      <Show when={data.pods.length > 0}>
                        <div style={{ "font-size": "11px", color: "var(--text-secondary)", "text-transform": "uppercase", "margin-bottom": "8px" }}>
                          Per-Pod Breakdown (on-demand GKE pricing)
                        </div>
                        <table class="resource-table">
                          <thead>
                            <tr>
                              <th>Pod</th>
                              <th>Container</th>
                              <th>CPU Req</th>
                              <th>Mem Req</th>
                              <th>CPU $/mo</th>
                              <th>Mem $/mo</th>
                              <th>Total $/mo</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={data.pods}>
                              {(pod) => (
                                <For each={pod.containers}>
                                  {(c, idx) => (
                                    <tr>
                                      <td>{idx() === 0 ? pod.pod_name : ""}</td>
                                      <td>{c.name}</td>
                                      <td style={{ color: c.cpu_request === "0" ? "var(--text-muted)" : "var(--text-primary)" }}>
                                        {c.cpu_request || "0"}
                                      </td>
                                      <td style={{ color: c.memory_request === "0" ? "var(--text-muted)" : "var(--text-primary)" }}>
                                        {c.memory_request || "0"}
                                      </td>
                                      <td class="metrics-cell" style={{ color: "var(--accent)" }}>{formatUSD(c.cpu_monthly)}</td>
                                      <td class="metrics-cell" style={{ color: "var(--info)" }}>{formatUSD(c.memory_monthly)}</td>
                                      <td class="metrics-cell" style={{ "font-weight": "600" }}>{formatUSD(c.total_monthly)}</td>
                                    </tr>
                                  )}
                                </For>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </Show>

                      <div style={{ "font-size": "11px", color: "var(--text-muted)", "border-top": "1px solid var(--border)", "padding-top": "8px", "margin-top": "12px" }}>
                        <strong>How to read:</strong> Cost = (CPU requests x CPU rate + Memory requests x Memory rate) x 730 hrs/mo.
                        Per-pod breakdown uses on-demand GKE rates. Spot prices are approximate (~60-91% off on-demand) and fluctuate.
                        Committed/Savings plans require upfront commitment. Pods without resource requests show $0.
                      </div>
                    </div>
                  );
                })()}
              </Show>
            </div>
          </Show>

          <Show when={activeTab() === "images"}>
            <div style={{ padding: "12px 16px" }}>
              <Show when={imageLoading()}>
                <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "20px 0" }}>
                  <span class="spinner" />
                  <span>Scanning images with Trivy (this may take a moment)...</span>
                </div>
              </Show>
              <Show when={!imageLoading() && !imageData()}>
                <div class="empty-state">
                  <p>No image data available</p>
                </div>
              </Show>
              <Show when={!imageLoading() && imageData()}>
                {(() => {
                  const data = imageData()!;

                  function sevColor(sev: string): string {
                    if (sev === "critical") return "var(--danger)";
                    if (sev === "high") return "#e57373";
                    if (sev === "medium") return "var(--warning)";
                    if (sev === "low") return "var(--info)";
                    return "var(--text-muted)";
                  }

                  function riskColor(score: number): string {
                    if (score >= 60) return "var(--danger)";
                    if (score >= 30) return "var(--warning)";
                    if (score > 0) return "var(--info)";
                    return "var(--success)";
                  }

                  return (
                    <div>
                      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "12px" }}>
                        <div>
                          <span style={{ "font-weight": "600" }}>Image Vulnerability Scan</span>
                          <span style={{ color: "var(--text-muted)", "font-size": "11px", "margin-left": "8px" }}>
                            {data.unique_images} image{data.unique_images !== 1 ? "s" : ""}
                            {data.trivy_available ? " — powered by Trivy" : " — static analysis only"}
                          </span>
                        </div>
                        <button class="action-btn" onClick={loadImages}>Re-scan</button>
                      </div>

                      <Show when={!data.trivy_available}>
                        <div style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", border: "1px solid var(--warning)", "border-radius": "6px", padding: "8px 12px", "margin-bottom": "12px", "font-size": "11px" }}>
                          Trivy not found. Install it for full CVE scanning: <code style={{ background: "var(--surface)", padding: "1px 4px", "border-radius": "3px" }}>brew install trivy</code>
                        </div>
                      </Show>

                      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr 1fr 1fr 1fr", gap: "10px", "margin-bottom": "16px" }}>
                        <div style={{ background: "var(--surface)", padding: "8px 10px", "border-radius": "6px", border: "1px solid var(--border)", "text-align": "center" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "2px" }}>Risk</div>
                          <div style={{ "font-size": "18px", "font-weight": "700", color: riskColor(data.overall_risk) }}>{data.overall_risk}</div>
                        </div>
                        <div style={{ background: "var(--surface)", padding: "8px 10px", "border-radius": "6px", border: `1px solid ${data.critical_count > 0 ? "var(--danger)" : "var(--border)"}`, "text-align": "center" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "2px" }}>Critical</div>
                          <div style={{ "font-size": "18px", "font-weight": "700", color: data.critical_count > 0 ? "var(--danger)" : "var(--success)" }}>{data.critical_count}</div>
                        </div>
                        <div style={{ background: "var(--surface)", padding: "8px 10px", "border-radius": "6px", border: "1px solid var(--border)", "text-align": "center" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "2px" }}>High</div>
                          <div style={{ "font-size": "18px", "font-weight": "700", color: data.high_count > 0 ? "#e57373" : "var(--success)" }}>{data.high_count}</div>
                        </div>
                        <div style={{ background: "var(--surface)", padding: "8px 10px", "border-radius": "6px", border: "1px solid var(--border)", "text-align": "center" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "2px" }}>Medium</div>
                          <div style={{ "font-size": "18px", "font-weight": "700", color: data.medium_count > 0 ? "var(--warning)" : "var(--success)" }}>{data.medium_count}</div>
                        </div>
                        <div style={{ background: "var(--surface)", padding: "8px 10px", "border-radius": "6px", border: "1px solid var(--border)", "text-align": "center" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "2px" }}>Low</div>
                          <div style={{ "font-size": "18px", "font-weight": "700", color: data.low_count > 0 ? "var(--info)" : "var(--success)" }}>{data.low_count}</div>
                        </div>
                      </div>

                      <For each={data.images}>
                        {(img) => (
                          <div class="image-card">
                            <div style={{ display: "flex", "justify-content": "space-between", "align-items": "flex-start", "margin-bottom": "6px" }}>
                              <div>
                                <div style={{ "font-size": "12px", "font-weight": "600", "word-break": "break-all" }}>{img.repository}</div>
                                <div style={{ "font-size": "11px", color: "var(--text-muted)" }}>
                                  {img.registry} — tag: <span style={{ color: img.tag === "latest" ? "var(--danger)" : "var(--accent)", "font-weight": "500" }}>{img.tag}</span>
                                </div>
                              </div>
                              <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                                <Show when={img.trivy_scanned}>
                                  <span style={{ "font-size": "9px", color: "var(--success)", "font-family": "var(--font-mono)" }}>TRIVY</span>
                                </Show>
                                <span style={{ "font-size": "10px", color: "var(--text-muted)" }}>
                                  {img.pod_count} pod{img.pod_count !== 1 ? "s" : ""}
                                </span>
                                <span class="image-risk-badge" style={{ background: img.risk_score > 0 ? riskColor(img.risk_score) : "var(--success)" }}>
                                  {img.risk_score > 0 ? `risk: ${img.risk_score}` : "clean"}
                                </span>
                              </div>
                            </div>

                            {/* CVE Summary from Trivy */}
                            <Show when={img.cve_summary}>
                              {(() => {
                                const cve = img.cve_summary!;
                                return (
                                  <div style={{ "margin-top": "6px" }}>
                                    <div style={{ display: "flex", gap: "10px", "margin-bottom": "6px", "font-size": "11px" }}>
                                      <span style={{ color: "var(--text-muted)" }}>CVEs:</span>
                                      <Show when={cve.critical > 0}><span style={{ color: "var(--danger)", "font-weight": "700" }}>{cve.critical} CRITICAL</span></Show>
                                      <Show when={cve.high > 0}><span style={{ color: "#e57373", "font-weight": "600" }}>{cve.high} HIGH</span></Show>
                                      <Show when={cve.medium > 0}><span style={{ color: "var(--warning)" }}>{cve.medium} MEDIUM</span></Show>
                                      <Show when={cve.low > 0}><span style={{ color: "var(--info)" }}>{cve.low} LOW</span></Show>
                                      <span style={{ color: "var(--text-muted)", "margin-left": "auto" }}>{cve.total} total</span>
                                    </div>
                                    <Show when={cve.top_cves.length > 0}>
                                      <table class="resource-table" style={{ "font-size": "11px" }}>
                                        <thead>
                                          <tr>
                                            <th>CVE</th>
                                            <th>Severity</th>
                                            <th>Package</th>
                                            <th>Installed</th>
                                            <th>Fixed</th>
                                            <th>Description</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          <For each={cve.top_cves}>
                                            {(v) => (
                                              <tr>
                                                <td style={{ "font-family": "var(--font-mono)", "font-size": "10px", "white-space": "nowrap" }}>{v.id}</td>
                                                <td>
                                                  <span style={{ color: sevColor(v.severity), "font-weight": "700", "font-size": "9px", "text-transform": "uppercase", "font-family": "var(--font-mono)" }}>
                                                    {v.severity}
                                                  </span>
                                                </td>
                                                <td style={{ "font-weight": "500" }}>{v.pkg_name}</td>
                                                <td style={{ color: "var(--text-secondary)", "font-family": "var(--font-mono)", "font-size": "10px" }}>{v.installed_version}</td>
                                                <td style={{ color: v.fixed_version ? "var(--success)" : "var(--text-muted)", "font-family": "var(--font-mono)", "font-size": "10px" }}>
                                                  {v.fixed_version || "no fix"}
                                                </td>
                                                <td style={{ color: "var(--text-secondary)", "max-width": "250px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                                                  {v.title}
                                                </td>
                                              </tr>
                                            )}
                                          </For>
                                        </tbody>
                                      </table>
                                    </Show>
                                    <Show when={cve.total === 0}>
                                      <div style={{ "font-size": "11px", color: "var(--success)", padding: "4px 0" }}>
                                        No CVEs found by Trivy
                                      </div>
                                    </Show>
                                  </div>
                                );
                              })()}
                            </Show>

                            {/* Trivy error */}
                            <Show when={img.trivy_error}>
                              <div style={{ "font-size": "11px", color: "var(--warning)", "margin-top": "4px" }}>
                                Trivy scan failed: {img.trivy_error}
                              </div>
                            </Show>

                            {/* Static findings */}
                            <Show when={img.findings.length > 0}>
                              <div style={{ "margin-top": "6px", "border-top": img.cve_summary ? "1px solid var(--border)" : "none", "padding-top": img.cve_summary ? "6px" : "0" }}>
                                <Show when={img.cve_summary}>
                                  <div style={{ "font-size": "10px", color: "var(--text-muted)", "text-transform": "uppercase", "margin-bottom": "4px" }}>Config Issues</div>
                                </Show>
                                <For each={img.findings}>
                                  {(f) => (
                                    <div class="image-finding">
                                      <span class="image-finding-sev" style={{ color: sevColor(f.severity) }}>
                                        {f.severity.toUpperCase()}
                                      </span>
                                      <span style={{ "font-weight": "500" }}>{f.title}</span>
                                      <span style={{ color: "var(--text-secondary)" }}> — {f.description}</span>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Show>

                            <Show when={!img.cve_summary && !img.trivy_error && img.findings.length === 0}>
                              <div style={{ "font-size": "11px", color: "var(--success)", "margin-top": "4px" }}>
                                No issues found
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>

                      <div style={{ "font-size": "11px", color: "var(--text-muted)", "border-top": "1px solid var(--border)", "padding-top": "8px", "margin-top": "12px" }}>
                        {data.trivy_available
                          ? "CVE data from Trivy (aquasecurity/trivy). Top 20 vulnerabilities shown per image, sorted by severity. Re-scan to refresh."
                          : "Static analysis only. Install Trivy for full CVE scanning: brew install trivy"}
                      </div>
                    </div>
                  );
                })()}
              </Show>
            </div>
          </Show>

          <Show when={activeTab() === "benchmark" && isPod()}>
            <div style={{ padding: "12px 16px" }}>
              <Show when={!benchmarking() && !benchmarkResult()}>
                <div class="benchmark-config">
                  <p style={{ color: "var(--text-secondary)", "font-size": "12px", "margin-bottom": "12px" }}>
                    Collect metrics samples over time to recommend optimal CPU/Memory requests and limits.
                  </p>
                  <div style={{ display: "flex", gap: "16px", "align-items": "flex-end", "margin-bottom": "12px", "flex-wrap": "wrap" }}>
                    <div class="benchmark-field">
                      <label>Duration</label>
                      <select value={benchmarkDuration()} onChange={(e) => setBenchmarkDuration(parseInt(e.currentTarget.value))}>
                        <option value="30">30s (quick)</option>
                        <option value="60">1 min</option>
                        <option value="120">2 min</option>
                        <option value="300">5 min</option>
                        <option value="600">10 min</option>
                        <option value="1800">30 min</option>
                        <option value="3600">1 hour</option>
                      </select>
                    </div>
                    <div class="benchmark-field">
                      <label>Interval</label>
                      <select value={benchmarkInterval()} onChange={(e) => setBenchmarkInterval(parseInt(e.currentTarget.value))}>
                        <option value="3">3s</option>
                        <option value="5">5s</option>
                        <option value="10">10s</option>
                        <option value="15">15s</option>
                        <option value="30">30s</option>
                        <option value="60">60s</option>
                      </select>
                    </div>
                    <button
                      class="action-btn"
                      style={{ padding: "6px 16px" }}
                      onClick={() => {
                        const res = resource();
                        if (!res) return;
                        startBenchmark(res.namespace || "default", res.name);
                      }}
                    >
                      Start Benchmark
                    </button>
                  </div>
                  <div style={{ "font-size": "11px", color: "var(--text-muted)" }}>
                    Samples: ~{Math.floor(benchmarkDuration() / benchmarkInterval())} | Requires metrics-server |
                    Runs in background — you'll get a notification when done
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
                    Benchmarking <strong>{benchmarkPodName()}</strong> — every {benchmarkInterval()}s for {benchmarkDuration() >= 60 ? `${Math.floor(benchmarkDuration() / 60)}m` : `${benchmarkDuration()}s`}
                    <br />Runs in background — you can navigate away and will be notified when done.
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
          {/* HPA/VPA Tab */}
          <Show when={activeTab() === "hpa"}>
            <div class="detail-content" style={{ padding: "16px" }}>
              <Show when={hpaLoading()}>
                <div style={{ color: "var(--text-secondary)", "font-size": "12px" }}>Loading autoscaler data...</div>
              </Show>
              <Show when={!hpaLoading() && hpaData()}>
                {(() => {
                  const data = hpaData()!;
                  const resName = resource()?.name || "";
                  const relevantHpas = data.hpas.filter(h => h.target_name === resName);
                  const relevantVpas = data.vpas.filter(v => v.target_name === resName);
                  return (
                    <div>
                      <Show when={relevantHpas.length === 0 && relevantVpas.length === 0}>
                        <div style={{ color: "var(--text-secondary)", "font-size": "12px", padding: "20px", "text-align": "center" }}>
                          No HPA or VPA configured for this workload
                        </div>
                      </Show>

                      <For each={relevantHpas}>
                        {(hpa) => (
                          <div style={{ background: "var(--bg-secondary)", "border-radius": "8px", padding: "16px", "margin-bottom": "16px" }}>
                            <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "12px" }}>
                              <div>
                                <span style={{ "font-weight": "600", "font-size": "14px" }}>HPA: {hpa.name}</span>
                                <span style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-left": "8px" }}>Age: {hpa.age}</span>
                              </div>
                            </div>

                            {/* Replica gauge */}
                            <div style={{ display: "grid", "grid-template-columns": "repeat(4, 1fr)", gap: "12px", "margin-bottom": "16px" }}>
                              <div style={{ "text-align": "center" }}>
                                <div style={{ "font-size": "10px", color: "var(--text-secondary)" }}>Min</div>
                                <div style={{ "font-size": "20px", "font-weight": "700" }}>{hpa.min_replicas}</div>
                              </div>
                              <div style={{ "text-align": "center" }}>
                                <div style={{ "font-size": "10px", color: "var(--text-secondary)" }}>Current</div>
                                <div style={{ "font-size": "20px", "font-weight": "700", color: "var(--accent)" }}>{hpa.current_replicas}</div>
                              </div>
                              <div style={{ "text-align": "center" }}>
                                <div style={{ "font-size": "10px", color: "var(--text-secondary)" }}>Desired</div>
                                <div style={{ "font-size": "20px", "font-weight": "700", color: hpa.desired_replicas !== hpa.current_replicas ? "var(--status-warning)" : "var(--status-running)" }}>{hpa.desired_replicas}</div>
                              </div>
                              <div style={{ "text-align": "center" }}>
                                <div style={{ "font-size": "10px", color: "var(--text-secondary)" }}>Max</div>
                                <div style={{ "font-size": "20px", "font-weight": "700" }}>{hpa.max_replicas}</div>
                              </div>
                            </div>

                            {/* Replica bar */}
                            <div style={{ height: "6px", background: "var(--bg-tertiary)", "border-radius": "3px", "margin-bottom": "16px", position: "relative" }}>
                              <div style={{
                                height: "100%", "border-radius": "3px", background: "var(--accent)",
                                width: `${Math.min(100, ((hpa.current_replicas - hpa.min_replicas) / Math.max(1, hpa.max_replicas - hpa.min_replicas)) * 100)}%`,
                              }} />
                            </div>

                            {/* Metrics */}
                            <Show when={hpa.metrics.length > 0}>
                              <h4 style={{ "font-size": "12px", "font-weight": "600", "margin-bottom": "8px" }}>Metrics</h4>
                              <table class="resource-table" style={{ "margin-bottom": "12px" }}>
                                <thead><tr><th>Metric</th><th>Type</th><th>Current</th><th>Target</th></tr></thead>
                                <tbody>
                                  <For each={hpa.metrics}>
                                    {(m) => (
                                      <tr>
                                        <td style={{ "font-weight": "500" }}>{m.metric_name}</td>
                                        <td style={{ color: "var(--text-secondary)" }}>{m.metric_type}</td>
                                        <td style={{ color: "var(--accent)" }}>{m.current_value}</td>
                                        <td>{m.target_value}</td>
                                      </tr>
                                    )}
                                  </For>
                                </tbody>
                              </table>
                            </Show>

                            {/* Conditions */}
                            <Show when={hpa.conditions.length > 0}>
                              <h4 style={{ "font-size": "12px", "font-weight": "600", "margin-bottom": "8px" }}>Conditions</h4>
                              <For each={hpa.conditions}>
                                {(c) => (
                                  <div style={{ "font-size": "11px", padding: "4px 0", display: "flex", gap: "8px", "border-bottom": "1px solid var(--bg-tertiary)" }}>
                                    <span style={{ color: c.status === "True" ? "var(--status-running)" : "var(--status-error)", "font-weight": "600", width: "40px" }}>{c.status}</span>
                                    <span style={{ "font-weight": "500", width: "140px" }}>{c.condition_type}</span>
                                    <span style={{ color: "var(--text-secondary)" }}>{c.message}</span>
                                  </div>
                                )}
                              </For>
                            </Show>

                            <Show when={hpa.last_scale_time}>
                              <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-top": "8px" }}>
                                Last scaled: {hpa.last_scale_time}
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>

                      <For each={relevantVpas}>
                        {(vpa) => (
                          <div style={{ background: "var(--bg-secondary)", "border-radius": "8px", padding: "16px", "margin-bottom": "16px" }}>
                            <div style={{ "margin-bottom": "12px" }}>
                              <span style={{ "font-weight": "600", "font-size": "14px" }}>VPA: {vpa.name}</span>
                              <span style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-left": "8px" }}>Mode: {vpa.update_mode}</span>
                              <span style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-left": "8px" }}>Age: {vpa.age}</span>
                            </div>
                            <Show when={vpa.recommendations.length > 0}>
                              <table class="resource-table">
                                <thead><tr><th>Container</th><th>Target CPU</th><th>Target Mem</th><th>Lower CPU</th><th>Upper CPU</th><th>Lower Mem</th><th>Upper Mem</th></tr></thead>
                                <tbody>
                                  <For each={vpa.recommendations}>
                                    {(rec) => (
                                      <tr>
                                        <td style={{ "font-weight": "500" }}>{rec.container_name}</td>
                                        <td style={{ color: "var(--accent)", "font-weight": "600" }}>{rec.target_cpu}</td>
                                        <td style={{ color: "var(--info)", "font-weight": "600" }}>{rec.target_memory}</td>
                                        <td style={{ color: "var(--text-secondary)" }}>{rec.lower_cpu}</td>
                                        <td style={{ color: "var(--text-secondary)" }}>{rec.upper_cpu}</td>
                                        <td style={{ color: "var(--text-secondary)" }}>{rec.lower_memory}</td>
                                        <td style={{ color: "var(--text-secondary)" }}>{rec.upper_memory}</td>
                                      </tr>
                                    )}
                                  </For>
                                </tbody>
                              </table>
                            </Show>
                            <Show when={vpa.recommendations.length === 0}>
                              <div style={{ color: "var(--text-secondary)", "font-size": "12px" }}>No recommendations available yet</div>
                            </Show>
                          </div>
                        )}
                      </For>

                      {/* Show all HPAs/VPAs in namespace */}
                      <Show when={data.hpas.length > relevantHpas.length || data.vpas.length > relevantVpas.length}>
                        <div style={{ "margin-top": "16px", "font-size": "11px", color: "var(--text-secondary)" }}>
                          Other autoscalers in namespace: {data.hpas.length} HPA(s), {data.vpas.length} VPA(s)
                        </div>
                      </Show>
                    </div>
                  );
                })()}
              </Show>
            </div>
          </Show>

          {/* CronJob Tab */}
          <Show when={activeTab() === "cronjob"}>
            <div class="detail-content" style={{ padding: "16px" }}>
              <Show when={cronJobLoading()}>
                <div style={{ color: "var(--text-secondary)", "font-size": "12px" }}>Loading job history...</div>
              </Show>
              <Show when={!cronJobLoading() && cronJobData()}>
                {(() => {
                  const data = cronJobData()!;
                  return (
                    <div>
                      {/* CronJob info */}
                      <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(120px, 1fr))", gap: "12px", "margin-bottom": "16px" }}>
                        <div style={{ background: "var(--bg-secondary)", padding: "10px", "border-radius": "6px", "text-align": "center" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-secondary)" }}>Schedule</div>
                          <div style={{ "font-size": "13px", "font-weight": "600", color: "var(--accent)" }}>{data.schedule}</div>
                        </div>
                        <div style={{ background: "var(--bg-secondary)", padding: "10px", "border-radius": "6px", "text-align": "center" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-secondary)" }}>Suspend</div>
                          <div style={{ "font-size": "13px", "font-weight": "600", color: data.suspend ? "var(--status-error)" : "var(--status-running)" }}>
                            {data.suspend ? "Yes" : "No"}
                          </div>
                        </div>
                        <div style={{ background: "var(--bg-secondary)", padding: "10px", "border-radius": "6px", "text-align": "center" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-secondary)" }}>Active</div>
                          <div style={{ "font-size": "13px", "font-weight": "600" }}>{data.active_count}</div>
                        </div>
                        <div style={{ background: "var(--bg-secondary)", padding: "10px", "border-radius": "6px", "text-align": "center" }}>
                          <div style={{ "font-size": "10px", color: "var(--text-secondary)" }}>Concurrency</div>
                          <div style={{ "font-size": "13px", "font-weight": "600" }}>{data.concurrency_policy}</div>
                        </div>
                      </div>

                      {/* Trigger button */}
                      <div style={{ "margin-bottom": "16px" }}>
                        <button
                          class="btn btn-sm btn-primary"
                          onClick={handleTriggerCronJob}
                          disabled={triggering()}
                        >
                          {triggering() ? "Triggering..." : "Trigger Now"}
                        </button>
                      </div>

                      {/* Job history */}
                      <h4 style={{ "font-size": "12px", "font-weight": "600", "margin-bottom": "8px" }}>
                        Job History ({data.jobs.length})
                      </h4>
                      <Show when={data.jobs.length > 0}>
                        <table class="resource-table">
                          <thead>
                            <tr><th>Job</th><th>Status</th><th>Completions</th><th>Duration</th><th>Age</th></tr>
                          </thead>
                          <tbody>
                            <For each={data.jobs}>
                              {(job) => (
                                <tr>
                                  <td style={{ "font-size": "11px" }}>{job.name}</td>
                                  <td>
                                    <span style={{
                                      "font-size": "10px", padding: "1px 6px", "border-radius": "3px",
                                      background: job.status === "Succeeded" ? "var(--status-running)22" :
                                        job.status === "Failed" ? "var(--status-error)22" : "var(--status-warning)22",
                                      color: job.status === "Succeeded" ? "var(--status-running)" :
                                        job.status === "Failed" ? "var(--status-error)" : "var(--status-warning)",
                                    }}>{job.status}</span>
                                  </td>
                                  <td>{job.completions}</td>
                                  <td>{job.duration_secs != null ? `${job.duration_secs}s` : "-"}</td>
                                  <td style={{ color: "var(--text-secondary)" }}>{job.age}</td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </Show>
                      <Show when={data.jobs.length === 0}>
                        <div style={{ color: "var(--text-secondary)", "font-size": "12px", "text-align": "center", padding: "20px" }}>
                          No jobs found for this CronJob
                        </div>
                      </Show>
                    </div>
                  );
                })()}
              </Show>
            </div>
          </Show>

          {/* Diff Tab */}
          <Show when={activeTab() === "diff"}>
            <div class="detail-content" style={{ padding: "16px" }}>
              <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "16px" }}>
                <span style={{ "font-size": "12px", color: "var(--text-secondary)" }}>Compare with:</span>
                <select
                  style={{ "font-size": "12px", padding: "4px 8px", background: "var(--bg-secondary)", border: "1px solid var(--border-color)", "border-radius": "4px", color: "var(--text-primary)" }}
                  value={diffTarget()}
                  onChange={(e) => setDiffTarget(e.currentTarget.value)}
                >
                  <option value="">Select a {resource()?.kind}...</option>
                  <For each={resources().filter(r => r.kind === resource()?.kind && r.name !== resource()?.name)}>
                    {(r) => <option value={r.name}>{r.name}</option>}
                  </For>
                </select>
                <button class="btn btn-sm" onClick={loadDiff} disabled={diffLoading() || !diffTarget()}>
                  {diffLoading() ? "Comparing..." : "Compare"}
                </button>
              </div>

              <Show when={diffData()}>
                {(() => {
                  const data = diffData()!;
                  return (
                    <div>
                      <div style={{ display: "flex", gap: "12px", "margin-bottom": "12px", "font-size": "12px" }}>
                        <span style={{ color: "var(--status-running)" }}>+{data.additions} additions</span>
                        <span style={{ color: "var(--status-error)" }}>-{data.deletions} deletions</span>
                        <Show when={!data.has_changes}>
                          <span style={{ color: "var(--text-secondary)" }}>No differences found</span>
                        </Show>
                      </div>
                      <div style={{
                        background: "var(--bg-secondary)", "border-radius": "6px", padding: "0",
                        "font-family": "monospace", "font-size": "11px", overflow: "auto",
                        "max-height": "500px", border: "1px solid var(--border-color)",
                      }}>
                        <For each={data.lines}>
                          {(line) => (
                            <div style={{
                              padding: "1px 8px", "white-space": "pre",
                              background: line.line_type === "add" ? "#22c55e11" :
                                line.line_type === "remove" ? "#ef444411" : "transparent",
                              color: line.line_type === "add" ? "var(--status-running)" :
                                line.line_type === "remove" ? "var(--status-error)" : "var(--text-primary)",
                              "border-left": line.line_type === "add" ? "3px solid var(--status-running)" :
                                line.line_type === "remove" ? "3px solid var(--status-error)" : "3px solid transparent",
                            }}>
                              <span style={{ color: "var(--text-muted)", "min-width": "35px", display: "inline-block", "user-select": "none" }}>
                                {line.old_line ?? " "}
                              </span>
                              <span style={{ color: "var(--text-muted)", "min-width": "35px", display: "inline-block", "user-select": "none" }}>
                                {line.new_line ?? " "}
                              </span>
                              {line.line_type === "add" ? "+" : line.line_type === "remove" ? "-" : " "} {line.content}
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  );
                })()}
              </Show>

              <Show when={!diffData() && !diffLoading()}>
                <div style={{ color: "var(--text-secondary)", "font-size": "12px", "text-align": "center", padding: "30px" }}>
                  Select another {resource()?.kind} to compare YAML differences
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
