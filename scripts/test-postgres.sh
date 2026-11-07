#!/usr/bin/env bash
# Disposable PostgreSQL proof only. No kind, production service, or dispatch calls.
# Run from the repository root: bash scripts/test-postgres.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

name=telegram-pi-postgres-validation
image=postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15
label=dev.telegram-pi.postgres-validation
run_id=$(openssl rand -hex 16)
container_id=
private_dir=$(mktemp -d)
chmod 700 "$private_dir"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$container_id" ]]; then
    actual_id=$(docker inspect --format '{{.Id}}' "$container_id" 2>/dev/null || true)
    actual_label=$(docker inspect --format "{{index .Config.Labels \"$label\"}}" "$container_id" 2>/dev/null || true)
    if [[ "$actual_id" == "$container_id" && "$actual_label" == "$run_id" ]]; then
      docker rm --force --volumes "$container_id" >/dev/null || status=1
    else
      printf 'Refuse cleanup: container ID/ownership does not match this run.\n' >&2
      status=1
    fi
  fi
  rm -rf -- "$private_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
command -v docker >/dev/null
command -v openssl >/dev/null
docker info >/dev/null
if docker container inspect "$name" >/dev/null 2>&1; then
  printf 'Refuse existing container: %s\n' "$name" >&2
  exit 1
fi
# Distinct generated credentials are fixture-only. Do not print them or save them in the repository.
admin_password=$(openssl rand -hex 24)
owner_password=$(openssl rand -hex 24)
app_password=$(openssl rand -hex 24)
substrate_password=$(openssl rand -hex 24)
printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_DB=postgres\n' "$admin_password" > "$private_dir/postgres.env"
chmod 600 "$private_dir/postgres.env"
docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image" >/dev/null
container_id=$(docker create --name "$name" --label "$label=$run_id" \
  --publish 127.0.0.1::5432 --env-file "$private_dir/postgres.env" \
  --tmpfs /var/lib/postgresql:rw,nosuid,noexec,size=512m "$image")
docker start "$container_id" >/dev/null
ready=false
for _ in {1..60}; do
  if docker exec "$container_id" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  printf 'Disposable PostgreSQL did not become ready.\n' >&2
  exit 1
fi
port=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$container_id")
# Connect is denied by default, including from the Gateway to the Substrate fixture database.
# The app role has DML only. Migrations use a separate owner role.
printf '%s\n' \
  "CREATE ROLE gateway_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$owner_password';" \
  "CREATE ROLE gateway_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$app_password';" \
  "CREATE ROLE substrate_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$substrate_password';" \
  'CREATE DATABASE gateway_test OWNER gateway_owner;' \
  'CREATE DATABASE substrate_test OWNER substrate_owner;' \
  'REVOKE CONNECT ON DATABASE postgres, template1, gateway_test, substrate_test FROM PUBLIC;' \
  'GRANT CONNECT ON DATABASE gateway_test TO gateway_owner, gateway_app;' \
  'GRANT CONNECT ON DATABASE substrate_test TO substrate_owner;' \
  | docker exec -i "$container_id" psql -X --set ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
printf '%s\n' 'REVOKE ALL ON SCHEMA public FROM PUBLIC;' \
  | docker exec -i "$container_id" psql -X --set ON_ERROR_STOP=1 -U postgres -d gateway_test >/dev/null
printf '%s\n' \
  'REVOKE ALL ON SCHEMA public FROM PUBLIC;' \
  'CREATE SCHEMA substrate AUTHORIZATION substrate_owner;' \
  'SET ROLE substrate_owner;' \
  'CREATE TABLE substrate.private_state (id integer PRIMARY KEY, secret text NOT NULL);' \
  "INSERT INTO substrate.private_state VALUES (1, 'fixture-only-substrate-secret');" \
  | docker exec -i "$container_id" psql -X --set ON_ERROR_STOP=1 -U postgres -d substrate_test >/dev/null
export STORE_TEST_ADMIN_URL="postgresql://postgres:$admin_password@127.0.0.1:$port/gateway_test"
export STORE_TEST_OWNER_URL="postgresql://gateway_owner:$owner_password@127.0.0.1:$port/gateway_test"
export STORE_TEST_APP_URL="postgresql://gateway_app:$app_password@127.0.0.1:$port/gateway_test"
export STORE_TEST_SUBSTRATE_URL="postgresql://substrate_owner:$substrate_password@127.0.0.1:$port/substrate_test"
printf 'PostgreSQL container: %s (ID %.12s), loopback ephemeral port %s\n' "$name" "$container_id" "$port"
printf 'Image: %s\n' "$image"
./node_modules/.bin/vitest run --config tests/store/vitest.config.ts
