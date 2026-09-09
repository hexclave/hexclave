# Optional reverse-SSH pilot support

This is a transport to the existing certificate-restricted appliance support
interface, not a Hexclave HTTP API or a remote root shell. It requires a
dedicated operator-managed public OpenSSH relay. The ordinary image remains
unenrolled: no external connection is made and no relay credentials are cloned.
Local certificate-authenticated support remains available.

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
`sshd_config.template` as a reviewed starting point on a dedicated host/service.
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

## Qualification before enabling a customer registration

- Measure idle/active/reconnecting transport RSS/CPU on the qualified Pi.
- Verify office-to-relay-to-box support and unchanged local support; expired
  appliance certificates, unrelated device keys, wrong relay host keys, and
  unauthorized operator listeners must be rejected.
- Verify that each role cannot open a shell, exec/SFTP session, PTY, agent/X11
  forward, Unix socket forward, arbitrary local/remote forward, or public
  listener. Confirm listener port collisions fail rather than redirecting to
  another device. Inspect sockets and both role-specific effective configs.
- Disconnect Wi-Fi, stop/restart the relay, restart the service, reboot, and
  verify bounded backoff (4–300 seconds with jitter) and unchanged playback and
  persistent pairing. No transport failure triggers an appliance reboot.
- Factory reset and reflash must invalidate the local relay identity; verify
  revocation of the old server-side registration and fresh enrollment.
- Logs contain only connection state, bounded counts, durations, exit codes
  and fixed failure categories. They never emit raw SSH output, private keys,
  cookies, pairing data, Wi-Fi credentials, or snapshot contents.

This manual registration process is for the small pilot. Automated enrollment,
an identity directory, fleet dashboards and full remote updates remain outside
this transport implementation.
