# Host + hub monitoring with Grafana Alloy

> **Low on RAM? Prefer the agent-less shell pusher in [`../push/`](../push/README.md).**
> Alloy's component runtime uses ~100–200 MB and can be unstable on a tiny box
> (Alpine). `ops/push/siano-metrics-push.sh` does the same job with a one-shot
> `sh` + `curl` on a cron timer (no daemon, ~0 idle RAM). Use Alloy only on hosts
> that can spare the memory; the two are interchangeable per host.

One **Grafana Alloy** agent runs on each hub host and sends everything to your
Grafana Cloud (free tier) over outbound HTTPS. Alloy collects two things per host:

1. **Machine metrics** — CPU, memory, disk/filesystem (free space of `/`), load,
   network — via the built-in `prometheus.exporter.unix` component (that *is*
   node_exporter, embedded; **no Node.js and no separate exporter to install**).
2. **App log-file sizes** — node_exporter can't size individual files, so a tiny
   POSIX script (`siano-logsize.sh`) writes them to node_exporter's **textfile
   collector**, which Alloy scrapes.

Plus the Siano hub's own token-gated `/metrics` (app metrics). All of it is
stamped with a unique `hub` label so the two machines stay separable on one
dashboard (see [../grafana/README.md](../grafana/README.md)).

```
  Alpine host                         Ubuntu host (Oracle Cloud)
  ┌───────────────────────┐           ┌───────────────────────┐
  │ siano hub :4000        │          │ siano hub :4000        │
  │ node_exporter (in Alloy)│         │ node_exporter (in Alloy)│
  │ siano-logsize.sh → .prom│         │ siano-logsize.sh → .prom│
  │ Alloy  hub="hub-a"      │         │ Alloy  hub="hub-b"      │
  └───────────┬───────────┘           └───────────┬───────────┘
              └──────────── remote_write (HTTPS) ──┴───────► Grafana Cloud
```

## Files

| File | Use |
|---|---|
| `hub-a-alpine.alloy` | Alloy config for the Alpine host (`hub="hub-a"`, `os="alpine"`). |
| `hub-b-ubuntu.alloy` | Alloy config for the Ubuntu host (`hub="hub-b"`, `os="ubuntu"`). |
| `siano-logsize.sh` | Textfile-collector script: emits `siano_logfile_bytes{path}` per file and `siano_logdir_bytes{dir}` for the op-log dir total. |

Adjust in each `.alloy`: the hub address/port if not `127.0.0.1:4000`, the
`instance` label, and in `siano-logsize.sh` the `SIANO_LOG_GLOBS` /
`SIANO_DATA_DIR` (via env in the cron line) to match where your logs actually live.

## Setup — Ubuntu (systemd)

```bash
# 1. Install Alloy from Grafana's APT repo (see Grafana docs), then:
sudo mkdir -p /var/lib/node_exporter/textfile_collector

# 2. Drop the config in place and set the secrets.
sudo cp hub-b-ubuntu.alloy /etc/alloy/config.alloy
sudo tee /etc/default/alloy >/dev/null <<'EOF'
GRAFANA_CLOUD_PROM_URL=https://prometheus-prod-XX.grafana.net/api/prom/push
GRAFANA_CLOUD_USER=<metrics-instance-id>
GRAFANA_CLOUD_TOKEN=<grafana-cloud-token>
SIANO_METRICS_TOKEN=<same token the hub uses>
CUSTOM_ARGS=
EOF
sudo systemctl restart alloy

# 3. Schedule the log-size script (runs as root; writes the .prom atomically).
echo '*/2 * * * * root /opt/siano/ops/alloy/siano-logsize.sh' | sudo tee /etc/cron.d/siano-logsize
```

Oracle Cloud: this is all **outbound** HTTPS, so no VCN/security-list ingress rule
is needed. Keep the hub bound to loopback as before.

## Setup — Alpine (OpenRC)

```sh
# 1. Install Alloy (static binary or apk) and enable its OpenRC service.
mkdir -p /var/lib/node_exporter/textfile_collector

# 2. Config + secrets. Point the service at the config and export the env
#    (e.g. in /etc/conf.d/alloy). Then:
cp hub-a-alpine.alloy /etc/alloy/config.alloy
rc-service alloy restart

# 3. Schedule the script with busybox crond:
mkdir -p /etc/periodic/2min   # or use a crontab entry directly:
echo '*/2 * * * * /opt/siano/ops/alloy/siano-logsize.sh' >> /etc/crontabs/root
rc-service crond restart
```

Alpine is musl + busybox; `siano-logsize.sh` is written to run under busybox
`sh`/`stat`/`du`, and node_exporter reads `/proc` + `/sys` the same as on glibc.

## Verify

```bash
# The script produced metrics:
cat /var/lib/node_exporter/textfile_collector/siano_logsize.prom

# Alloy is scraping locally (its own UI, default :12345):
curl -s localhost:12345/-/ready
```

Within a minute you should see `node_cpu_seconds_total`, `node_filesystem_avail_bytes`,
`node_memory_*`, `siano_logfile_bytes`, and `siano_up` in Grafana Cloud — all
carrying `hub="hub-a"`/`"hub-b"`. Then (re)import the dashboard; its **Host
machines** row lights up.

## What the dashboard shows for hosts

CPU % and memory % per host, disk-used gauge + free-bytes trend for `/`, load
average, app log-file sizes (total per host + a per-file table), and a Hosts table
(hostname / kernel / arch / os) — all split by `hub`.

## Suggested host alerts (Grafana → Alerting)

- **Disk almost full** — `100 * (1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) > 90` for 10m.
- **High memory** — `100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) > 92` for 10m.
- **CPU saturated** — `100 * (1 - avg by (hub)(rate(node_cpu_seconds_total{mode="idle"}[5m]))) > 90` for 15m.
- **Log/data dir growth** — `siano_logdir_bytes` above your budget, or a steep `deriv(siano_logdir_bytes[1h])`.
- **Host stopped reporting** — `absent(node_uname_info{hub="hub-a"})` for 5m.
