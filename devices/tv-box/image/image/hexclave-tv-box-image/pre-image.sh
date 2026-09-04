#!/bin/sh
set -eu

genimage_input=$2
. "${IGconf_image_outputdir}/tvbox_image_uuids"

swap_image="${IGconf_image_outputdir}/tvbox.swap"
truncate -s "$IGconf_image_swap_part_size" "$swap_image"
chmod 0600 "$swap_image"
mkswap --label TVBOX_SWAP "$swap_image" >/dev/null

root_arguments="-U $ROOT_UUID ${IGconf_fs_ext4_mkfs_args:-}"
state_arguments="${IGconf_fs_ext4_mkfs_args:-}"
vfat_arguments="-S $IGconf_device_sector_size -i $BOOT_LABEL"

sed \
  -e "s|<IMAGE_DIR>|$IGconf_image_outputdir|g" \
  -e "s|<IMAGE_NAME>|$IGconf_image_name|g" \
  -e "s|<IMAGE_SUFFIX>|$IGconf_image_suffix|g" \
  -e "s|<BOOT_SIZE>|$IGconf_image_boot_part_size|g" \
  -e "s|<ROOT_SIZE>|$IGconf_image_root_part_size|g" \
  -e "s|<STATE_SIZE>|$IGconf_image_state_part_size|g" \
  -e "s|<SETUP>|'$(readlink -ef setup.sh)'|g" \
  -e "s|<MKE2FS_CONF>|'$(readlink -ef mke2fs.conf)'|g" \
  -e "s|<ROOT_ARGS>|$root_arguments|g" \
  -e "s|<STATE_ARGS>|$state_arguments|g" \
  -e "s|<VFAT_ARGS>|$vfat_arguments|g" \
  genimage.cfg.in.ext4 > "${genimage_input}/genimage.cfg"
