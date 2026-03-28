#!/usr/bin/env bash
# FreeRAID Plugin: filebrowser — uninstall

COMPOSE_DIR="/etc/freeraid/compose"
COMPOSE_FILE="$COMPOSE_DIR/filebrowser.docker-compose.yml"

if [ -f "$COMPOSE_FILE" ]; then
    cd "$COMPOSE_DIR"
    docker compose -f filebrowser.docker-compose.yml down 2>/dev/null || \
      docker-compose -f filebrowser.docker-compose.yml down 2>/dev/null || true
    rm -f "$COMPOSE_FILE"
fi

echo "File Browser removed."
