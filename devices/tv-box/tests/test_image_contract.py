from __future__ import annotations

import ipaddress
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_cursor_asset import cursor_asset
from test_image_preflight import make_raw_image, mount_command_environment
from test_image_verification import make_verification_fixture


ROOT = Path(__file__).resolve().parents[1]
ROOTFS = ROOT / "image" / "rootfs"


class ImageContractTests(unittest.TestCase):
    def test_local_support_firewall_rejects_globally_routed_sources(self) -> None:
        firewall = (ROOTFS / "etc/nftables.d/hexclave-tv-box.nft").read_text(encoding="utf-8")
        support_rules = [line for line in firewall.splitlines() if "tcp dport 22 accept" in line]
        self.assertEqual(len(support_rules), 2)
        networks = []
        for line in support_rules:
            match = re.fullmatch(r'\s*iifname "wlan0" ip6? saddr \{ ([^}]+) \} tcp dport 22 accept', line)
            self.assertIsNotNone(match)
            if match is None:
                raise AssertionError("SSH support rule lacks an explicit source restriction.")
            networks.extend(ipaddress.ip_network(value.strip()) for value in match.group(1).split(","))
        for value in ("192.168.0.10", "172.20.10.2", "10.42.0.2", "169.254.10.2", "fd00::2", "fe80::2"):
            address = ipaddress.ip_address(value)
            self.assertTrue(any(address in network for network in networks), value)
        for value in ("1.1.1.1", "172.32.0.1", "192.169.0.1", "2001:4860:4860::8888"):
            address = ipaddress.ip_address(value)
            self.assertFalse(any(address in network for network in networks), value)

    def test_setup_portal_only_shows_manual_network_fields_for_manual_entry(self) -> None:
        setup_ui = ROOT / "setup-ui"
        html = (setup_ui / "index.html").read_text(encoding="utf-8")
        script = (setup_ui / "setup.js").read_text(encoding="utf-8")
        styles = (setup_ui / "setup.css").read_text(encoding="utf-8")
        self.assertIn('id="manual-name" hidden', html)
        self.assertIn('id="manual-security" hidden', html)
        self.assertIn('manualOption.textContent = "Enter another network…"', script)
        self.assertIn('networkSelect.value = firstSupportedNetwork >= 0 ? String(firstSupportedNetwork) : "manual";', script)
        self.assertIn("manualName.hidden = !manual", script)
        self.assertIn("[hidden] { display: none !important; }", styles)

    def test_services_use_the_persistent_cookie_jar_and_production_url(self) -> None:
        launcher = (ROOTFS / "usr/lib/hexclave-tv-box/kiosk-launch").read_text(encoding="utf-8")
        self.assertIn("/var/lib/hexclave-tv-box/browser", launcher)
        self.assertIn("/run/hexclave-tv-box-browser-cache", launcher)
        self.assertIn('data_dir="$cookie_dir/data"', launcher)
        self.assertIn('config_dir="$cookie_dir/config"', launcher)
        self.assertIn('export XDG_CACHE_HOME="$cache_dir"', launcher)
        self.assertIn('export XDG_DATA_HOME="$data_dir"', launcher)
        self.assertIn('export XDG_CONFIG_HOME="$config_dir"', launcher)
        self.assertNotIn("data_dir=/run/", launcher)
        self.assertNotIn("config_dir=/run/", launcher)
        self.assertIn("wayland_runtime_dir=/run/hexclave-tv-box-wayland", launcher)
        self.assertIn('export XDG_RUNTIME_DIR="$wayland_runtime_dir"', launcher)
        self.assertIn("unset DBUS_SESSION_BUS_ADDRESS", launcher)
        self.assertLess(
            launcher.index('export XDG_RUNTIME_DIR="$wayland_runtime_dir"'),
            launcher.index("unset DBUS_SESSION_BUS_ADDRESS"),
        )
        self.assertLess(
            launcher.index("unset DBUS_SESSION_BUS_ADDRESS"),
            launcher.index("exec /usr/bin/python3"),
        )
        self.assertIn('stat -c %u "$wayland_runtime_dir"', launcher)
        self.assertIn('stat -c %a "$wayland_runtime_dir"', launcher)
        self.assertIn("hexclave_tv_box.kiosk_supervisor", launcher)
        self.assertIn('--health-file="$cookie_dir/kiosk-health"', launcher)
        self.assertNotIn("--remote-debugging", launcher)
        supervisor = (ROOT / "src/hexclave_tv_box/kiosk_supervisor.py").read_text(encoding="utf-8")
        self.assertIn('"--platform=wl"', supervisor)
        self.assertIn('"--webprocess-failure=exit"', supervisor)
        self.assertIn('"--enable-write-console-messages-to-stdout=false"', supervisor)
        self.assertNotIn("--remote-debugging", supervisor)
        network_agent = (ROOT / "src/hexclave_tv_box/network_agent.py").read_text(encoding="utf-8")
        self.assertIn('PRODUCTION_URL = "https://app.hexclave.com/tv-box"', network_agent)
        self.assertIn('TEST_IMAGE_MARKER = Path("/etc/hexclave-tv-box-test-image")', network_agent)
        self.assertIn('TEST_ORIGIN_FILE = Path("/boot/firmware/hexclave-tv-box-test-origin.txt")', network_agent)
        kiosk = (ROOTFS / "etc/systemd/system/hexclave-tv-box-kiosk.service").read_text(encoding="utf-8")
        self.assertIn("Restart=always", kiosk)
        self.assertIn("StartLimitAction=reboot", kiosk)
        self.assertIn("StartLimitIntervalSec=15min", kiosk)
        self.assertIn("StartLimitBurst=5", kiosk)
        self.assertIn("RuntimeDirectory=hexclave-tv-box-wayland hexclave-tv-box-browser-cache", kiosk)
        self.assertIn("Environment=XDG_RUNTIME_DIR=/run/hexclave-tv-box-wayland", kiosk)
        self.assertIn(
            "ReadWritePaths=/run/hexclave-tv-box-wayland /run/hexclave-tv-box-browser-cache",
            kiosk,
        )
        self.assertIn("Conflicts=getty@tty1.service hexclave-tv-box-setup-display.service", kiosk)
        self.assertIn("Wants=dbus.socket systemd-logind.service", kiosk)
        self.assertIn("StandardInput=tty-fail", kiosk)
        self.assertIn("PAMName=hexclave-tv-box-kiosk", kiosk)
        self.assertIn("ExecStartPost=+/usr/bin/chvt 1", kiosk)
        self.assertIn("TimeoutStopSec=20", kiosk)
        self.assertIn("KillMode=control-group", kiosk)
        self.assertNotIn("KillMode=mixed", kiosk)
        verifier = (ROOT / "scripts/verify-image.sh").read_text(encoding="utf-8")
        self.assertIn("grep -qxF 'TimeoutStopSec=20'", verifier)
        self.assertIn("grep -qxF 'KillMode=control-group'", verifier)
        self.assertIn("Environment=WLR_LIBINPUT_NO_DEVICES=1", kiosk)
        self.assertIn("SyslogIdentifier=hexclave-tv-box-kiosk", kiosk)
        kiosk_pam = (ROOTFS / "etc/pam.d/hexclave-tv-box-kiosk").read_text(encoding="utf-8")
        self.assertIn("session required pam_systemd.so", kiosk_pam)
        setup_display = (ROOTFS / "etc/systemd/system/hexclave-tv-box-setup-display.service").read_text(encoding="utf-8")
        self.assertIn("User=hexclave-tv-portal", setup_display)
        self.assertIn("StandardOutput=tty", setup_display)
        self.assertIn("StandardError=journal", setup_display)
        self.assertIn("RestrictAddressFamilies=AF_UNIX", setup_display)
        self.assertIn("Conflicts=getty@tty1.service hexclave-tv-box-kiosk.service", setup_display)
        for service_name in ("hexclave-tv-box-network.service", "hexclave-tv-box-setup.service"):
            service = (ROOTFS / "etc/systemd/system" / service_name).read_text(encoding="utf-8")
            self.assertIn("Restart=", service)
            self.assertIn("StartLimitAction=reboot", service)
            self.assertIn("PYTHONDONTWRITEBYTECODE=1", service)

    def test_unique_identity_and_network_profiles_live_outside_the_base_image(self) -> None:
        layer = (ROOT / "image/layer/hexclave-tv-box-pilot.yaml").read_text(encoding="utf-8")
        metadata = layer.split("# METAEND", maxsplit=1)[0]
        self.assertNotIn("network-manager", metadata)
        self.assertIn("# X-Env-Layer-Provides: network-activator", metadata)
        self.assertIn("  suite: trixie", layer)
        self.assertIn("    - fake-hwclock", layer)
        self.assertNotIn("systemd-timesyncd,fake-hwclock", layer)
        self.assertIn('date -d "@${SOURCE_DATE_EPOCH}" > "$1/etc/fake-hwclock.data"', layer)
        self.assertIn("    - network-manager", layer)
        self.assertNotIn("libraspberrypi-bin", layer)
        self.assertNotIn("${DIRECTORY}", layer)
        self.assertIn('cp -a --no-preserve=ownership "${SRCROOT}/rootfs/." "$1/"', layer)
        self.assertIn('cp -a --no-preserve=ownership "${SRCROOT}/../src/hexclave_tv_box"', layer)
        self.assertIn("-name __pycache__ -prune -exec rm -rf {} +", layer)
        self.assertIn("-name '*.pyc' -o -name '*.pyo'", layer)
        self.assertIn('cp -a --no-preserve=ownership "${SRCROOT}/../setup-ui/."', layer)
        self.assertIn(': > "$1/etc/machine-id"', layer)
        self.assertIn(': > "$1/etc/hostname"', layer)
        self.assertIn("bluetooth.service hciuart.service", layer)
        self.assertIn("apt-daily.timer apt-daily-upgrade.timer", layer)
        self.assertIn("dtoverlay=disable-bt", layer)
        self.assertIn('scripts/image_verification.py" runtime "$1" "${SRCROOT}/qualified-runtime.json"', layer)
        self.assertIn("groupadd --system hexclave-tv-relay", layer)
        self.assertIn("--gid hexclave-tv-relay --groups hexclave-tv-runtime", layer)
        self.assertIn('rm -f "$1/var/lib/dbus/machine-id" "$1/var/lib/systemd/random-seed"', layer)
        self.assertIn("ln -s /var/lib/hexclave-tv-box/network-connections", layer)
        self.assertIn("--home-dir /var/empty/hexclave-support", layer)
        self.assertIn('install -d -m 0755 -o root -g root "$1/var/empty/hexclave-support"', layer)
        enable_line = next(line for line in layer.splitlines() if "systemctl enable" in line)
        self.assertNotIn("hexclave-tv-box-kiosk.service", enable_line)
        self.assertIn("hexclave-tv-box-network.service", enable_line)
        self.assertIn("hexclave-tv-box-relay.service", enable_line)
        self.assertIn("hexclave-tv-box-relay-identity.service", enable_line)
        build = (ROOT / "scripts/build-image.sh").read_text(encoding="utf-8")
        self.assertIn("status --porcelain --untracked-files=all", build)
        self.assertIn("HEXCLAVE_TV_BOX_TEST_IMAGE=${HEXCLAVE_TV_BOX_TEST_IMAGE:-false}", build)
        self.assertIn("true) tv_box_image_name=hexclave-tv-box-test", build)
        self.assertIn("false) tv_box_image_name=hexclave-tv-box-pilot", build)
        self.assertIn('"IGconf_image_name=$tv_box_image_name"', build)
        self.assertIn('"IGconf_tvbox_test_image=$HEXCLAVE_TV_BOX_TEST_IMAGE"', build)
        self.assertIn("# X-Env-Var-test_image-Valid: keywords:true,false", layer)
        self.assertIn('printf \'%s\\n\' \'test\' > "$1/etc/hexclave-tv-box-test-image"', layer)
        self.assertIn("sed -i 's/^StartLimitAction=reboot$/StartLimitAction=none/'", layer)

    def test_verify_image_rejects_non_regular_inputs_and_propagates_find_failures(self) -> None:
        verifier = (ROOT / "scripts/verify-image.sh").read_text(encoding="utf-8")
        self.assertIn('test -f "$rootfs/$path"', verifier)
        self.assertNotIn('test -e "$rootfs/$path"', verifier)
        self.assertIn('[ ! -f "$rootfs/etc/hexclave-tv-box-test-image" ]', verifier)
        self.assertIn("find \"$rootfs/etc/ssh\" -maxdepth 1 -name 'ssh_host_*_key'", verifier)
        self.assertIn("hexclave-support-ca.pub", verifier)
        self.assertIn('find . -xdev -type f -print0 > "$list"', verifier)
        self.assertIn('if ! (cd "$tree" && find . -xdev -type f -print0 > "$list"); then', verifier)
        self.assertIn("LC_ALL=C sort -z \"$list\" | xargs -0 -r sha256sum", verifier)
        self.assertIn("Unable to enumerate image files.", verifier)
        self.assertIn("Image root-delegated code has unexpected ownership or writability.", verifier)
        self.assertIn("! -uid 0 -o ! -gid 0 -o -perm /022", verifier)

    def test_build_image_requires_clean_builder_and_absolute_support_ca(self) -> None:
        build = (ROOT / "scripts/build-image.sh").read_text(encoding="utf-8")
        self.assertIn('git -C "$RPI_IMAGE_GEN_DIR" status --porcelain --untracked-files=all', build)
        self.assertRegex(build, r"(realpath|CDPATH=.*dirname.*pwd).*HEXCLAVE_TV_BOX_SUPPORT_CA")

    def test_image_layer_validates_support_ca_before_installing(self) -> None:
        layer = (ROOT / "image/layer/hexclave-tv-box-pilot.yaml").read_text(encoding="utf-8")
        validation = 'image_verification.py" public-key "${IGconf_tvbox_support_ca_key}"'
        self.assertIn(validation, layer)
        self.assertLess(layer.index(validation), layer.index('install -m 0644 "${IGconf_tvbox_support_ca_key}"'))

    def test_network_firewall_accepts_dhcpv6_and_extension_header_icmpv6(self) -> None:
        firewall = (ROOTFS / "etc/nftables.d/hexclave-tv-box.nft").read_text(encoding="utf-8")
        self.assertIn("udp sport 547 udp dport 546 accept", firewall)
        self.assertIn("meta l4proto ipv6-icmp accept", firewall)
        self.assertNotIn("ip6 nexthdr ipv6-icmp", firewall)

    def test_network_service_restarts_with_networkmanager(self) -> None:
        service = (ROOTFS / "etc/systemd/system/hexclave-tv-box-network.service").read_text(encoding="utf-8")
        self.assertIn("PartOf=NetworkManager.service", service)
        self.assertIn("Requires=NetworkManager.service", service)
        self.assertIn("After=NetworkManager.service", service)

    def test_relay_identity_service_only_writes_relay_directory(self) -> None:
        service = (ROOTFS / "etc/systemd/system/hexclave-tv-box-relay-identity.service").read_text(encoding="utf-8")
        firstboot = (ROOT / "src/hexclave_tv_box/firstboot.py").read_text(encoding="utf-8")
        self.assertNotIn("ExecStartPre=", service)
        self.assertIn("ReadWritePaths=/var/lib/hexclave-tv-box/relay", service)
        self.assertNotIn("ReadWritePaths=/var/lib/hexclave-tv-box\n", service)
        self.assertIn('"ssh", "relay")', firstboot)
        self.assertIn('mode = 0o750 if name == "relay" else 0o700', firstboot)

    def test_swap_source_has_distinct_name_from_genimage_output(self) -> None:
        config = (ROOT / "image/image/hexclave-tv-box-image/genimage.cfg.in.ext4").read_text(encoding="utf-8")
        pre_image = (ROOT / "image/image/hexclave-tv-box-image/pre-image.sh").read_text(encoding="utf-8")
        self.assertIn('name = "tvbox.swap.source"', config)
        self.assertIn('swap_image="${genimage_input}/tvbox.swap.source"', pre_image)
        self.assertNotIn('swap_image="${IGconf_image_outputdir}/tvbox.swap"', pre_image)

    def test_pi_zero_image_prebuilds_bounded_state_and_swap_without_runtime_repartitioning(self) -> None:
        device = (ROOT / "image/layer/hexclave-rpizero2w-armhf.yaml").read_text(encoding="utf-8")
        self.assertIn("X-Env-Layer-Requires: linux-base,rpi-device-base,rpi-linux-v7", device)
        config = (ROOT / "image/config/hexclave-tv-box-pilot.yaml").read_text(encoding="utf-8")
        image_layer = (ROOT / "image/image/hexclave-tv-box-image/image.yaml").read_text(encoding="utf-8")
        self.assertIn("layer: hexclave-tv-box-image", config)
        self.assertIn("# X-Env-Var-assetdir: ${DIRECTORY}", image_layer)
        self.assertIn("state_part_size: 1G", config)
        self.assertIn("swap_part_size: 2G", config)
        image = (ROOT / "image/image/hexclave-tv-box-image/genimage.cfg.in.ext4").read_text(encoding="utf-8")
        self.assertIn('partition-table-type = "mbr"', image)
        self.assertIn("partition tvbox-state", image)
        self.assertIn("partition tvbox-swap", image)
        self.assertIn("image state.ext4.sparse", image)
        self.assertIn("image tvbox.swap.sparse", image)
        self.assertIn("image tvbox.swap {", image)
        self.assertIn('name = "tvbox.swap.source"', image)
        setup = (ROOT / "image/image/hexclave-tv-box-image/setup.sh").read_text(encoding="utf-8")
        self.assertIn("/var/lib/hexclave-tv-box/journal /var/log/journal", setup)
        self.assertFalse((ROOTFS / "etc/systemd/system/hexclave-tv-box-storage.service").exists())
        self.assertEqual(list((ROOTFS / "etc/systemd/repart.d").glob("*.conf")), [])

    def test_image_scripts_generate_mounts_and_an_initialized_swap_image(self) -> None:
        image_root = ROOT / "image/image/hexclave-tv-box-image"
        with tempfile.TemporaryDirectory() as directory:
            temporary_root = Path(directory)
            filesystem = temporary_root / "rootfs"
            output = temporary_root / "output"
            genimage_input = temporary_root / "input"
            (filesystem / "etc").mkdir(parents=True)
            (filesystem / "boot/firmware").mkdir(parents=True)
            (filesystem / "boot/firmware/cmdline.txt").write_text("console=tty1 root=/dev/old rw\n", encoding="utf-8")
            output.mkdir()
            genimage_input.mkdir()
            (output / "tvbox_image_uuids").write_text(
                "BOOT_LABEL=1234ABCD\nBOOT_UUID=1234-ABCD\nROOT_UUID=11111111-1111-1111-1111-111111111111\n",
                encoding="utf-8",
            )
            environment = {
                **os.environ,
                "IGconf_image_outputdir": str(output),
                "IGconf_image_swap_part_size": "8M",
                "IGconf_fs_ext4_mkfs_args": "-F -b 4096",
                "IGconf_device_sector_size": "512",
                "IGconf_image_name": "test-tv-box",
                "IGconf_image_suffix": "img",
                "IGconf_image_boot_part_size": "256M",
                "IGconf_image_root_part_size": "6G",
                "IGconf_image_state_part_size": "1G",
            }
            subprocess.run(
                [str(image_root / "setup.sh"), "ROOT"],
                cwd=image_root,
                env={**environment, "IMAGEMOUNTPATH": str(filesystem)},
                check=True,
            )
            subprocess.run(
                [str(image_root / "setup.sh"), "BOOT"],
                cwd=image_root,
                env={**environment, "IMAGEMOUNTPATH": str(filesystem / "boot/firmware")},
                check=True,
            )
            subprocess.run(
                [str(image_root / "pre-image.sh"), str(filesystem), str(genimage_input)],
                cwd=image_root,
                env=environment,
                check=True,
            )
            fstab = (filesystem / "etc/fstab").read_text(encoding="utf-8")
            self.assertIn("LABEL=TVBOX_STATE", fstab)
            self.assertIn("LABEL=TVBOX_SWAP", fstab)
            self.assertIn("/var/lib/hexclave-tv-box/journal", fstab)
            self.assertIn("root=LABEL=ROOT", (filesystem / "boot/firmware/cmdline.txt").read_text(encoding="utf-8"))
            self.assertIn("partition-table-type = \"mbr\"", (genimage_input / "genimage.cfg").read_text(encoding="utf-8"))
            swap_type = subprocess.check_output(
                ["blkid", "-p", "-s", "TYPE", "-o", "value", str(genimage_input / "tvbox.swap.source")],
                text=True,
            ).strip()
            self.assertEqual(swap_type, "swap")

    def test_ssh_and_firewall_have_no_password_or_debug_access(self) -> None:
        ssh = (ROOTFS / "etc/ssh/sshd_config.d/90-hexclave-tv-box.conf").read_text(encoding="utf-8")
        self.assertIn("PasswordAuthentication no", ssh)
        self.assertIn("PermitRootLogin no", ssh)
        self.assertIn("ForceCommand", ssh)
        self.assertIn("AllowTcpForwarding no", ssh)
        self.assertIn("AuthorizedKeysFile none", ssh)
        self.assertIn("PermitTTY no", ssh)
        self.assertIn("DisableForwarding yes", ssh)
        self.assertIn("PermitUserRC no", ssh)
        self.assertIn("LogLevel VERBOSE", ssh)
        layer = (ROOT / "image/layer/hexclave-tv-box-pilot.yaml").read_text(encoding="utf-8")
        self.assertIn("useradd --system --password '*NP*'", layer)
        firewall = (ROOTFS / "etc/nftables.d/hexclave-tv-box.nft").read_text(encoding="utf-8")
        self.assertNotIn("8101", firewall)
        self.assertNotIn("8102", firewall)
        self.assertIn("chain forward", firewall)
        self.assertIn("policy drop", firewall)
        self.assertNotIn('iifname "wlan0" tcp dport 22 accept', firewall)
        self.assertIn('ip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } tcp dport 22 accept', firewall)
        self.assertIn('ip6 saddr { fc00::/7, fe80::/10 } tcp dport 22 accept', firewall)
        self.assertIn('iifname "lo" accept', firewall)
        network_service = (ROOTFS / "etc/systemd/system/hexclave-tv-box-network.service").read_text(encoding="utf-8")
        for directive in (
            "NoNewPrivileges=yes",
            "ProtectKernelModules=yes",
            "ProtectKernelTunables=yes",
            "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
        ):
            self.assertIn(directive, network_service)

    def test_image_verifier_rejects_initialized_state_and_hashes_the_disk_image(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary_root = Path(directory)
            image = temporary_root / "tv-box.img"
            rootfs = temporary_root / "rootfs"
            state = temporary_root / "state"
            boot = temporary_root / "boot"
            manifest = temporary_root / "builder-manifest.tsv"
            output = temporary_root / "verification"
            boot.mkdir()
            make_raw_image(image)
            for path in (
                "usr/lib/hexclave-tv-box/kiosk-launch",
                "usr/lib/hexclave-tv-box/relay-enroll",
                "usr/lib/hexclave-tv-box/factory-reset-job",
                "usr/lib/python3/dist-packages/hexclave_tv_box/relay.py",
                "usr/lib/python3/dist-packages/hexclave_tv_box/relay_metrics.py",
                "usr/lib/python3/dist-packages/hexclave_tv_box/kiosk_supervisor.py",
                "usr/lib/python3/dist-packages/hexclave_tv_box/network_agent.py",
                "usr/lib/python3/dist-packages/hexclave_tv_box/setup_display.py",
                "etc/systemd/system/hexclave-tv-box-kiosk.service",
                "etc/systemd/system/hexclave-tv-box-relay.service",
                "etc/systemd/system/hexclave-tv-box-relay-identity.service",
                "etc/systemd/system/hexclave-tv-box-network.service",
                "etc/systemd/system/hexclave-tv-box-setup-display.service",
                "etc/systemd/system/hexclave-tv-box-setup.service",
                "etc/pam.d/hexclave-tv-box-kiosk",
                "etc/hexclave-tv-box-release",
            ):
                target = rootfs / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(
                    (
                        "image-channel=production\n"
                        if path == "etc/hexclave-tv-box-release"
                        else (
                            "wayland_runtime_dir=/run/hexclave-tv-box-wayland\n"
                            'export XDG_RUNTIME_DIR="$wayland_runtime_dir"\n'
                            "unset DBUS_SESSION_BUS_ADDRESS\n"
                            "export XCURSOR_PATH=/usr/share/hexclave-tv-box/cursors\n"
                            "hexclave_tv_box.kiosk_supervisor\n"
                        )
                        if path == "usr/lib/hexclave-tv-box/kiosk-launch"
                        else '"--platform=wl"\nenable_child_subreaper()\nsignal.pidfd_send_signal\nrequire_document_load=True\n'
                        if path == "usr/lib/python3/dist-packages/hexclave_tv_box/kiosk_supervisor.py"
                        else (
                            "Environment=WLR_LIBINPUT_NO_DEVICES=1\n"
                            "Environment=XDG_RUNTIME_DIR=/run/hexclave-tv-box-wayland\n"
                            "TimeoutStopSec=20\n"
                            "KillMode=control-group\n"
                            "StartLimitAction=reboot\n"
                            "StartLimitIntervalSec=15min\n"
                            "StartLimitBurst=5\n"
                        )
                        if path == "etc/systemd/system/hexclave-tv-box-kiosk.service"
                        else "StartLimitAction=reboot\n"
                        if path.startswith("etc/systemd/system/hexclave-tv-box-") and path.endswith(".service")
                        else "fixture\n"
                    ),
                    encoding="utf-8",
                )
            make_verification_fixture(rootfs, manifest)
            cursor_asset.install_cursor(rootfs)
            support = rootfs / "usr/lib/hexclave-tv-box/support"
            support.write_text("support\n", encoding="utf-8")
            (rootfs / "etc/sudoers.d").mkdir(parents=True)
            (rootfs / "etc/machine-id").write_text("", encoding="utf-8")
            (rootfs / "var/lib/hexclave-tv-box/network-connections").mkdir(parents=True)
            (rootfs / "etc/NetworkManager").mkdir(parents=True)
            (rootfs / "etc/NetworkManager/system-connections").symlink_to(
                "/var/lib/hexclave-tv-box/network-connections",
                target_is_directory=True,
            )
            (state / "journal").mkdir(parents=True)
            (state / "lost+found").mkdir()
            (state / "network-connections").mkdir()

            command = [str(ROOT / "scripts/verify-image.sh"), str(image), str(rootfs), str(state), str(boot), str(manifest), str(output)]
            environment = mount_command_environment(image, rootfs, state, temporary_root, boot=boot)
            environment.update(
                HEXCLAVE_TV_BOX_TEST_ROOT_UID=str(os.getuid()),
                HEXCLAVE_TV_BOX_TEST_ROOT_GID=str(os.getgid()),
            )
            ownership_find = Path(environment["PATH"].split(":", maxsplit=1)[0]) / "find"
            ownership_find.write_text(
                "#!/usr/bin/env python3\n"
                "import os\n"
                "import sys\n"
                "arguments = sys.argv[1:]\n"
                "for index in range(len(arguments) - 1):\n"
                "    if arguments[index] == '-uid' and arguments[index + 1] == '0':\n"
                "        arguments[index + 1] = os.environ['HEXCLAVE_TV_BOX_TEST_ROOT_UID']\n"
                "    elif arguments[index] == '-gid' and arguments[index + 1] == '0':\n"
                "        arguments[index + 1] = os.environ['HEXCLAVE_TV_BOX_TEST_ROOT_GID']\n"
                "os.execv('/usr/bin/find', ['find', *arguments])\n",
                encoding="utf-8",
            )
            ownership_find.chmod(0o755)

            def run_verifier(run_environment: dict[str, str] = environment) -> subprocess.CompletedProcess[str]:
                return subprocess.run(command, env=run_environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

            accepted = run_verifier()
            self.assertEqual(accepted.returncode, 0, accepted.stdout)
            self.assertIn("tv-box.img", (output / "disk-image-sha256.txt").read_text(encoding="utf-8"))
            for manifest_name in ("rootfs-sha256.txt", "state-sha256.txt", "boot-sha256.txt"):
                manifest_lines = (output / manifest_name).read_text(encoding="utf-8").splitlines()
                manifest_paths = [line.split("  ", maxsplit=1)[1] for line in manifest_lines]
                self.assertEqual(manifest_paths, sorted(manifest_paths), manifest_name)

            support.chmod(0o775)
            rejected_writable = run_verifier()
            self.assertNotEqual(rejected_writable.returncode, 0)
            self.assertIn("Image root-delegated code has unexpected ownership or writability.", rejected_writable.stdout)
            support.chmod(0o755)
            rejected_uid_environment = {**environment, "HEXCLAVE_TV_BOX_TEST_ROOT_UID": str(os.getuid() + 1)}
            rejected_uid = run_verifier(rejected_uid_environment)
            self.assertNotEqual(rejected_uid.returncode, 0)
            self.assertIn("Image root-delegated code has unexpected ownership or writability.", rejected_uid.stdout)
            rejected_gid_environment = {**environment, "HEXCLAVE_TV_BOX_TEST_ROOT_GID": str(os.getgid() + 1)}
            rejected_gid = run_verifier(rejected_gid_environment)
            self.assertNotEqual(rejected_gid.returncode, 0)
            self.assertIn("Image root-delegated code has unexpected ownership or writability.", rejected_gid.stdout)

            relative_cwd = temporary_root / "relative-output-cwd"
            relative_cwd.mkdir()
            relative_output = "verification-relative"
            relative_command = [*command[:-1], relative_output]
            relative_result = subprocess.run(
                relative_command,
                cwd=relative_cwd,
                env=environment,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            self.assertEqual(relative_result.returncode, 0, relative_result.stdout)
            for manifest_name in ("rootfs-sha256.txt", "state-sha256.txt", "boot-sha256.txt"):
                self.assertTrue((relative_cwd / relative_output / manifest_name).is_file(), manifest_name)
            unexpected_rootfs_outputs = [
                path
                for path in rootfs.rglob("*")
                if "manifest" in path.name or path.name.endswith(".sha256")
            ]
            self.assertEqual(unexpected_rootfs_outputs, [])

            marker = rootfs / "etc/hexclave-tv-box-test-image"
            marker.write_text("test\n", encoding="utf-8")
            rejected_production_marker = run_verifier()
            self.assertNotEqual(rejected_production_marker.returncode, 0)
            self.assertIn("Production image contains", rejected_production_marker.stdout)
            marker.unlink()

            make_verification_fixture(rootfs, manifest, channel="test")
            rejected_missing_test_marker = run_verifier()
            self.assertNotEqual(rejected_missing_test_marker.returncode, 0)
            self.assertIn("missing its build-time", rejected_missing_test_marker.stdout)
            marker.write_text("test\n", encoding="utf-8")
            rejected_test_reboot = run_verifier()
            self.assertNotEqual(rejected_test_reboot.returncode, 0)
            self.assertIn("test-channel restart-limit action", rejected_test_reboot.stdout)
            for service in (
                "hexclave-tv-box-kiosk.service",
                "hexclave-tv-box-network.service",
                "hexclave-tv-box-setup-display.service",
                "hexclave-tv-box-setup.service",
            ):
                service_path = rootfs / "etc/systemd/system" / service
                service_path.write_text(
                    service_path.read_text(encoding="utf-8").replace(
                        "StartLimitAction=reboot",
                        "StartLimitAction=none",
                    ),
                    encoding="utf-8",
                )
            accepted = run_verifier()
            self.assertEqual(accepted.returncode, 0, accepted.stdout)
            marker.unlink()
            make_verification_fixture(rootfs, manifest)
            for service in (
                "hexclave-tv-box-kiosk.service",
                "hexclave-tv-box-network.service",
                "hexclave-tv-box-setup-display.service",
                "hexclave-tv-box-setup.service",
            ):
                service_path = rootfs / "etc/systemd/system" / service
                service_path.write_text(
                    service_path.read_text(encoding="utf-8").replace(
                        "StartLimitAction=none",
                        "StartLimitAction=reboot",
                    ),
                    encoding="utf-8",
                )

            saved_network = state / "network-connections/customer.nmconnection"
            saved_network.write_text("[connection]\n", encoding="utf-8")
            rejected_network = run_verifier()
            self.assertNotEqual(rejected_network.returncode, 0)
            self.assertIn("saved customer network", rejected_network.stdout)
            saved_network.unlink()

            (state / "identity").mkdir()
            (state / "identity/device-id").write_text("cloned", encoding="utf-8")
            rejected = run_verifier()
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("initialized device data", rejected.stdout)

            identity_path = state / "identity/device-id"
            identity_path.unlink()
            (state / "identity").rmdir()
            required_path = rootfs / "etc/pam.d/hexclave-tv-box-kiosk"
            required_contents = required_path.read_text(encoding="utf-8")

            required_path.unlink()
            required_path.mkdir()
            rejected_directory = run_verifier()
            self.assertNotEqual(rejected_directory.returncode, 0)
            required_path.rmdir()
            required_path.write_text(required_contents, encoding="utf-8")

            required_path.unlink()
            required_path.symlink_to(rootfs / "etc/hexclave-tv-box-release")
            rejected_symlink = run_verifier()
            self.assertNotEqual(rejected_symlink.returncode, 0)
            required_path.unlink()
            required_path.write_text(required_contents, encoding="utf-8")

            host_key = rootfs / "etc/ssh/ssh_host_ed25519_key"
            host_key.symlink_to(rootfs / "etc/hexclave-tv-box-release")
            rejected_host_key = run_verifier()
            self.assertNotEqual(rejected_host_key.returncode, 0)
            self.assertIn("pre-generated SSH host keys", rejected_host_key.stdout)
            host_key.unlink()

            failing_tools = temporary_root / "failing-tools"
            failing_tools.mkdir()
            fake_find = failing_tools / "find"
            fake_find.write_text(
                "#!/bin/sh\n"
                "case \"$*\" in\n"
                "  *ssh_host_*_key*) exit 1 ;;\n"
                f"  *) exec \"{ownership_find}\" \"$@\" ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            fake_find.chmod(0o755)
            failing_environment = {**environment, "PATH": f"{failing_tools}:{environment['PATH']}"}
            rejected_find = subprocess.run(
                command,
                env=failing_environment,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            self.assertNotEqual(rejected_find.returncode, 0)
            self.assertIn("Unable to", rejected_find.stdout)

    def test_pilot_document_keeps_phase_two_gates_explicit(self) -> None:
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        for gate in ("read-only-root", "signed image", "physical customer reset", "full GA fault-injection"):
            self.assertIn(gate, readme)
        self.assertIn("72-hour", readme)
        runbook = (ROOT / "PILOT_RUNBOOK.md").read_text(encoding="utf-8")
        for gate in ("Cold boot", "Unpair", "five controlled abrupt power cuts", "10 continuous hours"):
            self.assertIn(gate, runbook)

    def test_customer_wifi_retry_guidance_is_in_the_runbook(self) -> None:
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("[PILOT_RUNBOOK.md](PILOT_RUNBOOK.md)", readme)
        content = (ROOT / "PILOT_RUNBOOK.md").read_text(encoding="utf-8")
        for instruction in (
            "incorrect **hotspot password**",
            "incorrect **destination Wi-Fi password**",
            "1–2 minutes",
            "same hotspot name and a **new per-session password**",
            "forget only the saved",
            "http://10.42.0.1",
        ):
            self.assertIn(instruction, content)

    def test_public_document_links_do_not_depend_on_local_reference_files(self) -> None:
        for document in ("README.md", "PILOT_RUNBOOK.md"):
            content = (ROOT / document).read_text(encoding="utf-8")
            for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", content):
                if target.startswith(("https://", "http://", "#")):
                    continue
                path = ROOT / target.split("#", 1)[0]
                self.assertTrue(path.is_file(), f"Broken link in {document}: {target}")


if __name__ == "__main__":
    unittest.main()
