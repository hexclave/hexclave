# Optional reverse-SSH pilot support

This is a transport to the existing certificate-restricted appliance support
interface, not a Hexclave HTTP API or a remote root shell. It requires an
operator-managed, internet-reachable OpenSSH endpoint. Its host and port are
configuration, not a dependency on a hosting provider or the development VM.
An isolated relay service can run on an approved existing host; no new server,
backend API, database table, VPN, or fleet service is required by the appliance.
The ordinary image remains
unenrolled: no external connection is made and no relay credentials are cloned.
Local certificate-authenticated support remains an independent supported path.

## Device process and recovery

The startup helper validates root-owned enrollment and the pinned host key,
then replaces itself with `/usr/bin/ssh` using `execve`. Only OpenSSH stays
resident: no Python supervisor, log parser, polling loop, or transport daemon.
The separate identity initializer is a short boot-time task, not a resident
process, and never enrolls a box or opens a connection by itself.

Systemd restarts the client after both failures and clean remote disconnects.
The qualified systemd 257 supports native retry delay growth from five seconds
to five minutes across six steps. Retries continue during extended outages;
they do not exhaust a start budget or trigger a reboot. SSH uses a 15-second
connection/handshake timeout, 30-second server keepalives with three unanswered
probes, and failure on unsuccessful forward allocation. Resolver delays are
also subject to the OS resolver's own timeouts. Reconnection is automatic, not
instantaneous; the capped retry delay still applies when connectivity returns.

Missing enrollment skips the service. Malformed local configuration fails with
exit 78 and requires correcting the enrollment before restarting the relay;
it never falls back to another endpoint, trust key, password, or authentication
method. Network/DNS/authentication/host-key failures in SSH remain fail-closed
and retry without changing trust. Stopping this unit intentionally does not
restart it. Neither relay unit is required by the kiosk, Wi-Fi, or local SSH.

`diagnostics` distinguishes enrollment (`disabled`, `invalid-config`, or
`configured`) from the native systemd service state. `active` means a process
is running, not that the reverse listener or the final support login works.
Use an actual certificate-authenticated remote diagnostic request as the
end-to-end check. Raw SSH output is discarded to avoid journaling arbitrary
server banners or private topology; systemd lifecycle, exit status, restart
counts and the bounded `relay-metrics` command remain available.

## Trust and scope

- Each physical box generates its own relay-only Ed25519 key in an independent
  first-boot identity service. Failure of this optional service never blocks
  the network or renderer services.
  The key, enrollment and pinned relay host key live under the exact persistent
  `relay/` state directory, owned by root and readable only by the dedicated
  `hexclave-tv-relay` group. The transport process cannot rewrite these files.
- The relay grants each box one unique loopback listener. A box may establish
  only a remote forward, not a relay shell or arbitrary relay-side outbound
  connection. The appliance client forwards this listener to its own
  `127.0.0.1:22`; inbound appliance SSH forwarding stays disabled.
- Operators use their own relay identity and can connect only to explicitly
  assigned listeners. A second SSH handshake authenticates the **box host key**
  and then the operator's short-lived **appliance support certificate**. Relay
  access alone grants no appliance command execution.
- Never register keys learned only from an unauthenticated network scan. Verify
  the relay host key through its trusted host console and the box public key
  and SSH host key through authenticated local support or controlled physical
  manufacturing. Maintain device/account/port/host-key mappings privately,
  outside this public repository.
- Do not share a signing CA private key among support staff. Issue individual
  operator credentials; revocation and retention policy belong to the operator.

OpenSSH documents the relevant `MaxSessions`, `PermitListen`, `PermitOpen`,
`GatewayPorts` and forwarding restrictions in its
[server configuration reference](https://man.openbsd.org/sshd_config).

## Relay provisioning

No server provisioning is performed by the image build. Use the adjacent
`sshd_config.template` as a reviewed starting point for an isolated SSH service
on a host approved by its owner. Nothing in the device requires a particular
provider or a newly provisioned machine. If sharing a host, reserve a separate
listener and service configuration without replacing its administrative SSH.
Do not replace an existing production host's SSH configuration without its own
access/recovery plan. Create separate no-password accounts in
`hexclave-relay-devices` and `hexclave-relay-operators`; give them an existing
non-interactive shell, and root-owned public-key files in
`/etc/hexclave-relay/authorized_keys/` (directory 0755, files 0644). Do not rely
on password locking behavior across distributions; independently verify that
public-key-only authentication succeeds and every password method fails.

For the box's key file, use only the independently verified public key, with
its exact listener restriction as a second layer:

```text
restrict,port-forwarding,permitlisten="127.0.0.1:ASSIGNED_RELAY_PORT" ssh-ed25519 VERIFIED_DEVICE_PUBLIC_KEY
```

For an operator's relay key file, independently restrict each permitted target:

```text
restrict,port-forwarding,permitopen="127.0.0.1:ASSIGNED_RELAY_PORT" ssh-ed25519 VERIFIED_OPERATOR_PUBLIC_KEY
```

Replace placeholders, validate `sshd -t`, and inspect effective configuration
with `sshd -T -C user=ACCOUNT,host=RELAY_HOST,addr=TEST_CLIENT_ADDRESS` for both
roles. Unregistered accounts/listeners must fail. `GatewayPorts no` is essential:
the forwarded listener is never public. Keep the server patched, retain bounded
authentication/audit logs, and apply connection-rate limits appropriate to the
small batch. The relay's public SSH port must be reachable outbound from the
customer network; a corporate firewall may prohibit it.

## Authenticating and enrolling a physical pilot unit

The initial pilot deliberately uses a trusted Linux manufacturing workstation
for enrollment. It does not add a public upload API, a Wi-Fi portal enrollment
feature, or an arbitrary-file-write support command.

1. Boot the individually flashed card to initialize its unique identity. Use
   authenticated local `diagnostics` to obtain `relay-enrollment-public-key`, and
   independently retain the authenticated appliance host key in the private
   manufacturing record. Do not copy any private key from the box.
2. Register that exact public key, a unique `tvbox-` account (8–26 lowercase
   alphanumeric suffix characters), and one unique unprivileged listener port
   on the relay. Record the registration against this unit, not its tenant.
3. Shut down the unit safely. Mount **that initialized card's state partition**
   on the trusted Linux workstation. Never enroll the golden/base image. macOS
   does not normally provide native write access to this ext4 partition.
4. Create a root-owned 0600 approved local JSON file with this exact schema;
   the key must be the verified relay Ed25519 host key, without a comment:

   ```json
   {
     "version": 1,
     "host": "relay.example.invalid",
     "port": 22,
     "user": "tvbox-example0001",
     "listen_port": 22001,
     "host_key": "ssh-ed25519 REPLACE_WITH_VERIFIED_BASE64_KEY"
   }
   ```

5. From a reviewed checkout, run the root-only provisioning helper. Substitute
   the **verified state mount** and approved JSON file; the helper only creates
   `known_hosts` and `enrollment.json` within its existing exact `relay/` child:

   ```sh
   sudo env PYTHONPATH="$PWD/devices/tv-box/src" \
     python3 -m hexclave_tv_box.relay \
     --state-root /mnt/tv-box-state \
     --enroll /root/approved-tv-box-relay.json
   ```

6. Synchronize and unmount that card, then boot the unit. The optional service
   activates only when enrollment is present. Read `diagnostics` and
   `recent-logs` through the verified local support connection first. Reusing
   an already enrolled directory is rejected rather than silently replacing
   trust or the unit's account.

Every ordinary reboot preserves the registration. Factory reset stops the
transport and deletes only this unit's local relay state. The relay operator
must also revoke the old account/key, terminate any remaining old relay
connection, and remove obsolete host-key mappings; the reset unit needs fresh
trusted enrollment. A reflash similarly requires revocation and re-enrollment.

## Operator connection

Use an operator-owned SSH config on the support workstation. These are
placeholders, not deployed addresses or shared identities:

```sshconfig
Host hexclave-pilot-relay
    HostName VERIFIED_RELAY_HOST
    User INDIVIDUAL_RELAY_OPERATOR
    IdentityFile PATH_TO_OPERATOR_RELAY_KEY
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    UserKnownHostsFile PATH_TO_VERIFIED_RELAY_HOST_KEYS

Host selected-tv-box
    HostName 127.0.0.1
    Port ASSIGNED_RELAY_PORT
    ProxyJump hexclave-pilot-relay
    HostKeyAlias VERIFIED_DEVICE_ID
    User hexclave-support
    IdentityFile PATH_TO_INDIVIDUAL_SUPPORT_KEY
    CertificateFile PATH_TO_CURRENT_SUPPORT_CERTIFICATE
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    UserKnownHostsFile PATH_TO_VERIFIED_DEVICE_HOST_KEYS
```

Then `ssh selected-tv-box diagnostics`, `recent-logs`, and the existing fixed
support command names work without exposing device SSH publicly. Never disable
host-key checking to bypass a reset/re-enrollment mismatch. There is no support
when the box is offline or powered down. Playback and Wi-Fi recovery do not
depend on the relay being available.

### Independent local-LAN access

Keep a second SSH alias, such as `selected-tv-box-lan`, using the box's private
LAN address with the same appliance user, certificate, verified host key and
`HostKeyAlias`. It has no `ProxyJump` and needs no relay enrollment or relay
credentials. Prefer the current private IPv4 address for a Mac-to-Pi session;
IPv6 ULA and interface-scoped link-local addresses also remain permitted.

The existing firewall is unchanged: private/link-local sources on `wlan0` and
loopback are allowed. Globally addressed IPv4/IPv6 sources remain blocked even
if on the same physical LAN. This policy is an address allowlist, not automatic
on-link detection. Neither the relay nor this change widens it, binds sshd to
loopback only, or disables ordinary local support.

## Qualification before enabling a customer registration

- Measure idle/active/reconnecting transport cgroup memory and CPU on the
  qualified Pi; cgroup memory is not process RSS.
- Verify office-to-relay-to-box support and unchanged local support; expired
  appliance certificates, unrelated device keys, wrong relay host keys, and
  unauthorized operator listeners must be rejected.
- Verify that each role cannot open a shell, exec/SFTP session, PTY, agent/X11
  forward, Unix socket forward, arbitrary local/remote forward, or public
  listener. Confirm listener port collisions fail rather than redirecting to
  another device. Inspect sockets and both role-specific effective configs.
- Disconnect Wi-Fi, stop/restart the relay, restart the service, reboot, and
  verify native bounded retry delay (5–300 seconds) and unchanged playback and
  persistent pairing. No transport failure triggers an appliance reboot.
- Factory reset and reflash must invalidate the local relay identity; verify
  revocation of the old server-side registration and fresh enrollment.
- Logs contain only lifecycle state, bounded counts, durations and exit codes.
  They never emit raw SSH output, private keys,
  cookies, pairing data, Wi-Fi credentials, or snapshot contents.

## Zero 2 W overhead measurements

`relay-metrics` is a read-only, no-argument command through the existing
certificate/forced-command interface. It queries only the relay service's
systemd accounting. Nothing samples in the background or stores metrics on
the SD card. CPU, memory and task accounting are enabled on that unit.

From an authorized workstation on the same LAN, configure the direct
`selected-tv-box-lan` alias described above and run:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=8 selected-tv-box-lan diagnostics

for sample in {1..20}; do
  ssh -o BatchMode=yes -o ConnectTimeout=8 selected-tv-box-lan relay-metrics || break
  sleep 30
done | tee tv-box-relay-idle.untracked.txt

ssh -o BatchMode=yes -o ConnectTimeout=8 selected-tv-box-lan diagnostics
```

Use LAN access for idle samples: taking them through the relay measures active
support traffic instead. On each phase, keep the same slideshow and record its
visible smoothness, freshness, temperature, available memory and swap use:

1. **Baseline:** run on the same initialized but unenrolled image. Expect no
   relay main process. `unavailable` accounting is not zero usage.
2. **Idle connection:** after trusted enrollment, let startup settle and sample
   for ten minutes. Prove office-to-box diagnostics work separately, then leave
   the tunnel idle while collecting over LAN.
3. **Reconnection:** the authorized relay operator temporarily stops only the
   dedicated test relay service. Keep Pi Wi-Fi and LAN SSH available; collect
   the same samples as `tv-box-relay-reconnect.untracked.txt`. Restore that
   service and verify automatic office-to-box access, no duplicated listeners,
   no lost pairing and no kiosk restart. Never stop a shared host's admin SSH.
4. **Network loss and reboot:** retain the existing short/long network-loss and
   OS-reboot tests, checking automatic relay recovery as well as playback.
   Complete the existing 24-hour pilot soak with the transport enabled before
   enabling remote support on customer units; 72-hour qualification remains GA.

The output includes a monotonic sample time and systemd `InvocationID`. Only
calculate CPU deltas between samples with the **same non-unavailable invocation
ID** and nondecreasing counters: `100 × delta(cpu-nsec) / delta(sample-nsec)` is
percent of one CPU core. Counters must not be subtracted across restarts or
reboots; reset the baseline instead. Increase in `relay-restarts` and changes
in invocation ID identify retry activity. Short failed attempts may finish
between samples, so native accounting samples are not a complete cumulative
CPU profile of a restart storm.

`relay-memory-current-bytes` is cgroup-charged memory (including cache), not
process RSS. Compare steady-state and peak values in each phase; do not sum
repeated samples. Missing/unsupported counters are explicitly `unavailable`.
`active`/a PID is not proof of connection readiness. The running main process
should be OpenSSH after the brief validator; there must be no resident Python
supervisor for this unit. Hardware measurements, not source tests, determine
whether overhead is acceptable on the qualified Zero 2 W.

This manual registration process is for the small pilot. Automated enrollment,
an identity directory, fleet dashboards and full remote updates remain outside
this transport implementation.
