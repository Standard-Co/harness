#!/usr/bin/env bash
# Build the Standard image and smoke-test it.
#   scripts/build-image.sh [extra docker build args...]
# Tags standard-co/harness:<git sha12> and standard-co/harness:dev.
set -euo pipefail

cd "$(dirname "$0")/.."
fail() { echo "build-image: $*" >&2; exit 1; }

command -v docker >/dev/null || fail "docker not found"
sha=$(git rev-parse --short=12 HEAD) || fail "not a git checkout"
if [ -n "$(git status --porcelain)" ]; then
  echo "build-image: warning: working tree is dirty; :$sha will not match the commit" >&2
fi

image=standard-co/harness
docker build --tag "$image:$sha" --tag "$image:dev" "$@" . || fail "docker build failed"

# Smoke: `state` needs no API key. It should open an empty state volume and
# report no entries.
volume=$(docker volume create) || fail "could not create smoke volume"
trap 'docker volume rm -f "$volume" >/dev/null' EXIT
out=$(docker run --rm -v "$volume:/work/.standard" "$image:$sha" state 2>&1) \
  || { echo "$out" >&2; fail "smoke run exited non-zero"; }
echo "$out"
grep -qF "(no continual harness entries yet)" <<<"$out" || fail "smoke output did not match"

echo "build-image: ok $image:$sha"
