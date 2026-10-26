#!/usr/bin/env bash
# Build locally, ship the image, replace the container, then prove it works.
# Rolls back to the previous image when any check fails, so a bad deploy costs seconds.
#
#   bash deploy/deploy.sh            # build + deploy + verify
#   SKIP_BUILD=1 bash deploy/deploy.sh   # ship an image that is already built
set -uo pipefail

HOST="${DEPLOY_HOST:-ovh}"
IMAGE="${DEPLOY_IMAGE:-skylit-gateway:branded}"
# Expanded on the REMOTE side; a local $HOME would be a Windows path.
REMOTE_DIR="${DEPLOY_DIR:-\$HOME/skylit-gateway-deploy}"
ORIGIN="${DEPLOY_ORIGIN:-https://skylit.tsra.dev}"
# Paths that must answer 200 for the deploy to count as good.
CHECKS=("/heatmaps" "/atlas" "/academy" "/stages" "/calendar")

cd "$(dirname "$0")/.." || exit 1
fail() { echo "DEPLOY FAILED: $*" >&2; exit 1; }

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== building $IMAGE locally"
  wslc build -t "$IMAGE" . >/tmp/skylit-build.log 2>&1 || { tail -20 /tmp/skylit-build.log; fail "image build"; }
  grep -q "test result: ok" /tmp/skylit-build.log || echo "note: in-image tests did not report ok"
  wslc save "$IMAGE" -o /tmp/skylit-image.tar >/dev/null 2>&1 || fail "image save"
fi

echo "== shipping image"
scp -q /tmp/skylit-image.tar "$HOST:/tmp/skylit-image.tar" || fail "image transfer"

echo "== loading image and keeping the previous one for rollback"
ssh -o BatchMode=yes "$HOST" "set -e
  docker image inspect $IMAGE >/dev/null 2>&1 && docker tag $IMAGE ${IMAGE}-prev || true
  docker load -i /tmp/skylit-image.tar >/dev/null
  rm -f /tmp/skylit-image.tar" || fail "image load"

deploy_image() {
  ssh -o BatchMode=yes "$HOST" "cd $REMOTE_DIR/repo/deploy && GATEWAY_IMAGE=$1 docker compose -p skylit --env-file $REMOTE_DIR/.env up -d --no-build --force-recreate gateway" 2>&1 | tail -3
}

echo "== recreating the gateway container"
deploy_image "$IMAGE" || fail "compose up"

echo "== verifying through the container"
ok=1
for path in "${CHECKS[@]}"; do
  code=$(ssh -o BatchMode=yes "$HOST" "curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${ORIGIN#https://}' http://127.0.0.1:23881$path")
  echo "   $path -> $code"
  [ "$code" = "200" ] || ok=0
done
status=$(ssh -o BatchMode=yes "$HOST" "curl -s -H 'Host: ${ORIGIN#https://}' http://127.0.0.1:23881/_gateway/status")
echo "   status -> $(echo "$status" | head -c 240)"
echo "$status" | grep -q '"status":"ok"' || ok=0

# A missing snapshot file is the failure mode that silently turned pages into 404s once.
missing=$(ssh -o BatchMode=yes "$HOST" "docker logs --since 2m skylit-gateway-1 2>&1 | grep -c 'cannot read\|frontend mirror: missing' || true")
[ "${missing:-0}" = "0" ] || { echo "   snapshot reads failed ${missing}x"; ok=0; }

if [ "$ok" != "1" ]; then
  echo "== checks failed; rolling back to ${IMAGE}-prev"
  if ssh -o BatchMode=yes "$HOST" "docker image inspect ${IMAGE}-prev >/dev/null 2>&1"; then
    deploy_image "${IMAGE}-prev" || echo "rollback also failed; manual action needed" >&2
  else
    echo "no previous image to roll back to" >&2
  fi
  fail "verification"
fi

echo "== deployed: $IMAGE ($ORIGIN)"
