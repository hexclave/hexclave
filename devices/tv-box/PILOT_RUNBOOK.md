# TV Box Pilot Runbook

This runbook is the acceptance boundary for the first small TV Box pilot. It does not replace the Phase 2 gates in [GA_GATES.md](GA_GATES.md).

## Build and manufacture

1. Use a dedicated image-build host and the pinned `rpi-image-gen` revision recorded in `README.md`.
2. Keep the support CA private key offline. Supply only its OpenSSH public key through `HEXCLAVE_TV_BOX_SUPPORT_CA_PUBLIC_KEY_FILE`.
3. Set `HEXCLAVE_TV_BOX_WIFI_COUNTRY` for the destination region and run `scripts/build-image.sh` from a clean committed TV Box source tree.
4. Ensure `HEXCLAVE_TV_BOX_TEST_IMAGE` is unset or exactly `false`. Test-channel images and the boot-partition `hexclave-tv-box-test-origin.txt` override are development artifacts and must never be shipped.
5. Verify the downloaded artifact checksum before decompressing it. Use the raw `.img`, not `.img.xz` or `.img.zst`. Attach that exact raw image through a read-only loop device (`losetup --read-only --partscan`), mount its first (boot) partition read-only, and its second (root) and third (`TVBOX_STATE`) partitions with `ro,noload`. Decompress the builder's existing `manifest.zst` for the inventory input. Run `scripts/verify-image.sh DISK_IMAGE ROOTFS_MOUNT STATE_MOUNT BOOT_MOUNT BUILDER_MANIFEST OUTPUT_DIRECTORY`; it rejects incorrect/writable mounts, runtime-version drift, inventory mismatches, initialized state and targeted credential contamination. Confirm the archived manifest says `image-channel=production`. Archive the verification receipt, package inventory, qualification policy, image/manifest/filesystem hashes and build record outside Git. This receipt is an integrity record, not a release signature.
6. Flash only an explicitly selected, unmounted SD-card device with `scripts/manufacture.sh RAW_DISK_IMAGE BLOCK_DEVICE VERIFICATION_DIRECTORY`. A matching production-channel verification receipt is required before writing; compressed/non-appliance images and undersized targets are rejected. Success requires a full image-extent read-back after flushing buffers. Raspberry Pi Imager may instead consume a verified compressed image directly; wait for its verification stage to finish.
7. Boot every card once. Record the image version and public device ID, and verify that host keys, relay public keys, device IDs and initial OS machine IDs differ between two independently flashed cards. Never copy first-boot state into the base image. Office support enrollment, when required, is a separate per-device operation using the [relay runbook](support-relay/README.md), never golden-image customization.
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
- Confirm no visible mouse cursor during native startup, pairing, playback, restart, network recovery, or HDMI reconnect. If a mouse is connected for testing, movement must not restore the native cursor; desktop `/tv` remains unchanged.
- First boot without a saved network must expose a password-protected temporary setup network and show its per-session credentials directly on HDMI without depending on Cage, Cog, WPE, or internet access.
- Join open, WPA2 Personal, and WPA3 Personal test networks where available. Confirm the Wi-Fi password never appears in the system journal, process list, diagnostics, or Hexclave requests.
- Submit an incorrect router password, then retry without rebooting. The returned hotspot must match the credentials currently shown on HDMI. Drop/recover the setup AP and verify that it is reconciled even while the policy stays in setup mode.
- Confirm the phone's valid timezone reaches the renderer without changing the system timezone. Malformed values and installed zoneinfo metadata filenames must fail validation, not be accepted as timezones.
- Pair the display, reboot it, and confirm pairing persists without administrator action.
- Unpair it from the dashboard. The display must return to pairing and accept immediate re-pairing without a device reboot or local reset.
- Stop Cog, terminate its WPE web process, and stop Cage in separate trials. Include a stopped renderer child and an orphaned WPE child; bounded shutdown must leave no old renderer descendants. Repeated fast and slow startup failures must exhaust the five-start/fifteen-minute service budget: production images reboot, while test images remain stopped for diagnosis. A healthy slideshow must not restart when only the public-document probe flaps.
- Disconnect Wi-Fi, restore it, deny backend access temporarily, and restore access. Local network setup and browser recovery must remain independent; backend failure must not erase pairing or Wi-Fi state.
- Interrupt initial application navigation between reachability probes, and separately interrupt its JavaScript module download. Both must retry without manual intervention or losing pairing. Distinguish this from an API outage after the application is already running.
- Remove and restore HDMI while running. The compositor must recover a stable fullscreen picture at the fixed 1920×1080 at 60 Hz pilot resolution. This qualifies the Pi appliance running `/tv-box`; it does not constrain `/tv` rendering on other devices.
- Perform five controlled abrupt power cuts across boot, pairing, normal playback, and network recovery. The filesystem, pairing cookie, unique identity, and saved network must remain valid, or the box must return to a safe setup state.
- Run the restricted `diagnostics`, `recent-logs`, and `previous-logs` support commands and verify that they contain useful health information but no tokens, cookies, pairing secrets, Wi-Fi names/passwords, snapshot payloads, or customer data. After an OS reboot, use `previous-logs` to confirm that the prior kiosk descendants completed their bounded shutdown.
- From another LAN host, verify that no dashboard/backend development ports are reachable and that SSH rejects passwords, ordinary keys, root login, forwarding, and expired/untrusted certificates.
- Exercise `reset-network`, dashboard-admin-unpair followed by `reset-pairing`, and dashboard-admin-unpair followed by `factory-reset`. Factory reset responds **scheduled**, then executes independently of its SSH connection. It must remove the browser cookie jar, saved TV Box network profiles, local logs/state, relay identity and SSH host keys; the next boot must create a new device UUID and SSH/relay keys and start unpaired. Revoke any old relay registration separately. The OS `/etc/machine-id` intentionally survives factory reset on the pilot root and is copied back into state; it is not a display credential. Independently flashed clean cards must still generate distinct initial OS machine IDs.
- Exercise support kiosk restart and pairing reset while Wi-Fi setup is active. Setup credentials must remain visible; support operations must not start a competing browser or race deletion of its persistent state.
- Attempt concurrent support mutations from separate SSH sessions, including factory reset against network restart. They must serialize, while read-only diagnostics remain accessible.
- Before enabling office support on a customer unit, complete the [relay qualification checks](support-relay/README.md#qualification-before-enabling-a-customer-registration): actual office access, role/listener isolation, independent host/certificate verification, resource overhead, outage/reboot recovery and reset/revocation. An unenrolled image must make no relay connection; an unavailable or invalid relay must not block playback or Wi-Fi setup.

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

The optional outbound transport requires a separately provisioned dedicated relay and trusted enrollment; it is not activated by building or flashing the base image. Local private/link-local Wi-Fi support remains a fallback. Use verified device host-key mappings and do not bypass changed-host-key warnings. Relay authentication and appliance support certificates are independent controls.

Collect bounded `diagnostics`, `recent-logs` and `previous-logs`. Support command audits carry operation and SSH ancestor process IDs; native SSH logs retain certificate identity for private operator correlation. Do not publish those records or assume that relay readiness proves the inner appliance login works. Existing journal size/rate limits remain in force.

Pairing and factory reset require the operator to unpair the display in the Hexclave dashboard first, then pass the fixed confirmation guard to the restricted command. This preserves server-side authorization as the source of truth even if a box is offline during local service.
