import { createSignal, Show, For, createMemo } from "solid-js";
import {
  RESOURCE_KINDS,
  setActiveResourceKind,
  setActiveNamespace,
  loadResources,
  setSelectedResource,
  namespaces,
  contexts,
  switchContext,
  loadTopology,
  loadClusterMetrics,
  runSecurityScan,
  loadHelmReleases,
  loadRbac,
} from "../stores/k8s";

const [showCommand, setShowCommand] = createSignal(false);
export { showCommand, setShowCommand };

interface CommandItem {
  label: string;
  shortcut?: string;
  action: () => void;
}

export default function CommandPalette() {
  const [input, setInput] = createSignal("");
  let inputRef: HTMLInputElement | undefined;

  // Build all available commands
  const allCommands = createMemo((): CommandItem[] => {
    const cmds: CommandItem[] = [];

    // Resource kind commands
    for (const kind of RESOURCE_KINDS) {
      cmds.push({
        label: `:${kind.key}`,
        shortcut: kind.label,
        action: () => {
          setActiveResourceKind(kind.key);
          setSelectedResource(null);
          loadResources();
          close();
        },
      });
    }

    // Namespace commands
    for (const ns of namespaces()) {
      cmds.push({
        label: `:ns ${ns.name}`,
        shortcut: `Switch to namespace ${ns.name}`,
        action: () => {
          setActiveNamespace(ns.name);
          setSelectedResource(null);
          loadResources();
          close();
        },
      });
    }
    cmds.push({
      label: `:ns _all`,
      shortcut: "All Namespaces",
      action: () => {
        setActiveNamespace("_all");
        setSelectedResource(null);
        loadResources();
        close();
      },
    });

    // Context commands
    for (const ctx of contexts()) {
      cmds.push({
        label: `:ctx ${ctx.name}`,
        shortcut: `Switch context to ${ctx.name}`,
        action: () => {
          switchContext(ctx.name);
          close();
        },
      });
    }

    // View commands
    cmds.push({ label: `:topology`, shortcut: "Open Topology", action: () => { loadTopology(); close(); } });
    cmds.push({ label: `:dashboard`, shortcut: "Open Dashboard", action: () => { loadClusterMetrics(); close(); } });
    cmds.push({ label: `:security`, shortcut: "Run Security Scan", action: () => { runSecurityScan(); close(); } });
    cmds.push({ label: `:helm`, shortcut: "View Helm Releases", action: () => { loadHelmReleases(); close(); } });
    cmds.push({ label: `:rbac`, shortcut: "View RBAC Bindings", action: () => { loadRbac(); close(); } });

    return cmds;
  });

  const filteredCommands = createMemo(() => {
    const q = input().toLowerCase().trim();
    if (!q) return allCommands().slice(0, 15);
    return allCommands().filter((c) => c.label.toLowerCase().includes(q) || (c.shortcut && c.shortcut.toLowerCase().includes(q))).slice(0, 15);
  });

  const [selectedIdx, setSelectedIdx] = createSignal(0);

  function close() {
    setShowCommand(false);
    setInput("");
    setSelectedIdx(0);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filteredCommands().length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmds = filteredCommands();
      if (cmds.length > 0 && selectedIdx() < cmds.length) {
        cmds[selectedIdx()].action();
      }
      return;
    }
  }

  // Reset selectedIdx when input changes
  function handleInput(val: string) {
    setInput(val);
    setSelectedIdx(0);
  }

  return (
    <Show when={showCommand()}>
      <div class="cmd-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div class="cmd-panel">
          <input
            ref={inputRef}
            type="text"
            class="cmd-input"
            placeholder=":pods, :ns default, :ctx my-cluster, :helm, :rbac..."
            value={input()}
            onInput={(e) => handleInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            autofocus
          />
          <div class="cmd-results">
            <For each={filteredCommands()}>
              {(cmd, idx) => (
                <div
                  class={`cmd-item ${selectedIdx() === idx() ? "cmd-selected" : ""}`}
                  onClick={() => cmd.action()}
                  onMouseEnter={() => setSelectedIdx(idx())}
                >
                  <span class="cmd-label">{cmd.label}</span>
                  <Show when={cmd.shortcut}>
                    <span class="cmd-shortcut">{cmd.shortcut}</span>
                  </Show>
                </div>
              )}
            </For>
            <Show when={filteredCommands().length === 0}>
              <div class="cmd-empty">No matching commands</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
