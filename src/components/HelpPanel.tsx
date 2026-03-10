import { Show } from "solid-js";
import { showHelpPanel, setShowHelpPanel } from "../stores/k8s";

export default function HelpPanel() {
  return (
    <Show when={showHelpPanel()}>
      <div class="help-panel">
        <div class="help-header">
          <h3>Help &amp; Guide</h3>
          <button class="detail-close" onClick={() => setShowHelpPanel(false)}>x</button>
        </div>
        <div class="help-content">

          <section class="help-section">
            <h4>Getting Started</h4>
            <p>r3x is a lightweight Kubernetes cockpit. Select a context and namespace from the top bar to connect to your cluster. The sidebar lets you browse resources, views, and security tools.</p>
          </section>

          <section class="help-section">
            <h4>Navigation</h4>
            <table class="help-table">
              <tbody>
                <tr><td class="help-key">Sidebar</td><td>Click any resource type (Pods, Deployments, etc.) to list resources</td></tr>
                <tr><td class="help-key">Context Switcher</td><td>Top-left dropdown — switch between Kubernetes clusters</td></tr>
                <tr><td class="help-key">Namespace Filter</td><td>Second dropdown — filter by namespace or view all</td></tr>
                <tr><td class="help-key">Search / Filter</td><td>Top-right input — filter resources by name</td></tr>
                <tr><td class="help-key">Label Filter</td><td>Filter bar below header — filter resources by label selector</td></tr>
              </tbody>
            </table>
          </section>

          <section class="help-section">
            <h4>Keyboard Shortcuts</h4>
            <table class="help-table">
              <thead>
                <tr><th>Key</th><th>Action</th></tr>
              </thead>
              <tbody>
                <tr><td class="help-key"><kbd>:</kbd></td><td>Open Command Palette</td></tr>
                <tr><td class="help-key"><kbd>/</kbd></td><td>Focus search / filter</td></tr>
                <tr><td class="help-key"><kbd>Esc</kbd></td><td>Close panel / deselect</td></tr>
                <tr><td class="help-key"><kbd>Enter</kbd></td><td>Select highlighted resource</td></tr>
                <tr><td class="help-key"><kbd>↑</kbd> <kbd>↓</kbd></td><td>Navigate resource list</td></tr>
                <tr><td class="help-key"><kbd>1</kbd>-<kbd>9</kbd></td><td>Switch resource kind (Pods, Deployments...)</td></tr>
                <tr><td class="help-key"><kbd>r</kbd></td><td>Refresh current view</td></tr>
                <tr><td class="help-key"><kbd>t</kbd></td><td>Toggle dark / light theme</td></tr>
                <tr><td class="help-key"><kbd>y</kbd></td><td>YAML tab (in detail panel)</td></tr>
                <tr><td class="help-key"><kbd>d</kbd></td><td>Describe tab (in detail panel)</td></tr>
                <tr><td class="help-key"><kbd>e</kbd></td><td>Edit YAML (in detail panel)</td></tr>
              </tbody>
            </table>
          </section>

          <section class="help-section">
            <h4>Resource Detail Panel</h4>
            <p>Click any resource to open its detail panel on the right. Available tabs depend on resource type:</p>
            <table class="help-table">
              <tbody>
                <tr><td class="help-key">YAML</td><td>View and edit raw YAML. Click Edit, modify, then Apply.</td></tr>
                <tr><td class="help-key">Describe</td><td>kubectl describe-like view — labels, annotations, conditions, containers, volumes, tolerations</td></tr>
                <tr><td class="help-key">Containers</td><td>(Pods) Container list with image, state, CPU/memory metrics, ports, limits</td></tr>
                <tr><td class="help-key">Logs</td><td>(Pods) Stream or tail logs. Filter by keyword. Select container.</td></tr>
                <tr><td class="help-key">Exec</td><td>(Pods) Open interactive shell sessions in containers</td></tr>
                <tr><td class="help-key">Events</td><td>Kubernetes events related to the selected resource</td></tr>
                <tr><td class="help-key">Pods</td><td>(Workloads) List pods owned by the Deployment/StatefulSet/DaemonSet</td></tr>
                <tr><td class="help-key">Benchmark</td><td>(Pods) HTTP benchmark tool — measure latency and throughput</td></tr>
                <tr><td class="help-key">Restarts</td><td>(Pods) Restart history and crash loop analysis</td></tr>
                <tr><td class="help-key">Images</td><td>(Pods) Container image scan for vulnerabilities</td></tr>
                <tr><td class="help-key">HPA/VPA</td><td>(Pods) Autoscaler configuration and status</td></tr>
                <tr><td class="help-key">Traffic</td><td>(Services/Workloads) Traffic distribution across pods</td></tr>
                <tr><td class="help-key">Cost</td><td>(Workloads) Estimated resource cost breakdown</td></tr>
                <tr><td class="help-key">Diff</td><td>(ConfigMaps/Secrets) Compare two resources side by side</td></tr>
              </tbody>
            </table>
          </section>

          <section class="help-section">
            <h4>Port Forward</h4>
            <p>Click the globe icon in the pod detail header to open port forwarding. Select a container port or enter custom ports. Active forwards show as clickable links that open in your browser.</p>
          </section>

          <section class="help-section">
            <h4>Views (Sidebar)</h4>
            <table class="help-table">
              <tbody>
                <tr><td class="help-key">Overview</td><td>Cluster dashboard with CPU, memory, pod status, and workload summary</td></tr>
                <tr><td class="help-key">Topology</td><td>Visual tree of controllers → ReplicaSets → Pods → Containers</td></tr>
                <tr><td class="help-key">Helm</td><td>List all Helm releases with status, chart version, and revision</td></tr>
                <tr><td class="help-key">RBAC</td><td>Role bindings, cluster roles, and subject permissions</td></tr>
                <tr><td class="help-key">Health Score</td><td>Cluster health analysis with actionable recommendations</td></tr>
                <tr><td class="help-key">Net Policies</td><td>Network policy visualization and coverage analysis</td></tr>
                <tr><td class="help-key">Events Log</td><td>Real-time cluster events with severity filtering</td></tr>
              </tbody>
            </table>
          </section>

          <section class="help-section">
            <h4>Security Scan</h4>
            <p>Scans workloads for misconfigurations: privileged containers, missing resource limits, dangerous capabilities, missing probes, root users, host access, latest image tags, and more. Filter by severity (Critical/High/Medium/Low) and category. Click any finding to see details and remediation steps.</p>
          </section>

          <section class="help-section">
            <h4>Command Palette</h4>
            <p>Press <kbd>:</kbd> to open. Type to search commands:</p>
            <table class="help-table">
              <tbody>
                <tr><td class="help-key">:ctx &lt;name&gt;</td><td>Switch context</td></tr>
                <tr><td class="help-key">:ns &lt;name&gt;</td><td>Switch namespace</td></tr>
                <tr><td class="help-key">:topology</td><td>Open topology view</td></tr>
                <tr><td class="help-key">:helm</td><td>Open Helm releases</td></tr>
                <tr><td class="help-key">:rbac</td><td>Open RBAC view</td></tr>
                <tr><td class="help-key">:security</td><td>Run security scan</td></tr>
                <tr><td class="help-key">:health</td><td>Open health score</td></tr>
                <tr><td class="help-key">:events</td><td>Open events log</td></tr>
                <tr><td class="help-key">:theme</td><td>Toggle theme</td></tr>
              </tbody>
            </table>
          </section>

          <section class="help-section help-footer">
            <p>r3x v0.2.1 — Built by <strong>Rebash</strong> (rebash.in)</p>
          </section>
        </div>
      </div>
    </Show>
  );
}
