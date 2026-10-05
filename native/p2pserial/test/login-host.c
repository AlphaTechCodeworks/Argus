// login-host: a small C host for the vendor SDK, to watch libp2pserial.so at work without the app
// (test.sh). It logs in by serial number (NET_SDK_LoginEx, connect type 2) through a documentation
// address, so nothing leaves the machine: the login fails after about 20 s with error 8, and the
// add-on's line on stderr (P2P_SERIAL_LOG=1) shows which device code reached the NAT library.
//   login-host [--addon LIB [--add SERIAL]] [--load-only] SDK HOST PORT SERIAL
//   --addon LIB    dlopen LIB with RTLD_GLOBAL before the SDK, as the app's koffi.load(.., { global: true });
//                  without it the add-on comes from LD_PRELOAD (or is not there at all)
//   --add SERIAL   call p2pserial_add(SERIAL) in LIB
//   --load-only    stop once the SDK is loaded (for LD_DEBUG=bindings LD_BIND_NOW=1)
// The SDK is opened as koffi opens it: dlopen(RTLD_NOW), local. Exit code 0 when every step ran
// (whatever the login returned), 2 for bad arguments or a missing library.
#include <arpa/inet.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static int documentation_address(const char *host) {
  struct in_addr a;
  if (inet_pton(AF_INET, host, &a) != 1) return 0;
  unsigned ip = ntohl(a.s_addr) >> 8;
  return ip == 0xC00002 /* 192.0.2.0/24 */ || ip == 0xC63364 /* 198.51.100.0/24 */ || ip == 0xCB0071 /* 203.0.113.0/24 */;
}

static double now_s(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}

static void *need(void *lib, const char *name) {
  void *p = dlsym(lib, name);
  if (!p) {
    fprintf(stderr, "login-host: %s not found\n", name);
    exit(2);
  }
  return p;
}

static int usage(void) {
  fprintf(stderr, "usage: login-host [--addon LIB [--add SERIAL]] [--load-only] SDK HOST PORT SERIAL\n");
  return 2;
}

int main(int argc, char **argv) {
  const char *addon = NULL, *add = NULL;
  int loadOnly = 0, i = 1;
  for (; i < argc && strncmp(argv[i], "--", 2) == 0; i++) {
    if (!strcmp(argv[i], "--addon") && i + 1 < argc) addon = argv[++i];
    else if (!strcmp(argv[i], "--add") && i + 1 < argc) add = argv[++i];
    else if (!strcmp(argv[i], "--load-only")) loadOnly = 1;
    else return usage();
  }
  if (argc - i != 4 || (add && !addon)) return usage();
  const char *sdkPath = argv[i], *serial = argv[i + 3];
  int port = atoi(argv[i + 2]);
  char host[64];
  snprintf(host, sizeof host, "%s", argv[i + 1]);
  if (!documentation_address(host)) {
    fprintf(stderr, "login-host: offline test only: %s is not a documentation address (192.0.2.x, 198.51.100.x, 203.0.113.x)\n", host);
    return 2;
  }
  setvbuf(stdout, NULL, _IOLBF, 0);

  if (addon) {
    void *a = dlopen(addon, RTLD_NOW | RTLD_GLOBAL);
    if (!a) {
      fprintf(stderr, "login-host: %s\n", dlerror());
      return 2;
    }
    if (add) {
      int (*p2pserial_add)(const char *) = (int (*)(const char *))need(a, "p2pserial_add");
      int (*p2pserial_count)(void) = (int (*)(void))need(a, "p2pserial_count");
      int r = p2pserial_add(add);
      printf("p2pserial_add(%s) -> %d, count %d\n", add, r, p2pserial_count());
    }
  }
  void *sdk = dlopen(sdkPath, RTLD_NOW);
  if (!sdk) {
    fprintf(stderr, "login-host: %s\n", dlerror());
    return 2;
  }
  if (loadOnly) {
    printf("loaded %s\n", sdkPath);
    return 0;
  }

  // DVR_NET_SDK.h on x86-64 Linux: BOOL is bool, LONG is 64 bits, WORD 16, DWORD 32
  _Bool (*Init)(void) = (_Bool (*)(void))need(sdk, "NET_SDK_Init");
  _Bool (*Cleanup)(void) = (_Bool (*)(void))need(sdk, "NET_SDK_Cleanup");
  _Bool (*SetNat2Addr)(char *, unsigned short) = (_Bool (*)(char *, unsigned short))need(sdk, "NET_SDK_SetNat2Addr");
  long (*LoginEx)(char *, unsigned short, char *, char *, void *, int, const char *) =
      (long (*)(char *, unsigned short, char *, char *, void *, int, const char *))need(sdk, "NET_SDK_LoginEx");
  unsigned (*GetLastError)(void) = (unsigned (*)(void))need(sdk, "NET_SDK_GetLastError");

  printf("NET_SDK_Init -> %d\n", Init());
  printf("NET_SDK_SetNat2Addr(%s, %d) -> %d\n", host, port, SetNat2Addr(host, (unsigned short)port));
  static char info[4096]; // NET_SDK_DEVICEINFO is smaller
  char user[] = "offline", pass[] = "offline";
  double t = now_s();
  long id = LoginEx(host, (unsigned short)port, user, pass, info, 2 /* NET_SDK_CONNECT_NAT20 */, serial);
  double took = now_s() - t;
  printf("NET_SDK_LoginEx -> %ld after %.1f s, last error %u\n", id, took, GetLastError());
  t = now_s();
  _Bool ok = Cleanup();
  printf("NET_SDK_Cleanup -> %d after %.1f s\n", ok, now_s() - t);
  return 0;
}
