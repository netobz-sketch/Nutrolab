#!/usr/bin/env bash
# Roda a suíte inteira contra o banco de ENSAIO `nutrolab_ensaio`, DENTRO da VPS:
# o código vai para /srv/clinica/build/nutrolab-ensaio, vira a imagem `nutrolab:ensaio`
# (nunca a `nutrolab:local` de produção) e os testes rodam num container temporário na
# rede `clinica_data`, com a role própria `nutrolab_ensaio` (dona só desse banco; senha
# nova a cada execução). Sem túnel SSH (instável em execuções longas). Nunca toca outro banco.
# Uso: bash scripts/test-pg-ensaio.sh [host-ssh=vps-clinica]   (TEST_FILES="dist/test/x.test.js" opcional)
set -euo pipefail
HOST=${1:-vps-clinica}
cd "$(dirname "$0")/.."
PASS=$(openssl rand -hex 24)
FILES=${TEST_FILES:-"dist/test/**/*.test.js"}
rsync -a --delete --exclude node_modules --exclude dist --exclude data --exclude .env --exclude .git ./ "$HOST:/srv/clinica/build/nutrolab-ensaio/"
ssh -o BatchMode=yes "$HOST" "cd /srv/clinica && docker compose exec -T db psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres" >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'nutrolab_ensaio') then
    create role nutrolab_ensaio login password '$PASS';
  else
    alter role nutrolab_ensaio login password '$PASS';
  end if;
end \$\$;
select 'create database nutrolab_ensaio owner nutrolab_ensaio' where not exists (select 1 from pg_database where datname = 'nutrolab_ensaio')\gexec
alter database nutrolab_ensaio owner to nutrolab_ensaio;
revoke connect on database nutrolab_ensaio from public;
grant connect on database nutrolab_ensaio to nutrolab_ensaio;
SQL
ssh -o BatchMode=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=30 "$HOST" "cd /srv/clinica && docker build -q -t nutrolab:ensaio build/nutrolab-ensaio >/dev/null"
# Roda desacoplado (a sessão SSH pode cair em execuções longas) e espera o fim com keepalive.
ssh -o BatchMode=yes "$HOST" "docker rm -f nutrolab-ensaio-testes >/dev/null 2>&1; docker run -d --name nutrolab-ensaio-testes --network clinica_data \
  -e DATABASE_URL='postgresql://nutrolab_ensaio:$PASS@db:5432/nutrolab_ensaio' -e NUTROLAB_TEST_RESET_PG=1 -e NODE_ENV=test \
  --entrypoint sh nutrolab:ensaio -c 'node --disable-warning=ExperimentalWarning --test --test-concurrency=1 $FILES' >/dev/null"
# Espera com consultas curtas (a rede Mac↔VPS oscila; uma sessão longa cai).
SSHQ=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=6 "$HOST")
for _ in $(seq 1 180); do
  STATE=$("${SSHQ[@]}" "docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' nutrolab-ensaio-testes" 2>/dev/null || echo "ssh-falhou")
  case "$STATE" in exited*) break ;; esac
  sleep 5
done
CODE=${STATE#exited }
for _ in 1 2 3 4 5; do
  if "${SSHQ[@]}" "docker logs nutrolab-ensaio-testes 2>&1"; then break; fi
  sleep 5
done
"${SSHQ[@]}" "docker rm nutrolab-ensaio-testes >/dev/null" || true
[[ "$CODE" =~ ^[0-9]+$ ]] || { echo "estado final desconhecido: $STATE"; exit 2; }
exit "$CODE"
