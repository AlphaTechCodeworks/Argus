// libp2pserial.so
//
// The vendor SDK (libdvrnetsdk.so, CNetDeviceMan::AddDevice) turns the serial number into its
// upper-case MD5 before a P2P 2.0 login and hands that to libNatClientSDK.so.1 as the device code.
// The cloud knows these NVRs by their plain serial, so it answers "not online" and
// NET_SDK_LoginEx(..., NET_SDK_CONNECT_NAT20, serial) fails with error 8 after 20 s.
//
// libdvrnetsdk.so calls NAT_CLIENT_ConnectDev through its PLT, so a library that is earlier in the
// symbol search order can stand in front of it. This one does only that: for serials registered
// with p2pserial_add() (or listed in P2P_PLAIN_SERIALS) it puts the plain serial back and calls the
// real function. Every other call passes through unchanged. No vendor file is modified.
//
// Load order: LD_PRELOAD=/path/libp2pserial.so, or dlopen it with RTLD_GLOBAL before
// libdvrnetsdk.so (koffi.load(path, { global: true })). Not compatible with RTLD_DEEPBIND on the SDK.
//
//   P2P_PLAIN_SERIALS=SERIAL1,SERIAL2   serials to register at load time (optional)
//   P2P_SERIAL_LOG=1                    one line on stderr per ConnectDev call
//
// It runs inside the app's process, on the SDK's threads, so it is kept small and self-contained:
// no C++ runtime (no exceptions, RTTI, guarded statics or operator new; linked without libstdc++),
// no thread-local storage, nothing large on the caller's stack, and it never calls itself. Built
// on glibc 2.17 by build.sh, which checks the linked result (check-lib.sh); test.sh tests it.
#include <dlfcn.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// same name and layout as the vendor's struct, so the function below gets the vendor's mangled name
struct _tag_client_connect_info {
  uint32_t dwIdType;   // 0 = by device code
  char szDevId[0x1000];
};

// ---- MD5 (RFC 1321) -----------------------------------------------------------------------
static const uint32_t K[64] = {
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1,
    0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453,
    0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942,
    0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d,
    0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391};
static const int R[64] = {7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9,  14, 20, 5, 9,  14, 20, 5, 9,  14, 20, 5, 9,  14, 20,
                          4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21};

static void md5_block(uint32_t h[4], const unsigned char *p) {
  uint32_t w[16];
  for (int i = 0; i < 16; i++) w[i] = (uint32_t)p[i * 4] | (uint32_t)p[i * 4 + 1] << 8 | (uint32_t)p[i * 4 + 2] << 16 | (uint32_t)p[i * 4 + 3] << 24;
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
  for (int i = 0; i < 64; i++) {
    uint32_t f;
    int g;
    if (i < 16) f = (b & c) | (~b & d), g = i;
    else if (i < 32) f = (d & b) | (~d & c), g = (5 * i + 1) & 15;
    else if (i < 48) f = b ^ c ^ d, g = (3 * i + 5) & 15;
    else f = c ^ (b | ~d), g = (7 * i) & 15;
    uint32_t x = a + f + K[i] + w[g];
    a = d, d = c, c = b;
    b += (x << R[i]) | (x >> (32 - R[i]));
  }
  h[0] += a, h[1] += b, h[2] += c, h[3] += d;
}

// 32 upper-case hex characters + NUL, as the vendor's PUB_MD5Encrypt(.., upper = true)
static void md5_upper_hex(const char *s, char out[33]) {
  uint32_t h[4] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476};
  size_t len = strlen(s), off = 0;
  for (; off + 64 <= len; off += 64) md5_block(h, (const unsigned char *)s + off);
  unsigned char tail[128];
  size_t rest = len - off, n = rest < 56 ? 64 : 128;
  memset(tail, 0, sizeof tail);
  memcpy(tail, s + off, rest);
  tail[rest] = 0x80;
  uint64_t bits = (uint64_t)len * 8;
  for (int i = 0; i < 8; i++) tail[n - 8 + i] = (unsigned char)(bits >> (8 * i));
  for (size_t i = 0; i < n; i += 64) md5_block(h, tail + i);
  static const char hex[] = "0123456789ABCDEF";
  for (int i = 0; i < 16; i++) {
    unsigned char v = (unsigned char)(h[i / 4] >> (8 * (i % 4)));
    out[i * 2] = hex[v >> 4];
    out[i * 2 + 1] = hex[v & 15];
  }
  out[32] = 0;
}

// ---- log lines --------------------------------------------------------------------------------
// One write() per line: lines from logins on several threads do not run into each other, and it
// needs little stack (fprintf to the unbuffered stderr puts an 8 KiB buffer on the caller's stack).
__attribute__((format(printf, 1, 2))) static void say(const char *fmt, ...) {
  char line[256];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(line, sizeof line - 1, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if (n > (int)sizeof line - 2) n = (int)sizeof line - 2;
  line[n++] = '\n';
  ssize_t w = write(2, line, (size_t)n);
  (void)w;
}

// ---- registered serials ---------------------------------------------------------------------
enum { MAX_SERIALS = 256, MAX_SERIAL_LEN = 63 };
static struct {
  char md5[33];
  char serial[MAX_SERIAL_LEN + 1];
} g_serials[MAX_SERIALS];
static int g_count;
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static int g_log; // set once by the constructor, before anything can call in

extern "C" {

// Registers a serial whose P2P 2.0 logins must use the plain serial. Returns 1 if it is registered
// (also when it already was), 0 if the serial is empty, too long or the table is full.
__attribute__((visibility("default"))) int p2pserial_add(const char *serial) {
  if (!serial) return 0;
  // copied first, so the length check, the MD5 and the table entry all see the same characters
  char plain[MAX_SERIAL_LEN + 1];
  size_t len = strnlen(serial, MAX_SERIAL_LEN + 1);
  if (len == 0 || len > MAX_SERIAL_LEN) return 0;
  memcpy(plain, serial, len);
  plain[len] = 0;
  char md5[33];
  md5_upper_hex(plain, md5);
  int ok = 1;
  pthread_mutex_lock(&g_mu);
  int i = 0;
  while (i < g_count && strcmp(g_serials[i].md5, md5) != 0) i++;
  if (i == g_count) {
    if (g_count == MAX_SERIALS) ok = 0;
    else {
      memcpy(g_serials[i].md5, md5, sizeof md5);
      memcpy(g_serials[i].serial, plain, len + 1);
      g_count++;
    }
  }
  pthread_mutex_unlock(&g_mu);
  return ok;
}

__attribute__((visibility("default"))) void p2pserial_clear(void) {
  pthread_mutex_lock(&g_mu);
  g_count = 0;
  pthread_mutex_unlock(&g_mu);
}

__attribute__((visibility("default"))) int p2pserial_count(void) {
  pthread_mutex_lock(&g_mu);
  int n = g_count;
  pthread_mutex_unlock(&g_mu);
  return n;
}

} // extern "C"

__attribute__((constructor)) static void p2pserial_init(void) {
  const char *l = getenv("P2P_SERIAL_LOG");
  g_log = l && l[0] == '1';
  const char *list = getenv("P2P_PLAIN_SERIALS");
  if (!list) return;
  // separated by commas, spaces or semicolons; read in place, so a long list is not cut short
  while (*list) {
    size_t n = strcspn(list, ", ;");
    if (n > 0 && n <= MAX_SERIAL_LEN) {
      char one[MAX_SERIAL_LEN + 1];
      memcpy(one, list, n);
      one[n] = 0;
      p2pserial_add(one);
    }
    list += n;
    if (*list) list++;
  }
}

// ---- the stand-in -----------------------------------------------------------------------------
typedef unsigned int (*connect_dev_fn)(const _tag_client_connect_info &, bool, int);
#define CONNECT_DEV_SYMBOL "_Z21NAT_CLIENT_ConnectDevRK24_tag_client_connect_infobi"

__attribute__((visibility("default"))) unsigned int NAT_CLIENT_ConnectDev(const _tag_client_connect_info &info, bool sync, int timeoutS);

// The vendor's function, looked up on the first call (libdvrnetsdk.so needs libNatClientSDK.so.1,
// so it is loaded by then). Logins can start on several threads at once: the address is read and
// stored with atomic operations, and threads that look it up at the same time find the same one.
static connect_dev_fn g_real;

static connect_dev_fn real_connect_dev(void) {
  connect_dev_fn f = __atomic_load_n(&g_real, __ATOMIC_ACQUIRE);
  if (f) return f;
  // RTLD_NOLOAD only finds the library if it is loaded already. The handle is kept open, so the
  // library, and the address stored below, stay valid for the life of the process.
  void *h = dlopen("libNatClientSDK.so.1", RTLD_NOW | RTLD_NOLOAD);
  void *p = h ? dlsym(h, CONNECT_DEV_SYMBOL) : nullptr;
  if (h && !p) dlclose(h);
  if (!p) p = dlsym(RTLD_NEXT, CONNECT_DEV_SYMBOL);
  f = (connect_dev_fn)p;
  if (f == &NAT_CLIENT_ConnectDev) f = nullptr; // this stand-in itself (a misnamed copy): calling it would never end
  if (f) __atomic_store_n(&g_real, f, __ATOMIC_RELEASE);
  return f;
}

__attribute__((visibility("default"))) unsigned int NAT_CLIENT_ConnectDev(const _tag_client_connect_info &info, bool sync, int timeoutS) {
  connect_dev_fn real = real_connect_dev();
  if (!real) {
    say("p2pserial: the vendor NAT_CLIENT_ConnectDev was not found; the connection is not attempted");
    return 0;
  }
  if (info.dwIdType == 0) {
    char serial[MAX_SERIAL_LEN + 1];
    serial[0] = 0;
    pthread_mutex_lock(&g_mu);
    for (int i = 0; i < g_count; i++)
      if (strncmp(g_serials[i].md5, info.szDevId, sizeof info.szDevId) == 0) {
        memcpy(serial, g_serials[i].serial, sizeof serial);
        break;
      }
    pthread_mutex_unlock(&g_mu);
    if (serial[0]) {
      // The copy only has to last for this call: the NAT library copies the whole struct before it
      // returns (CTNATClientPeer::Connect), and the SDK's own caller keeps it on its stack. It goes
      // on the heap, not on a thread stack whose size this library does not know (koffi's, the SDK's).
      _tag_client_connect_info *plain = (_tag_client_connect_info *)calloc(1, sizeof *plain);
      if (plain) {
        memcpy(plain->szDevId, serial, strlen(serial) + 1); // zeros after it, as in the SDK's own struct
        if (g_log) say("p2pserial: device code %.40s -> plain serial %s", info.szDevId, serial);
        unsigned int r = real(*plain, sync, timeoutS);
        free(plain);
        return r;
      }
      say("p2pserial: out of memory, device code %.40s passed through unchanged", info.szDevId);
      return real(info, sync, timeoutS);
    }
  }
  if (g_log) say("p2pserial: device code %.40s passed through unchanged", info.szDevId);
  return real(info, sync, timeoutS);
}
