#!/usr/bin/env bash
# FreeRAID Plugin: filebrowser
# Installs File Browser as a docker-compose service

set -euo pipefail

COMPOSE_DIR="/etc/freeraid/compose"
COMPOSE_FILE="$COMPOSE_DIR/filebrowser.docker-compose.yml"

mkdir -p "$COMPOSE_DIR"

cat > "$COMPOSE_FILE" <<'EOF'
version: "3"
services:
  filebrowser:
    image: filebrowser/filebrowser:latest
    container_name: filebrowser
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - /mnt/user:/srv
      - /etc/freeraid/plugins/filebrowser/data:/database
    environment:
      - PUID=0
      - PGID=0
EOF

mkdir -p "${PLUGIN_INSTALL_DIR:-/etc/freeraid/plugins/filebrowser}/data"

# Start the container
cd "$COMPOSE_DIR"
docker compose -f filebrowser.docker-compose.yml up -d 2>/dev/null || \
  docker-compose -f filebrowser.docker-compose.yml up -d 2>/dev/null || true

echo "File Browser installed. Access at http://$(hostname -I | awk '{print $1}'):8080"
echo "Default login: admin / admin (change immediately)"
