#!/usr/bin/env bash
# Verifica el estado de Turnstile en un despliegue, EN EL ORDEN QUE IMPORTA.
#
# Contexto (CLAUDE.md → "Limitaciones conocidas"): Turnstile se desactivó porque
# el bundle del frontend no llevaba la site key pública mientras el backend sí
# exigía el token — resultado: TODOS los reportes de personas desaparecidas
# fallaban con 403. La regla es:
#
#   1. la site key llega al bundle del frontend
#   2. DESPUÉS se repone TURNSTILE_SECRET_KEY en el Worker de la API
#
# En ese orden. Este script comprueba cada paso por separado para que nadie
# repita el fallo.
#
# Uso:
#   scripts/verify-turnstile.sh staging
#   scripts/verify-turnstile.sh production
#
# No escribe nada: la sonda de la API manda un cuerpo vacío, que es rechazado
# por el middleware (403 si Turnstile está activo) o por la validación (400 si
# no lo está) — nunca llega a insertar una fila.

set -euo pipefail

ENVIRONMENT="${1:-staging}"

case "$ENVIRONMENT" in
  staging)
    WEB="https://mallanet-platform-web-staging.e-muth-martinez.workers.dev"
    API="https://api-staging.mallanet.org"
    ;;
  production|prod)
    WEB="https://mallanet-platform-web.e-muth-martinez.workers.dev"
    API="https://api.mallanet.org"
    ;;
  *)
    echo "Uso: $0 [staging|production]" >&2
    exit 2
    ;;
esac

echo "Entorno: $ENVIRONMENT"
echo "  web: $WEB"
echo "  api: $API"
echo

# --- Paso 1: ¿la site key está inlineada en el bundle? -----------------------
# El hook lee process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY en BUILD TIME
# (frontend/hooks/useTurnstile.tsx). Si no estaba en Doppler al construir, el
# valor queda como "" y el widget nunca monta — da igual lo que haya en runtime.
#
# OJO: se escanea una página CON formulario (/solicitar-borrado), no el home.
# Con el chunking por ruta de Turbopack, el chunk del hook solo aparece en las
# páginas que montan un form — escanear el home daba un FALSO NEGATIVO aunque
# la key estuviera perfectamente inlineada.

echo "== Paso 1: site key en el bundle del frontend =="
FORM_PAGE="$WEB/solicitar-borrado"
html="$(curl -fsS -m 25 "$FORM_PAGE" || true)"
if [ -z "$html" ]; then
  echo "  ERROR: no se pudo cargar $FORM_PAGE"
  exit 1
fi

chunks="$(printf '%s' "$html" \
  | grep -oE '/_next/static/chunks/[a-zA-Z0-9_.\-]+\.js' \
  | sort -u)"

# La key puede venir inlineada en el HTML del server render, sin bajar chunks.
inline="$(printf '%s' "$html" | grep -oE '0x4AAAAAA[A-Za-z0-9_-]+' | head -1 || true)"

sitekey=""
if [ -n "$inline" ]; then
  sitekey="$inline"
  echo "  OK: site key encontrada en el HTML de $FORM_PAGE"
  echo "      $sitekey"
fi
for c in $chunks; do
  [ -n "$sitekey" ] && break
  body="$(curl -fsS -m 20 "$WEB$c" || true)"
  found="$(printf '%s' "$body" | grep -oE '0x4AAAAAA[A-Za-z0-9_-]+' | head -1 || true)"
  if [ -n "$found" ]; then
    sitekey="$found"
    echo "  OK: site key encontrada en $c"
    echo "      $sitekey"
    break
  fi
done

if [ -z "$sitekey" ]; then
  echo "  FALTA: ninguna site key de Turnstile en los $(printf '%s\n' "$chunks" | grep -c . ) chunks escaneados."
  echo "         => NEXT_PUBLIC_TURNSTILE_SITE_KEY no llegó al build."
  echo "         NO repongas TURNSTILE_SECRET_KEY todavía: romperías las escrituras."
fi
echo

# --- Paso 2: ¿la API exige el token? ----------------------------------------
# Cuerpo vacío a propósito. requireHuman corre ANTES del handler, así que:
#   403 -> Turnstile activo en el backend
#   400 -> Turnstile inactivo (pasó al validador)
# En ninguno de los dos casos se inserta nada.

echo "== Paso 2: ¿la API exige prueba de humanidad? =="
code="$(curl -s -o /dev/null -m 25 -w '%{http_code}' \
  -X POST "$API/api/missing" \
  -H 'content-type: application/json' \
  --data '{}' || true)"

case "$code" in
  403) backend_on=1; echo "  Turnstile ACTIVO en el backend (403)" ;;
  400|422) backend_on=0; echo "  Turnstile INACTIVO en el backend ($code = validación)" ;;
  429) backend_on=-1; echo "  Rate-limited (429) — repite en un minuto" ;;
  *) backend_on=-1; echo "  Respuesta inesperada: $code" ;;
esac
echo

# --- Veredicto ---------------------------------------------------------------
echo "== Veredicto =="
if [ -n "$sitekey" ] && [ "$backend_on" = "1" ]; then
  echo "  COHERENTE: frontend y backend con Turnstile activo."
elif [ -z "$sitekey" ] && [ "$backend_on" = "0" ]; then
  echo "  COHERENTE (desactivado en ambos lados). Estado actual conocido."
  echo "  Siguiente paso: poner NEXT_PUBLIC_TURNSTILE_SITE_KEY en Doppler,"
  echo "  redesplegar el frontend, volver a correr este script, y SOLO SI el"
  echo "  paso 1 pasa, reponer TURNSTILE_SECRET_KEY."
elif [ -n "$sitekey" ] && [ "$backend_on" = "0" ]; then
  echo "  LISTO PARA EL PASO FINAL: el bundle ya lleva la site key y el backend"
  echo "  aún no exige el token. Ahora sí es seguro reponer TURNSTILE_SECRET_KEY."
elif [ -z "$sitekey" ] && [ "$backend_on" = "1" ]; then
  echo "  ROTO: el backend exige token y el frontend no lo puede generar."
  echo "  Este es exactamente el fallo que tumbó los reportes. Quita"
  echo "  TURNSTILE_SECRET_KEY del Worker de la API YA, o repón la site key."
  exit 1
else
  echo "  INDETERMINADO — revisa los pasos de arriba."
fi
