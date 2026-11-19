#!/usr/bin/env bash
# Roda a suíte inteira contra o banco de ENSAIO `nutrolab_ensaio`, DENTRO da VPS:
# código em /srv/clinica/build/nutrolab-ensaio, imagem `nutrolab:ensaio` (nunca a
# `nutrolab:local` de produção), container temporário na rede `clinica_data` com a
# role própria `nutrolab_ensaio` (dona só desse banco; senha nova a cada execução).
# A rede Mac↔VPS oscila: toda etapa longa roda desacoplada na VPS e é acompanhada
# por chamadas SSH curtas com novas tentativas. Nunca toca outro banco.
# Uso: bash scripts/test-pg-ensaio.sh [host-ssh=vps-clinica]   (TEST_FILES opcional)
set -euo pipefail
HOST=${1:-vps-clinica}
cd "$(dirname "$0")/.."
PASS=$(openssl rand -hex 24)
FILES=${TEST_FILES:-"dist/test/**/*.test.js"}
WORK=/srv/clinica/build/nutrolab-ensaio-run

sshq() { # chamada curta com até 6 tentativas
  local i
  for i in 1 2 3 4 5 6; do
    if ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=6 "$HOST" "$@"; then return 0; fi
    sleep 5
  done
  return 1
}

for i in 1 2 3 4 5 6; do
  rsync -a --delete --timeout=60 -e "ssh -o BatchMode=yes -o ConnectTimeout=15" --exclude node_modules --exclude dist --exclude data --exclude .env --exclude .git ./ "$HOST:/srv/clinica/build/nutrolab-ensaio/" && break
  [ "$i" = 6 ] && { echo "rsync falhou"; exit 1; }
  sleep 5
done

sshq "cd /srv/clinica && docker compose exec -T db psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres" >/dev/null <<SQL
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

# Build + testes desacoplados: um job em background na VPS que grava o código de saída.
sshq "mkdir -p $WORK && rm -f $WORK/rc $WORK/log && docker rm -f nutrolab-ensaio-testes >/dev/null 2>&1; \
  setsid nohup sh -c \"cd /srv/clinica && docker build -q -t nutrolab:ensaio build/nutrolab-ensaio >/dev/null && \
  docker run --name nutrolab-ensaio-testes --network clinica_data \
  -e DATABASE_URL='postgresql://nutrolab_ensaio:$PASS@db:5432/nutrolab_ensaio' -e NUTROLAB_TEST_RESET_PG=1 -e NODE_ENV=test \
  --entrypoint sh nutrolab:ensaio -c 'node --disable-warning=ExperimentalWarning --test --test-concurrency=1 $FILES'; \
  echo \\\$? > $WORK/rc\" > $WORK/log 2>&1 < /dev/null &"

for _ in $(seq 1 240); do
  if sshq "test -f $WORK/rc" 2>/dev/null; then break; fi
  sleep 5
done
CODE=$(sshq "cat $WORK/rc" 2>/dev/null || echo "?")
sshq "cat $WORK/log; docker rm -f nutrolab-ensaio-testes >/dev/null 2>&1" || true
[[ "$CODE" =~ ^[0-9]+$ ]] || { echo "estado final desconhecido: $CODE"; exit 2; }
exit "$CODE"
