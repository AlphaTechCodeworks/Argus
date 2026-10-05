#!/bin/sh
# Checks a built libp2pserial.so (the Dockerfile runs it in the build image, right after linking).
# It may need only libc, libdl and libpthread, at glibc 2.17 or older; it exports exactly its four
# functions, uses nothing from the C++ runtime, has no thread-local storage or text relocations,
# and keeps the NOW and NODELETE flags. Prints a summary; exits 1, with the reasons on stderr, if
# anything is off.
#   sh check-lib.sh libp2pserial.so
set -eu
export LC_ALL=C
lib=${1:?usage: check-lib.sh libp2pserial.so}
fail=0
miss() {
  echo "check-lib: $*" >&2
  fail=1
}

needed=$(readelf -d "$lib" | sed -n 's/.*(NEEDED).*\[\(.*\)\]$/\1/p' | sort | tr '\n' ' ')
[ "$needed" = "libc.so.6 libdl.so.2 libpthread.so.0 " ] || miss "needs $needed(allowed: libc.so.6 libdl.so.2 libpthread.so.0)"

exports=$(nm -D --defined-only "$lib" | awk '{ print $3 }' | sort | tr '\n' ' ')
[ "$exports" = "_Z21NAT_CLIENT_ConnectDevRK24_tag_client_connect_infobi p2pserial_add p2pserial_clear p2pserial_count " ] || miss "exports $exports"

cxx=$(nm -D --undefined-only "$lib" | awk '{ print $2 }' | grep -E '^(_Z|__gxx_|__cxa_(guard|throw|allocate|begin_catch|end_catch|pure_virtual|rethrow))' | tr '\n' ' ' || true)
[ -z "$cxx" ] || miss "uses the C++ runtime: $cxx"

glibc=$(objdump -T "$lib" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//' | sort -u -V | tail -n 1)
[ "$(printf '%s\n2.17\n' "$glibc" | sort -V | tail -n 1)" = 2.17 ] || miss "needs glibc $glibc (2.17 at most)"

if readelf -lW "$lib" | grep -q '^ *TLS '; then miss "has thread-local storage"; fi
if readelf -d "$lib" | grep -q TEXTREL; then miss "has text relocations"; fi
if readelf -lW "$lib" | grep '^ *GNU_STACK ' | grep -q 'RWE'; then miss "asks for an executable stack"; fi
flags=$(readelf -d "$lib" | sed -n 's/.*(FLAGS_1).*Flags: *//p')
case " $flags " in *" NOW "*) ;; *) miss "FLAGS_1 lacks NOW ($flags)" ;; esac
case " $flags " in *" NODELETE "*) ;; *) miss "FLAGS_1 lacks NODELETE ($flags)" ;; esac

echo "file     $lib, $(wc -c <"$lib") bytes"
echo "sha256   $(sha256sum "$lib" | cut -d' ' -f1)"
echo "needs    $needed"
echo "exports  $exports"
echo "glibc    $glibc (the newest GLIBC_ symbol version it uses)"
echo "flags    $flags"
exit $fail
