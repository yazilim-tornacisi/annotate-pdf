#!/usr/bin/env bash
set -e

# Eski container'ı temizle (varsa)
if docker ps -a --format '{{.Names}}' | grep -q '^annotate-pdf$'; then
  echo "Eski container temizleniyor..."
  docker rm -f annotate-pdf 2>/dev/null || true
fi

echo "Build ve başlatılıyor..."
docker compose up --build -d

echo ""
echo "✔ Uygulama hazır: http://localhost:3003"
docker ps --filter name=annotate-pdf --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
