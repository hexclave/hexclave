#!/bin/sh
set -eu

RPI_IMAGE_GEN_COMMIT=3f2c916086ad70197945bfc50ef953c1f6035f10
: "${RPI_IMAGE_GEN_DIR:?Set RPI_IMAGE_GEN_DIR to a checkout of rpi-image-gen v2.6.0}"
: "${HEXCLAVE_TV_BOX_WIFI_COUNTRY:?Set the two-letter pilot Wi-Fi country}"
: "${HEXCLAVE_TV_BOX_SUPPORT_CA_PUBLIC_KEY_FILE:?Set the offline support CA public-key path}"
HEXCLAVE_TV_BOX_TEST_IMAGE=${HEXCLAVE_TV_BOX_TEST_IMAGE:-false}

for tool in git grep mkswap truncate; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Missing TV Box image-build tool: %s\n' "$tool" >&2; exit 1; }
done

case "$HEXCLAVE_TV_BOX_WIFI_COUNTRY" in
  [A-Z][A-Z]) ;;
  *) printf '%s\n' 'HEXCLAVE_TV_BOX_WIFI_COUNTRY must be two uppercase letters.' >&2; exit 1 ;;
esac
case "$HEXCLAVE_TV_BOX_TEST_IMAGE" in
  true) tv_box_image_name=hexclave-tv-box-test ;;
  false) tv_box_image_name=hexclave-tv-box-pilot ;;
  *) printf '%s\n' 'HEXCLAVE_TV_BOX_TEST_IMAGE must be exactly true or false.' >&2; exit 1 ;;
esac
test -f "$HEXCLAVE_TV_BOX_SUPPORT_CA_PUBLIC_KEY_FILE"
grep -Eq '^ssh-(ed25519|rsa) [A-Za-z0-9+/]+={0,3}( |$)' "$HEXCLAVE_TV_BOX_SUPPORT_CA_PUBLIC_KEY_FILE"

actual_commit=$(git -C "$RPI_IMAGE_GEN_DIR" rev-parse HEAD)
if [ "$actual_commit" != "$RPI_IMAGE_GEN_COMMIT" ]; then
  printf 'Expected rpi-image-gen %s, found %s.\n' "$RPI_IMAGE_GEN_COMMIT" "$actual_commit" >&2
  exit 1
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
export HEXCLAVE_TV_BOX_SOURCE_COMMIT
HEXCLAVE_TV_BOX_SOURCE_COMMIT=$(git -C "$repository_root" rev-parse HEAD)
if [ -n "$(git -C "$repository_root" status --porcelain --untracked-files=all -- devices/tv-box apps/dashboard/public/tv-box apps/dashboard/src/app/tv-box apps/dashboard/tv-box-runtime.test.js)" ]; then
  printf '%s\n' 'Commit the TV Box appliance and renderer changes before producing a versioned image.' >&2
  exit 1
fi

exec "$RPI_IMAGE_GEN_DIR/rpi-image-gen" build \
  -S "$repository_root/devices/tv-box/image" \
  -c "$repository_root/devices/tv-box/image/config/hexclave-tv-box-pilot.yaml" -- \
  "IGconf_image_name=$tv_box_image_name" \
  "IGconf_tvbox_wifi_country=$HEXCLAVE_TV_BOX_WIFI_COUNTRY" \
  "IGconf_ieee80211_regdom=$HEXCLAVE_TV_BOX_WIFI_COUNTRY" \
  "IGconf_tvbox_support_ca_key=$HEXCLAVE_TV_BOX_SUPPORT_CA_PUBLIC_KEY_FILE" \
  "IGconf_tvbox_source_commit=$HEXCLAVE_TV_BOX_SOURCE_COMMIT" \
  "IGconf_tvbox_test_image=$HEXCLAVE_TV_BOX_TEST_IMAGE"
