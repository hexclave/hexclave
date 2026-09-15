from __future__ import annotations

import ipaddress
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ROOTFS = ROOT / "image/rootfs"
SSH_CONFIG = ROOTFS / "etc/ssh/sshd_config.d/90-hexclave-tv-box.conf"
FIREWALL = ROOTFS / "etc/nftables.d/hexclave-tv-box.nft"

# Source prefix restrictions do not distinguish on-link global addresses from
# Internet traffic. Local support intentionally uses private or link-local IPs.
LAN_CASES = (
    ("192.168.1.10", "192.168.1.1", True),
    ("10.42.0.2", "10.42.0.1", True),
    ("172.16.0.2", "172.16.0.1", True),
    ("172.31.255.2", "172.31.255.1", True),
    ("169.254.10.2", "169.254.10.1", True),
    ("fc00::2", "fc00::1", True),
    ("fd00::2", "fd00::1", True),
    ("fe80::2", "fe80::1", True),
    ("172.15.0.2", "172.15.0.1", False),
    ("172.32.0.2", "172.32.0.1", False),
    ("192.169.0.2", "192.169.0.1", False),
    ("203.0.113.2", "203.0.113.1", False),
    ("2001:db8::2", "2001:db8::1", False),
)


def command(arguments: list[str]) -> str:
    return subprocess.run(arguments, check=True, capture_output=True, text=True, timeout=10).stdout


def network_namespace() -> str:
    return os.readlink("/proc/self/ns/net")


def require_fresh_namespace(parent_namespace: str) -> None:
    # Both subprocess entry points refuse to touch the caller's namespace.
    # No named namespaces, host sysctls, firewall rules, or interfaces are used.
    if network_namespace() == parent_namespace:
        raise RuntimeError("SSH firewall tests require a separate network namespace.")
    links = json.loads(command(["ip", "-json", "link", "show"]))
    if [link["ifname"] for link in links] != ["lo"]:
        raise RuntimeError("SSH firewall tests require a fresh loopback-only namespace.")


def configure_address(interface: str, address: str, action: str) -> None:
    version = ipaddress.ip_address(address).version
    prefix = 24 if version == 4 else 64
    arguments = ["ip", "address", action, f"{address}/{prefix}", "dev", interface]
    if version == 6 and action == "add":
        arguments.append("nodad")
    command(arguments)


def can_connect(source: str, target: str, interface: str) -> bool:
    ipv6 = ipaddress.ip_address(source).version == 6
    family = socket.AF_INET6 if ipv6 else socket.AF_INET
    scope = socket.if_nametoindex(interface) if ipv6 else 0
    with socket.socket(family, socket.SOCK_STREAM) as client:
        client.settimeout(0.4)
        client.bind((source, 0, 0, scope) if ipv6 else (source, 0))
        try:
            client.connect((target, 22, 0, scope) if ipv6 else (target, 22))
        except TimeoutError:
            return False
    return True


def client_probe(parent_namespace: str) -> None:
    require_fresh_namespace(parent_namespace)
    command(["ip", "link", "set", "lo", "up"])
    print("ready", flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        interface, source, target = request["interface"], request["source"], request["target"]
        if interface not in {"ssh-lan-peer", "ssh-other-peer"}:
            raise ValueError("Unexpected isolated-test interface.")
        command(["ip", "link", "set", interface, "up"])
        configure_address(interface, source, "add")
        try:
            result = can_connect(source, target, interface)
        finally:
            configure_address(interface, source, "delete")
        print(json.dumps(result), flush=True)


def firewall_probe(parent_namespace: str) -> None:
    require_fresh_namespace(parent_namespace)
    command(["ip", "link", "set", "lo", "up"])
    with subprocess.Popen(
        ["unshare", "--net", sys.executable, __file__, "--ssh-client", network_namespace()],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    ) as client:
        if client.stdin is None or client.stdout is None:
            raise RuntimeError("SSH firewall probe pipes were not created.")
        try:
            if client.stdout.readline().strip() != "ready":
                raise RuntimeError("Isolated SSH client failed to start.")
            for interface, peer in (("wlan0", "ssh-lan-peer"), ("eth0", "ssh-other-peer")):
                command(["ip", "link", "add", interface, "type", "veth", "peer", "name", peer])
                command(["ip", "link", "set", peer, "netns", str(client.pid)])
                command(["ip", "link", "set", interface, "up"])
            # Load the unmodified shipped rules, not a test model of their syntax.
            command(["nft", "--file", str(FIREWALL)])
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as ipv4, socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as ipv6:
                ipv6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                ipv4.bind(("0.0.0.0", 22))
                ipv6.bind(("::", 22))
                ipv4.listen(64)
                ipv6.listen(64)
                results = [
                    ["lo", "127.0.0.1", can_connect("127.0.0.1", "127.0.0.1", "lo")],
                    ["lo", "::1", can_connect("::1", "::1", "lo")],
                ]
                for interface, peer in (("wlan0", "ssh-lan-peer"), ("eth0", "ssh-other-peer")):
                    for source, target, _expected in LAN_CASES:
                        configure_address(interface, target, "add")
                        try:
                            client.stdin.write(json.dumps({"interface": peer, "source": source, "target": target}) + "\n")
                            client.stdin.flush()
                            result = json.loads(client.stdout.readline())
                        finally:
                            configure_address(interface, target, "delete")
                        if type(result) is not bool:
                            raise RuntimeError("Unexpected SSH probe result.")
                        results.append([interface, source, result])
                print(json.dumps(results))
        finally:
            # Closing stdin ends only this owned child. Kernel namespace teardown
            # removes exactly the interfaces/rules created inside the fixture.
            client.stdin.close()
            try:
                client.wait(timeout=5)
            except subprocess.TimeoutExpired:
                client.kill()
                client.wait(timeout=5)
        if client.returncode != 0:
            raise RuntimeError("Isolated SSH client failed.")


class SshPathContractTests(unittest.TestCase):
    def test_local_ssh_is_enabled_independently_of_relay_enrollment(self) -> None:
        layer = (ROOT / "image/layer/hexclave-tv-box-pilot.yaml").read_text(encoding="utf-8")
        enabled = next(line for line in layer.splitlines() if "systemctl enable" in line).split()
        self.assertIn("ssh.service", enabled)
        self.assertIn("nftables.service", enabled)
        self.assertNotIn("ListenAddress", SSH_CONFIG.read_text(encoding="utf-8"))
        self.assertFalse((ROOTFS / "var/lib/hexclave-tv-box/relay/enrollment.json").exists())
        # No image-supplied ssh.service override may make the local listener
        # conditional on enrollment or dependent on the optional transport.
        systemd = ROOTFS / "etc/systemd/system"
        self.assertFalse((systemd / "ssh.service").exists())
        self.assertFalse((systemd / "ssh.service.d").exists())
        firstboot = (systemd / "hexclave-tv-box-firstboot.service").read_text(encoding="utf-8")
        self.assertIn("ssh.service", next(line for line in firstboot.splitlines() if line.startswith("Before=")))
        self.assertNotIn("ConditionPathExists", firstboot)
        self.assertNotIn("Requires=hexclave-tv-box-relay", firstboot)

    @unittest.skipUnless(shutil.which("sshd") and shutil.which("ssh-keygen"), "OpenSSH server/client tools are required.")
    def test_lan_and_relay_use_identical_effective_certificate_and_forced_command_policy(self) -> None:
        expected = {
            "passwordauthentication": "no",
            "kbdinteractiveauthentication": "no",
            "pubkeyauthentication": "yes",
            "authenticationmethods": "publickey",
            "authorizedkeysfile": "none",
            "trustedusercakeys": "/etc/ssh/hexclave-support-ca.pub",
            "authorizedprincipalsfile": "/etc/ssh/auth_principals/%u",
            "forcecommand": "/usr/lib/hexclave-tv-box/forced-support-command",
            "allowusers": "hexclave-support",
            "permitrootlogin": "no",
            "permittty": "no",
            "allowtcpforwarding": "no",
            "allowstreamlocalforwarding": "no",
            "allowagentforwarding": "no",
            "disableforwarding": "yes",
            "x11forwarding": "no",
            "permituserrc": "no",
            "permituserenvironment": "no",
            "permittunnel": "no",
        }
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            host_key = str(Path(directory) / "host-key.untracked")
            command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", host_key])
            for source in ("192.168.1.10", "10.42.0.2", "172.20.10.2", "169.254.10.2", "fd00::2", "fe80::2", "127.0.0.1", "::1"):
                with self.subTest(source=source):
                    # -h supplies a disposable host key; the appliance's persistent
                    # host-key paths need not exist on the test machine. No daemon
                    # is started, and no host SSH configuration is read or changed.
                    output = command([
                        "sshd", "-T", "-f", str(SSH_CONFIG), "-h", host_key,
                        "-C", f"user=hexclave-support,host=tvbox,addr={source}",
                    ])
                    effective = dict(line.split(" ", 1) for line in output.splitlines())
                    for name, value in expected.items():
                        self.assertEqual(effective.get(name), value, name)
        principal = (ROOTFS / "etc/ssh/auth_principals/hexclave-support").read_text(encoding="utf-8")
        self.assertEqual(principal.strip(), "hexclave-tv-support")

    @unittest.skipUnless(sys.platform == "linux" and all(shutil.which(tool) for tool in ("unshare", "nft", "ip")), "Linux network namespace and nftables tools are required.")
    def test_shipped_firewall_accepts_local_and_loopback_ssh_and_drops_other_paths(self) -> None:
        capability = subprocess.run(
            ["unshare", "--net", "nft", "list", "tables"],
            capture_output=True, text=True, timeout=10,
        )
        if capability.returncode != 0:
            self.skipTest("Creating an isolated network namespace with nftables is not permitted.")
        result = subprocess.run(
            ["unshare", "--net", sys.executable, __file__, "--firewall-probe", network_namespace()],
            capture_output=True, text=True, timeout=45,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = [["lo", "127.0.0.1", True], ["lo", "::1", True]]
        expected.extend(["wlan0", source, allowed] for source, _target, allowed in LAN_CASES)
        expected.extend(["eth0", source, False] for source, _target, _allowed in LAN_CASES)
        self.assertEqual(json.loads(result.stdout), expected)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--firewall-probe":
        firewall_probe(sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == "--ssh-client":
        client_probe(sys.argv[2])
    else:
        unittest.main()
