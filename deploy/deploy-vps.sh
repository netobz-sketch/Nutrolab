#!/usr/bin/env bash
# Deploy do NutroLab na VPS (host ssh "vps-clinica", stack em /srv/clinica).
# 1ª execução: acrescenta serviço ao compose, bloco ao Caddyfile e variáveis ao .env.
# Execuções seguintes: só reconstrói a imagem e reinicia o serviço.
# Sempre (idempotente): garante NUTROLAB_INTEGRATION_TOKEN no .env, INTEGRATION_TOKEN
# no serviço e o bloqueio público de /api/integration/* no Caddyfile (API do LN Evolution
# só pela rede interna do Docker); recarrega o Caddy se o Caddyfile mudou.
set -euo pipefail
HOST_SSH="${HOST_SSH:-vps-clinica}"
STACK=/srv/clinica
SRC="$(cd "$(dirname "$0")/.." && pwd)"

echo "== enviando código =="
rsync -a --delete --exclude node_modules --exclude dist --exclude data --exclude .env --exclude .git "$SRC/" "$HOST_SSH:$STACK/build/nutrolab/"

ssh "$HOST_SSH" "NUTROLAB_ADMIN_EMAIL='${NUTROLAB_ADMIN_EMAIL:-}' NUTROLAB_ADMIN_NAME='${NUTROLAB_ADMIN_NAME:-Administrador}' NUTROLAB_ADMIN_PASSWORD='${NUTROLAB_ADMIN_PASSWORD:-}' bash -s" <<'REMOTE'
set -euo pipefail
cd /srv/clinica
if ! grep -q '^NUTROLAB_HOST=' .env; then
  echo "== primeira instalação: .env, compose, Caddyfile =="
  IP=$(curl -s4 ifconfig.me || hostname -I | awk '{print $1}')
  FQDN=$(hostname -f 2>/dev/null || true)
  {
    echo ""
    echo "# --- NutroLab --------------------------------------------------------------"
    # VPS Hostinger publica *.srvNNN.hstgr.cloud -> IP da VPS; senão, sslip.io
    if [[ "$FQDN" == *.hstgr.cloud ]]; then echo "NUTROLAB_HOST=nutrolab.$FQDN"; else echo "NUTROLAB_HOST=nutrolab.${IP//./-}.sslip.io"; fi
    echo "NUTROLAB_SESSION_SECRET=$(openssl rand -hex 32)"
    echo "NUTROLAB_ADMIN_EMAIL=${NUTROLAB_ADMIN_EMAIL:-}"
    echo "NUTROLAB_ADMIN_NAME=${NUTROLAB_ADMIN_NAME:-Administrador}"
    echo "NUTROLAB_ADMIN_PASSWORD=${NUTROLAB_ADMIN_PASSWORD:-}"
    echo "NUTROLAB_ANTHROPIC_MODEL=claude-opus-5-5"
  } >> .env
  cp docker-compose.yml "docker-compose.yml.bak-$(date +%Y%m%d%H%M)"
  cp Caddyfile "Caddyfile.bak-$(date +%Y%m%d%H%M)"
  # serviço antes de "networks:" (nível raiz)
  python3 - <<'PY'
import re
p='docker-compose.yml'; s=open(p).read()
frag=open('build/nutrolab/deploy/compose.nutrolab.yml').read().split('\n',2)[2]
if '  nutrolab:' not in s:
    s=s.replace('\nnetworks:\n', '\n'+frag.rstrip('\n')+'\n\nnetworks:\n',1)
if 'NUTROLAB_HOST: ${NUTROLAB_HOST}' not in s:
    s=s.replace('      AUTH_HOST: ${AUTH_HOST}\n','      AUTH_HOST: ${AUTH_HOST}\n      NUTROLAB_HOST: ${NUTROLAB_HOST}\n',1)
open(p,'w').write(s)
c='Caddyfile'; t=open(c).read()
if '{$NUTROLAB_HOST}' not in t:
    t=t.rstrip('\n')+'\n\n'+open('build/nutrolab/deploy/Caddyfile.nutrolab').read().split('\n',2)[2]
open(c,'w').write(t)
PY
  mkdir -p nutrolab-data
  docker compose config -q
fi
# variáveis de shell venceriam o .env na interpolação do compose; a partir daqui só o .env manda
unset NUTROLAB_ADMIN_EMAIL NUTROLAB_ADMIN_NAME NUTROLAB_ADMIN_PASSWORD
echo "== integração LN Evolution (idempotente) =="
if ! grep -q '^NUTROLAB_INTEGRATION_TOKEN=' .env; then
  echo "NUTROLAB_INTEGRATION_TOKEN=\"$(openssl rand -hex 32)\"" >> .env
  echo "token de integração gerado no .env"
fi
CADDY_BEFORE=$(md5sum Caddyfile | cut -d' ' -f1)
python3 - <<'PY'
import shutil, time
ts=time.strftime('%Y%m%d%H%M')
p='docker-compose.yml'; s=open(p).read()
line='      INTEGRATION_TOKEN: ${NUTROLAB_INTEGRATION_TOKEN:-}\n'
anchor='      APP_URL: https://${NUTROLAB_HOST}\n'
if line not in s and anchor in s:
    shutil.copy(p, f'{p}.bak-{ts}')
    s=s.replace(anchor, anchor+line, 1)
    open(p,'w').write(s)
    print('compose: INTEGRATION_TOKEN acrescentado ao serviço nutrolab')
c='Caddyfile'; t=open(c).read()
start=t.find('{$NUTROLAB_HOST} {')
if start!=-1 and '@integ path /api/integration/*' not in t:
    rp=t.find('\treverse_proxy nutrolab:8090', start)
    if rp!=-1:
        shutil.copy(c, f'{c}.bak-{ts}')
        t=t[:rp]+'\t@integ path /api/integration/*\n\trespond @integ 404\n'+t[rp:]
        open(c,'w').write(t)
        print('Caddyfile: /api/integration/* bloqueado no host público')
PY
docker compose config -q
CADDY_AFTER=$(md5sum Caddyfile | cut -d' ' -f1)
echo "== build =="
docker build -q -t nutrolab:local build/nutrolab
echo "== subir =="
docker compose up -d nutrolab
if [[ "$CADDY_BEFORE" != "$CADDY_AFTER" ]]; then
  echo "== Caddyfile mudou: recarregando o Caddy =="
  docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
fi
if ! docker compose exec caddy printenv NUTROLAB_HOST >/dev/null 2>&1; then
  echo "== caddy sem NUTROLAB_HOST: recriando (alguns segundos sem proxy) =="
  docker compose up -d --force-recreate caddy
fi
sleep 5
docker compose ps nutrolab caddy --format "table {{.Name}}\t{{.Status}}"
echo "HOST: https://$(grep '^NUTROLAB_HOST=' .env | cut -d= -f2)"
REMOTE
