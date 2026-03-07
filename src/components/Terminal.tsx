import { onMount, onCleanup } from "solid-js";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  namespace: string;
  podName: string;
  container?: string;
  context: string;
  active: boolean;
}

export default function TerminalComp(props: TerminalProps) {
  let termRef: HTMLDivElement | undefined;
  let term: XTerm | null = null;
  let fitAddon: FitAddon | null = null;
  let sessionId: string | null = null;
  let unlistenStdout: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let started = false;

  async function startSession() {
    if (!termRef || started) return;
    started = true;

    term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      rows: 20,
      cols: 100,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        selectionBackground: "#264f78",
        black: "#0d1117",
        red: "#f85149",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#e6edf3",
      },
      allowProposedApi: true,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef);

    term.writeln(`Connecting to ${props.podName}...`);

    try {
      sessionId = await invoke<string>("exec_pod", {
        context: props.context,
        namespace: props.namespace,
        podName: props.podName,
        container: props.container || null,
      });

      const stdoutEvent = `${sessionId}-stdout`;
      const exitEvent = `${sessionId}-exit`;
      const stdinEvent = `${sessionId}-stdin`;

      unlistenStdout = await listen<string>(stdoutEvent, (event) => {
        if (term) term.write(event.payload);
      });

      unlistenExit = await listen<string>(exitEvent, (event) => {
        if (term) term.writeln(`\r\n[${event.payload}]`);
      });

      term.onData((data: string) => {
        emit(stdinEvent, data);
      });
    } catch (e: any) {
      if (term) term.writeln(`\r\nError: ${e}`);
    }
  }

  onMount(() => {
    startSession();
  });

  onCleanup(() => {
    if (unlistenStdout) unlistenStdout();
    if (unlistenExit) unlistenExit();
    if (term) term.dispose();
    sessionId = null;
  });

  return (
    <div
      ref={termRef}
      class="terminal-container"
    />
  );
}
