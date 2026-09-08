# TV Box Pilot Runbook

This runbook is the acceptance boundary for the first small TV Box pilot. It does not replace the Phase 2 gates in [GA_GATES.md](GA_GATES.md).

## Build and manufacture

1. Use a dedicated image-build host and the pinned `rpi-image-gen` revision recorded in `README.md`.
2. Keep the support CA private key offline. Supply only its OpenSSH public key through `HEXCLAVE_TV_BOX_SUPPORT_CA_PUBLIC_KEY_FILE`.
3. Set `HEXCLAVE_TV_BOX_WIFI_COUNTRY` for the destination region and run `scripts/build-image.sh` from a clean committed TV Box source tree.
4. Ensure `HEXCLAVE_TV_BOX_TEST_IMAGE` is unset or exactly `false`. Test-channel images and the boot-partition `hexclave-tv-box-test-origin.txt` override are development artifacts and must never be shipped.
5. Verify the downloaded artifact checksum before decompressing it. Use the raw `.img` for the following scripts, not `.img.xz` or `.img.zst`. Attach that exact raw image through a read-only loop device (`losetup --read-only --partscan`), and mount its second (root) and third (`TVBOX_STATE`) partitions with `ro,noload`. Run `scripts/verify-image.sh DISK_IMAGE ROOTFS_MOUNT STATE_MOUNT OUTPUT_DIRECTORY`; it rejects ordinary directories, writable mounts, mounts backed by another image, and incorrect partition offsets. Confirm the archived manifest says `image-channel=production`; the verifier also rejects an inconsistent channel/marker pair and initialized state. Archive the disk-image hash, manifest, and filesystem hashes with the pilot build record.
6. Flash only an explicitly selected, unmounted SD-card device with `scripts/manufacture.sh RAW_DISK_IMAGE BLOCK_DEVICE`. It rejects compressed/non-appliance images and undersized targets before writing. Raspberry Pi Imager may instead consume a verified compressed image directly; the raw `dd` wrapper cannot.
7. Boot every card once. Record the image version and public device ID, and verify that host keys and device IDs differ between two independently flashed cards. Never copy first-boot state into the base image.
8. Shut the box down cleanly before packaging it.

Generated images, manifests, keys, certificates, customer network profiles, and device state are manufacturing artifacts. They do not belong in Git.

The pilot support CA is created once on an offline administrative system. Each support session uses a separate operator key and a short-lived user certificate whose only principal is `hexclave-tv-support`; no CA private key or pre-issued user certificate is copied into an image. For example, the administrative signing step is equivalent to:

```sh
ssh-keygen -s /offline/path/tv-box-support-ca -I pilot-support-ticket -n hexclave-tv-support -V -5m:+2h operator-key.pub
```

Apply the organization's approval, custody, and audit process around that command. The two-hour example is an upper bound for a pilot session, not a long-lived credential policy.

## Per-device acceptance

Perform these checks on the exact Raspberry Pi Zero 2 W, power supply, microSD class, and HDMI configuration intended for the pilot.

- Cold boot with no keyboard, mouse, or interactive login. The display must reach local Wi-Fi setup or `/tv-box` automatically, and restricted diagnostics must report the Cage, Cog, and WPE process chain as ready.
- First boot without a saved network must expose a password-protected temporary setup network and show its per-session credentials directly on HDMI without depending on Cage, Cog, WPE, or internet access.
- Join open, WPA2 Personal, and WPA3 Personal test networks where available. Confirm the Wi-Fi password never appears in the system journal, process list, diagnostics, or Hexclave requests.
- Submit an incorrect router password, then retry without rebooting. The returned hotspot must match the credentials currently shown on HDMI. Drop/recover the setup AP and verify that it is reconciled even while the policy stays in setup mode.
- Pair the display, reboot it, and confirm pairing persists without administrator action.
- Unpair it from the dashboard. The display must return to pairing and accept immediate re-pairing without a device reboot or local reset.
- Stop Cog, terminate its WPE web process, and stop Cage in separate trials. Include a stopped renderer child and an orphaned WPE child; bounded shutdown must leave no old renderer descendants. Repeated fast and slow startup failures must exhaust the five-start/fifteen-minute service budget: production images reboot, while test images remain stopped for diagnosis. A healthy slideshow must not restart when only the public-document probe flaps.
- Disconnect Wi-Fi, restore it, deny backend access temporarily, and restore access. Local network setup and browser recovery must remain independent; backend failure must not erase pairing or Wi-Fi state.
- Interrupt initial application navigation between reachability probes, and separately interrupt its JavaScript module download. Both must retry without manual intervention or losing pairing. Distinguish this from an API outage after the application is already running.
- Remove and restore HDMI while running. The compositor must recover a stable fullscreen picture at the pilot resolution.
- Perform five controlled abrupt power cuts across boot, pairing, normal playback, and network recovery. The filesystem, pairing cookie, unique identity, and saved network must remain valid, or the box must return to a safe setup state.
- Run the restricted `diagnostics`, `recent-logs`, and `previous-logs` support commands and verify that they contain useful health information but no tokens, cookies, pairing secrets, Wi-Fi names/passwords, snapshot payloads, or customer data. After an OS reboot, use `previous-logs` to confirm that the prior kiosk descendants completed their bounded shutdown.
- From another LAN host, verify that no dashboard/backend development ports are reachable and that SSH rejects passwords, ordinary keys, root login, forwarding, and expired/untrusted certificates.
- Exercise `reset-network`, dashboard-admin-unpair followed by `reset-pairing`, and dashboard-admin-unpair followed by `factory-reset`. Factory reset must remove the browser cookie jar, saved TV Box network profiles, local logs/state, and SSH host keys; the next boot must create a new unpaired local identity.
- Exercise support kiosk restart and pairing reset while Wi-Fi setup is active. Setup credentials must remain visible; support operations must not start a competing browser or race deletion of its persistent state.
- Attempt concurrent support mutations from separate SSH sessions, including factory reset against network restart. They must serialize, while read-only diagnostics remain accessible.

The current readiness signal covers the native document load and process health, not arbitrary post-load JavaScript hangs. Killing/stopping the supervisor itself can also bypass its descendant cleanup. These remain explicit limits; do not substitute a passing process-health check for visible playback and recovery observations.

## Pilot soak gate

Run at least 24 continuous hours on every hardware/configuration combination. Record:

- service restart counts;
- memory, zram, and disk-swap use;
- CPU load, temperature, and throttling flags;
- state-partition and journal growth;
- snapshot freshness/recovery behavior;
- HDMI stability and visible rendering defects.

The pilot is blocked by an unattended dead screen, repeated reboot loop, lost pairing after an ordinary restart, credentials in logs/process arguments, cross-device cloned identity, an exposed debug/development port, failure to recover after network/backend restoration, or destructive reset outside the exact box state.

A lost or stolen pilot box must be unpaired immediately in the dashboard and the customer Wi-Fi credential must be rotated. The narrow display credential limits Hexclave access, but a Zero 2 W has no approved hardware-backed secret in this phase; a person with the microSD can extract locally stored network and browser state. Do not present the pilot filesystem as tamper-resistant.

## Support procedure

Pilot support uses a short-lived SSH user certificate for the `hexclave-tv-support` principal. The appliance exposes only the forced command allowlist. Do not enable a shell, password login, port forwarding, remote browser debugging, or shared device credentials.

Pairing and factory reset require the operator to unpair the display in the Hexclave dashboard first, then pass the fixed confirmation guard to the restricted command. This preserves server-side authorization as the source of truth even if a box is offline during local service.
