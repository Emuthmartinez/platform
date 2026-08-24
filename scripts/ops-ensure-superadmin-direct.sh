#!/usr/bin/env bash
# Run ops:ensure-superadmin against the Neon DIRECT endpoint (never -pooler).
# Doppler stg/prd DATABASE_URL is the pooler. This script strips that suffix.
# It never prints the URL. It prints only the host.
#
#   doppler run --command 'bash scripts/ops-ensure-superadmin-direct.sh DATABASE_URL --confirm platform-operator-bootstrap'
set -euo pipefail

SRC_VAR="DATABASE_URL"
if [[ "${1:-}" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
  SRC_VAR="$1"
  shift
fi

URL="${!SRC_VAR:-}"
if [ -z "$URL" ]; then
  echo "[ops-ensure-superadmin] missing variable $SRC_VAR" >&2
  exit 1
fi

DIRECT="${URL/-pooler/}"

HOST=$(printf '%s' "$DIRECT" | sed -E 's#^[^@]*@##; s#/.*$##; s#\?.*$##')
case "$HOST" in
  *-pooler*) echo "[ops-ensure-superadmin] ABORT: host is still the pooler ($HOST)" >&2; exit 1 ;;
  *nameless-dew*) echo "[ops-ensure-superadmin] ABORT: Colombia production Neon" >&2; exit 1 ;;
esac
echo "[ops-ensure-superadmin] destino: ${HOST}"

cd "$(dirname "$0")/../backend"
DATABASE_URL="$DIRECT" npm run ops:ensure-superadmin -- "$@"
