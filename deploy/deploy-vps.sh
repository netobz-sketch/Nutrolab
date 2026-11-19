#!/usr/bin/env bash
# Deploy do NutroLab na VPS (host ssh "vps-clinica", stack em /srv/clinica).
# Só envia o código, constrói a imagem e (re)sobe o serviço `nutrolab`.
# NÃO altera docker-compose.yml, Caddyfile nem db-init: esses arquivos vêm do
# repo clinica-api/deploy (dono: aba 6d). O serviço `nutrolab` precisa já existir lá.
#   ./deploy/deploy-vps.sh            → rsync + build + up
#   ./deploy/deploy-vps.sh --build-only → rsync + build (não reinicia o serviço)
set -euo pipefail
HOST_SSH="${HOST_SSH:-vps-clinica}"
STACK=/srv/clinica
SRC="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ONLY=0
[ "${1:-}" = "--build-only" ] && BUILD_ONLY=1

echo "== enviando código =="
rsync -a --delete --exclude node_modules --exclude dist --exclude data --exclude .env --exclude .git "$SRC/" "$HOST_SSH:$STACK/build/nutrolab/"

ssh "$HOST_SSH" "BUILD_ONLY=$BUILD_ONLY bash -s" <<'REMOTE'
set -euo pipefail
cd /srv/clinica
grep -q '^  nutrolab:' docker-compose.yml || { echo "serviço nutrolab ausente do docker-compose.yml (adicione pelo repo clinica-api/deploy)"; exit 1; }
echo "== build =="
docker build -q -t nutrolab:local build/nutrolab
if [ "$BUILD_ONLY" = "1" ]; then echo "== build-only: serviço não reiniciado =="; exit 0; fi
echo "== subir =="
docker compose up -d nutrolab
sleep 5
docker compose ps nutrolab --format "table {{.Name}}\t{{.Status}}"
REMOTE
