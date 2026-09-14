#!/bin/sh
set -eu

tv_box_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repository_root=$(CDPATH= cd -- "$tv_box_root/../.." && pwd)

PYTHONPATH="$tv_box_root/src" python3 -m unittest discover -s "$tv_box_root/tests" -p 'test_*.py' -v

find "$tv_box_root" -type f \( -name '*.sh' -o -path '*/bdebstrap/*' -o -path '*/usr/lib/hexclave-tv-box/kiosk-launch' \) -print |
while IFS= read -r script; do
  first_line=$(sed -n '1p' "$script")
  case "$first_line" in
    '#!/bin/bash') bash -n "$script" ;;
    '#!/bin/sh') sh -n "$script" ;;
  esac
done

if [ -n "${RPI_IMAGE_GEN_DIR:-}" ]; then
  expected_commit=3f2c916086ad70197945bfc50ef953c1f6035f10
  actual_commit=$(git -C "$RPI_IMAGE_GEN_DIR" rev-parse HEAD)
  test "$actual_commit" = "$expected_commit" || {
    printf 'Expected rpi-image-gen %s, found %s.\n' "$expected_commit" "$actual_commit" >&2
    exit 1
  }
  for layer in "$tv_box_root"/image/layer/*.yaml "$tv_box_root"/image/image/hexclave-tv-box-image/image.yaml; do
    "$RPI_IMAGE_GEN_DIR/rpi-image-gen" metadata --lint "$layer"
  done
  paths="custom-layer=$tv_box_root/image/layer:custom-image=$tv_box_root/image/image:layer=$RPI_IMAGE_GEN_DIR/layer:device=$RPI_IMAGE_GEN_DIR/device:image=$RPI_IMAGE_GEN_DIR/image"
  for layer_name in hexclave-rpizero2w-armhf hexclave-tv-box-pilot hexclave-tv-box-image; do
    description=$("$RPI_IMAGE_GEN_DIR/rpi-image-gen" layer --path "$paths" --describe "$layer_name")
    printf '%s\n' "$description" | grep -F '<unknown>' >/dev/null && {
      printf 'TV Box layer %s has an unresolved dependency.\n' "$layer_name" >&2
      exit 1
    }
  done
else
  printf '%s\n' 'RPI_IMAGE_GEN_DIR is unset; pinned builder metadata/dependency validation was skipped.'
fi

printf 'TV Box appliance source validation passed for %s.\n' "$repository_root"
