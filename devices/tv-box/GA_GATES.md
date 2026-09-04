# TV Box Phase 2: Production Hardening and GA Gates

Phase 1 deliberately establishes interfaces that these gates can harden without replacing the appliance architecture: systemd remains the supervisor, NetworkManager remains the Wi-Fi authority, Cog/WPE remains the thin renderer, `/var/lib/hexclave-tv-box` remains the device-state boundary, and Hexclave remains the only project/profile/snapshot authority.

None of the following work is implemented by the pilot slice unless explicitly stated otherwise.

## Image, filesystem, and updates

- Convert the base/root filesystem to read-only or immutable operation with explicitly enumerated writable state and WPE cache paths.
- Add a signed release pipeline, provenance, SBOM, vulnerability scanning, artifact retention, and reproducible package-snapshot policy.
- Design verified A/B or equivalent atomic updates with rollback, power-loss safety, update health confirmation, and a recovery image.
- Define staged rollout, update deferral, fleet targeting, version inventory, and decommission/revocation behavior. Do not add a general device-control channel merely to deliver updates.
- Validate long-term microSD wear, filesystem repair, state growth, log rotation, and recovery from corruption at every writable boundary.

## Manufacturing and identity

- Automate multi-card manufacturing, artifact/signature verification, per-unit first-boot evidence, serial/label association, quarantine, rework, and secure decommissioning.
- Prove factory images never contain initialized machine IDs, SSH host keys, browser identity, Wi-Fi profiles, support certificates, or pairing state.
- Evaluate stronger hardware-backed identity/verified boot on future hardware; Pi Zero 2 W limitations must not be disguised as guarantees.
- Define an at-rest protection strategy for browser and Wi-Fi credentials on lost/stolen devices. Encryption whose unlock key is stored beside the ciphertext on the same microSD is not an acceptable security claim.
- Add regional image/configuration controls for Wi-Fi regulatory requirements and the final sales regions.

## Provisioning and customer recovery

- Add a documented customer-accessible physical reset/re-pair mechanism with deliberate activation, safe interruption behavior, and clear feedback.
- Qualify upstream captive portals and networks that require web sign-in.
- Add enterprise Wi-Fi only with an explicit certificate/private-key lifecycle; do not stretch the Personal-network portal into 802.1X support.
- Expand accessibility, localization, router compatibility, mobile captive-portal behavior, and setup timeout/retry usability across supported phones and browsers.

## Support and security

- Operationalize support-certificate issuance, short validity, approval, rotation, revocation, and access audit without adding dashboard credentials to a box.
- Threat-model and penetration-test the setup AP, captive portal, local agent socket, forced support command, image supply chain, renderer storage, reset flow, and network transitions.
- Run secret scanning and adversarial tests proving that tokens, cookies, pairing material, snapshots, Wi-Fi names/passwords, and customer data cannot enter diagnostics or logs.
- Validate firewall/port posture on every supported network mode and after failed upgrades/resets.
- Define a security-update SLA and end-of-support process.

## Hardware and fault qualification

- Qualify the final power supply, enclosure, thermal profile, storage media, HDMI cable, TV/monitor matrix, EDID modes, hot-plug behavior, overscan, CEC policy, and display sleep/wake behavior.
- Run the full fault-injection matrix: at least 25 abrupt power cuts at varied write/boot phases, 30 browser/compositor/network-service failures, repeated router/backend/DNS/TLS outages, state-partition-full conditions, corrupted state samples, and watchdog recovery.
- Run at least 72-hour representative soaks and broader multi-unit soaks while tracking CPU, memory, zram/swap, temperature, throttling, disk growth, service restarts, stale intervals, and visual defects.
- Test supported routers, phone platforms, weak/intermittent Wi-Fi, clock loss, certificate-time failures, DNS changes, IPv4/IPv6 combinations, and multiple geographic regions.

## Deferred product platform

Fleet health/heartbeat, remote configuration, remote logs, remote factory reset, and general device management remain deferred until pilot evidence establishes a concrete need. If introduced, they must be narrow device operations with explicit authorization and privacy boundaries—not a second TV Mode backend or a route for dashboard credentials onto the appliance.
