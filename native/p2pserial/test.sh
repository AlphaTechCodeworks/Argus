#!/usr/bin/env bash
# Offline tests of libp2pserial.so (README.md), in Docker containers without network:
#   build     p2pserial.cpp builds (and passes check-lib.sh) to exactly bin/linux/libp2pserial.so
#   logins    the vendor SDK logs in by serial through 203.0.113.1 (a documentation address, so the
#             login fails after about 20 s with error 8): a registered serial goes to the NAT library
#             plain, an unregistered one unchanged, and the process exits cleanly. The add-on comes
#             from LD_PRELOAD (C host), from dlopen(RTLD_GLOBAL) (C host) and from
#             koffi.load(.., { global: true }) (node, as the app loads it)
#   bindings  LD_DEBUG=bindings LD_BIND_NOW=1: the SDK's NAT_CLIENT_ConnectDev binds to the add-on,
#             and without it to libNatClientSDK.so.1
#   stress    threads adding, clearing and looking up at once; edge cases; whole log lines; a
#             missing or misnamed NAT library (a stand-in NAT library, test/fake-nat.c, no SDK)
#   native/p2pserial/test.sh                  about a minute (the logins run side by side)
#   APP_IMAGE=tvt-cctv:latest                 the app image the tests run in (the default: node + koffi)
#   SANITIZER_IMAGE=<image with gcc, libtsan>  also run the stress test under ThreadSanitizer and
#                                             AddressSanitizer, compiled in that image
#   TEST_NAME=<prefix>                        container names (default p2pserial-test-<pid>)
# Needs the build image of build.sh (built here when missing) and the app image; nothing else is
# downloaded. Exit code 0 when everything passed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
APP_IMAGE=${APP_IMAGE:-tvt-cctv:latest}
build_tag=cctv-p2pserial-build:local
test_tag=cctv-p2pserial-test:local
run=${TEST_NAME:-p2pserial-test-$$} # container names start with this (TEST_NAME: to choose it)
export MSYS_NO_PATHCONV=1 # Git Bash: hand the container paths below to docker unchanged
export DOCKER_BUILDKIT=1
P2P=203.0.113.1
SERIAL=TESTSERIAL0000
SERIAL_MD5=EABE3EA41FB62077FB81B590E6FD6116 # md5sum, upper case
SDK=/p2ps/lib/libdvrnetsdk.so
ADDON=/p2ps/lib/libp2pserial.so
BINDING="binding file [^ ]*libdvrnetsdk\.so \[0\] to [^ ]*/libp2pserial\.so \[0\]: normal symbol .?_Z21NAT_CLIENT_ConnectDev"

PASS=0
FAIL=0
check() { # check NAME 1|0 [EXTRA]
  if [[ $2 == 1 ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
  echo "$([[ $2 == 1 ]] && echo PASS || echo FAIL)  $1${3:+  ($3)}"
}
has() { grep -qE -- "$2" <<<"$1" && echo 1 || echo 0; }
hasnt() { grep -qE -- "$2" <<<"$1" && echo 0 || echo 1; }
# the PASS/FAIL lines of a helper's output, counted here
relay() {
  local line
  while IFS= read -r line; do
    case $line in
      PASS*) PASS=$((PASS + 1)) && echo "$line" ;;
      FAIL*) FAIL=$((FAIL + 1)) && echo "$line" ;;
    esac
  done <<<"$1"
}

stage=$(mktemp -d)
cleanup() {
  docker ps -aq --filter "name=^$run-" | xargs -r docker rm -f >/dev/null 2>&1 || true
  rm -rf "$stage"
}
trap cleanup EXIT

[[ -f $root/bin/linux/libp2pserial.so ]] || { echo "bin/linux/libp2pserial.so is missing: run native/p2pserial/build.sh" >&2; exit 1; }
echo "building the add-on and the test image ..."
(cd "$here" && docker build -q --target build -t "$build_tag" . >/dev/null)
fresh=$(docker run --rm --network none "$build_tag" sha256sum /p2pserial/libp2pserial.so | cut -c1-64)
committed=$(sha256sum "$root/bin/linux/libp2pserial.so" | cut -c1-64)
check "bin/linux/libp2pserial.so is what build.sh makes from p2pserial.cpp" "$([[ $fresh == "$committed" ]] && echo 1 || echo 0)" "sha256 ${committed:0:16}..."
mkdir -p "$stage/lib" "$stage/test"
cp "$root"/bin/linux/*.so* "$stage/lib/"
cp "$here"/test/* "$stage/test/"
(cd "$stage" && docker build -q -f test/Dockerfile --build-arg "BUILD_IMAGE=$build_tag" --build-arg "APP_IMAGE=$APP_IMAGE" -t "$test_tag" . >/dev/null)

# ---- logins (side by side, about 22 s each)
login() { # login NAME [docker options] -- COMMAND...
  local name=$1 opts=()
  shift
  while [[ $1 != -- ]]; do opts+=("$1") && shift; done
  shift
  docker run -d --network none --name "$run-$name" "${opts[@]}" "$test_tag" "$@" >/dev/null
}
login preload-reg -e LD_PRELOAD=$ADDON -e P2P_PLAIN_SERIALS=$SERIAL -e P2P_SERIAL_LOG=1 -- /p2ps/bin/login-host $SDK $P2P 9969 $SERIAL
login preload-unreg -e LD_PRELOAD=$ADDON -e P2P_SERIAL_LOG=1 -- /p2ps/bin/login-host $SDK $P2P 9969 $SERIAL
login dlopen-reg -e P2P_SERIAL_LOG=1 -- /p2ps/bin/login-host --addon $ADDON --add $SERIAL $SDK $P2P 9969 $SERIAL
login koffi-reg -e P2P_SERIAL_LOG=1 -- node /app/p2ps-test/koffi-login.mjs $ADDON $SDK $P2P 9969 $SERIAL
login koffi-unreg -e P2P_SERIAL_LOG=1 -- node /app/p2ps-test/koffi-login.mjs $ADDON $SDK $P2P 9969 $SERIAL --no-add

# ---- bindings (no login)
quick() { docker run --rm --network none --name "$run-$1" "${@:2}" 2>&1 || true; }
sdk_binding() { grep -E 'binding file [^ ]*libdvrnetsdk\.so .*NAT_CLIENT_ConnectDev' <<<"$1" | sed -E 's/^ *[0-9]+:\s*//' | head -n 1; }
out=$(quick bind-preload -e LD_PRELOAD=$ADDON -e LD_BIND_NOW=1 -e LD_DEBUG=bindings "$test_tag" /p2ps/bin/login-host --load-only $SDK $P2P 9969 $SERIAL | grep -E 'NAT_CLIENT_ConnectDev' || true)
check "bindings, LD_PRELOAD: the SDK's NAT_CLIENT_ConnectDev binds to libp2pserial.so" "$(has "$out" "$BINDING")" "$(sdk_binding "$out")"
out=$(quick bind-koffi -e LD_BIND_NOW=1 -e LD_DEBUG=bindings "$test_tag" node /app/p2ps-test/koffi-login.mjs $ADDON $SDK $P2P 9969 $SERIAL --load-only | grep -E 'NAT_CLIENT_ConnectDev' || true)
check "bindings, koffi { global: true }: the SDK's NAT_CLIENT_ConnectDev binds to libp2pserial.so" "$(has "$out" "$BINDING")" "$(sdk_binding "$out")"
out=$(quick bind-none -e LD_BIND_NOW=1 -e LD_DEBUG=bindings "$test_tag" /p2ps/bin/login-host --load-only $SDK $P2P 9969 $SERIAL | grep -E 'NAT_CLIENT_ConnectDev' || true)
check "bindings, no add-on: it binds to libNatClientSDK.so.1 (so the two checks above can fail)" "$(has "$out" 'libdvrnetsdk\.so \[0\] to [^ ]*/libNatClientSDK\.so\.1 \[0\]')" "$(sdk_binding "$out")"

# ---- stress (stand-in NAT library)
# 300 serials of 4 to 63 characters (both MD5 padding cases), each with its MD5 from md5sum
list='for i in $(seq 0 299); do s="$(printf "N%03d" "$i")$(head -c $((i * 7 % 60)) /dev/zero | tr "\000" X)"; printf "%s %s\n" "$s" "$(printf %s "$s" | md5sum | cut -c1-32 | tr a-f A-F)"; done >/tmp/list'
out=$(quick stress "$test_tag" sh -c "$list; /p2ps/bin/stress run $ADDON /p2ps/fake/libNatClientSDK.so.1 </tmp/list; echo \"exit code \$?\"")
relay "$out"
check "stress: exit code 0" "$(has "$out" '^exit code 0$')" ""
out=$(quick stress-log -e P2P_SERIAL_LOG=1 -e STRESS_ITERS=2000 "$test_tag" sh -c "$list; /p2ps/bin/stress run $ADDON /p2ps/fake/libNatClientSDK.so.1 </tmp/list >/dev/null 2>/tmp/log; echo \"lines \$(wc -l </tmp/log) other \$(grep -cvE '^p2pserial: device code [0-9A-Z]{1,40} (-> plain serial [0-9A-Z]+|passed through unchanged)\$' /tmp/log)\"")
check "P2P_SERIAL_LOG=1 with 8 threads: every log line whole (one write per line)" "$(has "$out" '^lines [0-9]{4,} other 0$')" "$out"
out=$(quick missing "$test_tag" sh -c "/p2ps/bin/stress missing $ADDON; echo \"exit code \$?\"")
relay "$out"
check "  ... and it says so on stderr" "$(has "$out" 'the vendor NAT_CLIENT_ConnectDev was not found')" ""
out=$(quick self "$test_tag" sh -c "mkdir /tmp/self && cp $ADDON /tmp/self/libNatClientSDK.so.1 && LD_LIBRARY_PATH=/tmp/self /p2ps/bin/stress self; echo \"exit code \$?\"")
relay "$out"
check "  ... exit code 0 (not 139)" "$(has "$out" '^exit code 0$')" "$(grep '^exit code' <<<"$out" || true)"

# ---- sanitizers (optional)
if [[ -n ${SANITIZER_IMAGE:-} ]]; then
  docker create --name "$run-san" --network none --entrypoint sh "$SANITIZER_IMAGE" -c "set -e; cd /tmp/p2pserial; $list; fail=0
    for s in thread address; do
      mkdir -p /tmp/\$s
      g++ -std=gnu++11 -O1 -g -fsanitize=\$s -fPIC -shared -o /tmp/\$s/libp2pserial.so p2pserial.cpp -ldl -lpthread
      gcc -O1 -g -fsanitize=\$s -fPIC -shared -Wl,-soname,libNatClientSDK.so.1 -o /tmp/\$s/libNatClientSDK.so.1 test/fake-nat.c
      gcc -O1 -g -fsanitize=\$s -o /tmp/\$s/stress test/stress.c -ldl -lpthread
      STRESS_ITERS=5000 TSAN_OPTIONS=halt_on_error=1 ASAN_OPTIONS=halt_on_error=1 /tmp/\$s/stress run /tmp/\$s/libp2pserial.so /tmp/\$s/libNatClientSDK.so.1 </tmp/list >/tmp/\$s/out 2>&1 || fail=1
      sed \"s/^\\(PASS\\|FAIL\\)  /\\1  \$s sanitizer: /\" /tmp/\$s/out
    done
    if [ \$fail = 0 ]; then echo sanitizers clean; fi" >/dev/null
  tar -C "$here/.." -cf - p2pserial/p2pserial.cpp p2pserial/test | docker cp - "$run-san:/tmp"
  out=$(docker start -a "$run-san" 2>&1 || true)
  relay "$out"
  check "ThreadSanitizer and AddressSanitizer: no reports" "$(($(hasnt "$out" 'WARNING: ThreadSanitizer|ERROR: AddressSanitizer|ERROR: LeakSanitizer') & $(has "$out" '^sanitizers clean$')))" ""
fi

# ---- logins: results
echo "waiting for the logins ..."
for s in preload-reg preload-unreg dlopen-reg koffi-reg koffi-unreg; do
  rc=$(docker wait "$run-$s")
  out=$(docker logs "$run-$s" 2>&1)
  login_line=$(grep -E '^NET_SDK_LoginEx' <<<"$out" || true)
  ok=$(($(has "$out" '^NET_SDK_SetNat2Addr\(203\.0\.113\.1, 9969\) -> 1$') & $(has "$out" '^NET_SDK_LoginEx -> -1 after (19|2[0-3])\.[0-9] s, last error 8$') & $(has "$out" '^NET_SDK_Cleanup -> 1 ') & $([[ $rc == 0 ]] && echo 1 || echo 0)))
  check "$s: login refused with error 8 after about 20 s, Cleanup, exit code 0" "$ok" "${login_line#NET_SDK_LoginEx }, exit code $rc"
  case $s in
    *-reg) check "$s: the NAT library got the plain serial" "$(has "$out" "^p2pserial: device code $SERIAL_MD5 -> plain serial $SERIAL\$")" "" ;;
    *-unreg) check "$s: the NAT library got the MD5, unchanged" "$(($(has "$out" "^p2pserial: device code $SERIAL_MD5 passed through unchanged\$") & $(hasnt "$out" 'plain serial')))" "" ;;
  esac
  [[ $ok == 1 ]] || sed 's/^/    | /' <<<"$out" | tail -n 15
done

if ((FAIL)); then echo && echo "$FAIL FAILED, $PASS passed" && exit 1; fi
echo && echo "ALL PASSED ($PASS)"
