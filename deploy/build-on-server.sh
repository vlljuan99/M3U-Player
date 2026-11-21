#!/usr/bin/env bash
# Construye m3u-player:<sha> en el VPS, lo arranca y comprueba que responde.
# Si no responde, vuelve a la imagen anterior. Lo ejecuta el workflow.
set -euo pipefail
cd "$(dirname "$0")"

TAG="${M3U_IMAGE_TAG:?Falta M3U_IMAGE_TAG}"
IMAGE="m3u-player:$TAG"

rm -rf build && mkdir build
tar -xzf src.tar.gz -C build
docker build --pull -q \
  --label "org.opencontainers.image.revision=$TAG" \
  --label "org.opencontainers.image.source=https://github.com/vlljuan99/M3U-Player" \
  -t "$IMAGE" build
rm -rf build src.tar.gz

[[ -f .deploy.env ]] && cp -- .deploy.env .deploy.previous.env
printf 'M3U_IMAGE=%s\n' "$IMAGE" > .deploy.env
docker compose --env-file .deploy.env up -d --remove-orphans app

for i in $(seq 1 15); do
  if docker exec m3u-player-app wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "m3u-player-app responde ($IMAGE)"
    # Limpieza: conservar solo las 3 imágenes más recientes (el disco es compartido).
    docker image ls m3u-player --format '{{.Repository}}:{{.Tag}}' | tail -n +4 | xargs -r docker rmi >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done

echo "La nueva imagen no responde: vuelvo a la anterior" >&2
docker logs --tail 50 m3u-player-app >&2 || true
./rollback.sh || true
exit 1
