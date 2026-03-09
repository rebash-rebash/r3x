import { createSignal, createMemo, For, Show } from "solid-js";
import {
  RESOURCE_KINDS,
  activeResourceKind,
  setActiveResourceKind,
  loadResources,
  setSelectedResource,
  runSecurityScan,
  securityScanning,
  showSecurityPanel,
  loadTopology,
  topologyLoading,
  showTopologyPanel,
  crds,
  loadCustomResources,
  CrdInfo,
  loadHelmReleases,
  helmLoading,
  showHelmPanel,
  loadRbac,
  rbacLoading,
  showRbacPanel,
  loadClusterHealth,
  healthLoading,
  showHealthPanel,
  showNetpolPanel,
  setShowNetpolPanel,
  showDashboard,
  setShowDashboard,
  loadClusterOverview,
  showEventsPanel,
  loadEvents,
  eventsLoading,
  closeAllViewPanels,
} from "../stores/k8s";

export default function Sidebar() {
  const [expandedSections, setExpandedSections] = createSignal<Record<string, boolean>>({
    workloads: true,
    network: false,
    config: false,
    storage: false,
    cluster: false,
    customResources: false,
    views: false,
    security: false,
  });

  const [expandedGroups, setExpandedGroups] = createSignal<Record<string, boolean>>({});

  // Group CRDs by API group
  const crdGroups = createMemo(() => {
    const groups: Record<string, CrdInfo[]> = {};
    for (const crd of crds()) {
      const g = crd.group || "core";
      if (!groups[g]) groups[g] = [];
      groups[g].push(crd);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  });

  function toggleSection(section: string) {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  }

  function handleKindClick(kind: string) {
    closeAllViewPanels();
    setActiveResourceKind(kind);
    setSelectedResource(null);
    loadResources();
  }

  function SectionHeader(props: { title: string; section: string }) {
    return (
      <div
        class={`sidebar-section-title collapsible ${expandedSections()[props.section] ? "expanded" : ""}`}
        onClick={() => toggleSection(props.section)}
      >
        <span class="section-chevron">{expandedSections()[props.section] ? "▾" : "▸"}</span>
        {props.title}
      </div>
    );
  }

  return (
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1>r3x</h1>
        <span class="badge">rebash</span>
      </div>

      <div class="sidebar-section">
        <SectionHeader title="Workloads" section="workloads" />
        <Show when={expandedSections().workloads}>
          <button
            class={`sidebar-item ${showDashboard() ? "active" : ""}`}
            onClick={() => {
              if (showDashboard()) { closeAllViewPanels(); return; }
              closeAllViewPanels();
              loadClusterOverview();
              setShowDashboard(true);
            }}
          >
            <span class="icon">O</span>
            Overview
          </button>
          <For each={RESOURCE_KINDS.filter((k) =>
            ["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs"].includes(k.key)
          )}>
            {(kind) => (
              <button
                class={`sidebar-item ${activeResourceKind() === kind.key ? "active" : ""}`}
                onClick={() => handleKindClick(kind.key)}
              >
                <span class="icon">{kind.icon}</span>
                {kind.label}
              </button>
            )}
          </For>
        </Show>
      </div>

      <div class="sidebar-section">
        <SectionHeader title="Network" section="network" />
        <Show when={expandedSections().network}>
          <For each={RESOURCE_KINDS.filter((k) =>
            ["services", "ingresses", "networkpolicies"].includes(k.key)
          )}>
            {(kind) => (
              <button
                class={`sidebar-item ${activeResourceKind() === kind.key ? "active" : ""}`}
                onClick={() => handleKindClick(kind.key)}
              >
                <span class="icon">{kind.icon}</span>
                {kind.label}
              </button>
            )}
          </For>
        </Show>
      </div>

      <div class="sidebar-section">
        <SectionHeader title="Config" section="config" />
        <Show when={expandedSections().config}>
          <For each={RESOURCE_KINDS.filter((k) =>
            ["configmaps", "secrets", "serviceaccounts"].includes(k.key)
          )}>
            {(kind) => (
              <button
                class={`sidebar-item ${activeResourceKind() === kind.key ? "active" : ""}`}
                onClick={() => handleKindClick(kind.key)}
              >
                <span class="icon">{kind.icon}</span>
                {kind.label}
              </button>
            )}
          </For>
        </Show>
      </div>

      <div class="sidebar-section">
        <SectionHeader title="Storage" section="storage" />
        <Show when={expandedSections().storage}>
          <For each={RESOURCE_KINDS.filter((k) =>
            ["persistentvolumes", "persistentvolumeclaims"].includes(k.key)
          )}>
            {(kind) => (
              <button
                class={`sidebar-item ${activeResourceKind() === kind.key ? "active" : ""}`}
                onClick={() => handleKindClick(kind.key)}
              >
                <span class="icon">{kind.icon}</span>
                {kind.label}
              </button>
            )}
          </For>
        </Show>
      </div>

      <div class="sidebar-section">
        <SectionHeader title="Cluster" section="cluster" />
        <Show when={expandedSections().cluster}>
          <For each={RESOURCE_KINDS.filter((k) =>
            ["nodes"].includes(k.key)
          )}>
            {(kind) => (
              <button
                class={`sidebar-item ${activeResourceKind() === kind.key ? "active" : ""}`}
                onClick={() => handleKindClick(kind.key)}
              >
                <span class="icon">{kind.icon}</span>
                {kind.label}
              </button>
            )}
          </For>
        </Show>
      </div>

      <Show when={crdGroups().length > 0}>
        <div class="sidebar-section">
          <SectionHeader title="Custom Resources" section="customResources" />
          <Show when={expandedSections().customResources}>
            <For each={crdGroups()}>
              {([group, groupCrds]) => (
                <div>
                  <div
                    class="sidebar-group-title"
                    onClick={() => setExpandedGroups((prev) => ({ ...prev, [group]: !prev[group] }))}
                  >
                    <span class="section-chevron">{expandedGroups()[group] ? "▾" : "▸"}</span>
                    <span style={{ "font-size": "10px", opacity: 0.7 }}>{group}</span>
                    <span class="badge" style={{ "margin-left": "auto", "font-size": "9px" }}>{groupCrds.length}</span>
                  </div>
                  <Show when={expandedGroups()[group]}>
                    <For each={groupCrds}>
                      {(crd) => {
                        const crdKey = `crd:${crd.plural}.${crd.group}`;
                        return (
                          <button
                            class={`sidebar-item ${activeResourceKind() === crdKey ? "active" : ""}`}
                            onClick={() => {
                              setSelectedResource(null);
                              loadCustomResources(crd);
                            }}
                          >
                            <span class="icon" style={{ "font-size": "10px" }}>CR</span>
                            {crd.kind}
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      <div class="sidebar-section">
        <SectionHeader title="Views" section="views" />
        <Show when={expandedSections().views}>
          <button
            class={`sidebar-item ${showTopologyPanel() ? "active" : ""}`}
            onClick={() => {
              if (showTopologyPanel()) { closeAllViewPanels(); return; }
              closeAllViewPanels();
              loadTopology();
            }}
            disabled={topologyLoading()}
          >
            <span class="icon">T</span>
            {topologyLoading() ? "Loading..." : "Topology"}
          </button>
          <button
            class={`sidebar-item ${showHelmPanel() ? "active" : ""}`}
            onClick={() => {
              if (showHelmPanel()) { closeAllViewPanels(); return; }
              closeAllViewPanels();
              loadHelmReleases();
            }}
            disabled={helmLoading()}
          >
            <span class="icon">H</span>
            {helmLoading() ? "Loading..." : "Helm"}
          </button>
          <button
            class={`sidebar-item ${showRbacPanel() ? "active" : ""}`}
            onClick={() => {
              if (showRbacPanel()) { closeAllViewPanels(); return; }
              closeAllViewPanels();
              loadRbac();
            }}
            disabled={rbacLoading()}
          >
            <span class="icon">R</span>
            {rbacLoading() ? "Loading..." : "RBAC"}
          </button>
          <button
            class={`sidebar-item ${showHealthPanel() ? "active" : ""}`}
            onClick={() => {
              if (showHealthPanel()) { closeAllViewPanels(); return; }
              closeAllViewPanels();
              loadClusterHealth();
            }}
            disabled={healthLoading()}
          >
            <span class="icon">+</span>
            {healthLoading() ? "Analyzing..." : "Health Score"}
          </button>
          <button
            class={`sidebar-item ${showNetpolPanel() ? "active" : ""}`}
            onClick={() => {
              if (showNetpolPanel()) { closeAllViewPanels(); return; }
              closeAllViewPanels();
              setShowNetpolPanel(true);
            }}
          >
            <span class="icon">N</span>
            Net Policies
          </button>
          <button
            class={`sidebar-item ${showEventsPanel() ? "active" : ""}`}
            onClick={() => {
              if (showEventsPanel()) { closeAllViewPanels(); return; }
              closeAllViewPanels();
              loadEvents();
            }}
            disabled={eventsLoading()}
          >
            <span class="icon">E</span>
            {eventsLoading() ? "Loading..." : "Events Log"}
          </button>
        </Show>
      </div>

      <div class="sidebar-section">
        <SectionHeader title="Security" section="security" />
        <Show when={expandedSections().security}>
          <button
            class={`sidebar-item ${showSecurityPanel() ? "active" : ""}`}
            onClick={() => {
              if (showSecurityPanel()) { closeAllViewPanels(); return; }
              closeAllViewPanels();
              runSecurityScan();
            }}
            disabled={securityScanning()}
          >
            <span class="icon">S</span>
            {securityScanning() ? "Scanning..." : "Security Scan"}
          </button>
        </Show>
      </div>
    </aside>
  );
}
