<p align="center">
  <img src="src/assets/icon.svg" width="128" height="128" alt="r3x logo" />
</p>

<h1 align="center">r3x</h1>

<p align="center">
  <strong>Lightweight Kubernetes cockpit with security built in.</strong><br/>
  The speed of k9s. The visuals of Lens. None of the bloat.
</p>

<p align="center">
  <a href="https://rebash.in">rebash.in</a> &middot;
  <a href="#installation">Installation</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#keyboard-shortcuts">Keyboard Shortcuts</a> &middot;
  <a href="#building-from-source">Build from Source</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/version-0.2.0-orange" alt="Version" />
  <img src="https://img.shields.io/badge/rust-stable-brightgreen" alt="Rust" />
</p>

---

## Why r3x?

| | k9s | Lens | r3x |
|---|---|---|---|
| **UI** | Terminal only | Full GUI | Full GUI |
| **Memory** | ~30MB | ~500MB+ | ~30MB |
| **Bundle size** | ~30MB | ~400MB | ~17MB |
| **Startup** | <1s | 5-10s | <1s |
| **Runtime** | Go | Electron | Tauri (Rust + native webview) |
| **Security scanning** | No | Paid | Built-in |
| **Keyboard-first** | Yes | No | Yes |

r3x gives you a real GUI with the resource efficiency of a terminal app. No Electron. No subscription. Just a fast, native Kubernetes cockpit.

---

## Features

### Cluster Overview Dashboard
- **Default landing page** — Opens on startup with a full cluster summary
- **CPU & Memory donut charts** — Visual utilization gauges with color-coded thresholds
- **Pod status pie chart** — Running, Pending, Failed, Succeeded breakdown at a glance
- **Workload summary cards** — Deployments, StatefulSets, DaemonSets, Jobs with ready/not-ready counts
- **Per-node utilization table** — CPU and memory bars for every node in the cluster
- **Recent warnings** — Latest warning events surfaced immediately

### Live Cluster Health Bar
- **Always-visible status bar** — CPU and memory utilization displayed in the header at all times
- **Color-coded thresholds** — Green (<70%), amber (70-90%), red (>90%)
- **Node and pod counts** — Quick cluster size indicator

### Resource Management
- **15 resource types** — Pods, Deployments, Services, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs, ConfigMaps, Secrets, Ingresses, NetworkPolicies, ServiceAccounts, PVCs, Nodes
- **Custom Resources (CRDs)** — Auto-discovers and browses any CRD in your cluster
- **Multi-cluster** — Switch between kubeconfig contexts instantly with cluster name and user info displayed
- **Namespace filtering** — Browse all namespaces or pin favorites for quick access
- **Label filtering** — Filter resources by Kubernetes label selectors (e.g., `app=nginx,env=prod`)
- **Auto-refresh** — Configurable polling interval to keep resources up to date
- **Sorting & search** — Column sorting, full-text search across all visible fields

### Inspection
- **YAML viewer** — View the full YAML spec of any resource
- **Real-time log streaming** — Stream pod logs with container selection and keyword filtering
- **Log export** — Download logs as text files
- **Events timeline** — View Kubernetes events for any resource
- **Pod exec terminal** — Interactive shell into running containers via integrated terminal

### Operations
- **Scale deployments** — Scale replicas up/down directly from the UI
- **Rollout restart** — Trigger rolling restarts on Deployments, StatefulSets, DaemonSets
- **Port forwarding** — Forward local ports to pods/services with active session management
- **Delete resources** — Remove resources with confirmation
- **Apply YAML** — Edit and apply resource YAML directly
- **CronJob triggers** — Manually trigger CronJobs on demand

### Cluster Views
- **Cluster Dashboard** — CPU/memory donut charts, pod status pie, workload cards, node table, warning events
- **Topology graph** — Visual tree of Controllers → ReplicaSets → Pods → Containers with status indicators
- **Helm releases** — View all Helm releases with status, chart version, and revision history
- **RBAC viewer** — Inspect ClusterRoleBindings and RoleBindings with subject details and search
- **Network Policies** — Policy list with selector matching, rule details, and unprotected pod detection
- **Events log** — Cluster-wide event stream with filtering by type, reason, and object
- **Health Score** — Cluster health analysis with scoring and actionable recommendations

### Security
- **Security scanner** — Detects misconfigurations across your workloads:
  - Privileged containers
  - Running as root
  - Privilege escalation
  - Host network/PID/IPC access
  - Dangerous capabilities (SYS_ADMIN, NET_RAW, etc.)
  - Missing resource limits
  - `latest` image tags
  - Missing health probes
  - Default service account usage
  - Writable root filesystem
- **Security score** — 0-100 score with severity breakdown (Critical / High / Medium / Low)
- **Filterable findings** — Filter by severity, category, or search
- **Image scanning** — Detect image vulnerabilities and outdated base images

### Resource Benchmarking
- **CPU & memory recommendations** — Analyzes actual usage metrics and recommends right-sized requests and limits
- **Percentile-based** — Uses P50 for requests, P99 for limits, with safety margins

### Cost Estimation
- **Resource cost analysis** — Estimates monthly cost based on CPU and memory allocation

### Command Palette
- **k9s-style command mode** — Press `:` to open, type commands like:
  - `:pods`, `:deploy`, `:services` — switch resource type
  - `:ns default`, `:ns kube-system` — switch namespace
  - `:ctx my-cluster` — switch context
  - `:helm`, `:rbac`, `:dashboard`, `:topology`, `:security` — open views

### Quality of Life
- **Dark / Light theme** — Toggle with `t`
- **Keyboard-first navigation** — Full keyboard control, mouse optional
- **System tray** — Runs in background for instant access; click tray icon to restore
- **Favorite namespaces** — Pin frequently used namespaces for quick switching
- **Alerts bell** — Critical alerts indicator with warning count badge
- **Two-row header** — Context, namespace, cluster info on row 1; breadcrumb, filters, search on row 2
- **Tiny footprint** — ~17MB app bundle, ~30MB RAM at runtime

---

## Installation

### macOS

Download the latest `.dmg` from [Releases](https://github.com/rebash-rebash/r3x/releases), open it, and drag **r3x** to your Applications folder.

> **Note:** If macOS says "r3x is damaged and can't be opened", run:
> ```bash
> xattr -cr /Applications/r3x.app
> ```
> This removes the quarantine flag that macOS applies to unsigned apps.

Or build from source:

```bash
git clone https://github.com/rebash-rebash/r3x.git
cd r3x
npm install
cargo tauri build
open src-tauri/target/release/bundle/macos/r3x.app
```

### Windows

Download the latest `.msi` or `.exe` installer from [Releases](https://github.com/rebash-rebash/r3x/releases).

Or build from source:

```bash
git clone https://github.com/rebash-rebash/r3x.git
cd r3x
npm install
cargo tauri build
# Installer at: src-tauri\target\release\bundle\nsis\r3x_0.2.0_x64-setup.exe
```

### Linux

Download the latest `.AppImage` or `.deb` from [Releases](https://github.com/rebash-rebash/r3x/releases).

Or build from source:

```bash
git clone https://github.com/rebash-rebash/r3x.git
cd r3x
npm install
cargo tauri build
# Output at: src-tauri/target/release/bundle/deb/*.deb
```

---

## Prerequisites

r3x reads your local kubeconfig (`~/.kube/config`). Make sure:

1. **kubectl** is configured and can reach your cluster
2. **Helm** (optional) — required for Helm releases view (`helm` must be in PATH)
3. **Metrics Server** (optional) — required for CPU/memory metrics, dashboard charts, and benchmarking

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `:` | Open command palette |
| `/` | Focus search |
| `Up/Down` | Navigate resources |
| `Enter` | Select / expand resource |
| `Esc` | Close panel / deselect |
| `1`-`9` | Switch resource kind |
| `r` | Refresh resources |
| `t` | Toggle dark/light theme |
| `j` / `Arrow Down` | Focus first resource row |

---

## Building from Source

### Requirements

- **Rust** (stable) — [Install via rustup](https://rustup.rs/)
- **Node.js** 18+ — [Install via nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org/)
- **System dependencies** (platform-specific):

#### macOS
```bash
xcode-select --install
```

#### Windows
- [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 10/11)

#### Linux (Debian/Ubuntu)
```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

### Build

```bash
# Clone
git clone https://github.com/rebash-rebash/r3x.git
cd r3x

# Install frontend dependencies
npm install

# Development (hot-reload)
npm run tauri dev

# Production build
cargo tauri build
```

Build outputs:
- **macOS**: `src-tauri/target/release/bundle/macos/r3x.app` and `.dmg`
- **Windows**: `src-tauri/target/release/bundle/nsis/r3x_*-setup.exe` and `.msi`
- **Linux**: `src-tauri/target/release/bundle/deb/*.deb` and `appimage/*.AppImage`

---

## Architecture

```
r3x/
├── src/                    # Frontend (SolidJS + TypeScript)
│   ├── components/         # UI components
│   │   ├── Sidebar.tsx         # Resource kind navigation
│   │   ├── Header.tsx          # Context/namespace switcher, health bar, search
│   │   ├── ResourceTable.tsx   # Main resource list with sorting
│   │   ├── DetailPanel.tsx     # YAML, logs, exec, events, metrics
│   │   ├── CommandPalette.tsx  # k9s-style command mode
│   │   ├── ClusterDashboard.tsx# Cluster overview with donut charts
│   │   ├── TopologyPanel.tsx   # Workload topology tree
│   │   ├── SecurityPanel.tsx   # Security scan results
│   │   ├── HelmPanel.tsx       # Helm releases viewer
│   │   ├── RbacPanel.tsx       # RBAC bindings viewer
│   │   ├── HealthPanel.tsx     # Cluster health scoring
│   │   ├── NetpolPanel.tsx     # Network policy viewer
│   │   ├── EventsPanel.tsx     # Cluster events log
│   │   ├── AlertsBell.tsx      # Critical alerts indicator
│   │   └── Terminal.tsx        # xterm.js pod exec
│   ├── stores/
│   │   ├── k8s.ts              # Central state (signals + Tauri IPC)
│   │   └── theme.ts            # Dark/light theme state
│   └── styles/
│       └── global.css          # All styles (~40KB)
├── src-tauri/              # Backend (Rust)
│   └── src/
│       ├── lib.rs              # Tauri app setup, system tray, window management
│       └── k8s/
│           ├── resources.rs    # Resource listing (15 types + CRDs)
│           ├── context.rs      # Kubeconfig context management
│           ├── logs.rs         # Log streaming
│           ├── exec.rs         # Pod exec via WebSocket
│           ├── security.rs     # Security misconfiguration scanner
│           ├── topology.rs     # Workload topology builder
│           ├── metrics.rs      # Cluster metrics aggregation
│           ├── summary.rs      # Cluster overview data
│           ├── health.rs       # Cluster health scoring
│           ├── benchmark.rs    # Resource recommendation engine
│           ├── cost.rs         # Cost estimation
│           ├── helm.rs         # Helm CLI integration
│           ├── rbac.rs         # RBAC binding queries
│           ├── netpol.rs       # Network policy analysis
│           ├── events.rs       # Kubernetes events
│           ├── nodes.rs        # Node details, cordon/drain
│           ├── portforward.rs  # Port forwarding
│           ├── scale.rs        # Deployment scaling, rollout restart
│           ├── images.rs       # Image scanning
│           ├── hpa.rs          # Horizontal Pod Autoscaler
│           ├── diff.rs         # Resource diff
│           ├── discovery.rs    # API resource discovery
│           ├── crds.rs         # CRD discovery
│           ├── cronjob.rs      # CronJob management
│           ├── restarts.rs     # Restart history tracking
│           └── traffic.rs      # Traffic distribution
└── package.json
```

**Frontend** communicates with **Backend** via Tauri IPC (invoke/listen). All Kubernetes API calls happen in Rust via [kube-rs](https://github.com/kube-rs/kube). The frontend never touches the network directly.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | [Tauri 2.x](https://tauri.app/) |
| Backend | Rust + [kube-rs](https://github.com/kube-rs/kube) 0.98 |
| Frontend | [SolidJS](https://www.solidjs.com/) + TypeScript |
| Terminal | [xterm.js](https://xtermjs.org/) |
| Bundler | [Vite](https://vitejs.dev/) |

---

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

```bash
# Fork & clone
git clone https://github.com/<your-username>/r3x.git
cd r3x
npm install
npm run tauri dev
```

---

## License

[MIT](LICENSE) - Made by [Rebash](https://rebash.in)
