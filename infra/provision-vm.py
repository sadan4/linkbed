#!/usr/bin/env python3
"""run on chrysalis; creates only vm 109 and its own network rules."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess

os.umask(0o077)
lock = open("/run/lembed-db-provision.lock", "w")
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
VMID, NAME, IP = 109, "lembed-db", "10.203.0.50"
base = Path("/root/lembed-db")
image = Path("/var/lib/vz/template/cloud-images/noble-server-cloudimg-amd64.img")
snippets = Path("/var/lib/vz/snippets")

def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)

if any(Path(p).exists() for p in [f"/etc/pve/qemu-server/{VMID}.conf", f"/etc/pve/lxc/{VMID}.conf"]):
    raise SystemExit("refusing: vm id already exists")
if any((snippets / f"{NAME}-{kind}.yaml").exists() for kind in ["user", "network", "meta"]):
    raise SystemExit("refusing: cloud-init snippets already exist")
if subprocess.run(["ping", "-c", "1", "-W", "1", IP], capture_output=True).returncode == 0:
    raise SystemExit("refusing: address already responds")
checksum = next(line.split()[0] for line in (image.parent / "SHA256SUMS").read_text().splitlines() if line.split()[-1].lstrip("*") == image.name)
with image.open("rb") as stream:
    if hashlib.file_digest(stream, "sha256").hexdigest() != checksum:
        raise SystemExit("cloud image checksum mismatch")
base.mkdir(exist_ok=True)
keys = [(base / "admin.pub").read_text().strip(), Path("/root/.ssh/id_rsa.pub").read_text().strip()]
cloud = {
    "hostname": NAME, "manage_etc_hosts": True, "disable_root": True, "ssh_pwauth": False,
    "users": [{"name": "ops", "groups": ["sudo"], "sudo": "ALL=(ALL) NOPASSWD:ALL",
               "shell": "/bin/bash", "lock_passwd": True, "ssh_authorized_keys": keys}],
    "package_update": True, "package_upgrade": True,
    "packages": ["qemu-guest-agent", "curl", "ca-certificates", "ufw", "unattended-upgrades", "python3-cryptography", "sqlite3"],
    "write_files": [
        {"path": "/etc/ssh/sshd_config.d/00-lembed.conf", "permissions": "0644",
         "content": "PermitRootLogin no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nX11Forwarding no\nAllowUsers ops\n"},
        {"path": "/etc/sysctl.d/90-lembed.conf", "permissions": "0644",
         "content": "net.ipv4.conf.all.rp_filter=1\nnet.ipv4.conf.default.rp_filter=1\nnet.ipv4.conf.all.accept_redirects=0\nnet.ipv4.conf.all.send_redirects=0\nnet.ipv4.conf.default.accept_source_route=0\nnet.ipv6.conf.all.disable_ipv6=1\nnet.ipv6.conf.default.disable_ipv6=1\n"},
        {"path": "/etc/apt/apt.conf.d/20auto-upgrades", "permissions": "0644",
         "content": 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n'},
    ],
    "runcmd": [
        ["systemctl", "enable", "--now", "qemu-guest-agent"],
        ["sysctl", "--system"],
        ["ufw", "default", "deny", "incoming"],
        ["ufw", "default", "allow", "outgoing"],
        ["ufw", "allow", "from", "10.203.0.1", "to", "any", "port", "22", "proto", "tcp"],
        ["ufw", "deny", "out", "to", "10.0.0.0/8"],
        ["ufw", "deny", "out", "to", "172.16.0.0/12"],
        ["ufw", "deny", "out", "to", "192.168.0.0/16"],
        ["ufw", "deny", "out", "to", "169.254.0.0/16"],
        ["ufw", "deny", "out", "to", "100.64.0.0/10"],
        ["ufw", "--force", "enable"],
        ["systemctl", "restart", "ssh"],
    ]
}
network = {"version": 2, "ethernets": {"ens18": {
    "match": {"macaddress": "02:00:00:00:03:6d"}, "set-name": "ens18",
    "dhcp4": False, "dhcp6": False, "accept-ra": False,
    "addresses": [IP + "/24"], "routes": [{"to": "default", "via": "10.203.0.1"}],
    "nameservers": {"addresses": ["1.1.1.1", "9.9.9.9"]}
}}}
(snippets / f"{NAME}-user.yaml").write_text("#cloud-config\n" + json.dumps(cloud) + "\n")
(snippets / f"{NAME}-network.yaml").write_text(json.dumps(network) + "\n")
(snippets / f"{NAME}-meta.yaml").write_text(f"instance-id: {NAME}-{VMID}\nlocal-hostname: {NAME}\n")
nat = ["#!/bin/sh", "set -eu", '[ "${IFACE:-vmbr1}" = vmbr1 ] || exit 0']
for table, rule in [
    ([], ["FORWARD", "-i", "vmbr1", "-o", "vmbr0", "-s", IP + "/32", "-j", "ACCEPT"]),
    ([], ["FORWARD", "-i", "vmbr0", "-o", "vmbr1", "-d", IP + "/32", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"]),
    (["-t", "nat"], ["POSTROUTING", "-s", IP + "/32", "-o", "vmbr0", "-j", "MASQUERADE"]),
]:
    command = shlex.join(["iptables", *table])
    args = shlex.join(rule)
    nat.append(f"{command} -C {args} 2>/dev/null || {command} -A {args}")
hook = Path("/etc/network/if-up.d/lembed-db-nat")
hook.write_text("\n".join(nat) + "\n")
hook.chmod(0o755)
run([str(hook)])
run(["qm", "create", str(VMID), "--name", NAME, "--memory", "1024", "--balloon", "0",
     "--cores", "1", "--sockets", "1", "--cpu", "host", "--net0", "virtio=02:00:00:00:03:6d,bridge=vmbr1",
     "--scsihw", "virtio-scsi-single", "--agent", "enabled=1", "--serial0", "socket", "--vga", "serial0",
     "--ostype", "l26", "--onboot", "1", "--startup", "order=30", "--description", "lembed libsql database; private guest; Cloudflare Tunnel only"])
run(["qm", "set", str(VMID), "--scsi0", f"nvme-zfs:0,import-from={image},discard=on,ssd=1,iothread=1"], stdout=subprocess.DEVNULL)
run(["qm", "resize", str(VMID), "scsi0", "16G"])
run(["qm", "set", str(VMID), "--ide2", "local-lvm:cloudinit", "--boot", "order=scsi0",
     "--cicustom", f"user=local:snippets/{NAME}-user.yaml,network=local:snippets/{NAME}-network.yaml,meta=local:snippets/{NAME}-meta.yaml"])
run(["qm", "start", str(VMID)])
print(f"created vm {VMID}: {NAME}, {IP}, 1 vcpu, 1024 mib, 16 gib", flush=True)
