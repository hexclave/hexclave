#!/usr/bin/env bash

set -euo pipefail

case "${1:-}" in
  reset|sample|snapshot)
    ;;
  *)
    echo "Usage: $0 {reset|sample|snapshot}" >&2
    exit 2
    ;;
esac

state_file="${RUNNER_TEMP:-/tmp}/hexclave-process-attribution.state.untracked.tsv"
container_state_file="${RUNNER_TEMP:-/tmp}/hexclave-container-attribution.state.untracked.tsv"
disk_state_file="${RUNNER_TEMP:-/tmp}/hexclave-disk-attribution.state.untracked.tsv"
container_io_state_file="${RUNNER_TEMP:-/tmp}/hexclave-container-io-attribution.state.untracked.tsv"
clock_ticks="$(getconf CLK_TCK)"

declare -A previous_process_cpu
declare -A previous_container_cpu
declare -A previous_disk_stats
declare -A previous_container_io

if [[ "$1" == reset ]]; then
  "$0" snapshot >/dev/null
  exit 0
fi

if [[ -f "$state_file" ]]; then
  while IFS='|' read -r pid label cpu_seconds; do
    [[ -n "$pid" ]] && previous_process_cpu["$pid"]="$cpu_seconds"
  done < "$state_file"
fi

if [[ -f "$container_state_file" ]]; then
  while IFS='|' read -r container_id container_name cpu_seconds; do
    [[ -n "$container_id" ]] && previous_container_cpu["$container_id"]="$cpu_seconds"
  done < "$container_state_file"
fi

if [[ -f "$disk_state_file" ]]; then
  while IFS='|' read -r device reads sectors_read read_ms writes sectors_written write_ms io_ms weighted_io_ms; do
    [[ -n "$device" ]] && previous_disk_stats["$device"]="$reads|$sectors_read|$read_ms|$writes|$sectors_written|$write_ms|$io_ms|$weighted_io_ms"
  done < "$disk_state_file"
fi

if [[ -f "$container_io_state_file" ]]; then
  while IFS='|' read -r container_id read_bytes write_bytes read_ops write_ops; do
    [[ -n "$container_id" ]] && previous_container_io["$container_id"]="$read_bytes|$write_bytes|$read_ops|$write_ops"
  done < "$container_io_state_file"
fi

read_process_label() {
  local command_line="$1"
  local working_directory="$2"
  case "$command_line" in
    *"bulldozer"*|*"start:bulldozer"*) printf '%s' "bulldozer" ;;
    *"run-cron-jobs"*) printf '%s' "cron-jobs" ;;
    *"run-email-queue"*) printf '%s' "email-queue" ;;
    *"apps/mcp"*|*"start:mcp"*) printf '%s' "mcp" ;;
    *"apps/dashboard"*|*"start:dashboard"*) printf '%s' "dashboard" ;;
    *"stack-backend"*|*"apps/backend"*|*"dist/server.mjs"*) printf '%s' "backend" ;;
    *)
      # tsx re-spawns the actual server as a node child whose cmdline is just
      # "node --require .../tsx/preflight.cjs --import .../tsx/loader.mjs src/index.ts",
      # with no app name in it. The Bulldozer server (the process doing all the real
      # work) was therefore invisible to the cmdline patterns above and its CPU went
      # unattributed. Fall back to the process working directory for that case.
      case "$working_directory" in
        */apps/bulldozer-js*) printf '%s' "bulldozer" ;;
        *) return 1 ;;
      esac
      ;;
  esac
}

read_process_cpu_seconds() {
  local stat_file="$1"
  local stat_line fields
  stat_line="$(<"$stat_file")"
  stat_line="${stat_line#*) }"
  read -r -a fields <<< "$stat_line"
  awk -v user_ticks="${fields[11]}" -v system_ticks="${fields[12]}" -v clock_ticks="$clock_ticks" \
    'BEGIN { printf "%.6f", (user_ticks + system_ticks) / clock_ticks }'
}

read_process_rss_kb() {
  awk '$1 == "VmRSS:" { print $2; found = 1 } END { if (!found) print 0 }' "$1/status"
}

read_host_cpu() {
  awk -v clock_ticks="$clock_ticks" \
    '$1 == "cpu" {
      for (i = 2; i <= 9; i++) total += $i / clock_ticks
      idle = $5 / clock_ticks
      io_wait = $6 / clock_ticks
      printf "%.6f|%.6f|%.6f", total, idle, io_wait
      exit
    }' /proc/stat
}

read_monotonic_seconds() {
  awk '{ printf "%.6f", $1; exit }' /proc/uptime
}

read_container_cpu() {
  local container_pid="$1"
  local cgroup_path cpu_stat usage_usec
  cgroup_path="$(awk -F: '$1 == "0" { print $3 }' "/proc/$container_pid/cgroup" 2>/dev/null || true)"
  if [[ -z "$cgroup_path" ]]; then
    return 1
  fi
  if [[ -f "/sys/fs/cgroup${cgroup_path}/cpu.stat" ]]; then
    cpu_stat="$(awk '$1 == "usage_usec" { print $2 }' "/sys/fs/cgroup${cgroup_path}/cpu.stat")"
    usage_usec="${cpu_stat:-0}"
    awk -v usage_usec="$usage_usec" 'BEGIN { printf "%.6f", usage_usec / 1000000 }'
  else
    return 1
  fi
}

read_container_io() {
  local container_pid="$1"
  local cgroup_path io_stat
  cgroup_path="$(awk -F: '$1 == "0" { print $3 }' "/proc/$container_pid/cgroup" 2>/dev/null || true)"
  [[ -n "$cgroup_path" ]] || return 1
  io_stat="/sys/fs/cgroup${cgroup_path}/io.stat"
  [[ -f "$io_stat" ]] || return 1
  awk '{
    for (i = 2; i <= NF; i++) {
      split($i, value, "=")
      if (value[1] == "rbytes") read_bytes += value[2]
      else if (value[1] == "wbytes") write_bytes += value[2]
      else if (value[1] == "rios") read_ops += value[2]
      else if (value[1] == "wios") write_ops += value[2]
    }
  } END {
    printf "%.0f|%.0f|%.0f|%.0f\n", read_bytes, write_bytes, read_ops, write_ops
  }' "$io_stat"
}

if [[ "$1" == sample ]]; then
  # Whole-pass deltas hide short periods of saturation. Preserve raw one-second counters so
  # utilization, queue depth, IOPS, latency, and CPU iowait percentiles can be derived together.
  echo "# host|monotonic_seconds|unix_time_millis|host_total_seconds|host_idle_seconds|host_iowait_seconds|load_average_1|load_average_5|load_average_15"
  echo "# disk|monotonic_seconds|unix_time_millis|device|reads|sectors_read|read_ms|writes|sectors_written|write_ms|ios_in_progress|io_ms|weighted_io_ms"
  trap 'exit 0' TERM INT
  while true; do
    sample_time="$(read_monotonic_seconds)"
    sample_unix_time_millis="$(date +%s%3N)"
    IFS='|' read -r host_total_cpu host_idle_cpu host_iowait_cpu <<< "$(read_host_cpu)"
    IFS=' ' read -r load_average_1 load_average_5 load_average_15 _unused < /proc/loadavg
    printf 'host|%s|%s|%s|%s|%s|%s|%s|%s\n' \
      "$sample_time" "$sample_unix_time_millis" "$host_total_cpu" "$host_idle_cpu" "$host_iowait_cpu" \
      "$load_average_1" "$load_average_5" "$load_average_15"
    while read -r _major _minor device reads _reads_merged sectors_read read_ms writes _writes_merged sectors_written write_ms ios_in_progress io_ms weighted_io_ms \
      _discards _discards_merged _sectors_discarded _discard_ms _flushes _flush_ms; do
      [[ -n "$device" ]] || continue
      printf 'disk|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
        "$sample_time" "$sample_unix_time_millis" "$device" "$reads" "$sectors_read" "$read_ms" \
        "$writes" "$sectors_written" "$write_ms" "$ios_in_progress" "$io_ms" "$weighted_io_ms"
    done < /proc/diskstats
    sleep 1
  done
fi

if [[ "$1" == snapshot ]]; then
  echo
  echo "========== Process and container attribution =========="
  echo "CPU values are deltas since the previous snapshot; process rows retain each matching PID."
  echo
fi

current_state="$(mktemp "${RUNNER_TEMP:-/tmp}/hexclave-process-attribution.XXXXXX.untracked")"
current_container_state="$(mktemp "${RUNNER_TEMP:-/tmp}/hexclave-container-attribution.XXXXXX.untracked")"
current_disk_state="$(mktemp "${RUNNER_TEMP:-/tmp}/hexclave-disk-attribution.XXXXXX.untracked")"
current_container_io_state="$(mktemp "${RUNNER_TEMP:-/tmp}/hexclave-container-io-attribution.XXXXXX.untracked")"
current_container_io_output="$(mktemp "${RUNNER_TEMP:-/tmp}/hexclave-container-io-output.XXXXXX.untracked")"
trap 'rm -f "$current_state" "$current_container_state" "$current_disk_state" "$current_container_io_state" "$current_container_io_output"' EXIT

if [[ "$1" == snapshot ]]; then
  echo "Host CPU and load"
  IFS='|' read -r host_total_cpu host_idle_cpu host_iowait_cpu <<< "$(read_host_cpu)"
  host_monotonic_seconds="$(read_monotonic_seconds)"
  load_average="$(awk '{ print $1 "|" $2 "|" $3 }' /proc/loadavg)"
  previous_host_file="${RUNNER_TEMP:-/tmp}/hexclave-host-attribution.state.untracked.tsv"
  if [[ -f "$previous_host_file" ]]; then
    IFS='|' read -r previous_host_total previous_host_idle previous_host_iowait previous_host_monotonic_seconds < "$previous_host_file"
    awk -v total="$host_total_cpu" -v idle="$host_idle_cpu" -v io_wait="$host_iowait_cpu" \
      -v previous_total="$previous_host_total" -v previous_idle="$previous_host_idle" -v previous_io_wait="$previous_host_iowait" \
      -v monotonic_seconds="$host_monotonic_seconds" -v previous_monotonic_seconds="$previous_host_monotonic_seconds" \
      -v load_values="$load_average" \
      'BEGIN {
        total_delta = total - previous_total
        idle_delta = idle - previous_idle
        io_wait_delta = io_wait - previous_io_wait
        printf "host_interval_seconds|%.6f\nhost_cpu_total_seconds|%.6f\nhost_cpu_busy_seconds|%.6f\nhost_cpu_idle_seconds|%.6f\nhost_cpu_iowait_seconds|%.6f\nload_average_1_5_15|%s\n",
          monotonic_seconds - previous_monotonic_seconds, total_delta, total_delta - idle_delta - io_wait_delta,
          idle_delta, io_wait_delta, load_values
      }'
  else
    printf 'host_interval_seconds|0\nhost_cpu_total_seconds|0\nhost_cpu_busy_seconds|0\nhost_cpu_idle_seconds|0\nhost_cpu_iowait_seconds|0\nload_average_1_5_15|%s\n' "$load_average"
  fi
  printf '%s|%s|%s|%s\n' "$host_total_cpu" "$host_idle_cpu" "$host_iowait_cpu" "$host_monotonic_seconds" > "$previous_host_file"
  echo

  echo "Per-process CPU and RSS"
  echo "label|pid|cpu_seconds_delta|cpu_seconds_total|rss_kb|command"
fi

if [[ "$1" == snapshot ]]; then
  echo
  echo "Per-device block I/O"
  echo "device|reads_delta|sectors_read_delta|read_ms_delta|writes_delta|sectors_written_delta|write_ms_delta|io_ms_delta|weighted_io_ms_delta"
fi

while read -r major minor device reads reads_merged sectors_read read_ms writes writes_merged sectors_written write_ms ios_in_progress io_ms weighted_io_ms \
  _discards _discards_merged _sectors_discarded _discard_ms _flushes _flush_ms; do
  [[ -n "$device" ]] || continue
  current="$reads|$sectors_read|$read_ms|$writes|$sectors_written|$write_ms|$io_ms|$weighted_io_ms"
  printf '%s|%s\n' "$device" "$current" >> "$current_disk_state"
  if [[ "$1" == snapshot ]]; then
    previous="${previous_disk_stats[$device]:-0|0|0|0|0|0|0|0}"
    IFS='|' read -r previous_reads previous_sectors_read previous_read_ms previous_writes previous_sectors_written previous_write_ms previous_io_ms previous_weighted_io_ms <<< "$previous"
    awk -v device="$device" \
      -v reads="$reads" -v previous_reads="$previous_reads" \
      -v sectors_read="$sectors_read" -v previous_sectors_read="$previous_sectors_read" \
      -v read_ms="$read_ms" -v previous_read_ms="$previous_read_ms" \
      -v writes="$writes" -v previous_writes="$previous_writes" \
      -v sectors_written="$sectors_written" -v previous_sectors_written="$previous_sectors_written" \
      -v write_ms="$write_ms" -v previous_write_ms="$previous_write_ms" \
      -v io_ms="$io_ms" -v previous_io_ms="$previous_io_ms" \
      -v weighted_io_ms="$weighted_io_ms" -v previous_weighted_io_ms="$previous_weighted_io_ms" \
      'BEGIN {
        printf "%s|%.0f|%.0f|%.0f|%.0f|%.0f|%.0f|%.0f|%.0f\n", device,
          reads - previous_reads, sectors_read - previous_sectors_read, read_ms - previous_read_ms,
          writes - previous_writes, sectors_written - previous_sectors_written,
          write_ms - previous_write_ms, io_ms - previous_io_ms, weighted_io_ms - previous_weighted_io_ms
      }'
  fi
done < <(cat /proc/diskstats 2>/dev/null || true)
mv "$current_disk_state" "$disk_state_file"

for stat_file in /proc/[0-9]*/stat; do
  [[ -r "$stat_file" ]] || continue
  pid="${stat_file#/proc/}"
  pid="${pid%/stat}"
  command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ -n "$command_line" ]] || continue
  working_directory="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  label="$(read_process_label "$command_line" "$working_directory" || true)"
  [[ -n "$label" ]] || continue
  cpu_seconds="$(read_process_cpu_seconds "$stat_file" || true)"
  [[ -n "$cpu_seconds" ]] || continue
  rss_kb="$(read_process_rss_kb "/proc/$pid" || true)"
  [[ -n "$rss_kb" ]] || continue
  previous_cpu="${previous_process_cpu[$pid]:-0}"
  cpu_delta="$(awk -v current="$cpu_seconds" -v previous="$previous_cpu" 'BEGIN { delta = current - previous; printf "%.6f", delta < 0 ? 0 : delta }')"
  printf '%s|%s|%s|%s|%s|%s\n' "$pid" "$label" "$cpu_seconds" "$cpu_delta" "$rss_kb" "$command_line" >> "$current_state"
  if [[ "$1" == snapshot ]]; then
    printf '%s|%s|%s|%s|%s|%s\n' "$label" "$pid" "$cpu_delta" "$cpu_seconds" "$rss_kb" "$command_line"
  fi
done

mv "$current_state" "$state_file"

if [[ "$1" == snapshot ]]; then
  echo
  echo "Per-container CPU"
  echo "container|id|cpu_seconds_delta|cpu_seconds_total"
  while IFS='|' read -r container_id container_name container_pid; do
    [[ -n "$container_id" ]] || continue
    cpu_seconds="$(read_container_cpu "$container_pid" || true)"
    [[ -n "$cpu_seconds" ]] || continue
    previous_cpu="${previous_container_cpu[$container_id]:-0}"
    cpu_delta="$(awk -v current="$cpu_seconds" -v previous="$previous_cpu" 'BEGIN { delta = current - previous; printf "%.6f", delta < 0 ? 0 : delta }')"
    printf '%s|%s|%s|%s\n' "$container_name" "$container_id" "$cpu_delta" "$cpu_seconds"
    printf '%s|%s|%s\n' "$container_id" "$container_name" "$cpu_seconds" >> "$current_container_state"
    io_values="$(read_container_io "$container_pid" || true)"
    if [[ -n "$io_values" ]]; then
      IFS='|' read -r read_bytes write_bytes read_ops write_ops <<< "$io_values"
      previous_io="${previous_container_io[$container_id]:-0|0|0|0}"
      IFS='|' read -r previous_read_bytes previous_write_bytes previous_read_ops previous_write_ops <<< "$previous_io"
      printf '%s|%s|%s|%s|%s\n' "$container_id" "$read_bytes" "$write_bytes" "$read_ops" "$write_ops" >> "$current_container_io_state"
      printf '%s|%s|%s|%s|%s\n' "$container_name" \
        "$((read_bytes - previous_read_bytes))" "$((write_bytes - previous_write_bytes))" \
        "$((read_ops - previous_read_ops))" "$((write_ops - previous_write_ops))" >> "$current_container_io_output"
    fi
  done < <(docker ps -q | while read -r container_id; do
    docker inspect --format '{{.Id}}|{{.Name}}|{{.State.Pid}}' "$container_id" | sed 's#|/#|#'
  done)
  echo
  echo "Per-container block I/O"
  echo "container|read_bytes_delta|write_bytes_delta|read_ops_delta|write_ops_delta"
  cat "$current_container_io_output"
else
  while IFS='|' read -r container_id container_name container_pid; do
    [[ -n "$container_id" ]] || continue
    cpu_seconds="$(read_container_cpu "$container_pid" || true)"
    [[ -n "$cpu_seconds" ]] || continue
    printf '%s|%s|%s\n' "$container_id" "$container_name" "$cpu_seconds" >> "$current_container_state"
    io_values="$(read_container_io "$container_pid" || true)"
    if [[ -n "$io_values" ]]; then
      printf '%s|%s\n' "$container_id" "$io_values" >> "$current_container_io_state"
    fi
  done < <(docker ps -q | while read -r container_id; do
    docker inspect --format '{{.Id}}|{{.Name}}|{{.State.Pid}}' "$container_id" | sed 's#|/#|#'
  done)
fi

mv "$current_container_state" "$container_state_file"
mv "$current_container_io_state" "$container_io_state_file"
