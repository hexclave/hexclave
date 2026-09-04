# Hexclave TV Box Pilot Appliance

This directory contains the device-only layer for the Raspberry Pi Zero 2 W pilot. The box remains a thin client: it opens `https://app.hexclave.com/tv-box`; Hexclave continues to own pairing, display authorization, snapshots, profiles, privacy, and presentation decisions.

## Build inputs

- Raspberry Pi `rpi-image-gen` pinned to commit `3f2c916086ad70197945bfc50ef953c1f6035f10` (v2.6.0).
- `HEXCLAVE_TV_BOX_WIFI_COUNTRY`: region-specific two-letter regulatory country.
- `HEXCLAVE_TV_BOX_SUPPORT_CA_PUBLIC_KEY_FILE`: OpenSSH CA **public** key. Never place the private key in this repository or image.
- `HEXCLAVE_TV_BOX_TEST_IMAGE`: optional, defaults to `false`. Set it to exactly `true` only for a non-shippable hardware-test image.

Run `scripts/build-image.sh` on a supported Raspberry Pi image-build host. Generated images, checksums and per-device state are release/manufacturing artifacts and must not be committed.

Before building, run `scripts/validate-source.sh`. Supplying `RPI_IMAGE_GEN_DIR` additionally validates all custom metadata and dependency resolution against the exact pinned builder. From the repository root, run `pnpm test run apps/dashboard/tv-box-runtime.test.js apps/dashboard/src/app/tv-box/document.test.ts apps/dashboard/src/app/tv-box/qa/route.test.ts` for the framework-free renderer and route contracts.

Pilot media must be at least 16 GB; the qualified hardware uses 32 GB high-endurance microSD cards. The MBR image contains a fixed boot partition, a 6 GB writable pilot root, a bounded 1 GB persistent-state partition, and a dedicated 2 GB swap partition. Creating these filesystems in the image avoids unsafe first-boot repartitioning and remains compatible with the Pi Zero 2 W boot layout.

## Quick Tunnel test images

A test image may open an ephemeral Cloudflare Quick Tunnel before `/tv-box` is deployed. Build it with `HEXCLAVE_TV_BOX_TEST_IMAGE=true`; this names the artifact `hexclave-tv-box-test` and writes a test-channel marker into the root filesystem. After flashing, place a file named `hexclave-tv-box-test-origin.txt` in the Mac-editable boot volume containing exactly one origin such as:

```text
https://example-random-name.trycloudflare.com
```

The appliance validates one lowercase, single-label, HTTPS `*.trycloudflare.com` origin and appends `/tv-box` itself. Ports, paths, queries, fragments, credentials, wildcards, nested subdomains, additional lines, and other domains are rejected. A missing or rejected override retains the production URL and records a bounded configuration error in the local journal. Add or replace the file while the card is powered off, then boot or reboot the box; the network agent resolves the URL once when it starts.

Production images do not contain the build-time test marker and therefore ignore this boot file completely, even if it is later added. Never ship an image whose manifest says `image-channel=test`; rebuild a production image instead of trying to convert a flashed test image.

## Runtime ownership

- `hexclave-tv-box-firstboot.service` creates the per-box device ID, hostname, machine-ID record, and SSH host keys after the state partition is mounted.
- `hexclave-tv-box-network.service` is the sole privileged Wi-Fi policy owner. It drives NetworkManager and exposes a narrow local Unix-socket protocol to the unprivileged setup portal.
- `hexclave-tv-box-setup.service` serves only the local captive portal. Wi-Fi secrets cross that local socket once, enter `nmcli` through a mode-0600 password file, and remain in NetworkManager's state-partition-backed profiles.
- `hexclave-tv-box-setup-display.service` owns tty1 only during local setup and prints the temporary network credentials directly to HDMI. It does not use WebKit, write those credentials to the journal, or persist them.
- `hexclave-tv-box-kiosk.service` owns tty1 and runs Cage plus Cog/WPE with a persistent cookie jar and a volatile cache. A WPE failure exits Cog so systemd restarts the complete compositor/browser stack rather than leaving a partial renderer alive.
- The `/tv-box` browser runtime distinguishes authoritative credential rejection from temporary network/backend failure. Only rejection returns the appliance to pairing; transient failure keeps local identity and retries with bounded backoff.

With no saved network, setup mode starts immediately. The browser-independent HDMI display remains available even if Cog/WPE cannot start, and the captive portal must pass a bounded local readiness check. Cage/Cog starts only for offline or connected application content. With a saved network, the appliance retries station mode for five minutes, offers setup for fifteen minutes, and then alternates two-minute station retries with setup windows. Backend availability does not participate in this Wi-Fi state machine.

The network agent performs a small public-document probe once per minute without credentials. It never changes Wi-Fi state based on that result; it only restarts Cog after the `/tv-box` application origin recovers, covering the engine error-page case where no in-page retry logic could have loaded. Once the document is running, the browser runtime owns API retry and stale-state presentation.

## Pilot support

SSH accepts only short-lived certificates for the `hexclave-tv-support` principal. The forced support interface exposes a fixed command allowlist; it does not provide an arbitrary shell. Pairing or factory reset must follow dashboard admin unpair so an offline reset cannot leave an authorized remote display record behind.

Pilot software updates are serviced image replacements/reflashes with recorded image versions. Phase 1 intentionally introduces no inbound control channel, unattended updater, or fleet service; signed atomic remote updates remain a Phase 2 gate.

The pilot image masks automatic package-update timers so field units cannot drift away from their recorded image artifact. Bluetooth is disabled because the appliance has no Bluetooth product function; Wi-Fi setup and restricted certificate-based support remain the only intended wireless and administrative paths.

## Acceptance and Phase 2 gates

The source-level implementation is followed by the per-device and soak checks in [PILOT_RUNBOOK.md](PILOT_RUNBOOK.md). The pilot does not complete the read-only-root conversion, signed image/SBOM pipeline, physical customer reset mechanism, fleet management, OTA updates, enterprise Wi-Fi, or full GA fault-injection matrix. Those remain explicit requirements in [GA_GATES.md](GA_GATES.md), not silently dropped scope.
