# Grafana dashboard for the Siano hub

`siano-hub-dashboard.json` is an importable Grafana dashboard for the hub's
Prometheus `/metrics` endpoint (see `hub/metrics.js` and
[docs/security.md → *Metrics / monitoring*](../../docs/security.md#metrics--monitoring)).

It works with **Grafana Cloud (free tier)** fed by Grafana Alloy/Agent
`remote_write`, or any Grafana pointed at a Prometheus that scrapes the hub.

## Import

1. In Grafana: **Dashboards → New → Import**.
2. **Upload** `siano-hub-dashboard.json` (or paste its contents).
3. When prompted, pick your **Prometheus** data source (the one Alloy writes to)
   for the `DS_PROMETHEUS` input, then **Import**.

The dashboard has `hub`, `job`, `instance` and `trip` template variables at the
top (all default to *All*), so it works whether you run one hub or several, and
lets you filter to a single hub or drill into a single trip.

## Two (or more) hubs on one dashboard

Point **both** hubs' Grafana Alloy/Agent at the **same** Prometheus / Grafana
Cloud stack (one data source). The catch: if each Alloy scrapes its local hub at
`127.0.0.1:4000`, every series arrives with identical `job`/`instance` labels and
the two hubs are indistinguishable (their remote-writes even collide). Give each
hub a unique **`hub`** label via `external_labels` on its `remote_write`:

```alloy
// on hub A's host
prometheus.remote_write "grafanacloud" {
  external_labels = { hub = "hub-a" }        // hub = "hub-b" on the other host
  endpoint {
    url = "https://prometheus-prod-XX.grafana.net/api/prom/push"
    basic_auth { username = "<instance-id>"  password = sys.env("GRAFANA_CLOUD_TOKEN") }
  }
}
```

The dashboard is built around that `hub` label:

- **Fleet overview** — stat tiles `sum(...)` across all selected hubs (totals).
- **Per-hub health** — one tile per hub for status / uptime / connections.
- **Traffic, Errors, Process** — every time series is `sum by (hub) (...)` with a
  `{{hub}}` legend, so each hub is its own line.
- **Per-trip** — merged across hubs by `trip` (a trip peer-synced to both hubs is
  summed), so you see total activity per trip regardless of which hub served it.

Use the **Hub** dropdown to focus on one hub or compare a subset. (No `hub` label
yet? Everything still loads — the per-hub breakouts just collapse to a single
unlabeled series until you add it.)

## What's on it

| Section | Panels |
|---|---|
| **Overview** | Hub status (`siano_up`), uptime, live connections, active trips, trips on disk, op append rate. |
| **Traffic** | Op throughput (appended vs rejected), client message rate, connection churn (open/close), concurrency (connections & active trips). |
| **Errors & abuse** | Rate-limit closes, bad-JSON frames, WS upgrade rejections by reason. |
| **Host machines** | Per-host CPU %, memory %, disk `/` used (gauge) + free bytes, load average, app log-file sizes (total + per-file table), and a Hosts info table. Uses the `host_*` metrics from the lightweight shell pusher ([../push/README.md](../push/README.md)); the heavier Alloy/node_exporter path is in [../alloy/README.md](../alloy/README.md). |
| **Per-trip** | Top trips by ops (table), per-trip live connections, per-trip op append rate. |
| **Process** | Hub process resident memory (RSS) and V8 heap (distinct from whole-host memory). |
| **Hub-to-hub sync (peer link)** | Peer link status (UP/DOWN per dialer→peer), inbound peer connections, configured peers, peer op flow in/out per sec, and peer reconnects / auth failures. Only the dialing hub reports link status/op-flow; the acceptor reports inbound connections. Empty on a single-hub deployment. |

## Suggested alerts (Grafana → Alerting)

- **Hub down** — `min(siano_up) < 1` (or `absent(siano_up)`) for 2m.
- **Abuse / flooding** — `sum(rate(siano_rate_limit_closes_total[5m])) > 0` for 10m.
- **Trip nearing its op cap** — `max(siano_trip_ops) > 0.9 * <SIANO_MAX_OPS_PER_TRIP>`.
- **Memory creep** — `max(siano_process_resident_memory_bytes)` above your host budget.
- **Peer link down** — `max(siano_peer_link_up) < 1` for 5m (only where a hub is configured to dial, i.e. `siano_peer_configured > 0`).
- **Peer link flapping** — `sum(rate(siano_peer_disconnects_total[5m])) > 0` sustained for 15m.
- **Peer auth failures** — `sum(rate(siano_peer_auth_failures_total[5m])) > 0` (a peer dialing with the wrong `SIANO_PEER_TOKEN`).

## Notes

- Counters are lifetime; every counter panel uses `rate(...[$__rate_interval])`.
- `siano_ws_upgrade_rejected_total{reason="none"}` is the zero-seed series (so the
  metric always exists); the rejections panel filters it out with `reason!="none"`.
- Per-trip series carry the trip id as a label — the same data the `/metrics`
  endpoint is token-gated to protect. Treat this dashboard (and the Prometheus
  behind it) as sensitive.
