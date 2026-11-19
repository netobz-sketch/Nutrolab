#!/usr/bin/env bash
# Smoke manual de login/caso/exportação contra o banco de ENSAIO `nutrolab_ensaio`, dentro da VPS.
# Pré-requisito: scripts/test-pg-ensaio.sh já rodou (imagem nutrolab:ensaio construída, role e banco existem).
# Zera só o schema do banco de ensaio, sobe o servidor real (imagem nutrolab:ensaio, rede clinica_data),
# roda o fluxo, REINICIA o servidor e confere persistência. Dados e senhas fictícios, gerados a cada execução.
set -euo pipefail
HOST=${1:-vps-clinica}
cd "$(dirname "$0")/.."
PASS=$(openssl rand -hex 24)
ADMIN_PASS=$(openssl rand -hex 16)
SECRET=$(openssl rand -hex 32)
C=nutrolab-ensaio-smoke

sshq() {
  local i
  for i in 1 2 3 4 5 6; do
    if ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=6 "$HOST" "$@"; then return 0; fi
    sleep 5
  done
  return 1
}

sshq "cd /srv/clinica && docker compose exec -T db psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres" >/dev/null <<SQL
alter role nutrolab_ensaio login password '$PASS';
\c nutrolab_ensaio
drop schema if exists public cascade;
create schema public authorization nutrolab_ensaio;
SQL

scp -q -o BatchMode=yes scripts/smoke-ensaio.mjs "$HOST:/srv/clinica/build/nutrolab-ensaio/scripts/smoke-ensaio.mjs"

sshq "set -e; docker rm -f $C >/dev/null 2>&1 || true; \
  docker run -d --name $C --network clinica_data \
  -e DATABASE_URL='postgresql://nutrolab_ensaio:$PASS@db:5432/nutrolab_ensaio' -e DATA_DIR=/tmp/nutrolab-smoke \
  -e SESSION_SECRET='$SECRET' -e ADMIN_EMAIL=smoke@ensaio.local -e ADMIN_NAME='Smoke Ensaio' -e ADMIN_PASSWORD='$ADMIN_PASS' \
  -e LOG_LEVEL=warn nutrolab:ensaio >/dev/null; \
  docker cp /srv/clinica/build/nutrolab-ensaio/scripts/smoke-ensaio.mjs $C:/tmp/smoke.mjs"

wait_up() { sshq "for i in \$(seq 1 60); do docker exec $C node -e \"fetch('http://localhost:8090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\" && exit 0; sleep 1; done; docker logs --tail 40 $C; exit 1"; }
RC=0
wait_up || RC=1
# Os passos do smoke NÃO são repetidos (repetir criaria outro caso e mascararia o resultado).
sshx() { ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=6 "$HOST" "$@"; }
[ $RC = 0 ] && { sshx "docker exec -e ADMIN_EMAIL=smoke@ensaio.local -e ADMIN_PASSWORD='$ADMIN_PASS' $C node /tmp/smoke.mjs fluxo" || RC=1; }
[ $RC = 0 ] && { sshq "docker restart $C >/dev/null && docker cp /srv/clinica/build/nutrolab-ensaio/scripts/smoke-ensaio.mjs $C:/tmp/smoke.mjs" && wait_up || RC=1; }
[ $RC = 0 ] && { sshx "docker exec -e ADMIN_EMAIL=smoke@ensaio.local -e ADMIN_PASSWORD='$ADMIN_PASS' $C node /tmp/smoke.mjs persistencia" || RC=1; }
sshq "echo '--- erros no log do servidor:'; docker logs $C 2>&1 | grep -E '\"level\":(50|60)' | head -20 || true; docker rm -f $C >/dev/null 2>&1" || true
exit $RC
