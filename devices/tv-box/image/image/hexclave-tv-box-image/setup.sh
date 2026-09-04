#!/bin/sh
set -eu

case "$1" in
  ROOT)
    cat > "$IMAGEMOUNTPATH/etc/fstab" <<'EOF'
LABEL=ROOT          /                          ext4 defaults,rw,relatime,errors=remount-ro,commit=30 0 1
LABEL=BOOT          /boot/firmware             vfat defaults,rw,noatime,errors=remount-ro           0 2
LABEL=TVBOX_STATE   /var/lib/hexclave-tv-box   ext4 defaults,rw,noatime,errors=remount-ro            0 2
LABEL=TVBOX_SWAP    none                       swap sw,pri=10                                        0 0
/var/lib/hexclave-tv-box/journal /var/log/journal none bind,x-systemd.requires-mounts-for=/var/lib/hexclave-tv-box/journal 0 0
EOF
    ;;
  BOOT)
    sed -Ei 's|root=[^ ]*|root=LABEL=ROOT|' "$IMAGEMOUNTPATH/cmdline.txt"
    grep -Eq '(^| )rootwait( |$)' "$IMAGEMOUNTPATH/cmdline.txt" || sed -i '1 s/$/ rootwait/' "$IMAGEMOUNTPATH/cmdline.txt"
    ;;
  *)
    printf 'Unknown TV Box image component: %s\n' "$1" >&2
    exit 1
    ;;
esac
