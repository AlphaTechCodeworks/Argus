// fake-nat.c: TEST ONLY. Stands in for libNatClientSDK.so.1 in stress.c (built with that soname).
// Its NAT_CLIENT_ConnectDev records, per thread, what the add-on handed on, and returns 7.
#include <stdint.h>
#include <string.h>

struct info {
  uint32_t type;
  char id[0x1000];
};

static __thread struct {
  const void *ptr;
  uint32_t type;
  char id[64];
  int padded, sync, timeout;
} last;

// the vendor's C++ name: NAT_CLIENT_ConnectDev(_tag_client_connect_info const&, bool, int)
unsigned fake_connect(const struct info *in, _Bool sync, int timeout) __asm__("_Z21NAT_CLIENT_ConnectDevRK24_tag_client_connect_infobi");

unsigned fake_connect(const struct info *in, _Bool sync, int timeout) {
  size_t n = strnlen(in->id, sizeof in->id), c = n < sizeof last.id - 1 ? n : sizeof last.id - 1;
  last.ptr = in;
  last.type = in->type;
  memcpy(last.id, in->id, c);
  last.id[c] = 0;
  last.padded = 1; // only zeros after the device code, as in the SDK's own struct
  for (size_t k = n; k < sizeof in->id; k++)
    if (in->id[k]) {
      last.padded = 0;
      break;
    }
  last.sync = sync;
  last.timeout = timeout;
  return 7;
}

void fake_nat_last(const void **ptr, uint32_t *type, char id[64], int *padded, int *sync, int *timeout) {
  *ptr = last.ptr;
  *type = last.type;
  memcpy(id, last.id, sizeof last.id);
  *padded = last.padded;
  *sync = last.sync;
  *timeout = last.timeout;
}
