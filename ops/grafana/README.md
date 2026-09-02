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

The dashboard has `job`, `instance` and `trip` template variables at the top
(all default to *All*), so it works whether you run one hub or several, and lets
you drill into a single trip in the *Per-trip* row.

## What's on it

| Section | Panels |
|---|---|
| **Overview** | Hub status (`siano_up`), uptime, live connections, active trips, trips on disk, op append rate. |
| **Traffic** | Op throughput (appended vs rejected), client message rate, connection churn (open/close), concurrency (connections & active trips). |
| **Errors & abuse** | Rate-limit closes, bad-JSON frames, WS upgrade rejections by reason. |
| **Per-trip** | Top trips by ops (table), per-trip live connections, per-trip op append rate. |
| **Process** | Resident memory (RSS) and V8 heap. |

## Suggested alerts (Grafana → Alerting)

- **Hub down** — `min(siano_up) < 1` (or `absent(siano_up)`) for 2m.
- **Abuse / flooding** — `sum(rate(siano_rate_limit_closes_total[5m])) > 0` for 10m.
- **Trip nearing its op cap** — `max(siano_trip_ops) > 0.9 * <SIANO_MAX_OPS_PER_TRIP>`.
- **Memory creep** — `max(siano_process_resident_memory_bytes)` above your host budget.

## Notes

- Counters are lifetime; every counter panel uses `rate(...[$__rate_interval])`.
- `siano_ws_upgrade_rejected_total{reason="none"}` is the zero-seed series (so the
  metric always exists); the rejections panel filters it out with `reason!="none"`.
- Per-trip series carry the trip id as a label — the same data the `/metrics`
  endpoint is token-gated to protect. Treat this dashboard (and the Prometheus
  behind it) as sensitive.
