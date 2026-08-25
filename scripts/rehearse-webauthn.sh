#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_root="$(mktemp -d "${TMPDIR:-/tmp}/vidha-webauthn-rehearsal.XXXXXX")"
run_suffix="$(basename "$run_root" | tr -cd 'a-zA-Z0-9' | tail -c 12)"
postgres_name="vidha-webauthn-${run_suffix}"
postgres_image="postgres:18.3-alpine3.23@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7"
api_pid=''

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for the disposable browser WebAuthn rehearsal.' >&2
  exit 1
fi

cleanup() {
  if [ -n "$api_pid" ]; then
    kill "$api_pid" >/dev/null 2>&1 || true
    wait "$api_pid" >/dev/null 2>&1 || true
  fi
  docker rm --force "$postgres_name" >/dev/null 2>&1 || true
  rm -rf "$run_root"
}
trap cleanup EXIT

docker run --detach \
  --name "$postgres_name" \
  --publish 127.0.0.1::5432 \
  --tmpfs /var/lib/postgresql/18/docker \
  --env POSTGRES_DB=vidha_fixture \
  --env POSTGRES_PASSWORD=disposable_fixture_only \
  --env POSTGRES_USER=postgres \
  --env PGDATA=/var/lib/postgresql/18/docker \
  "$postgres_image" >/dev/null

# The image's temporary initialization server exposes only its Unix socket.
# TCP readiness therefore proves the final postmaster has taken authority.
for attempt in $(seq 1 60); do
  if docker exec "$postgres_name" pg_isready -h 127.0.0.1 -U postgres -d vidha_fixture >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    docker logs "$postgres_name"
    exit 1
  fi
  sleep 1
done

docker exec -i "$postgres_name" psql -v ON_ERROR_STOP=1 -U postgres -d vidha_fixture >/dev/null <<'SQL'
CREATE ROLE vidha_api LOGIN PASSWORD 'vidha-api-test';
CREATE ROLE vidha_worker LOGIN PASSWORD 'vidha-worker-test';
CREATE ROLE vidha_restore NOLOGIN;
SQL

postgres_port="$(docker port "$postgres_name" 5432/tcp | sed -n 's/.*://p' | tail -1)"
owner_url="postgres://postgres:disposable_fixture_only@127.0.0.1:${postgres_port}/vidha_fixture"
api_url="postgres://vidha_api:vidha-api-test@127.0.0.1:${postgres_port}/vidha_fixture"
environment_id="environment_$(printf '2%.0s' {1..64})"
installation_id="installation_$(printf '3%.0s' {1..64})"

pnpm --dir "$project_root" --filter @vidha/runtime build

VIDHA_ROLE=migrate \
VIDHA_MODE=live \
DATABASE_URL="$owner_url" \
VIDHA_ENVIRONMENT_ID="$environment_id" \
VIDHA_INSTALLATION_ID="$installation_id" \
node "$project_root/apps/runtime/dist/main.mjs"

api_port="$(node -e "const n=require('node:net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
public_origin="http://localhost:${api_port}"
capability='vidha-disposable-browser-bootstrap-capability-2026-08-25'
capability_digest="$(node -e "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(process.argv[1]).digest('hex'))" "$capability")"

VIDHA_ROLE=api \
VIDHA_MODE=live \
DATABASE_URL="$api_url" \
VIDHA_ENVIRONMENT_ID="$environment_id" \
VIDHA_INSTALLATION_ID="$installation_id" \
VIDHA_ENABLE_IDENTITY_REHEARSAL=1 \
VIDHA_BIND_HOST=127.0.0.1 \
VIDHA_PUBLIC_ORIGIN="$public_origin" \
VIDHA_RP_ID=localhost \
VIDHA_BOOTSTRAP_CAPABILITY_DIGEST="$capability_digest" \
VIDHA_CSRF_SECRET='disposable-csrf-secret-with-at-least-256-bits-of-entropy' \
VIDHA_VERIFIED_CHANNEL_REF="channel_$(printf '4%.0s' {1..64})" \
PORT="$api_port" \
node "$project_root/apps/runtime/dist/main.mjs" >"$run_root/api.log" 2>&1 &
api_pid=$!

for attempt in $(seq 1 60); do
  if curl --fail --silent "$public_origin/readyz" >/dev/null; then
    break
  fi
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then
    cat "$run_root/api.log"
    exit 1
  fi
  if [ "$attempt" -eq 60 ]; then
    cat "$run_root/api.log"
    exit 1
  fi
  sleep 1
done

VIDHA_WEBAUTHN_ORIGIN="$public_origin" \
VIDHA_WEBAUTHN_CAPABILITY="$capability" \
pnpm --dir "$project_root" exec playwright test --config playwright.webauthn.config.ts

printf '{"browserBoundary":"passed","databaseMajor":18,"identity":"synthetic_fixture","publicEndpoint":false}\n'
