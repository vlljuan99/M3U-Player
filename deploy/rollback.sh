#!/usr/bin/env bash
# Vuelve a la imagen anterior (o a una concreta: ./rollback.sh <sha>).
set -euo pipefail
cd "$(dirname "$0")"
if [[ $# -ge 1 ]]; then
  printf 'M3U_IMAGE=m3u-player:%s\n' "$1" > .deploy.env
elif [[ -f .deploy.previous.env ]]; then
  cp -- .deploy.previous.env .deploy.env
else
  echo "No hay imagen anterior a la que volver" >&2
  exit 1
fi
docker compose --env-file .deploy.env up -d --remove-orphans app
echo "Ahora en: $(cat .deploy.env)"
