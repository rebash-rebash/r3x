import { createMemo, For, Show } from "solid-js";
import {
  contexts,
  activeContext,
  switchContext,
  namespaces,
  activeNamespace,
  setActiveNamespace,
  activeResourceKind,
  loadResources,
  setSelectedResource,
  RESOURCE_KINDS,
  autoRefresh,
  toggleAutoRefresh,
  labelFilter,
  setLabelFilter,
  searchQuery,
  setSearchQuery,
  favoriteNamespaces,
  toggleFavoriteNamespace,
  isFavoriteNamespace,
  clusterMetrics,
} from "../stores/k8s";
import { theme, toggleTheme } from "../stores/theme";
import AlertsBell from "./AlertsBell";

export default function Header() {

  function handleContextChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    switchContext(target.value);
    setSelectedResource(null);
  }

  function handleNamespaceChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    setActiveNamespace(target.value);
    setSelectedResource(null);
    loadResources();
  }

  const currentKindLabel = () =>
    RESOURCE_KINDS.find((k) => k.key === activeResourceKind())?.label || activeResourceKind();

  const activeCtxInfo = createMemo(() =>
    contexts().find((c) => c.name === activeContext())
  );

  return (
    <header class="header">
      {/* Row 1: Context, Namespace, Health Bar, Cluster Info */}
      <div class="header-row">
        <div class="header-left">
          <div class="context-selector">
            <select onChange={handleContextChange} value={activeContext()}>
              <For each={contexts()}>
                {(ctx) => (
                  <option value={ctx.name}>{ctx.name}</option>
                )}
              </For>
            </select>
          </div>

          <div class="namespace-selector">
            <select onChange={handleNamespaceChange} value={activeNamespace()}>
              <option value="_all">All Namespaces</option>
              <Show when={favoriteNamespaces().length > 0}>
                <optgroup label="Favorites">
                  <For each={namespaces().filter(ns => isFavoriteNamespace(ns.name))}>
                    {(ns) => (
                      <option value={ns.name}>★ {ns.name}</option>
                    )}
                  </For>
                </optgroup>
              </Show>
              <optgroup label={favoriteNamespaces().length > 0 ? "All" : ""}>
                <For each={namespaces()}>
                  {(ns) => (
                    <option value={ns.name}>{ns.name}</option>
                  )}
                </For>
              </optgroup>
            </select>
            <button
              class="ns-pin-btn"
              onClick={() => {
                const ns = activeNamespace();
                if (ns && ns !== "_all") toggleFavoriteNamespace(ns);
              }}
              title={activeNamespace() !== "_all" && isFavoriteNamespace(activeNamespace()) ? "Unpin namespace" : "Pin namespace"}
              disabled={activeNamespace() === "_all"}
            >
              {activeNamespace() !== "_all" && isFavoriteNamespace(activeNamespace()) ? "★" : "☆"}
            </button>
          </div>

          <Show when={activeCtxInfo()}>
            <div class="cluster-info">
              <span class="cluster-name">{activeCtxInfo()!.cluster}</span>
              <Show when={activeCtxInfo()!.user}>
                <span class="cluster-user">{activeCtxInfo()!.user}</span>
              </Show>
            </div>
          </Show>
        </div>

        <Show when={clusterMetrics()}>
          {(() => {
            const m = clusterMetrics()!;
            const cpuPct = m.cpu_percent;
            const memPct = m.memory_percent;
            const cpuColor = cpuPct > 90 ? "var(--status-error)" : cpuPct > 70 ? "var(--status-warning)" : "var(--status-running)";
            const memColor = memPct > 90 ? "var(--status-error)" : memPct > 70 ? "var(--status-warning)" : "var(--status-running)";
            return (
              <div class="cluster-health-bar">
                <div class="health-metric">
                  <span class="health-label">CPU</span>
                  <div class="health-bar-track">
                    <div class="health-bar-fill" style={{ width: `${Math.min(cpuPct, 100)}%`, background: cpuColor }} />
                  </div>
                  <span class="health-value" style={{ color: cpuColor }}>{cpuPct.toFixed(0)}%</span>
                </div>
                <div class="health-metric">
                  <span class="health-label">MEM</span>
                  <div class="health-bar-track">
                    <div class="health-bar-fill" style={{ width: `${Math.min(memPct, 100)}%`, background: memColor }} />
                  </div>
                  <span class="health-value" style={{ color: memColor }}>{memPct.toFixed(0)}%</span>
                </div>
                <span class="health-nodes">{m.node_count}N/{m.pod_count}P</span>
              </div>
            );
          })()}
        </Show>
      </div>

      {/* Row 2: Breadcrumb, Labels, Search, Actions */}
      <div class="header-row">
        <div class="header-left">
          <div class="breadcrumb">
            <span>/</span>
            <span class="current">{currentKindLabel()}</span>
          </div>

          <div class="label-filter">
            <input
              type="text"
              placeholder="Labels: app=nginx,env=prod"
              value={labelFilter()}
              onInput={(e) => setLabelFilter(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") loadResources(); }}
              class="label-input"
            />
          </div>
        </div>

        <div class="header-right">
          <div class="search-bar">
            <input
              type="text"
              placeholder="Filter resources..."
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              id="search-input"
            />
            <span class="shortcut">/</span>
          </div>

          <AlertsBell />

          <button
            class={`action-btn ${autoRefresh() ? "auto-refresh-active" : ""}`}
            onClick={toggleAutoRefresh}
            title={autoRefresh() ? "Stop auto-refresh" : "Start auto-refresh (10s)"}
          >
            {autoRefresh() ? "Auto" : "Auto"}
          </button>

          <button class="theme-toggle" onClick={toggleTheme} title="Toggle theme">
            <Show when={theme() === "dark"} fallback="☾">
              ☀
            </Show>
          </button>
        </div>
      </div>
    </header>
  );
}
