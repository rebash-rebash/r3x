import { createSignal, createMemo, Show, For } from "solid-js";
import {
  events,
  eventsLoading,
  showEventsPanel,
  loadEvents,
} from "../stores/k8s";

export default function EventsPanel() {
  const [filter, setFilter] = createSignal("");
  const [typeFilter, setTypeFilter] = createSignal<string>("all");

  const filteredEvents = createMemo(() => {
    const q = filter().toLowerCase();
    const t = typeFilter();
    return events().filter((ev) => {
      if (t !== "all" && ev.event_type !== t) return false;
      if (!q) return true;
      return (
        (ev.name && ev.name.toLowerCase().includes(q)) ||
        (ev.reason && ev.reason.toLowerCase().includes(q)) ||
        (ev.message && ev.message.toLowerCase().includes(q))
      );
    });
  });

  return (
    <Show when={showEventsPanel()}>
      <div class="view-panel" style={{ overflow: "auto" }}>
        <div class="view-panel-header">
          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
            <h2>Events Log</h2>
            <span style={{ "font-size": "11px", color: "var(--text-muted)" }}>
              {filteredEvents().length} events
            </span>
          </div>
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <select
              value={typeFilter()}
              onChange={(e) => setTypeFilter(e.currentTarget.value)}
              style={{ "font-size": "12px" }}
            >
              <option value="all">All Types</option>
              <option value="Normal">Normal</option>
              <option value="Warning">Warning</option>
            </select>
            <input
              type="text"
              placeholder="Filter events..."
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
              style={{ "font-size": "12px", padding: "4px 8px", width: "160px" }}
            />
            <button class="action-btn" onClick={loadEvents}>Refresh</button>
          </div>
        </div>

        <div class="view-panel-content">
          <Show when={eventsLoading()}>
            <div class="loading-overlay">
              <span class="spinner" />
              Loading events...
            </div>
          </Show>
          <Show when={!eventsLoading()}>
            <table class="resource-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Reason</th>
                  <th>Object</th>
                  <th>Message</th>
                  <th>Count</th>
                  <th>Last Seen</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                <For each={filteredEvents()}>
                  {(ev) => (
                    <tr>
                      <td>
                        <span
                          class={`event-type ${ev.event_type === "Warning" ? "event-warning" : "event-normal"}`}
                        >
                          {ev.event_type || "-"}
                        </span>
                      </td>
                      <td>{ev.reason || "-"}</td>
                      <td style={{ color: "var(--text-secondary)" }}>
                        {ev.kind}/{ev.name}
                      </td>
                      <td class="event-message">{ev.message || "-"}</td>
                      <td>{ev.count || "-"}</td>
                      <td style={{ color: "var(--text-secondary)" }}>{ev.last_seen || "-"}</td>
                      <td style={{ color: "var(--text-secondary)", "font-size": "11px" }}>
                        {ev.source || "-"}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <Show when={filteredEvents().length === 0}>
              <div class="empty-state">
                <p>No events found</p>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  );
}
