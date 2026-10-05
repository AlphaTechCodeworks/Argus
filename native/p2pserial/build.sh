#!/usr/bin/env bash
# Builds bin/linux/libp2pserial.so from p2pserial.cpp in Docker (Dockerfile: CentOS 7, glibc 2.17,
# GCC 10, pinned by digest), checks it (check-lib.sh) and writes it to bin/linux. Prints the
# checks' summary. The same source and image give the same file, byte for byte.
#   native/p2pserial/build.sh
# The first run downloads the build image (quay.io/pypa/manylinux2014_x86_64, about 1.7 GB
# unpacked); the compile step runs without network. No folder is shared with the container (Docker
# Desktop's folder sharing can hang): the source goes in as the build context, and the library
# comes back on stdout and is compared with the sha256 the container computed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../bin/linux/libp2pserial.so"
tag=cctv-p2pserial-build:local
export MSYS_NO_PATHCONV=1 # Git Bash: hand the container paths below to docker unchanged
export DOCKER_BUILDKIT=1  # RUN --network=none

cd "$here"
docker build --target build -t "$tag" . >&2
summary=$(docker run --rm --network none "$tag" cat /p2pserial/check.txt)
want=$(sed -n 's/^sha256 *//p' <<<"$summary")
part="$out.part"
trap 'rm -f "$part"' EXIT
docker run --rm --network none "$tag" cat /p2pserial/libp2pserial.so >"$part"
got=$(sha256sum "$part" | cut -d' ' -f1)
if [[ -z $want || $got != "$want" ]]; then
  echo "the library was damaged on the way out of the container (sha256 $got, expected ${want:-none})" >&2
  exit 1
fi
chmod 755 "$part"
mv -f "$part" "$out"
echo "$summary"
echo "written to bin/linux/libp2pserial.so"
