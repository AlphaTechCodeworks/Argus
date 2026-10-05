# Test image for test.sh: the app image (node, koffi) with the repository's bin/linux libraries and
# the test helpers, compiled in the add-on's build image (glibc 2.17, so they run on the app image).
# Built by test.sh from a staging folder that holds test/ and lib/ (a copy of bin/linux).
ARG BUILD_IMAGE=cctv-p2pserial-build:local
ARG APP_IMAGE=tvt-cctv:latest

FROM ${BUILD_IMAGE} AS tools
WORKDIR /tools
COPY test/login-host.c test/stress.c test/fake-nat.c ./
RUN --network=none \
    gcc -std=gnu99 -O2 -Wall -Wextra -Werror -o login-host login-host.c -ldl \
 && gcc -std=gnu99 -O2 -Wall -Wextra -Werror -o stress stress.c -ldl -lpthread \
 && gcc -std=gnu99 -O2 -Wall -Wextra -Werror -shared -fPIC -Wl,-soname,libNatClientSDK.so.1 -o libNatClientSDK.so.1 fake-nat.c

FROM ${APP_IMAGE}
COPY lib/ /p2ps/lib/
COPY --from=tools /tools/login-host /tools/stress /p2ps/bin/
COPY --from=tools /tools/libNatClientSDK.so.1 /p2ps/fake/
COPY test/koffi-login.mjs /app/p2ps-test/
ENV LD_LIBRARY_PATH=/p2ps/lib
