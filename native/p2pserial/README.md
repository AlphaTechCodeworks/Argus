# libp2pserial.so

A small add-on library for the vendor TVT SDK on Linux. With it, the SDK can log in to an NVR by
its serial number through the Eye in Cloud / Provision / TVT P2P cloud ("P2P 2.0",
`NET_SDK_LoginEx` with connect type 2). It ships as `bin/linux/libp2pserial.so`, next to the
vendor libraries, none of which is modified.

## Why it exists

For a login by serial number, `libdvrnetsdk.so` (`CNetDeviceMan::AddDevice`) replaces the serial
with its upper-case MD5 and hands that to `libNatClientSDK.so.1` as the device code. The cloud
knows these NVRs by the plain serial, so every lookup server answers "not online" and
`NET_SDK_LoginEx` returns -1 with last error 8 after a fixed 20 s. `libdvrnetsdk.so` calls
`NAT_CLIENT_ConnectDev` through its PLT, so a library that comes earlier in the symbol search order
can stand in front of it: this one puts the plain serial back for the serials registered with it,
and passes every other call through unchanged. Tested on 2026-10-04 with the unmodified vendor
libraries: logged in to NB8AF056T0D2 through `cli-nat20.eyeincloud.com:9969` in 4.6 s and played
live video; the same cloud also answered through `device.provisionisr-nat2.com:9968` and
`c2020.autonat.com:7968`. The transport is UDP only.

## How it is loaded

It must be earlier in the symbol search order than the SDK, in one of two ways:

- `koffi.load('bin/linux/libp2pserial.so', { global: true })` **before**
  `koffi.load('bin/linux/libdvrnetsdk.so')` (dlopen with `RTLD_GLOBAL`), or
- `LD_PRELOAD=/path/to/libp2pserial.so` for the whole process.

Do not load the SDK with `{ deep: true }`: `RTLD_DEEPBIND` makes the SDK find the vendor function
first and the add-on is bypassed. Once loaded it is never unmapped (`NODELETE`), so a dlclose or a
koffi unload cannot pull it out from under the SDK.

| Function | |
|---|---|
| `int p2pserial_add(const char *serial)` | Registers a serial: its P2P 2.0 logins use the plain serial. Call it before `NET_SDK_LoginEx`, with exactly the string given to `NET_SDK_LoginEx` (the MD5 is case-sensitive). Returns 1 when it is registered (also when it already was), 0 when the serial is empty, longer than 63 characters, or the table (256 serials) is full. |
| `void p2pserial_clear(void)` | Forgets every registered serial. |
| `int p2pserial_count(void)` | How many serials are registered. |

All three may be called from any thread at any time, also while logins are running.

| Environment | |
|---|---|
| `P2P_PLAIN_SERIALS=A,B` | Serials to register when the library is loaded (separated by commas, spaces or semicolons). |
| `P2P_SERIAL_LOG=1` | One line on stderr per `NAT_CLIENT_ConnectDev` call: `p2pserial: device code <MD5> -> plain serial <serial>` or `... passed through unchanged`. |

Related SDK behaviour the caller has to handle (not changed by the add-on): with connect type 2
the address given to `NET_SDK_LoginEx` is ignored and only the one given to `NET_SDK_SetNat2Addr`
counts; `NET_SDK_SetNat2Addr` takes effect once per process (later calls return false and change
nothing); and a process that exits within about 30 s of a serial login attempt must call
`NET_SDK_Cleanup` first, or a NAT thread of the SDK crashes during exit.

## Rebuild

```sh
native/p2pserial/build.sh
```

It builds in Docker on CentOS 7 (glibc 2.17, GCC 10; `quay.io/pypa/manylinux2014_x86_64`, pinned
by digest in `Dockerfile`), checks the result with `check-lib.sh` and writes
`bin/linux/libp2pserial.so`. The first run downloads the build image; the compile step runs without
network, and no folder is shared with the container. The same source gives the same file byte for
byte. The result needs only `libc.so.6`, `libdl.so.2` and `libpthread.so.0` (no libstdc++, no
libgcc_s), uses no glibc symbol newer than `GLIBC_2.4`, and exports only the four functions above
(`NAT_CLIENT_ConnectDev` under its C++ name `_Z21NAT_CLIENT_ConnectDevRK24_tag_client_connect_infobi`).

## Test

```sh
native/p2pserial/test.sh
SANITIZER_IMAGE=<an image with gcc and libtsan> native/p2pserial/test.sh
```

Offline (containers without network, P2P server 203.0.113.1, a documentation address). It checks
that `bin/linux/libp2pserial.so` is what `build.sh` makes; runs serial logins with the vendor SDK
(the add-on from `LD_PRELOAD`, from `dlopen(RTLD_GLOBAL)` and from koffi `{ global: true }`) and
checks which device code reached the NAT library, that the login fails with error 8 after about
20 s and that the process exits cleanly; checks with `LD_DEBUG=bindings` that the SDK's call binds
to the add-on; and runs a stress test with threads adding, clearing and looking up serials at the
same time against a stand-in NAT library (`test/fake-nat.c`). It runs in the app image
(`tvt-cctv:latest`, or `APP_IMAGE=...`) and takes about a minute and a half.

## Files

- `p2pserial.cpp` the library
- `exports.map` the four exported symbols
- `Dockerfile` build environment and build step; `check-lib.sh` checks the result
- `build.sh` builds and writes `bin/linux/libp2pserial.so`
- `test.sh`, `test/` offline tests (`login-host.c` a small C host for the SDK, `koffi-login.mjs`
  the same in node, `stress.c` + `fake-nat.c` the stress test, `Dockerfile` the test image)
