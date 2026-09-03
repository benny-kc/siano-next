# Lightweight metrics push (no agent)

`siano-metrics-push.sh` is a **dependency-free replacement for Grafana Alloy** on
small / low-RAM hosts (Alpine especially). There is **no long-running agent**: one
short `sh` + `curl` run on a timer, so nothing sits resident eating RAM or crashes
between scrapes. Idle cost is effectively zero (cron) or ~1–2 MB (sleep-loop),
versus Alloy's ~100–200 MB.

## Why this works (and why it isn't pure `remote_write`)

Prometheus `remote_write` needs protobuf + snappy framing — not doable in shell.
So instead the script posts **InfluxDB line protocol** to Grafana Cloud's
`…/api/v1/push/influx/write` endpoint (plain HTTP POST + basic auth), which Grafana
maps back to Prometheus series. Because each point uses a field named `value`, the
metric **name is preserved** and tags become labels — so the hub's whole `/metrics`
(app + peer series) is translated verbatim by one `awk` pass and keeps every name
and label. Only the host metrics (CPU/mem/disk/load), previously from node_exporter,
are computed here and named `host_*`.

Grafana adds a `__proxy_source__="influx"` label to every pushed series (harmless;
the dashboard tables exclude it).

## What it emits

| Metric | From |
|---|---|
| `host_cpu_percent` | `/proc/stat` delta since the previous run (state in `$STATE_DIR`) |
| `host_mem_used_percent`, `host_mem_used_bytes`, `host_mem_total_bytes` | `/proc/meminfo` |
| `host_disk_used_percent`, `host_disk_avail_bytes`, `host_disk_size_bytes` | `df -kP /` |
| `host_load1` / `_load5` / `_load15`, `host_uptime_seconds` | `/proc/loadavg`, `/proc/uptime` |
| `host_uname_info{nodename,sysname,release,machine}` | `uname` |
| `siano_logfile_bytes{path}`, `siano_logdir_bytes{dir}` | `stat` / `du` on the log paths |
| `siano_*` (all app + peer series, verbatim) | the hub's `GET /metrics` |

Every series is tagged `hub=<HUB>` and `os=<OS>` — the same labels Alloy set via
`external_labels`, so the dashboard (split by `hub`) works unchanged for the app +
peer rows. The Host row uses the `host_*` names.

## Configure (environment)

| Var | Meaning |
|---|---|
| `GRAFANA_INFLUX_URL` | e.g. `https://influx-prod-XX.grafana.net/api/v1/push/influx/write` (from the Cloud Portal → InfluxDB card). Unset ⇒ **dry run** to stdout. |
| `GRAFANA_INFLUX_USER` / `GRAFANA_INFLUX_TOKEN` | metrics instance id / access-policy token (metrics:write) |
| `HUB` / `OS` | the labels for this box, e.g. `hub-a` / `alpine` |
| `HUB_METRICS_URL` | default `http://127.0.0.1:4000/metrics` |
| `SIANO_METRICS_TOKEN` | bearer for the hub `/metrics` (same value the hub uses) |
| `SIANO_LOG_GLOBS` / `SIANO_DATA_DIR` | which log files / op-log dir to size |
| `STATE_DIR` | default `/var/lib/siano-metrics` (holds the previous CPU sample) |

**Dry run first** (no endpoint set) to eyeball the line protocol:

```sh
HUB=hub-a OS=alpine SIANO_METRICS_TOKEN=<tok> ./siano-metrics-push.sh | head
```

## Install — Alpine (busybox cron, recommended)

```sh
install -m755 siano-metrics-push.sh /opt/siano/ops/push/siano-metrics-push.sh
mkdir -p /var/lib/siano-metrics
cat > /etc/conf.d/siano-metrics.env <<'EOF'
GRAFANA_INFLUX_URL=https://influx-prod-XX.grafana.net/api/v1/push/influx/write
GRAFANA_INFLUX_USER=<instance-id>
GRAFANA_INFLUX_TOKEN=<token>
HUB=hub-a
OS=alpine
SIANO_METRICS_TOKEN=<hub token>
EOF
# One line per minute via busybox crond (reads the env file first):
echo '* * * * * . /etc/conf.d/siano-metrics.env; /opt/siano/ops/push/siano-metrics-push.sh' >> /etc/crontabs/root
rc-service crond restart
```

## Install — Ubuntu (cron)

```sh
sudo install -m755 siano-metrics-push.sh /opt/siano/ops/push/siano-metrics-push.sh
sudo mkdir -p /var/lib/siano-metrics
sudo tee /etc/siano-metrics.env >/dev/null <<'EOF'
GRAFANA_INFLUX_URL=https://influx-prod-XX.grafana.net/api/v1/push/influx/write
GRAFANA_INFLUX_USER=<instance-id>
GRAFANA_INFLUX_TOKEN=<token>
HUB=hub-b
OS=ubuntu
SIANO_METRICS_TOKEN=<hub token>
EOF
echo '* * * * * root . /etc/siano-metrics.env; /opt/siano/ops/push/siano-metrics-push.sh' | sudo tee /etc/cron.d/siano-metrics
```

Oracle Cloud: outbound HTTPS only — no ingress rule needed.

## Sub-minute resolution

Cron's floor is 1 minute (fine for host metrics). For finer, run the built-in loop
under a supervisor instead of cron:

```sh
# OpenRC (Alpine) or systemd (Ubuntu) service command:
/opt/siano/ops/push/siano-metrics-push.sh --loop 20   # push every 20s
```

That's still just `sh` + `curl` (~1–2 MB), not a metrics runtime.

## Trade-offs vs the alternatives

- **This (shell push)** — lightest, no daemon, most stable on a tiny box. Host
  metrics are the essentials (CPU/mem/disk/load), not node_exporter's full catalogue.
- **vmagent + node_exporter** — two small Go binaries (~40 MB total), keeps the full
  `node_*` metric set and standard `remote_write`. Use this if you'd rather not
  give up node_exporter's breadth; the dashboard's Host panels would then need the
  `node_*` queries (see git history for the node_exporter version) instead of `host_*`.
- **Alloy** (`../alloy/`) — full featured but heavy; kept for hosts that can spare
  the RAM.

Pick one collector **per host**. If you mix (e.g. Alloy on Ubuntu, shell push on
Alpine), the Host row only lights up for whichever hosts emit `host_*`.
