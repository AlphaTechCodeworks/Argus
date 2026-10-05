// stress: concurrency and edge cases of libp2pserial.so, with fake-nat.c standing in for
// libNatClientSDK.so.1 (it records what the add-on handed on). TEST ONLY (test.sh).
//   stress run ADDON FAKE_NAT < LIST   threads add, clear and look up at the same time, then edge cases.
//                                      LIST: 300 lines "SERIAL MD5", the MD5 in upper-case hex, made
//                                      with md5sum (not with the add-on's own code)
//   stress missing ADDON               no NAT library in the process: the call is refused, no crash
//   stress self                        the add-on loaded as "libNatClientSDK.so.1" (a misnamed copy on
//                                      LD_LIBRARY_PATH): it must not call itself
// STRESS_ITERS: lookups per thread and phase (default 20000). Prints PASS/FAIL lines; exit code 1
// if anything failed.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SYM "_Z21NAT_CLIENT_ConnectDevRK24_tag_client_connect_infobi"
// serials 0..15 are registered before the threads start, 16..63 by the threads, 200..299 never
enum { NSER = 300, FIXED = 16, ADDED = 64, LOOKERS = 8, ADDERS = 4, CHURNS = 2000 };

struct info {
  uint32_t type;
  char id[0x1000];
};
typedef unsigned (*connect_fn)(const struct info *, _Bool, int);
typedef void (*last_fn)(const void **, uint32_t *, char *, int *, int *, int *);

static int (*p_add)(const char *);
static void (*p_clear)(void);
static int (*p_count)(void);
static connect_fn connect_dev;
static last_fn fake_last;
static char ser[NSER][64], md5[NSER][33];
static long iters = 20000;
static int failures;

static void check(const char *name, int ok, const char *extra) {
  if (!ok) failures++;
  if (extra && *extra) printf("%s  %s  (%s)\n", ok ? "PASS" : "FAIL", name, extra);
  else printf("%s  %s\n", ok ? "PASS" : "FAIL", name);
}

static void *need(void *lib, const char *name) {
  void *p = dlsym(lib, name);
  if (!p) {
    fprintf(stderr, "stress: %s not found\n", name);
    exit(2);
  }
  return p;
}

// One call as the SDK makes it (sync false, 30 s). What reached the NAT library: the plain serial
// in a fresh, zero-padded struct (PLAIN), the caller's own struct as it was (UNCHANGED), or else WRONG.
enum { WRONG = -1, PLAIN = 0, UNCHANGED = 1 };
static int lookup(struct info *in, int i, uint32_t type) {
  memset(in, 0, sizeof *in);
  in->type = type;
  memcpy(in->id, md5[i], sizeof md5[i]);
  unsigned r = connect_dev(in, 0, 30);
  const void *ptr;
  uint32_t t;
  char got[64];
  int padded, sync, timeout;
  fake_last(&ptr, &t, got, &padded, &sync, &timeout);
  if (r != 7 || sync != 0 || timeout != 30) return WRONG;
  if (ptr != in && t == 0 && padded && strcmp(got, ser[i]) == 0) return PLAIN;
  if (ptr == in && t == type && strcmp(got, md5[i]) == 0) return UNCHANGED;
  return WRONG;
}

static long lookups, bad, bad_adds, bad_counts; // updated with atomic operations
static int adders_done, churn_done, noted;
static char first_bad[160];
static void note(const char *phase, int i, int r) {
  __atomic_add_fetch(&bad, 1, __ATOMIC_RELAXED);
  if (__atomic_exchange_n(&noted, 1, __ATOMIC_ACQ_REL) == 0) snprintf(first_bad, sizeof first_bad, "first: %s, serial %s gave %d", phase, ser[i], r);
}

// ---- phase 1: lookups while serials are being added
static void *adder(void *arg) {
  (void)arg;
  for (int round = 0; round < 50; round++)
    for (int i = FIXED; i < ADDED; i++) {
      if (p_add(ser[i]) != 1) __atomic_add_fetch(&bad_adds, 1, __ATOMIC_RELAXED);
      int n = p_count();
      if (n < FIXED || n > ADDED) __atomic_add_fetch(&bad_counts, 1, __ATOMIC_RELAXED);
    }
  return NULL;
}

static void *looker1(void *arg) {
  unsigned seed = (unsigned)(uintptr_t)arg;
  struct info *in = malloc(sizeof *in);
  long k = 0, until = -1; // at least iters lookups, and iters / 4 more once the adders are done
  for (; k < iters || until < 0 || k < until; k++) {
    int pick = rand_r(&seed) % (ADDED + 100), i = pick < ADDED ? pick : 200 + (pick - ADDED);
    int done = __atomic_load_n(&adders_done, __ATOMIC_ACQUIRE);
    if (done && until < 0) until = k + iters / 4;
    int r = lookup(in, i, 0);
    int ok = i < FIXED ? r == PLAIN : i < ADDED ? r == PLAIN || (r == UNCHANGED && !done) : r == UNCHANGED;
    if (!ok) note("phase 1", i, r);
  }
  __atomic_add_fetch(&lookups, k, __ATOMIC_RELAXED);
  free(in);
  return NULL;
}

// ---- phase 2: lookups while one thread clears the table and adds the serials again, over and over
static void *churner(void *arg) {
  (void)arg;
  for (int round = 0; round < CHURNS; round++) {
    p_clear();
    for (int i = 0; i < ADDED; i++) p_add(ser[i]);
  }
  __atomic_store_n(&churn_done, 1, __ATOMIC_RELEASE);
  return NULL;
}

static void *counter(void *arg) {
  (void)arg;
  while (!__atomic_load_n(&churn_done, __ATOMIC_ACQUIRE)) {
    int n = p_count();
    if (n < 0 || n > ADDED) __atomic_add_fetch(&bad_counts, 1, __ATOMIC_RELAXED);
  }
  return NULL;
}

static void *looker2(void *arg) {
  unsigned seed = (unsigned)(uintptr_t)arg;
  struct info *in = malloc(sizeof *in);
  long k = 0;
  for (; k < iters || !__atomic_load_n(&churn_done, __ATOMIC_ACQUIRE); k++) {
    int i = rand_r(&seed) % ADDED;
    uint32_t type = rand_r(&seed) % 8 == 0; // now and then an id that is not a device code
    int r = lookup(in, i, type);
    // either its own plain serial or its own struct untouched: never another serial, never a mix
    if (type ? r != UNCHANGED : r == WRONG) note("phase 2", i, r);
  }
  __atomic_add_fetch(&lookups, k, __ATOMIC_RELAXED);
  free(in);
  return NULL;
}

static void run_threads(int n, void *(*fn)(void *), pthread_t *t, int seed0) {
  for (int i = 0; i < n; i++) pthread_create(&t[i], NULL, fn, (void *)(uintptr_t)(seed0 + i));
}
static void join_threads(int n, pthread_t *t) {
  for (int i = 0; i < n; i++) pthread_join(t[i], NULL);
}

static int run(const char *addon, const char *fake) {
  int n = 0;
  while (n < NSER && scanf("%63s %32s", ser[n], md5[n]) == 2) n++;
  if (n < NSER) {
    fprintf(stderr, "stress: need %d \"SERIAL MD5\" lines on stdin, got %d\n", NSER, n);
    return 2;
  }
  void *a = dlopen(addon, RTLD_NOW | RTLD_GLOBAL), *f = dlopen(fake, RTLD_NOW | RTLD_GLOBAL);
  if (!a || !f) {
    fprintf(stderr, "stress: %s\n", dlerror());
    return 2;
  }
  p_add = (int (*)(const char *))need(a, "p2pserial_add");
  p_clear = (void (*)(void))need(a, "p2pserial_clear");
  p_count = (int (*)(void))need(a, "p2pserial_count");
  fake_last = (last_fn)need(f, "fake_nat_last");
  connect_dev = (connect_fn)need(RTLD_DEFAULT, SYM); // the first definition, as the SDK's PLT would bind
  Dl_info d;
  const char *file = dladdr((void *)connect_dev, &d) && d.dli_fname ? d.dli_fname : "?";
  check("the SDK's NAT_CLIENT_ConnectDev resolves to the add-on", strstr(file, "libp2pserial") != NULL, file);

  char extra[400];
  pthread_t t[LOOKERS + ADDERS + 2];
  for (int i = 0; i < FIXED; i++) p_add(ser[i]);
  run_threads(LOOKERS, looker1, t, 1);
  run_threads(ADDERS, adder, t + LOOKERS, 100);
  join_threads(ADDERS, t + LOOKERS);
  __atomic_store_n(&adders_done, 1, __ATOMIC_RELEASE);
  join_threads(LOOKERS, t);
  snprintf(extra, sizeof extra, "%ld lookups, %ld wrong, %ld adds refused, %ld counts out of range%s%s", lookups, bad, bad_adds, bad_counts, noted ? "; " : "", first_bad);
  check("phase 1: 8 threads look up while 4 add: registered serials go out plain, others unchanged", !bad && !bad_adds && !bad_counts && p_count() == ADDED, extra);

  lookups = bad = bad_counts = 0;
  noted = 0;
  run_threads(LOOKERS, looker2, t, 300);
  run_threads(1, churner, t + LOOKERS, 0);
  run_threads(1, counter, t + LOOKERS + 1, 0);
  join_threads(LOOKERS + 2, t);
  snprintf(extra, sizeof extra, "%ld lookups during %d clear + re-add rounds, %ld wrong, %ld counts out of range%s%s", lookups, CHURNS, bad, bad_counts,
           noted ? "; " : "", first_bad);
  check("phase 2: each call gets its own plain serial or its own struct untouched, never another serial", !bad && !bad_counts, extra);

  struct info *in = malloc(sizeof *in);
  int all = 1;
  for (int i = 0; i < ADDED; i++) all &= lookup(in, i, 0) == PLAIN;
  check("after the churn: count 64 and all 64 go out plain", all && p_count() == ADDED, "");

  // ---- edge cases, one thread
  check("p2pserial_add(NULL) and (\"\") refused", p_add(NULL) == 0 && p_add("") == 0, "");
  char s63[64], s64[65];
  memset(s63, 'S', 63);
  s63[63] = 0;
  memset(s64, 'S', 64);
  s64[64] = 0;
  int before = p_count();
  check("63 characters accepted, 64 refused", p_add(s63) == 1 && p_add(s64) == 0 && p_count() == before + 1, "");
  check("a serial added twice counts once", p_add(ser[1]) == 1 && p_count() == before + 1, "");
  check("dwIdType 1 (not a device code) passes unchanged although the serial is registered", lookup(in, 1, 1) == UNCHANGED, "");
  p_clear();
  all = 1;
  for (int i = 0; i < 256; i++) all &= p_add(ser[i]) == 1;
  int full = p_count();
  int refused = p_add(ser[256]) == 0, again = p_add(ser[7]) == 1;
  snprintf(extra, sizeof extra, "count %d", full);
  check("table: 256 serials fit, the 257th is refused, a known one is still accepted", all && full == 256 && refused && again && p_count() == 256, extra);
  check("table full: serial 255 plain, serial 256 unchanged", lookup(in, 255, 0) == PLAIN && lookup(in, 256, 0) == UNCHANGED, "");
  memset(in, 0, sizeof *in);
  memset(in->id, 'A', sizeof in->id); // no NUL in all 4096 bytes: compared and logged within bounds
  const void *ptr;
  uint32_t ty;
  char got[64];
  int padded, sync, timeout;
  unsigned r = connect_dev(in, 0, 30);
  fake_last(&ptr, &ty, got, &padded, &sync, &timeout);
  check("a device code without a terminating NUL passes unchanged", r == 7 && ptr == in && strlen(got) == 63, "");
  p_clear();
  check("after p2pserial_clear: count 0 and the serial goes out unchanged", p_count() == 0 && lookup(in, 0, 0) == UNCHANGED, "");
  free(in);
  return failures ? 1 : 0;
}

// the NAT library is not in the process at all
static int missing(const char *addon) {
  void *a = dlopen(addon, RTLD_NOW | RTLD_GLOBAL);
  if (!a) {
    fprintf(stderr, "stress: %s\n", dlerror());
    return 2;
  }
  int (*add)(const char *) = (int (*)(const char *))need(a, "p2pserial_add");
  connect_fn f = (connect_fn)need(a, SYM);
  add("TESTSERIAL0000");
  static struct info in;
  strcpy(in.id, "EABE3EA41FB62077FB81B590E6FD6116"); // MD5 of TESTSERIAL0000
  check("no NAT library: the call is refused (0) and nothing crashes", f(&in, 0, 30) == 0, "");
  return failures ? 1 : 0;
}

// a copy of the add-on is what "libNatClientSDK.so.1" finds
static int self(void) {
  void *h = dlopen("libNatClientSDK.so.1", RTLD_NOW | RTLD_GLOBAL);
  if (!h) {
    fprintf(stderr, "stress: %s\n", dlerror());
    return 2;
  }
  int is_addon = dlsym(h, "p2pserial_add") != NULL;
  check("libNatClientSDK.so.1 here is a copy of the add-on", is_addon, "");
  connect_fn f = (connect_fn)need(h, SYM);
  static struct info in;
  strcpy(in.id, "EABE3EA41FB62077FB81B590E6FD6116");
  check("the add-on does not call itself: refused (0), no endless recursion", is_addon && f(&in, 0, 30) == 0, "");
  return failures ? 1 : 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  const char *e = getenv("STRESS_ITERS");
  if (e && atol(e) > 0) iters = atol(e);
  if (argc == 4 && !strcmp(argv[1], "run")) return run(argv[2], argv[3]);
  if (argc == 3 && !strcmp(argv[1], "missing")) return missing(argv[2]);
  if (argc == 2 && !strcmp(argv[1], "self")) return self();
  fprintf(stderr, "usage: stress run ADDON FAKE_NAT < LIST | stress missing ADDON | stress self\n");
  return 2;
}
