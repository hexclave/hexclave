#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  printf 'Usage: %s IMAGE BLOCK_DEVICE\n' "$0" >&2
  exit 2
fi
image=$1
device=$2
test -f "$image"
case "$device" in
  /dev/mmcblk[0-9]|/dev/sd[a-z]) ;;
  *) printf 'Refusing unsupported manufacturing target: %s\n' "$device" >&2; exit 1 ;;
esac
test -b "$device" || { printf 'Manufacturing target is not a block device: %s\n' "$device" >&2; exit 1; }
test "$(lsblk -dn -o TYPE "$device")" = disk || { printf 'Manufacturing target is not a whole disk: %s\n' "$device" >&2; exit 1; }

root_source=$(findmnt -n -o SOURCE /)
if [ "$device" = "$root_source" ] || lsblk -sno PATH "$root_source" 2>/dev/null | grep -Fxq "$device"; then
  printf 'Refusing to overwrite the current system disk: %s\n' "$device" >&2
  exit 1
fi
if lsblk -nr -o MOUNTPOINT "$device" | grep -Eq '[^[:space:]]'; then
  printf 'Refusing a manufacturing target with mounted filesystems: %s\n' "$device" >&2
  exit 1
fi

printf 'About to overwrite %s with %s. Type the exact block device to continue: ' "$device" "$image"
read -r confirmation
test "$confirmation" = "$device" || { printf '%s\n' 'Cancelled.' >&2; exit 1; }

dd if="$image" of="$device" bs=8M conv=fsync status=progress
sync
printf '%s\n' 'Flash complete. Boot once, verify unique host identity and unpaired state, then shut down cleanly.'
