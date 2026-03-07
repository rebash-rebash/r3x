import { Show, For, createSignal } from "solid-js";
import {
  topologyData,
  topologyLoading,
  showTopologyPanel,
  setShowTopologyPanel,
  loadTopology,
  type TopoNode,
} from "../stores/k8s";

function kindIcon(kind: string): string {
  switch (kind) {
    case "Deployment": return "D";
    case "StatefulSet": return "S";
    case "DaemonSet": return "DS";
    case "ReplicaSet": return "RS";
    case "Pod": return "P";
    case "Container": return "C";
    default: return "?";
  }
}

function kindClass(kind: string): string {
  return `topo-kind-${kind.toLowerCase()}`;
}

function statusClass(status: string | null): string {
  if (!status) return "";
  const s = status.toLowerCase();
  if (s === "running" || s === "active" || s === "ready") return "topo-status-ok";
  if (s === "pending" || s === "waiting") return "topo-status-warn";
  if (s === "failed" || s === "error" || s === "crashloopbackoff") return "topo-status-err";
  // replica counts like "3/3"
  if (s.includes("/")) {
    const [a, b] = s.split("/");
    if (a === b) return "topo-status-ok";
    if (a === "0") return "topo-status-err";
    return "topo-status-warn";
  }
  return "";
}

function TreeNode(props: { node: TopoNode; depth: number }) {
  const [expanded, setExpanded] = createSignal(props.depth < 2);
  const hasChildren = () => props.node.children.length > 0;

  return (
    <div class="topo-node">
      <div
        class={`topo-row ${kindClass(props.node.kind)}`}
        style={{ "padding-left": `${props.depth * 20 + 12}px` }}
        onClick={() => hasChildren() && setExpanded(!expanded())}
      >
        <span class="topo-toggle">
          {hasChildren() ? (expanded() ? "v" : ">") : " "}
        </span>
        <span class={`topo-icon ${kindClass(props.node.kind)}`}>
          {kindIcon(props.node.kind)}
        </span>
        <span class="topo-name">{props.node.name}</span>
        <Show when={props.node.namespace}>
          <span class="topo-ns">{props.node.namespace}</span>
        </Show>
        <Show when={props.node.status}>
          <span class={`topo-status ${statusClass(props.node.status)}`}>
            {props.node.status}
          </span>
        </Show>
      </div>
      <Show when={expanded() && hasChildren()}>
        <For each={props.node.children}>
          {(child) => <TreeNode node={child} depth={props.depth + 1} />}
        </For>
      </Show>
    </div>
  );
}

export default function TopologyPanel() {
  return (
    <Show when={showTopologyPanel()}>
      <div class="topology-panel">
        <div class="topology-header">
          <div class="topology-header-left">
            <h3>Resource Topology</h3>
            <span class="topo-legend">
              <span class="topo-icon topo-kind-deployment">D</span> Deployment
              <span class="topo-icon topo-kind-replicaset">RS</span> ReplicaSet
              <span class="topo-icon topo-kind-pod">P</span> Pod
              <span class="topo-icon topo-kind-container">C</span> Container
            </span>
          </div>
          <div class="topology-header-right">
            <button
              class="action-btn"
              onClick={() => loadTopology()}
              disabled={topologyLoading()}
            >
              {topologyLoading() ? "Loading..." : "Refresh"}
            </button>
            <button
              class="detail-close"
              onClick={() => setShowTopologyPanel(false)}
            >
              x
            </button>
          </div>
        </div>

        <Show when={topologyLoading()}>
          <div class="loading-overlay">
            <span class="spinner" />
            Building topology...
          </div>
        </Show>

        <Show when={!topologyLoading()}>
          <div class="topology-tree">
            <Show
              when={topologyData().length > 0}
              fallback={
                <div class="empty-state">
                  <span class="icon">--</span>
                  <span>No workloads found in this namespace</span>
                </div>
              }
            >
              <For each={topologyData()}>
                {(node) => <TreeNode node={node} depth={0} />}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}
