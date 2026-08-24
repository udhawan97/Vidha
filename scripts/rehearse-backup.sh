#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_root="$(mktemp -d "${TMPDIR:-/tmp}/vidha-backup-rehearsal.XXXXXX")"
run_suffix="$(basename "$backup_root" | tr -cd 'a-zA-Z0-9' | tail -c 12)"
network_name="vidha-backup-${run_suffix}"
source_name="vidha-backup-source-${run_suffix}"
restore_name="vidha-backup-restore-${run_suffix}"
postgres_image="postgres:18.3-alpine3.23@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7"

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for the disposable PostgreSQL backup rehearsal.' >&2
  exit 1
fi

cleanup() {
  docker rm --force "$source_name" "$restore_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  rm -rf "$backup_root"
}
trap cleanup EXIT

docker network create "$network_name" >/dev/null
for container_name in "$source_name" "$restore_name"; do
  docker run --detach \
    --name "$container_name" \
    --network "$network_name" \
    --publish 127.0.0.1::5432 \
    --tmpfs /var/lib/postgresql/18/docker \
    --env POSTGRES_DB=vidha_fixture \
    --env POSTGRES_PASSWORD=disposable_fixture_only \
    --env POSTGRES_USER=postgres \
    --env PGDATA=/var/lib/postgresql/18/docker \
    "$postgres_image" >/dev/null
done

docker exec -i "$restore_name" psql -v ON_ERROR_STOP=1 -U postgres -d vidha_fixture >/dev/null <<'SQL'
CREATE ROLE vidha_restore_writer LOGIN PASSWORD 'disposable_restore_fixture_only';
GRANT CONNECT ON DATABASE vidha_fixture TO vidha_restore_writer;
GRANT USAGE, CREATE ON SCHEMA public TO vidha_restore_writer;
SQL

for container_name in "$source_name" "$restore_name"; do
  for attempt in $(seq 1 60); do
    if docker exec "$container_name" pg_isready -U postgres -d vidha_fixture >/dev/null 2>&1; then
      break
    fi
    if [ "$attempt" -eq 60 ]; then
      docker logs "$container_name"
      exit 1
    fi
    sleep 1
  done
  docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d vidha_fixture >/dev/null <<'SQL'
CREATE ROLE vidha_api LOGIN PASSWORD 'vidha-api-test';
CREATE ROLE vidha_worker LOGIN PASSWORD 'vidha-worker-test';
CREATE ROLE vidha_restore NOLOGIN;
SQL
done

source_port="$(docker port "$source_name" 5432/tcp | sed -n 's/.*://p' | tail -1)"
restore_port="$(docker port "$restore_name" 5432/tcp | sed -n 's/.*://p' | tail -1)"
source_url="postgres://postgres:disposable_fixture_only@127.0.0.1:${source_port}/vidha_fixture"
restore_url="postgres://postgres:disposable_fixture_only@127.0.0.1:${restore_port}/vidha_fixture"
application_commit="$(git -C "$project_root" rev-parse HEAD)"

VIDHA_REQUIRE_BACKUP_REHEARSAL=1 \
VIDHA_BACKUP_REHEARSAL_PHASE=seed \
VIDHA_BACKUP_SOURCE_URL="$source_url" \
pnpm --dir "$project_root" --filter @vidha/platform exec vitest run src/backup.integration.test.ts

docker exec "$source_name" pg_dump \
  --username postgres \
  --dbname vidha_fixture \
  --format custom \
  --no-owner \
  --exclude-table-data runtime_configuration \
  --file /tmp/source.dump
docker cp "$source_name:/tmp/source.dump" "$backup_root/source.dump" >/dev/null
head -c 16 "$backup_root/source.dump" > "$backup_root/partial.dump"
docker cp "$backup_root/partial.dump" "$restore_name:/tmp/partial.dump" >/dev/null
if docker exec "$restore_name" pg_restore --list /tmp/partial.dump >/dev/null 2>&1; then
  echo 'The truncated logical backup unexpectedly passed pg_restore inspection.' >&2
  exit 1
fi

VIDHA_REQUIRE_BACKUP_REHEARSAL=1 \
VIDHA_BACKUP_REHEARSAL_PHASE=protect \
VIDHA_BACKUP_ROOT="$backup_root" \
VIDHA_APPLICATION_COMMIT="$application_commit" \
pnpm --dir "$project_root" --filter @vidha/platform exec vitest run src/backup.integration.test.ts

docker cp "$backup_root/restore.dump" "$restore_name:/tmp/restore.dump" >/dev/null
docker exec --env PGPASSWORD=disposable_restore_fixture_only "$restore_name" pg_restore \
  --username vidha_restore_writer \
  --dbname vidha_fixture \
  --no-owner \
  --exit-on-error \
  --single-transaction \
  /tmp/restore.dump
docker exec --env PGPASSWORD=disposable_restore_fixture_only "$restore_name" psql -v ON_ERROR_STOP=1 -U vidha_restore_writer -d vidha_fixture \
  --command "INSERT INTO runtime_configuration(singleton, environment_id, installation_id, mode) VALUES (TRUE, 'environment_2222222222222222222222222222222222222222222222222222222222222222', 'installation_3333333333333333333333333333333333333333333333333333333333333333', 'restore_safe')" >/dev/null

VIDHA_REQUIRE_BACKUP_REHEARSAL=1 \
VIDHA_BACKUP_REHEARSAL_PHASE=verify \
VIDHA_BACKUP_RESTORE_URL="$restore_url" \
VIDHA_BACKUP_ROOT="$backup_root" \
pnpm --dir "$project_root" --filter @vidha/platform exec vitest run src/backup.integration.test.ts

cat "$backup_root/rehearsal-report.json"
