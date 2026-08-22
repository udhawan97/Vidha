#!/usr/bin/env bash
set -euo pipefail

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
vidha_run_id=${GITHUB_RUN_ID:-local}
vidha_run_attempt=${GITHUB_RUN_ATTEMPT:-1}
vidha_project="vidha-phase3b-${vidha_run_id}-${vidha_run_attempt}-$$"
if ! [[ "$vidha_project" =~ ^[a-z0-9][a-z0-9_-]{7,62}$ ]]; then
  echo 'The disposable Compose project identifier is invalid.' >&2
  exit 1
fi
export VIDHA_API_HOST_PORT=0
compose=(docker compose --project-name "$vidha_project" -f "$repo_root/infra/compose.yaml")
cleanup_required=false

report_failure() {
  vidha_status=$?
  echo "Topology rehearsal failed at line ${BASH_LINENO[0]}: ${BASH_COMMAND}" >&2
  return "$vidha_status"
}

cleanup_on_exit() {
  vidha_status=$?
  trap - EXIT
  if [ "$cleanup_required" = true ]; then
    if ! "${compose[@]}" down --volumes --remove-orphans; then
      echo 'The disposable Compose project did not cleanly tear down.' >&2
      if [ "$vidha_status" -eq 0 ]; then
        vidha_status=1
      fi
    fi
  fi
  exit "$vidha_status"
}
trap report_failure ERR
trap cleanup_on_exit EXIT

existing_resources=$(
  {
    docker ps -aq --filter "label=com.docker.compose.project=$vidha_project"
    docker network ls -q --filter "label=com.docker.compose.project=$vidha_project"
    docker volume ls -q --filter "label=com.docker.compose.project=$vidha_project"
  } | sed '/^$/d'
)
if [ -n "$existing_resources" ]; then
  echo 'The run-unique disposable Compose project already has resources.' >&2
  exit 1
fi
cleanup_required=true

if ! "${compose[@]}" up --build --wait --wait-timeout 240; then
  "${compose[@]}" ps --all
  "${compose[@]}" logs
  exit 1
fi

api_address=$("${compose[@]}" port api 8080)
api_port=${api_address##*:}
if ! [[ "$api_port" =~ ^[0-9]{2,5}$ ]]; then
  echo 'Docker did not assign a bounded loopback API port.' >&2
  exit 1
fi
ready_url="http://127.0.0.1:${api_port}/readyz"
ready_json=$(curl --fail --silent --show-error "$ready_url")
grep --quiet --fixed-strings '"databaseMajor":18' <<<"$ready_json"

api_id=$("${compose[@]}" ps -q api)
worker_id=$("${compose[@]}" ps -q worker)
postgres_id=$("${compose[@]}" ps -q postgres)
test "$(docker inspect --format '{{.Config.User}}' "$api_id")" = node
test "$(docker inspect --format '{{.Config.User}}' "$worker_id")" = node
test "$(docker inspect --format '{{json .HostConfig.Tmpfs}}' "$postgres_id")" = '{"/var/lib/postgresql/18/docker":""}'

roles=''
roles_observed=false
for _attempt in $(seq 1 30); do
  roles=$(
    "${compose[@]}" exec -T postgres \
      psql -U vidha_owner -d vidha_fixture -Atc \
      "SELECT string_agg(DISTINCT usename, ',' ORDER BY usename) FROM pg_stat_activity WHERE usename IN ('vidha_api','vidha_worker')"
  )
  if [ "$roles" = 'vidha_api,vidha_worker' ]; then
    roles_observed=true
    break
  fi
  sleep 1
done
if [ "$roles_observed" != true ]; then
  echo "The API and worker roles were not both active; observed: ${roles:-none}." >&2
  exit 1
fi
if "${compose[@]}" exec -T postgres \
  env PGPASSWORD=disposable_api_fixture_only \
  psql -h 127.0.0.1 -U vidha_api -d vidha_fixture -v ON_ERROR_STOP=1 -c \
  'TRUNCATE runtime_configuration' >/dev/null 2>&1; then
  echo 'The disposable API role unexpectedly acquired owner authority.' >&2
  exit 1
fi
if "${compose[@]}" exec -T postgres \
  env PGPASSWORD=disposable_worker_fixture_only \
  psql -h 127.0.0.1 -U vidha_worker -d vidha_fixture -v ON_ERROR_STOP=1 -c \
  "INSERT INTO plans(plan_id, state_json) VALUES ('plan_forbidden_worker', '{}'::jsonb)" \
  >/dev/null 2>&1; then
  echo 'The disposable worker role unexpectedly acquired API authority.' >&2
  exit 1
fi

core_network=$(
  docker network ls \
    --filter "label=com.docker.compose.project=$vidha_project" \
    --filter label=com.docker.compose.network=core \
    --format '{{.ID}}'
)
test -n "$core_network"
failures_before=$("${compose[@]}" logs worker 2>&1 | grep -c 'worker_poll_failed' || true)
docker network disconnect "$core_network" "$worker_id"
"${compose[@]}" exec -T postgres \
  psql -U vidha_owner -d vidha_fixture -Atc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'vidha_worker' AND datname = 'vidha_fixture'" \
  >/dev/null

partition_observed=false
for attempt in $(seq 1 30); do
  failures_after=$("${compose[@]}" logs worker 2>&1 | grep -c 'worker_poll_failed' || true)
  if [ "$failures_after" -gt "$failures_before" ]; then
    partition_observed=true
    break
  fi
  sleep 1
done
test "$partition_observed" = true
curl --fail --silent --show-error "$ready_url" >/dev/null

docker network connect "$core_network" "$worker_id"

worker_recovered=false
for attempt in $(seq 1 30); do
  active_workers=$(
    "${compose[@]}" exec -T postgres \
      psql -U vidha_owner -d vidha_fixture -Atc \
      "SELECT COUNT(*) FROM pg_stat_activity WHERE usename = 'vidha_worker' AND datname = 'vidha_fixture'"
  )
  if [ "$active_workers" -gt 0 ]; then
    worker_recovered=true
    break
  fi
  sleep 1
done
test "$worker_recovered" = true

"${compose[@]}" down --volumes --remove-orphans
if docker inspect "$postgres_id" >/dev/null 2>&1; then
  echo 'The disposable PostgreSQL container survived teardown.' >&2
  exit 1
fi
if docker network inspect "$core_network" >/dev/null 2>&1; then
  echo 'The disposable core network survived teardown.' >&2
  exit 1
fi

"${compose[@]}" up --detach postgres
fresh_postgres_id=$("${compose[@]}" ps -q postgres)
fresh_ready=false
for attempt in $(seq 1 30); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "$fresh_postgres_id")" = healthy ]; then
    fresh_ready=true
    break
  fi
  sleep 1
done
test "$fresh_ready" = true
schema_absent=$(
  "${compose[@]}" exec -T postgres \
    psql -U vidha_owner -d vidha_fixture -Atc \
    "SELECT to_regclass('public.runtime_configuration') IS NULL"
)
test "$schema_absent" = t

"${compose[@]}" down --volumes --remove-orphans
remaining_containers=$(docker ps -aq --filter "label=com.docker.compose.project=$vidha_project")
remaining_networks=$(docker network ls -q --filter "label=com.docker.compose.project=$vidha_project")
remaining_volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$vidha_project")
test -z "$remaining_containers"
test -z "$remaining_networks"
test -z "$remaining_volumes"
cleanup_required=false
trap - ERR
trap - EXIT

printf '%s\n' '{"apiReady":true,"dataRootDestroyed":true,"disposableOwnerControl":true,"leastPrivilegeDenialsVerified":true,"networkPartitionObserved":true,"nonRootApplicationRoles":true,"teardownVerified":true,"workerRecovered":true}'
