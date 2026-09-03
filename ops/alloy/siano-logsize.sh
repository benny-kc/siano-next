#!/bin/sh
# Emit Siano hub log / op-log file sizes for the node_exporter textfile
# collector (which Grafana Alloy's prometheus.exporter.unix scrapes). node_exporter
# measures the filesystem but not individual files, so this fills that gap.
#
# Portable across Alpine (busybox sh/stat/du) and Ubuntu (coreutils). Schedule it
# every 1-5 minutes from cron; it writes ATOMICALLY into the collector directory
# (temp file + mv) so node_exporter never reads a half-written file.
#
# Cron (both distros — busybox crond on Alpine, cron on Ubuntu):
#   */2 * * * * /opt/siano/ops/alloy/siano-logsize.sh
#
# Override any of these with environment variables (e.g. from the crontab line):
#   TEXTFILE_DIR      where Alloy's textfile collector reads .prom files
#   SIANO_LOG_GLOBS   space-separated globs of files to size individually
#   SIANO_DATA_DIR    op-log directory to report a rolled-up total for
set -eu

TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
SIANO_LOG_GLOBS="${SIANO_LOG_GLOBS:-/var/log/siano/*.log /opt/siano/siano_data/logs/*.jsonl}"
SIANO_DATA_DIR="${SIANO_DATA_DIR:-/opt/siano/siano_data}"

out="$TEXTFILE_DIR/siano_logsize.prom"
tmp="$out.$$"
mkdir -p "$TEXTFILE_DIR"

# stat -c works on both busybox and coreutils; wc -c is the last-resort fallback.
filesize() { stat -c %s "$1" 2>/dev/null || wc -c < "$1" 2>/dev/null || echo 0; }
# Escape backslash and double-quote for a Prometheus label value.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

{
  echo "# HELP siano_logfile_bytes Size of a Siano log / op-log file in bytes."
  echo "# TYPE siano_logfile_bytes gauge"
  for glob in $SIANO_LOG_GLOBS; do
    # Unquoted on purpose: the glob expands here. If nothing matches it stays
    # literal and the -f test below skips it.
    for f in $glob; do
      [ -f "$f" ] || continue
      echo "siano_logfile_bytes{path=\"$(esc "$f")\"} $(filesize "$f")"
    done
  done

  if [ -d "$SIANO_DATA_DIR" ]; then
    echo "# HELP siano_logdir_bytes Total size of the Siano op-log / data directory in bytes."
    echo "# TYPE siano_logdir_bytes gauge"
    # du -sk (kibibytes) is portable across busybox and coreutils; -sb is not.
    kb="$(du -sk "$SIANO_DATA_DIR" 2>/dev/null | awk '{print $1}')"
    [ -n "${kb:-}" ] && echo "siano_logdir_bytes{dir=\"$(esc "$SIANO_DATA_DIR")\"} $((kb * 1024))"
  fi
} > "$tmp"

mv "$tmp" "$out"
