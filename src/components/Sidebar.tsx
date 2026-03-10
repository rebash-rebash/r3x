import { createSignal, createMemo, For, Show } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
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
  showHelpPanel,
  setShowHelpPanel,
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
        <span class="version-label">v0.2.1</span>
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

      <div class="sidebar-help">
        <button
          class={`sidebar-item ${showHelpPanel() ? "active" : ""}`}
          onClick={() => {
            if (showHelpPanel()) { closeAllViewPanels(); return; }
            closeAllViewPanels();
            setShowHelpPanel(true);
          }}
        >
          <span class="icon">?</span>
          Help &amp; Guide
        </button>
        <div class="sidebar-links">
          <a class="sidebar-link" onClick={() => openUrl("https://rebash.in")} title="rebash.in">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
          </a>
          <a class="sidebar-link" onClick={() => openUrl("https://github.com/rebash-rebash/r3x")} title="GitHub">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
          </a>
          <a class="sidebar-link" onClick={() => openUrl("https://www.linkedin.com/in/shaikkhadarbasha/")} title="LinkedIn">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
          </a>
        </div>
      </div>
    </aside>
  );
}
