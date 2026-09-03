#!/bin/sh
# Dependency-free metrics push for the Siano hub host — a lightweight replacement
# for Grafana Alloy on small / low-RAM boxes (Alpine especially). No long-running
# agent: one short sh + curl run (cron every minute, or a sleep-loop for finer
# resolution), so there is nothing to leak memory or crash.
#
# It sends to Grafana Cloud's InfluxDB line-protocol endpoint (plain HTTP POST +
# basic auth), which Grafana maps back to Prometheus series — a line
#   measurement,tag=v value=0.64
# becomes  measurement{tag="v"} 0.64 . Because the field is named `value`, the
# metric NAME is preserved, so the hub's own /metrics (app + peer series) are
# translated verbatim by the awk pass below and keep every name and label. Only
# the host metrics (CPU/mem/disk/load), which used to come from node_exporter,
# are computed here and named `host_*`.
#
# Every series is tagged hub=<HUB> os=<OS>, exactly like the Alloy external_labels
# did, so the same dashboard (split by `hub`) works unchanged for the app + peer
# rows; the Host row uses the `host_*` names (see ops/grafana + README).
#
# ── Config (environment) ─────────────────────────────────────────────────────
#   GRAFANA_INFLUX_URL   Grafana Cloud influx write URL, e.g.
#                        https://influx-prod-XX.grafana.net/api/v1/push/influx/write
#   GRAFANA_INFLUX_USER  metrics instance id            GRAFANA_INFLUX_TOKEN  access-policy token
#   HUB                  hub label (e.g. hub-a)         OS                    os label (e.g. alpine)
#   HUB_METRICS_URL      default http://127.0.0.1:4000/metrics
#   SIANO_METRICS_TOKEN  bearer for the hub /metrics (as configured on the hub)
#   SIANO_LOG_GLOBS      default "/var/log/siano/*.log /opt/siano/siano_data/logs/*.jsonl"
#   SIANO_DATA_DIR       default /opt/siano/siano_data  (rolled-up size)
#   STATE_DIR            default /var/lib/siano-metrics  (holds the prev CPU sample)
# With GRAFANA_INFLUX_URL unset the payload is printed to stdout (dry run).
#
# Schedule (Alpine busybox crond OR Ubuntu cron):  * * * * * /opt/siano/ops/push/siano-metrics-push.sh
# Finer than 1 min? run  siano-metrics-push.sh --loop 20  under OpenRC/systemd.
set -u

HUB="${HUB:-hub}"
OS="${OS:-linux}"
HUB_METRICS_URL="${HUB_METRICS_URL:-http://127.0.0.1:4000/metrics}"
SIANO_LOG_GLOBS="${SIANO_LOG_GLOBS:-/var/log/siano/*.log /opt/siano/siano_data/logs/*.jsonl}"
SIANO_DATA_DIR="${SIANO_DATA_DIR:-/opt/siano/siano_data}"
STATE_DIR="${STATE_DIR:-/var/lib/siano-metrics}"
mkdir -p "$STATE_DIR" 2>/dev/null || true

esc_tag() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/,/\\,/g; s/=/\\=/g; s/ /\\ /g'; }

# ── Host metrics (computed from /proc + df) → line protocol on stdout ─────────
host_metrics() {
  BASE="host_placeholder,hub=$(esc_tag "$HUB"),os=$(esc_tag "$OS")"
  emit() { printf '%s,hub=%s,os=%s value=%s\n' "$1" "$(esc_tag "$HUB")" "$(esc_tag "$OS")" "$2"; }

  # CPU %: busy fraction over the interval since the previous run. /proc/stat's
  # first line is: cpu  user nice system idle iowait irq softirq steal ...
  set -- $(awk '/^cpu /{for(i=2;i<=NF;i++)s+=$i; print s, $5}' /proc/stat)
  tot="$1"; idle="$2"; prev="$STATE_DIR/cpu.prev"
  if [ -f "$prev" ]; then
    read ptot pidle < "$prev" 2>/dev/null || { ptot=""; pidle=""; }
    if [ -n "${ptot:-}" ] && [ "$tot" -gt "$ptot" ] 2>/dev/null; then
      cpu=$(awk -v t="$tot" -v i="$idle" -v pt="$ptot" -v pi="$pidle" \
        'BEGIN{dt=t-pt; di=i-pi; if(dt>0) printf "%.1f", (1-di/dt)*100; else print "0"}')
      emit host_cpu_percent "$cpu"
    fi
  fi
  printf '%s %s\n' "$tot" "$idle" > "$prev"

  # Memory (kB in /proc/meminfo → bytes).
  awk -v b="$BASE" '
    /^MemTotal:/{tot=$2} /^MemAvailable:/{av=$2}
    END{ if(tot>0){ used=tot-av;
      printf "host_mem_total_bytes,%s value=%d\n", substr(b,index(b,",")+1), tot*1024
      printf "host_mem_used_bytes,%s value=%d\n",  substr(b,index(b,",")+1), used*1024
      printf "host_mem_used_percent,%s value=%.1f\n", substr(b,index(b,",")+1), used/tot*100 } }' /proc/meminfo

  # Root filesystem (df -kP: POSIX one-line output; 1024-blocks).
  df -kP / 2>/dev/null | awk -v b="$BASE" 'NR==2{
    size=$2*1024; avail=$4*1024; usedpct=$3/($3+$4)*100;
    t=substr(b,index(b,",")+1)
    printf "host_disk_size_bytes,%s value=%d\n", t, size
    printf "host_disk_avail_bytes,%s value=%d\n", t, avail
    printf "host_disk_used_percent,%s value=%.1f\n", t, usedpct }'

  # Load average + uptime.
  set -- $(cat /proc/loadavg 2>/dev/null)
  [ $# -ge 3 ] && { emit host_load1 "$1"; emit host_load5 "$2"; emit host_load15 "$3"; }
  up=$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null); [ -n "${up:-}" ] && emit host_uptime_seconds "$up"

  # Host identity (one row for the dashboard's Hosts table).
  printf 'host_uname_info,hub=%s,os=%s,nodename=%s,sysname=%s,release=%s,machine=%s value=1\n' \
    "$(esc_tag "$HUB")" "$(esc_tag "$OS")" "$(esc_tag "$(uname -n)")" \
    "$(esc_tag "$(uname -s)")" "$(esc_tag "$(uname -r)")" "$(esc_tag "$(uname -m)")"
}

# ── App log-file sizes (node_exporter couldn't size individual files) ─────────
log_metrics() {
  H="$(esc_tag "$HUB")"; O="$(esc_tag "$OS")"
  for glob in $SIANO_LOG_GLOBS; do
    for f in $glob; do
      [ -f "$f" ] || continue
      sz=$(stat -c %s "$f" 2>/dev/null || wc -c < "$f" 2>/dev/null || echo 0)
      printf 'siano_logfile_bytes,hub=%s,os=%s,path=%s value=%s\n' "$H" "$O" "$(esc_tag "$f")" "$sz"
    done
  done
  if [ -d "$SIANO_DATA_DIR" ]; then
    kb=$(du -sk "$SIANO_DATA_DIR" 2>/dev/null | awk '{print $1}')
    [ -n "${kb:-}" ] && printf 'siano_logdir_bytes,hub=%s,os=%s,dir=%s value=%s\n' "$H" "$O" "$(esc_tag "$SIANO_DATA_DIR")" "$((kb*1024))"
  fi
}

# ── Hub app + peer metrics: fetch /metrics and translate Prom text → influx ───
# Every `name{labels} val` line becomes `name,<labels>,hub=,os= value=val`, so
# names/labels survive (field is `value`). Comments and non-numeric values skip.
app_metrics() {
  auth=""; [ -n "${SIANO_METRICS_TOKEN:-}" ] && auth="Authorization: Bearer ${SIANO_METRICS_TOKEN}"
  curl -sf --max-time 5 ${auth:+-H "$auth"} "$HUB_METRICS_URL" 2>/dev/null | awk -v hub="$HUB" -v os="$OS" '
    /^[#]/ { next }                                   # HELP/TYPE comments
    {
      # Trailing value must be a finite number; skip +Inf/-Inf/NaN and blanks.
      if (!match($0, /[ \t]-?[0-9][0-9.eE+-]*[ \t]*$/)) next
      val = substr($0, RSTART+1, RLENGTH-1); gsub(/[ \t]+/, "", val)
      head = substr($0, 1, RSTART-1)
      b = index(head, "{")
      if (b > 0) { metric = substr(head, 1, b-1); labels = substr(head, b+1); sub(/}[ \t]*$/, "", labels) }
      else { metric = head; gsub(/[ \t]+$/, "", metric); labels = "" }
      # Prom `k="v",k2="v2"` → influx `k=v,k2=v2` (field is `value`, so the metric
      # NAME is preserved by the influx→prom mapping). Escape spaces in values;
      # the hub validates label values to comma/space-free content otherwise.
      gsub(/="/, "=", labels); gsub(/",/, ",", labels); gsub(/"$/, "", labels)
      gsub(/ /, "\\ ", labels)
      tags = "hub=" hub ",os=" os
      if (labels != "") tags = tags "," labels
      printf "%s,%s value=%s\n", metric, tags, val
    }'
}

payload() { host_metrics; log_metrics; app_metrics; }

# ── Optional self-loop for sub-minute resolution (cron gives 1-minute) ────────
if [ "${1:-}" = "--loop" ]; then
  every="${2:-30}"
  while :; do "$0" >/dev/null 2>&1 || true; sleep "$every"; done
fi

BODY="$(payload)"
if [ -z "${GRAFANA_INFLUX_URL:-}" ]; then
  printf '%s\n' "$BODY"    # dry run: no endpoint configured
  exit 0
fi
printf '%s\n' "$BODY" | curl -sf --max-time 10 \
  -u "${GRAFANA_INFLUX_USER:-}:${GRAFANA_INFLUX_TOKEN:-}" \
  --data-binary @- "$GRAFANA_INFLUX_URL" \
  || { echo "siano-metrics-push: POST failed" >&2; exit 1; }
