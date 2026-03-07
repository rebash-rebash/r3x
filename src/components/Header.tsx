import { createSignal, For, Show } from "solid-js";
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
} from "../stores/k8s";
import { theme, toggleTheme } from "../stores/theme";

export default function Header() {
  const [searchQuery, setSearchQuery] = createSignal("");

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

  return (
    <header class="header">
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
            <For each={namespaces()}>
              {(ns) => (
                <option value={ns.name}>{ns.name}</option>
              )}
            </For>
          </select>
        </div>

        <div class="breadcrumb">
          <span>/</span>
          <span class="current">{currentKindLabel()}</span>
        </div>
      </div>

      <div class="header-right">
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
    </header>
  );
}

export function getSearchQuery(): string {
  const input = document.getElementById("search-input") as HTMLInputElement;
  return input?.value?.toLowerCase() || "";
}
