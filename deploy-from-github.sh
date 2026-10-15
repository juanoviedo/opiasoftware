#!/bin/bash
# Despliegue de opiasoftware.com en el servidor Debian (/opt/opiasoftware).
# Lo ejecuta opiasoftware-deploy.timer cada 5 minutos como root.
set -euo pipefail
cd /opt/opiasoftware
exec 9>/run/lock/opiasoftware-deploy.lock
flock -n 9 || exit 0

git fetch origin main
revision=$(git rev-parse FETCH_HEAD)
if [[ -f .deployed-commit ]] && [[ $(cat .deployed-commit) = "$revision" ]]; then
  echo "No hay cambios: $revision"
  exit 0
fi

git reset --hard "$revision"
docker compose up -d --build --wait --wait-timeout 180
curl -fsS http://127.0.0.1:8160/api/health >/dev/null

printf '%s\n' "$revision" > .deployed-commit
echo "Desplegado: $revision"
