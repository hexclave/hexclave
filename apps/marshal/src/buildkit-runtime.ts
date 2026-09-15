/** BuildKit lifecycle and bounded recovery, shared by all target build modes. */
export function buildkitRuntimeScript(): string {
  return `
BUILDKIT_DISK_DIR="\${BUILDKIT_DISK_DIR:-/.marshal-buildkit-disk}"
BUILDKIT_ROOT=""
BUILDKIT_STORE_READY=""
buildkit_disk_available() {
  # A plain directory on the root overlay would force slow native snapshots.
  # Require an actual disk mount that can host the overlayfs snapshotter.
  awk -v dir="$BUILDKIT_DISK_DIR" '$2 == dir && $3 != "overlay" && $3 != "tmpfs" { ok = 1 } END { exit !ok }' /proc/mounts
}
start_buildkit() {
  if [ -n "$BUILDKIT_ROOT" ]; then
    mkdir -p "$BUILDKIT_ROOT" || fail "could not create the disk-backed build store"
    buildkitd --root "$BUILDKIT_ROOT" >/tmp/buildkitd.log 2>&1 &
  else
    buildkitd >/tmp/buildkitd.log 2>&1 &
  fi
  BUILDKIT_PID=$!
  i=0
  until buildctl debug workers >/dev/null 2>&1; do
    kill -0 "$BUILDKIT_PID" 2>/dev/null || fail "buildkitd exited during startup"
    i=$((i+1)); [ $i -gt 60 ] && fail "buildkitd did not start"
    sleep 1
  done
  grep -o "auto snapshotter: using [a-z]*" /tmp/buildkitd.log | head -n 1
}
if [ -n "\${BUILDKIT_TMPFS_SIZE:-}" ]; then
  mkdir -p /var/lib/buildkit || fail "could not create the snapshot store"
  if mount -t tmpfs -o "size=$BUILDKIT_TMPFS_SIZE" tmpfs /var/lib/buildkit; then
    BUILDKIT_STORE_READY=1
    echo "MARSHAL_BUILDKIT_STORE tmpfs $BUILDKIT_TMPFS_SIZE"
  else
    echo "MARSHAL_TMPFS_MOUNT_FAILED (falling back to the disk-backed snapshot store)"
  fi
fi
if [ -z "$BUILDKIT_STORE_READY" ] && buildkit_disk_available; then
  BUILDKIT_ROOT="$BUILDKIT_DISK_DIR/buildkit"
  echo "MARSHAL_BUILDKIT_STORE disk $BUILDKIT_DISK_DIR"
fi
start_buildkit

# Keep output streaming without hiding buildctl's exit status behind a pipe.
# The reader stores only a capacity-error marker, not a second unbounded build log.
run_buildkit_attempt() {
  BUILDKIT_LOG_OFFSET=$(wc -c < /tmp/buildkitd.log)
  rm -f /tmp/buildkit-output.fifo /tmp/buildkit-capacity-error
  mkfifo /tmp/buildkit-output.fifo || fail "could not open the build log stream"
  awk '{ print; fflush(); if (tolower($0) ~ /no space left on device/) { print "full" > "/tmp/buildkit-capacity-error"; close("/tmp/buildkit-capacity-error") } }' < /tmp/buildkit-output.fifo &
  BUILD_LOG_PID=$!
  buildctl "$@" > /tmp/buildkit-output.fifo 2>&1
  BUILD_EXIT=$?
  wait "$BUILD_LOG_PID" || fail "could not stream the build log"
  rm -f /tmp/buildkit-output.fifo
  return "$BUILD_EXIT"
}
run_buildkit() {
  if run_buildkit_attempt "$@"; then return 0; fi
  if [ "\${HEXCLAVE_BUILDKIT_DISK_FALLBACK:-}" != "1" ] || [ -z "$BUILDKIT_STORE_READY" ]; then
    return "$BUILD_EXIT"
  fi
  # Metadata/content writes can fill the store in the daemon rather than a RUN
  # step. In that case buildctl may only report a closed connection.
  # Inspect only this attempt's daemon messages, so an earlier target's recovered
  # error cannot turn an unrelated later failure into a retry.
  if [ ! -f /tmp/buildkit-capacity-error ] && ! tail -c "+$((BUILDKIT_LOG_OFFSET+1))" /tmp/buildkitd.log | grep -qi "no space left on device"; then
    return "$BUILD_EXIT"
  fi
  buildkit_disk_available || fail "the memory-backed build store is full and no disk-backed store is available"
  echo "MARSHAL_BUILDKIT_DISK_FALLBACK: snapshot storage exhausted; retrying the current target once on disk"
  # No active solve remains. Stop the daemon before unmounting its snapshot store;
  # switching underneath running overlay mounts could change the build's contents.
  kill "$BUILDKIT_PID" 2>/dev/null || true
  wait "$BUILDKIT_PID" 2>/dev/null || true
  umount /var/lib/buildkit || fail "could not release the memory-backed build store"
  BUILDKIT_STORE_READY=""
  BUILDKIT_ROOT="$BUILDKIT_DISK_DIR/buildkit"
  echo "MARSHAL_BUILDKIT_STORE disk $BUILDKIT_DISK_DIR"
  start_buildkit
  # A fresh disk store avoids reusing metadata that may have been partially written
  # at ENOSPC. Earlier targets have already been pushed; only this target restarts.
  # Return the second attempt directly so a full disk or an application error fails.
  run_buildkit_attempt "$@"
}
`;
}
