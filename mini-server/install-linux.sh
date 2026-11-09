#!/bin/sh
# To Doom — встановлення сервера на liakh-server (Linux) як systemd-сервісу
# Запуск:  sudo sh install-linux.sh
set -e

APP_DIR="/opt/to-doom"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-$(whoami)}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не знайдено. Встановлюю Node.js 20..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    echo "Встановіть Node.js 18+ вручну та запустіть скрипт знову."
    exit 1
  fi
fi

mkdir -p "$APP_DIR"
cp -r "$SRC_DIR"/server.js "$SRC_DIR"/mcp-server.js "$SRC_DIR"/package.json "$SRC_DIR"/public "$APP_DIR"/
mkdir -p "$APP_DIR/data"
chown -R "$RUN_USER" "$APP_DIR"

cd "$APP_DIR"
sudo -u "$RUN_USER" npm install --omit=dev

cat > /etc/systemd/system/to-doom.service <<EOF
[Unit]
Description=To Doom sync server
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=PORT=3456
Environment=TODOOM_SERVER=
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now to-doom.service

if command -v ufw >/dev/null 2>&1; then
  ufw allow in on tailscale0 to any port 3456 proto tcp || true
fi

echo ""
echo "Готово! To Doom працює на:"
echo "  http://100.101.231.78:3456"
echo "  http://liakh-server.tail2f1f7e.ts.net:3456"
echo "Статус:  systemctl status to-doom"

