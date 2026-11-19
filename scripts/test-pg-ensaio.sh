#!/usr/bin/env bash
# Roda a suíte inteira contra o banco de ENSAIO `nutrolab_ensaio` no Postgres da VPS,
# por túnel SSH (127.0.0.1:54331 → VPS 127.0.0.1:5432), com a role própria
# `nutrolab_ensaio` (dona só desse banco; senha nova a cada execução). Nunca toca outro banco.
# Uso: bash scripts/test-pg-ensaio.sh [host-ssh=vps-clinica]
set -euo pipefail
HOST=${1:-vps-clinica}
cd "$(dirname "$0")/.."
PORT=54331
PASS=$(openssl rand -hex 24)
ssh -o BatchMode=yes "$HOST" "cd /srv/clinica && docker compose exec -T db psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres" <<SQL
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
ssh -f -N -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes -L "$PORT:127.0.0.1:5432" "$HOST"
trap 'pkill -f "$PORT:127.0.0.1:5432 $HOST" || true' EXIT
npm run build >/dev/null
DATABASE_URL="postgresql://nutrolab_ensaio:${PASS}@127.0.0.1:$PORT/nutrolab_ensaio" NUTROLAB_TEST_RESET_PG=1 NODE_ENV=test \
  node --disable-warning=ExperimentalWarning --test --test-concurrency=1 "dist/test/**/*.test.js"
