import { onMount, onCleanup, Show } from "solid-js";
import {
  initialize,
  loadResources,
  error,
  setSelectedResource,
  RESOURCE_KINDS,
  setActiveResourceKind,
  showHelmPanel,
  showRbacPanel,
  showNetpolPanel,
  showDashboard,
  showTopologyPanel,
  showSecurityPanel,
  showEventsPanel,
  showHealthPanel,
} from "./stores/k8s";
import { toggleTheme } from "./stores/theme";
import Sidebar from "./components/Sidebar";
import Header from "./components/Header";
import ResourceTable from "./components/ResourceTable";
import DetailPanel from "./components/DetailPanel";
import SecurityPanel from "./components/SecurityPanel";
import TopologyPanel from "./components/TopologyPanel";
import ClusterDashboard from "./components/ClusterDashboard";
import CommandPalette, { setShowCommand } from "./components/CommandPalette";
import HelmPanel from "./components/HelmPanel";
import RbacPanel from "./components/RbacPanel";
import KeyboardBar from "./components/KeyboardBar";
import HealthPanel from "./components/HealthPanel";
import NetpolPanel from "./components/NetpolPanel";
import EventsPanel from "./components/EventsPanel";
import "./styles/global.css";

function App() {
  onMount(async () => {
    await initialize();
  });

  // Global keyboard shortcuts
  function handleKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";

    if (e.key === ":" && !isInput) {
      e.preventDefault();
      setShowCommand(true);
      return;
    }

    if (e.key === "/" && !isInput) {
      e.preventDefault();
      const searchInput = document.getElementById("search-input");
      searchInput?.focus();
      return;
    }

    if (e.key === "Escape") {
      if (isInput) {
        (target as HTMLInputElement).blur();
      }
      setSelectedResource(null);
      return;
    }

    if (isInput) return;

    // Number keys to switch resource kind
    const num = parseInt(e.key);
    if (num >= 1 && num <= 9 && num <= RESOURCE_KINDS.length) {
      e.preventDefault();
      setActiveResourceKind(RESOURCE_KINDS[num - 1].key);
      setSelectedResource(null);
      loadResources();
      return;
    }

    if (e.key === "r") {
      e.preventDefault();
      loadResources();
      return;
    }

    if (e.key === "t") {
      e.preventDefault();
      toggleTheme();
      return;
    }

    // Focus first row on 'j' or down arrow
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      const firstRow = document.querySelector('[data-row-index="0"]') as HTMLElement;
      firstRow?.focus();
      return;
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div class="app">
      <Sidebar />
      <div class="main">
        <Header />

        <Show when={error()}>
          <div class="error-banner">
            <span>⚠</span>
            {error()}
            <button onClick={() => window.location.reload()}>×</button>
          </div>
        </Show>

        <Show when={showDashboard()}>
          <ClusterDashboard />
        </Show>
        <Show when={showHelmPanel()}>
          <HelmPanel />
        </Show>
        <Show when={showRbacPanel()}>
          <RbacPanel />
        </Show>
        <Show when={showNetpolPanel()}>
          <NetpolPanel />
        </Show>
        <Show when={showSecurityPanel()}>
          <SecurityPanel />
        </Show>
        <Show when={showTopologyPanel()}>
          <TopologyPanel />
        </Show>
        <Show when={showEventsPanel()}>
          <EventsPanel />
        </Show>
        <Show when={showHealthPanel()}>
          <HealthPanel />
        </Show>
        <Show when={!showDashboard() && !showHelmPanel() && !showRbacPanel() && !showTopologyPanel() && !showSecurityPanel() && !showEventsPanel() && !showHealthPanel() && !showNetpolPanel()}>
          <ResourceTable />
          <DetailPanel />
        </Show>
        <CommandPalette />
        <KeyboardBar />
      </div>
    </div>
  );
}

export default App;
