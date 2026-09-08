# Hexclave TV Box Pilot Appliance

This directory contains the device-only layer for the Raspberry Pi Zero 2 W pilot. The box remains a thin client: it opens `https://app.hexclave.com/tv-box`; Hexclave continues to own pairing, display authorization, snapshots, profiles, privacy, and presentation decisions.

## Build inputs

- Raspberry Pi `rpi-image-gen` pinned to commit `3f2c916086ad70197945bfc50ef953c1f6035f10` (v2.6.0).
- `HEXCLAVE_TV_BOX_WIFI_COUNTRY`: region-specific two-letter regulatory country.
- `HEXCLAVE_TV_BOX_SUPPORT_CA_PUBLIC_KEY_FILE`: OpenSSH CA **public** key. Never place the private key in this repository or image.
- `HEXCLAVE_TV_BOX_TEST_IMAGE`: optional, defaults to `false`. Set it to exactly `true` only for a non-shippable hardware-test image.

Run `scripts/build-image.sh` on a supported Raspberry Pi image-build host. Generated images, checksums and per-device state are release/manufacturing artifacts and must not be committed.

Before building, run `scripts/validate-source.sh`. Supplying `RPI_IMAGE_GEN_DIR` additionally validates all custom metadata and dependency resolution against the exact pinned builder. From the repository root, run `pnpm test run apps/dashboard/tv-box-runtime.test.js apps/dashboard/tv-box-app.test.js apps/dashboard/tv-box-bootstrap.test.js apps/dashboard/src/app/tv-box/document.test.ts apps/dashboard/src/app/tv-box/qa/route.test.ts apps/dashboard/src/app/tv/page-client.test.ts` for the framework-free renderer, shared request deadlines, and route contracts.

Pilot media must be at least 16 GB; the qualified hardware uses 32 GB high-endurance microSD cards. The MBR image contains a fixed boot partition, a 6 GB writable pilot root, a bounded 1 GB persistent-state partition, and a dedicated 2 GB swap partition. Creating these filesystems in the image avoids unsafe first-boot repartitioning and remains compatible with the Pi Zero 2 W boot layout.

The verification and manufacturing scripts require the raw disk image. Verify the compressed download's checksum first, then decompress it while keeping the original artifact (for example, `xz --decompress --keep IMAGE.img.xz` or `zstd --decompress --keep IMAGE.img.zst`). Verification requires read-only loop mounts of the exact image's root and state partitions, not an extracted build directory. Its checks are read-only and compare the loop backing inode/device and partition offsets with the input image. The manufacturing wrapper validates the raw four-partition layout and target capacity before allowing an explicitly confirmed write. Raspberry Pi Imager remains an alternative that supports compressed input itself.

## Quick Tunnel test images

A test image may open an ephemeral Cloudflare Quick Tunnel before `/tv-box` is deployed. Build it with `HEXCLAVE_TV_BOX_TEST_IMAGE=true`; this names the artifact `hexclave-tv-box-test` and writes a test-channel marker into the root filesystem. After flashing, place a file named `hexclave-tv-box-test-origin.txt` in the Mac-editable boot volume containing exactly one origin such as:

```text
https://example-random-name.trycloudflare.com
```

The appliance validates one lowercase, single-label, HTTPS `*.trycloudflare.com` origin and appends `/tv-box` itself. Ports, paths, queries, fragments, credentials, wildcards, nested subdomains, additional lines, and other domains are rejected. A missing or rejected override retains the production URL and records a bounded configuration error in the local journal. Add or replace the file while the card is powered off, then boot or reboot the box; the network agent resolves the URL once when it starts.

Production images do not contain the build-time test marker and therefore ignore this boot file completely, even if it is later added. Never ship an image whose manifest says `image-channel=test`; rebuild a production image instead of trying to convert a flashed test image.

Test images also stop after exhausting bounded service restart attempts instead of rebooting, retain bounded Cage/Cog failure diagnostics for support collection, and use an eight-character ambiguity-free temporary setup password. Production/pilot images retain automatic reboot recovery and the higher-entropy temporary setup password.

## Runtime ownership

- `hexclave-tv-box-firstboot.service` creates the per-box device ID, hostname, machine-ID record, and SSH host keys after the state partition is mounted.
- `hexclave-tv-box-network.service` is the sole privileged Wi-Fi policy owner. It drives NetworkManager and exposes a narrow local Unix-socket protocol to the unprivileged setup portal.
- `hexclave-tv-box-setup.service` serves only the local captive portal. Wi-Fi secrets cross that local socket once, enter `nmcli` through a mode-0600 password file, and remain in NetworkManager's state-partition-backed profiles.
- `hexclave-tv-box-setup-display.service` owns tty1 only during local setup and prints the temporary network credentials directly to HDMI. It refreshes them when a failed station attempt starts a new setup session. It does not use WebKit, write those credentials to the journal, or persist them.
- `hexclave-tv-box-kiosk.service` owns and explicitly activates tty1 through a dedicated logind session, gives Cage and Cog one private Wayland runtime directory, then runs Cage in its supported no-input appliance mode with Cog pinned to the Wayland platform, a persistent cookie jar, and a volatile cache. A narrow supervisor checks the exact Cage/Cog/WPE process tree, rejects stopped processes, and tolerates a short web-process replacement window. It adopts renderer orphans as a Linux child subreaper because PAM can place children outside the service cgroup. Shutdown targets only those descendants using process identities and pidfds: ten seconds for graceful exit, followed by up to five seconds for forced termination and reaping. The pre-existing PAM helper is excluded. systemd limits the unit to five starts in fifteen minutes, covering slow as well as rapid crash loops; production images retain reboot recovery, while test images stop for diagnosis.
- The `/tv-box` browser runtime distinguishes authoritative credential rejection from temporary network/backend failure. Only rejection returns the appliance to pairing; transient failure keeps local identity and retries with bounded backoff.

With no saved network, setup mode starts immediately. The browser-independent HDMI display remains available even if Cog/WPE cannot start, and the captive portal must pass a bounded local readiness check. Cage/Cog starts only for offline or connected application content. With a saved network, the appliance first performs one synchronous NetworkManager activation and recheck so a healthy boot launches the connected renderer only once; if station activation still fails, it shows offline content while retrying for five minutes, offers setup for fifteen minutes, and then alternates two-minute station retries with setup windows. Backend availability does not participate in this Wi-Fi state machine.

The supervisor also observes Cog's native document-load result without enabling page-console logging. Failed navigation retries after four minutes; navigation that never completes gets a two-minute load deadline followed by that retry delay. These retries stay below the crash-loop budget. The network agent's once-per-minute, credential-free origin probe can accelerate recovery, but only when the supervisor reports a failed or timed-out document. Flapping probes do not restart a healthy slideshow or change Wi-Fi state. Intentional network/document restarts reset the start counter only for an active unit with a valid healthy-process record; process failures and periodic reconciliation retain their budget. An inline thirty-second bootstrap deadline reloads a document whose external application module failed to initialize. Once the application is running, its request deadlines and retry logic own API outages and stale-state presentation.

Process/native-load readiness is not proof that every later JavaScript frame rendered successfully. A post-load busy JavaScript loop remains a qualification limit. Likewise, forcibly killing or indefinitely stopping the supervisor itself can prevent its exact descendant cleanup; the service cgroup alone is not a substitute for that cleanup across PAM scopes. Do not describe these as covered failure modes without additional validation and recovery design.

## Pilot support

SSH accepts only short-lived certificates for the `hexclave-tv-support` principal. The forced support interface exposes a fixed command allowlist; it does not provide an arbitrary shell. Pairing or factory reset must follow dashboard admin unpair so an offline reset cannot leave an authorized remote display record behind.

Support mutations are serialized across SSH sessions using a root-owned lock outside the network agent's runtime directory. While that agent is running, kiosk/network/reset transitions pass through its policy lock; a reset cannot start a browser over Wi-Fi setup or delete browser state while another support session restarts it. Read-only diagnostics remain available during these operations.

Pilot software updates are serviced image replacements/reflashes with recorded image versions. Phase 1 intentionally introduces no inbound control channel, unattended updater, or fleet service; signed atomic remote updates remain a Phase 2 gate.

The pilot image masks automatic package-update timers so field units cannot drift away from their recorded image artifact. Bluetooth is disabled because the appliance has no Bluetooth product function; Wi-Fi setup and restricted certificate-based support remain the only intended wireless and administrative paths.

## Acceptance and Phase 2 gates

The source-level implementation is followed by the per-device and soak checks in [PILOT_RUNBOOK.md](PILOT_RUNBOOK.md). The pilot does not complete the read-only-root conversion, signed image/SBOM pipeline, physical customer reset mechanism, fleet management, OTA updates, enterprise Wi-Fi, or full GA fault-injection matrix. Those remain explicit requirements in [GA_GATES.md](GA_GATES.md), not silently dropped scope.
