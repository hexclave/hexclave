#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  printf 'Usage: %s DISK_IMAGE ROOTFS_MOUNT STATE_MOUNT OUTPUT_DIRECTORY\n' "$0" >&2
  exit 2
fi
image=$1
rootfs=$2
state=$3
output=$4
test -f "$image"
test -d "$rootfs"
test -d "$state"
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 -B "$script_directory/image_preflight.py" mounts "$image" "$rootfs" "$state"
mkdir -p "$output"

required='usr/lib/hexclave-tv-box/kiosk-launch usr/lib/python3/dist-packages/hexclave_tv_box/kiosk_supervisor.py usr/lib/python3/dist-packages/hexclave_tv_box/network_agent.py usr/lib/python3/dist-packages/hexclave_tv_box/setup_display.py etc/systemd/system/hexclave-tv-box-kiosk.service etc/systemd/system/hexclave-tv-box-network.service etc/systemd/system/hexclave-tv-box-setup-display.service etc/systemd/system/hexclave-tv-box-setup.service etc/pam.d/hexclave-tv-box-kiosk etc/ssh/hexclave-support-ca.pub etc/hexclave-tv-box-release'
for path in $required; do
  test -e "$rootfs/$path" || { printf 'Missing image path: %s\n' "$path" >&2; exit 1; }
done
grep -qxF 'Environment=WLR_LIBINPUT_NO_DEVICES=1' "$rootfs/etc/systemd/system/hexclave-tv-box-kiosk.service" || {
  printf '%s\n' 'Image kiosk does not declare no-input Cage operation.' >&2
  exit 1
}
grep -qxF 'Environment=XDG_RUNTIME_DIR=/run/hexclave-tv-box-wayland' "$rootfs/etc/systemd/system/hexclave-tv-box-kiosk.service" || {
  printf '%s\n' 'Image kiosk does not declare its private Wayland runtime directory.' >&2
  exit 1
}
grep -qxF 'TimeoutStopSec=20' "$rootfs/etc/systemd/system/hexclave-tv-box-kiosk.service" || {
  printf '%s\n' 'Image kiosk does not allow the bounded WebKit shutdown interval.' >&2
  exit 1
}
grep -qxF 'KillMode=control-group' "$rootfs/etc/systemd/system/hexclave-tv-box-kiosk.service" || {
  printf '%s\n' 'Image kiosk does not retain its service-group shutdown fallback.' >&2
  exit 1
}
for directive in 'StartLimitIntervalSec=15min' 'StartLimitBurst=5'; do
  grep -qxF "$directive" "$rootfs/etc/systemd/system/hexclave-tv-box-kiosk.service" || {
    printf '%s\n' 'Image kiosk restart budget does not cover slow readiness failures.' >&2
    exit 1
  }
done
for mechanism in 'enable_child_subreaper()' 'signal.pidfd_send_signal' 'require_document_load=True'; do
  grep -qF "$mechanism" "$rootfs/usr/lib/python3/dist-packages/hexclave_tv_box/kiosk_supervisor.py" || {
    printf '%s\n' 'Image kiosk lacks exact renderer cleanup or native document-load recovery.' >&2
    exit 1
  }
done
grep -qF 'hexclave_tv_box.kiosk_supervisor' "$rootfs/usr/lib/hexclave-tv-box/kiosk-launch" || {
  printf '%s\n' 'Image kiosk does not launch the renderer supervisor.' >&2
  exit 1
}
grep -qxF 'wayland_runtime_dir=/run/hexclave-tv-box-wayland' "$rootfs/usr/lib/hexclave-tv-box/kiosk-launch" || {
  printf '%s\n' 'Image kiosk launcher does not select its private Wayland runtime directory.' >&2
  exit 1
}
grep -qxF 'export XDG_RUNTIME_DIR="$wayland_runtime_dir"' "$rootfs/usr/lib/hexclave-tv-box/kiosk-launch" || {
  printf '%s\n' 'Image kiosk launcher does not restore its Wayland runtime directory after PAM setup.' >&2
  exit 1
}
grep -qxF 'unset DBUS_SESSION_BUS_ADDRESS' "$rootfs/usr/lib/hexclave-tv-box/kiosk-launch" || {
  printf '%s\n' 'Image kiosk launcher exposes an incompatible desktop session bus to WebKit.' >&2
  exit 1
}
grep -qF '"--platform=wl"' "$rootfs/usr/lib/python3/dist-packages/hexclave_tv_box/kiosk_supervisor.py" || {
  printf '%s\n' 'Image kiosk does not pin Cog to the Cage Wayland platform.' >&2
  exit 1
}
if find "$rootfs/usr/lib/python3/dist-packages/hexclave_tv_box" -type f \( -name '*.pyc' -o -name '*.pyo' \) -print -quit | grep -q .; then
  printf '%s\n' 'Image contains generated build-host Python bytecode.' >&2
  exit 1
fi
grep -Eq '^ssh-(ed25519|rsa) [A-Za-z0-9+/]+={0,3}( |$)' "$rootfs/etc/ssh/hexclave-support-ca.pub" || {
  printf '%s\n' 'Image support CA is not an OpenSSH public key.' >&2
  exit 1
}

image_channel=$(sed -n 's/^image-channel=//p' "$rootfs/etc/hexclave-tv-box-release")
reboot_services='hexclave-tv-box-kiosk.service hexclave-tv-box-network.service hexclave-tv-box-setup-display.service hexclave-tv-box-setup.service'
case "$image_channel" in
  production)
    if [ -e "$rootfs/etc/hexclave-tv-box-test-image" ]; then
      printf '%s\n' 'Production image contains the TV Box test-image marker.' >&2
      exit 1
    fi
    expected_start_limit_action=reboot
    ;;
  test)
    if [ "$(cat "$rootfs/etc/hexclave-tv-box-test-image" 2>/dev/null || true)" != test ]; then
      printf '%s\n' 'Test image is missing its build-time TV Box test-image marker.' >&2
      exit 1
    fi
    expected_start_limit_action=none
    ;;
  *)
    printf '%s\n' 'Image manifest contains an invalid or duplicate image channel.' >&2
    exit 1
    ;;
esac
for service in $reboot_services; do
  grep -qxF "StartLimitAction=$expected_start_limit_action" "$rootfs/etc/systemd/system/$service" || {
    printf 'Image service %s does not use the %s-channel restart-limit action.\n' "$service" "$image_channel" >&2
    exit 1
  }
done

if find "$rootfs/var/lib/hexclave-tv-box" -mindepth 1 -type f -print -quit | grep -q .; then
  printf '%s\n' 'Image contains initialized TV Box state.' >&2
  exit 1
fi
if find "$state/network-connections" -mindepth 1 -print -quit | grep -q .; then
  printf '%s\n' 'Image contains a saved customer network.' >&2
  exit 1
fi
if find "$state" -mindepth 1 ! -type d -print -quit | grep -q .; then
  printf '%s\n' 'Image state partition contains initialized device data.' >&2
  exit 1
fi
state_directories=$(find "$state" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort)
# mke2fs creates lost+found for every ext filesystem; it is filesystem
# scaffolding, not initialized device state. Keep the allowlist exact so image
# verification still rejects credentials, browser data, and saved networks.
expected_state_directories=$(printf '%s\n' journal lost+found network-connections | LC_ALL=C sort)
if [ "$state_directories" != "$expected_state_directories" ]; then
  printf '%s\n' 'Image state partition has an unexpected directory layout.' >&2
  exit 1
fi
test "$(readlink "$rootfs/etc/NetworkManager/system-connections")" = /var/lib/hexclave-tv-box/network-connections || {
  printf '%s\n' 'NetworkManager profiles are not rooted in TV Box persistent state.' >&2
  exit 1
}
if [ -s "$rootfs/etc/machine-id" ]; then
  printf '%s\n' 'Image contains a pre-generated machine ID.' >&2
  exit 1
fi
if [ -e "$rootfs/var/lib/systemd/random-seed" ]; then
  printf '%s\n' 'Image contains a pre-generated random seed.' >&2
  exit 1
fi
if find "$rootfs/etc/ssh" -maxdepth 1 -name 'ssh_host_*_key' -print -quit | grep -q .; then
  printf '%s\n' 'Image contains pre-generated SSH host keys.' >&2
  exit 1
fi

cp "$rootfs/etc/hexclave-tv-box-release" "$output/image-manifest.txt"
(cd "$rootfs" && find . -xdev -type f -print0 | sort -z | xargs -0 sha256sum) > "$output/rootfs-sha256.txt"
(cd "$state" && find . -xdev -type f -print0 | sort -z | xargs -0 -r sha256sum) > "$output/state-sha256.txt"
image_name=$(basename "$image")
image_hash=$(sha256sum "$image" | cut -d ' ' -f 1)
printf '%s  %s\n' "$image_hash" "$image_name" > "$output/disk-image-sha256.txt"
