#!/bin/sh
# Starts (or reuses) a throwaway PostgreSQL 17 + pgvector container for tests
# and prints its admin URL. Only synthetic data is ever written there.
set -eu
name=telegram-insights-test-db
if ! docker inspect "$name" >/dev/null 2>&1; then
  docker run -d --name "$name" -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
    -p 127.0.0.1::5432 pgvector/pgvector:pg17 >/dev/null
fi
if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
  docker start "$name" >/dev/null
fi
i=0
until docker exec "$name" pg_isready -U test >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "test database did not start" >&2; exit 1; }
  sleep 1
done
port=$(docker port "$name" 5432/tcp | head -1 | sed 's/.*://')
echo "postgres://test:test@127.0.0.1:$port/postgres"
