#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  printf 'Usage: %s IMAGE BLOCK_DEVICE VERIFICATION_DIRECTORY\n' "$0" >&2
  exit 2
fi
image=$1
device=$2
verification=$3
test -f "$image" || { printf 'Image is not a regular file: %s\n' "$image" >&2; exit 1; }
# Pin every manufacturing read to the verified image inode before any checks.
exec 3< "$image"
image_source=/dev/fd/3
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Validate the artifact before even inspecting the destructive target. In
# particular, dd cannot decompress the .xz/.zst artifacts produced for download.
python3 -B "$script_directory/image_preflight.py" raw-image "$image_source"
python3 -B "$script_directory/image_verification.py" receipt "$image_source" "$verification"
case "$device" in
  /dev/mmcblk[0-9]|/dev/sd[a-z]) ;;
  *) printf 'Refusing unsupported manufacturing target: %s\n' "$device" >&2; exit 1 ;;
esac
test -b "$device" || { printf 'Manufacturing target is not a block device: %s\n' "$device" >&2; exit 1; }
exec 4<> "$device"
device_target=/dev/fd/4
device_rdev=$(stat -Lc '%t:%T' "$device_target")
if [ "$(stat -Lc '%t:%T' "$device")" != "$device_rdev" ]; then
  printf 'Manufacturing target changed while it was being opened: %s\n' "$device" >&2
  exit 1
fi
device_node=/dev/block/$(printf '%d:%d' "0x${device_rdev%%:*}" "0x${device_rdev##*:}")
# Use the node derived from the held descriptor so path replacement cannot redirect checks.
test -b "$device_node" || { printf 'Manufacturing target is not a block device: %s\n' "$device" >&2; exit 1; }
test "$(lsblk -dn -o TYPE "$device_node")" = disk || { printf 'Manufacturing target is not a whole disk: %s\n' "$device" >&2; exit 1; }

root_source=$(findmnt -n -o SOURCE /)
device_node_path=$(lsblk -dn -o PATH "$device_node")
if [ "$device_node_path" = "$root_source" ] || lsblk -sno PATH "$root_source" 2>/dev/null | grep -Fxq "$device_node_path"; then
  printf 'Refusing to overwrite the current system disk: %s\n' "$device" >&2
  exit 1
fi
if lsblk -nr -o MOUNTPOINT "$device_node" | grep -Eq '[^[:space:]]'; then
  printf 'Refusing a manufacturing target with mounted filesystems: %s\n' "$device" >&2
  exit 1
fi
image_bytes=$(stat -Lc %s "$image_source")
device_bytes=$(blockdev --getsize64 "$device_target")
device_identity=$(lsblk -dn -o MAJ:MIN,SERIAL,SIZE "$device_node")
if [ "$image_bytes" -gt "$device_bytes" ]; then
  printf '%s\n' 'Image is larger than the selected manufacturing device.' >&2
  exit 1
fi

printf 'About to overwrite %s with %s. Type the exact block device to continue: ' "$device" "$image"
read -r confirmation
test "$confirmation" = "$device" || { printf '%s\n' 'Cancelled.' >&2; exit 1; }

# Confirmation can take minutes. A remount or a replaced USB reader must not
# turn the previously inspected path into a different destructive target.
if [ "$(lsblk -dn -o MAJ:MIN,SERIAL,SIZE "$device_node")" != "$device_identity" ] ||
   [ "$(stat -Lc '%t:%T' "$device")" != "$device_rdev" ] ||
   lsblk -nr -o MOUNTPOINT "$device_node" | grep -Eq '[^[:space:]]'; then
  printf '%s\n' 'Manufacturing target changed or became mounted after confirmation.' >&2
  exit 1
fi
python3 -B "$script_directory/image_verification.py" receipt "$image_source" "$verification"

dd if="$image_source" of="$device_target" bs=8M conv=fsync status=progress
sync
# Invalidate the host's block cache before the bounded read-back; otherwise a
# cached read could "verify" bytes that never reached the physical SD card.
blockdev --flushbufs "$device_target"
python3 -B "$script_directory/image_verification.py" readback "$verification" "$device_target"
printf '%s\n' 'Flash and full image-extent read-back verified. Boot once, verify unique host identity and unpaired state, then shut down cleanly.'
