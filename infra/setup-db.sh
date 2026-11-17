#!/bin/bash
set -euo pipefail
umask 077
SQLD_VERSION=0.24.32
CLOUDFLARED_VERSION=2026.11.0
install -d -m 700 /root/lembed-secrets /root/lembed-downloads
cd /root/lembed-downloads
asset="libsql-server-x86_64-unknown-linux-gnu.tar.xz"
curl -fsSLo "$asset" "https://github.com/tursodatabase/libsql/releases/download/libsql-server-v$SQLD_VERSION/$asset"
curl -fsSLo "$asset.sha256" "https://github.com/tursodatabase/libsql/releases/download/libsql-server-v$SQLD_VERSION/$asset.sha256"
python3 - <<'PY'
from pathlib import Path
import hashlib
name = 'libsql-server-x86_64-unknown-linux-gnu.tar.xz'
expected = Path(name + '.sha256').read_text().split()[0]
if hashlib.sha256(Path(name).read_bytes()).hexdigest() != expected:
    raise SystemExit('libsql checksum mismatch')
PY
tar -xJf "$asset"
binary=$(find . -type f -name sqld -o -type f -name libsql-server | head -1)
test -n "$binary"
install -m 755 "$binary" /usr/local/bin/sqld
curl -fsSLo cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-amd64.deb"
printf '%s  %s\n' '5305dbaf62984e92e7daa29cdd6a35a4797edc23385d4c5b8422ff97eb96a19b' cloudflared.deb | sha256sum -c -
dpkg -i cloudflared.deb >/dev/null
id sqld >/dev/null 2>&1 || useradd --system --home /var/lib/sqld --shell /usr/sbin/nologin sqld
id cloudflared >/dev/null 2>&1 || useradd --system --home /var/lib/cloudflared --shell /usr/sbin/nologin cloudflared
install -d -o sqld -g sqld -m 750 /etc/sqld /var/lib/sqld
install -d -o root -g cloudflared -m 750 /etc/cloudflared
install -d -o cloudflared -g cloudflared -m 750 /var/lib/cloudflared
if test -s /etc/cloudflared/tunnel-token; then
    chown root:cloudflared /etc/cloudflared/tunnel-token
    chmod 640 /etc/cloudflared/tunnel-token
fi
python3 - <<'PY'
import base64, json, os
from pathlib import Path
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
os.umask(0o077)
private = Path('/root/lembed-secrets/db-signing-key.pem')
if private.exists():
    key = serialization.load_pem_private_key(private.read_bytes(), password=None)
else:
    key = Ed25519PrivateKey.generate()
    private.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
Path('/etc/sqld/jwt-public.pem').write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
encode = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=')
# scoped to default namespace, write access; revoke by replacing server public key.
header = encode(json.dumps({'alg':'EdDSA','typ':'JWT'},separators=(',',':')).encode())
payload = encode(json.dumps({'id':'default','a':'rw'},separators=(',',':')).encode())
message = header + b'.' + payload
token = message + b'.' + encode(key.sign(message))
token_file = Path('/root/lembed-secrets/db-auth-token')
token_file.write_bytes(token + b'\n')
env_file = Path('/root/lembed-secrets/.env')
if not env_file.exists():
    from urllib.parse import urlsplit
    database_url = os.environ.get('DATABASE_URL', 'https://lembed-db.ryana.dev')
    public_origin = os.environ.get('PUBLIC_ORIGIN', 'https://linkbed.me')
    for value in [database_url, public_origin]:
        if urlsplit(value).scheme not in ['http', 'https'] or any(char in value for char in '\r\n"'):
            raise SystemExit('invalid deployment url')
    env_file.write_text('DATABASE_URL="' + database_url + '"\nDATABASE_AUTH_TOKEN="' + token.decode() + '"\nPUBLIC_ORIGIN="' + public_origin + '"\n')
    env_file.chmod(0o600)
PY
chown root:sqld /etc/sqld/jwt-public.pem
chmod 640 /etc/sqld/jwt-public.pem
cat > /etc/systemd/system/lembed-db.service <<'UNIT'
[Unit]
Description=lembed authenticated libsql database
After=network.target
[Service]
Type=simple
User=sqld
Group=sqld
WorkingDirectory=/var/lib/sqld
ExecStart=/usr/local/bin/sqld --db-path /var/lib/sqld/data.sqld --http-listen-addr 127.0.0.1:8080 --auth-jwt-key-file /etc/sqld/jwt-public.pem --no-welcome
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
ReadWritePaths=/var/lib/sqld
MemoryMax=512M
TasksMax=128
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/cloudflared.service <<'UNIT'
[Unit]
Description=lembed database Cloudflare Tunnel
After=network-online.target lembed-db.service
Wants=network-online.target
[Service]
Type=simple
User=cloudflared
Group=cloudflared
ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel --metrics 127.0.0.1:2000 run --token-file /etc/cloudflared/tunnel-token
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
ReadWritePaths=/var/lib/cloudflared
MemoryMax=256M
TasksMax=128
[Install]
WantedBy=multi-user.target
UNIT
install -d -m 700 /var/backups/lembed
cat > /usr/local/sbin/lembed-db-backup <<'BACKUP'
#!/bin/sh
set -eu
umask 077
source=/var/lib/sqld/data.sqld/dbs/default/data
test -f "$source"
destination="/var/backups/lembed/cards-$(date -u +%Y%m%d-%H%M%S).sqlite"
sqlite3 "$source" ".backup '$destination'"
find /var/backups/lembed -name 'cards-*.sqlite' -mtime +7 -delete
BACKUP
chmod 750 /usr/local/sbin/lembed-db-backup
cat > /etc/systemd/system/lembed-db-backup.service <<'UNIT'
[Unit]
Description=lembed consistent local database backup
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/lembed-db-backup
UMask=0077
UNIT
cat > /etc/systemd/system/lembed-db-backup.timer <<'UNIT'
[Unit]
Description=lembed daily database backup
[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=20m
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now lembed-db
systemctl enable --now lembed-db-backup.timer
test -s /etc/cloudflared/tunnel-token && systemctl enable --now cloudflared
/usr/local/bin/sqld --version
/usr/bin/cloudflared --version
systemctl is-active lembed-db
ss -lnt | head -10
