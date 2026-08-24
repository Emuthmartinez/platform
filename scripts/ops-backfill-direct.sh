#!/usr/bin/env bash
# Run U8 ops:backfill against the Neon DIRECT endpoint (never -pooler).
# Doppler stg/prd DATABASE_URL is the pooler. This script strips that suffix.
# It never prints the URL. It prints only the host.
#
#   doppler run --command 'bash scripts/ops-backfill-direct.sh DATABASE_URL --domain reports --mode count-only --confirm colombia-u8-backfill --operator your-handle'
set -euo pipefail

SRC_VAR="DATABASE_URL"
if [[ "${1:-}" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
  SRC_VAR="$1"
  shift
fi

URL="${!SRC_VAR:-}"
if [ -z "$URL" ]; then
  echo "[ops-backfill] missing variable $SRC_VAR" >&2
  exit 1
fi

DIRECT="${URL/-pooler/}"

HOST=$(printf '%s' "$DIRECT" | sed -E 's#^[^@]*@##; s#/.*$##; s#\?.*$##')
case "$HOST" in
  *-pooler*) echo "[ops-backfill] ABORT: host is still the pooler ($HOST)" >&2; exit 1 ;;
esac
echo "[ops-backfill] destino: ${HOST}"

cd "$(dirname "$0")/../backend"
DATABASE_URL="$DIRECT" npm run ops:backfill -- "$@"
