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

The build checks the OS, architecture, and critical package versions against [image/qualified-runtime.json](image/qualified-runtime.json). Version drift stops the build: review and requalify a changed runtime before updating this baseline. This is not a complete reproducible repository snapshot; that remains future hardening.

The verification and manufacturing scripts require the raw disk image. Verify the compressed download's checksum first, then decompress it while keeping the original artifact (for example, `xz --decompress --keep IMAGE.img.xz` or `zstd --decompress --keep IMAGE.img.zst`). Attach that exact image read-only and mount its boot partition read-only and root/state partitions with `ro,noload`, not an extracted build directory. Decompress the builder's existing `manifest.zst` separately for the inventory input, then run:

```sh
scripts/verify-image.sh DISK_IMAGE ROOTFS_MOUNT STATE_MOUNT BOOT_MOUNT BUILDER_MANIFEST OUTPUT_DIRECTORY
```

Verification checks mount backing/offsets, runtime versions, exact installed-package inventory, clean unpaired state, and targeted credential contamination across boot/root/state. It rejects private keys and pre-issued user certificates; the sole packaged public cryptography-test-vector exception requires its exact path and file hash, with its package and upstream source recorded in the reviewed policy. These checks cannot prove the absence of every arbitrarily encoded secret. The receipt binds the raw image, inventory, source revision, and qualification policy using SHA-256, and records the reviewed builder revision that the build wrapper checks against its checkout. This is a build-host check, not a new Pi monitoring service or a signed release pipeline.

`scripts/manufacture.sh RAW_IMAGE BLOCK_DEVICE VERIFICATION_DIRECTORY` requires a matching production-channel receipt, validates the four-partition layout and target capacity, and requires explicit whole-device confirmation before writing. It flushes host buffers and verifies a read-back of the full image extent before reporting success. Raspberry Pi Imager remains an alternative that supports compressed input itself; let its verification stage finish. Neither check replaces first-boot and hardware qualification.

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
- `hexclave-tv-box-relay-identity.service` independently creates a unique relay-only key after first boot. `hexclave-tv-box-relay.service` is activated only by explicit per-device enrollment; neither service is a dependency of Wi-Fi or the renderer.
- `hexclave-tv-box-network.service` is the sole privileged Wi-Fi policy owner. It drives NetworkManager and exposes a narrow local Unix-socket protocol to the unprivileged setup portal.
- `hexclave-tv-box-setup.service` serves only the local captive portal. Wi-Fi secrets cross that local socket once, enter `nmcli` through a mode-0600 password file, and remain in NetworkManager's state-partition-backed profiles.
- `hexclave-tv-box-setup-display.service` owns tty1 only during local setup and prints the temporary network credentials directly to HDMI. It refreshes them when a failed station attempt starts a new setup session. It does not use WebKit, write those credentials to the journal, or persist them.
- `hexclave-tv-box-kiosk.service` owns and explicitly activates tty1 through a dedicated logind session, gives Cage and Cog one private Wayland runtime directory, then runs Cage in its supported no-input appliance mode with Cog pinned to the Wayland platform, a persistent cookie jar, and a volatile cache. A narrow supervisor checks the exact Cage/Cog/WPE process tree, rejects stopped processes, and tolerates a short web-process replacement window. It adopts renderer orphans as a Linux child subreaper because PAM can place children outside the service cgroup. Shutdown targets only those descendants using process identities and pidfds: ten seconds for graceful exit, followed by up to five seconds for forced termination and reaping. The pre-existing PAM helper is excluded. systemd limits the unit to five starts in fifteen minutes, covering slow as well as rapid crash loops; production images retain reboot recovery, while test images stop for diagnosis.
- The `/tv-box` browser runtime distinguishes authoritative credential rejection from temporary network/backend failure. Only rejection returns the appliance to pairing; transient failure keeps local identity and retries with bounded backoff.

With no saved network, setup mode starts immediately. The browser-independent HDMI display remains available even if Cog/WPE cannot start, and the captive portal must pass a bounded local readiness check. Cage/Cog starts only for offline or connected application content. With a saved network, the appliance first performs one synchronous NetworkManager activation and recheck so a healthy boot launches the connected renderer only once; if station activation still fails, it shows offline content while retrying for five minutes, offers setup for fifteen minutes, and then alternates two-minute station retries with setup windows. Backend availability does not participate in this Wi-Fi state machine.

The supervisor also observes Cog's native document-load result without enabling page-console logging. Failed navigation retries after four minutes; navigation that never completes gets a two-minute load deadline followed by that retry delay. These retries stay below the crash-loop budget. The network agent's once-per-minute, credential-free origin probe can accelerate recovery, but only when the supervisor reports a failed or timed-out document. Flapping probes do not restart a healthy slideshow or change Wi-Fi state. Intentional network/document restarts reset the start counter only for an active unit with a valid healthy-process record; process failures and periodic reconciliation retain their budget. An inline thirty-second bootstrap deadline reloads a document whose external application module failed to initialize. Once the application is running, its request deadlines and retry logic own API outages and stale-state presentation.

Process/native-load readiness is not proof that every later JavaScript frame rendered successfully. A post-load busy JavaScript loop remains a qualification limit. Likewise, forcibly killing or indefinitely stopping the supervisor itself can prevent its exact descendant cleanup; the service cgroup alone is not a substitute for that cleanup across PAM scopes. Do not describe these as covered failure modes without additional validation and recovery design.

## Pilot display and identity policy

The qualified Pi appliance uses fixed 1920×1080 at 60 Hz for `/tv-box`, not EDID-preferred resolution selection. This retains the tested rendering budget. It is a device HDMI setting, not a web-wide resolution cap: `/tv` and its higher-resolution presentation on other devices are unchanged.

A build-generated, static transparent cursor is selected only for Cage/Cog through their private `XCURSOR_PATH`. No animation, polling daemon, or hosted `/tv` cursor change is involved. The Wi-Fi portal's timezone must decode as an installed timezone; it is persisted for the renderer's `TZ` environment, without modifying `/etc/localtime` or other OS timezone files. It is not an SSH access restriction.

The clean image has an empty `/etc/machine-id`; systemd creates a unique OS machine ID on first boot. That file remains on the writable pilot root, with a copy recorded in persistent state. Ordinary restarts preserve the OS ID, device UUID, host keys, saved network, and browser identity. After an explicit factory reset, the next boot regenerates the device UUID and SSH host keys and starts unpaired, but retains the OS machine ID. The OS ID is not a display credential. Read-only-root qualification must account for this layout; do not rewrite the running OS identity as part of ordinary support.

## Pilot support

SSH accepts only short-lived certificates for the `hexclave-tv-support` principal. The forced support interface exposes a fixed command allowlist; it does not provide an arbitrary shell. Pairing or factory reset must follow dashboard admin unpair so an offline reset cannot leave an authorized remote display record behind.

Support mutations are serialized across SSH sessions using a root-owned lock outside the network agent's runtime directory. While that agent is running, kiosk/network/reset transitions pass through its policy lock; a reset cannot start a browser over Wi-Fi setup or delete browser state while another support session restarts it. Read-only diagnostics remain available during these operations.

Office support can use the optional [reverse-SSH transport](support-relay/README.md). A dedicated relay, trusted per-device enrollment and independent operator authentication are required; the base image is unenrolled and makes no support connection. One relay-loopback listener reaches the appliance's loopback SSH service, preserving its certificate/forced-command boundary. Local support remains available from private/link-local sources on Wi-Fi, not globally routed addresses. This address rule is not a claim of same-subnet enforcement.

Factory reset returns **scheduled** and runs as a fixed systemd-owned job so closing its own support connection cannot interrupt cleanup. It takes the mutation lock, stops the relay and removes only the exact device state directories, including the relay identity. Revoke the old relay account separately and enroll the reset box again; dashboard unpair does not manage support registration.

Diagnostics add bounded relay state and its public enrollment key. Network logs record transition reasons, durations and retry counts, with repeated failures coalesced. Support audits contain only validated command labels, outcomes, durations and process/operation IDs; individual certificate identity remains in native SSH authentication logs. Journal limits remain 32 MiB persistent/16 MiB runtime. There is no automatic log upload or raw page-console/SSH-debug export, and no credential, Wi-Fi-name or snapshot logging.

Pilot software updates remain serviced image replacements/reflashes with recorded image versions. The optional support transport is not an unattended updater or fleet service. Signed release, filesystem and broader qualification gates remain in Phase 2; fleet/OTA rollout is future scope, not an added requirement for this pilot slice.

The pilot image masks automatic package-update timers so field units cannot drift away from their recorded image artifact. Bluetooth is disabled because the appliance has no Bluetooth product function; Wi-Fi setup and restricted certificate-based support remain the only intended wireless and administrative paths.

## Acceptance and Phase 2 gates

The source-level implementation is followed by the per-device and soak checks in [PILOT_RUNBOOK.md](PILOT_RUNBOOK.md). The pilot does not complete the read-only-root conversion, signed image/SBOM pipeline, physical customer reset mechanism, fleet management, OTA updates, enterprise Wi-Fi, or full GA fault-injection matrix. Those remain explicit requirements in [GA_GATES.md](GA_GATES.md), not silently dropped scope.
