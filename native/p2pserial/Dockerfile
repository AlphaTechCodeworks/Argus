# Build environment for libp2pserial.so; build.sh drives it (see README.md).
# CentOS 7 with glibc 2.17 and GCC 10 (devtoolset-10), pinned by digest so every build uses the same
# compiler and C library: the result runs on any x86-64 Linux with glibc 2.17 or newer. The compile
# step itself has no network.
FROM quay.io/pypa/manylinux2014_x86_64@sha256:ffd6d1f11237599748657996b750db6b3a5b724fea5a81cd9ea65add4f45b6c9 AS build
ENV LC_ALL=C
WORKDIR /p2pserial
COPY p2pserial.cpp exports.map check-lib.sh ./
# Compiled as C++ (the stand-in needs the vendor's mangled name) but linked with the C driver, so
# neither libstdc++ nor libgcc_s is linked; -z defs turns anything from the C++ runtime that slips
# in (a guarded static, operator new) into a link error. -z now: everything it needs is resolved
# when it is loaded, not later on an SDK thread. -z nodelete: once the SDK's call is bound to this
# library it must never be unmapped (dlclose, koffi's unload).
RUN --network=none \
    g++ -std=gnu++11 -O2 -fPIC -fvisibility=hidden -fno-exceptions -fno-rtti -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
        -Wall -Wextra -Werror -c p2pserial.cpp -o p2pserial.o \
 && gcc -shared -o libp2pserial.so p2pserial.o -Wl,-soname,libp2pserial.so -Wl,--version-script,exports.map \
        -Wl,-z,defs -Wl,-z,now -Wl,-z,relro -Wl,-z,nodelete -Wl,-z,noexecstack -ldl -lpthread \
 && sh check-lib.sh libp2pserial.so >check.txt \
 && cat check.txt
