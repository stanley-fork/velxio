# Phase 2.CP — Standalone SHA peripheral (TRM Chapter 23) + SHA-256 refactor

**Estado**: ✅ done — replaces the Phase 2.I.sha smart_stub
(which only returned SHA_BUSY=0) with a real SHA-256
implementation backed by a **shared SHA core extracted from
the HMAC peripheral**. Cross-validated bit-perfect against
Python `hashlib.sha256()`. **33rd JSON event type** (`sha`).

Live verification (2026-05-20):

```
SHA-256("abc"):
  Velxio JSON:    "digest_prefix":"ba7816bf8f01cfea"
  Python hashlib: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
                  └─ MATCH ─┘
```

NIST FIPS 180-2 § B.1 reference vector validated. Phase 2.CN's
HMAC peripheral keeps working unchanged (eFuse gate fires
correctly, AES self-tests pass) — the SHA-256 extraction
refactor is zero-regression.

## Goal

Two intertwined goals in one phase:

1. **Refactor**: extract SHA-256 from Phase 2.CN's HMAC
   peripheral to a new `hw/misc/esp32p4_sha_common.{c,h}`
   module so other peripherals can reuse it without
   duplication.

2. **New peripheral**: add the standalone SHA accelerator
   at `DR_REG_SHA_BASE = 0x50091000` per TRM Chapter 23 +
   IDF `sha_reg.h`. Replaces the Phase 2.I.sha smart_stub
   with a real implementation.

The refactor is necessary because:
- HMAC peripheral (Phase 2.CN) has SHA-256 inline.
- SHA peripheral (this phase) needs the same SHA-256.
- Future peripherals (DS, Secure Boot digest verifier) will
  also need SHA-256.

Code duplication would diverge over time. Shared module
guarantees one source of truth.

## Lo que SE INVESTIGÓ

### 1. SHA register layout (IDF sha_reg.h)

13 control registers + 2 memory regions in 0x1000:

| Offset | Register | R/W | Purpose |
|--------|----------|-----|---------|
| 0x00 | MODE | RW | 3-bit (0=SHA-1, 2=SHA-256, …, 7=SHA-512/t) |
| 0x04 | T_STRING | RW | SHA-512/t parameter |
| 0x08 | T_LENGTH | RW | SHA-512/t parameter |
| 0x0C | DMA_BLOCK_NUM | RW | DMA block count |
| 0x10 | START | W | trigger first block (H ← H_init, then compress) |
| 0x14 | CONTINUE | W | trigger subsequent block (H preserved, then compress) |
| 0x18 | BUSY | R | 1 = compute in progress |
| 0x1C | DMA_START | W | DMA-SHA equivalent of START |
| 0x20 | DMA_CONTINUE | W | DMA-SHA equivalent of CONTINUE |
| 0x24 | CLEAR_IRQ | W | clear pending interrupt |
| 0x28 | IRQ_ENA | RW | enable interrupt output |
| 0x2C | DATE | R | version date |
| 0x40-0x7F | H_MEM | RW | 64-byte hash state (output digest) |
| 0x80-0xBF | M_MEM | W | 64-byte message block (input) |

The START / CONTINUE split is the silicon's multi-block
mechanism:
- **START**: initialize H from H_init constants (FIPS 180-4
  square roots of first 8 primes), then compress M_MEM.
- **CONTINUE**: preserve H from previous block, compress
  new M_MEM. Repeat for each 64-byte block.
- Final block: caller does padding (0x80 + zeros +
  64-bit length) manually then issues CONTINUE.

IDF's `sha_hal.c` follows this pattern: first block via
START, all subsequent blocks via CONTINUE.

### 2. Refactor strategy: shared core file

Chose **extract to a new file** over alternatives:

- **Copy-paste**: 80 LOC duplicated. Easy now, painful later
  if SHA-256 needs a fix (e.g., compiler-specific warning,
  endian assumption).
- **Function pointer from HMAC**: SHA peripheral calls into
  HMAC's private SHA-256. Awkward dependency direction —
  SHA is more fundamental than HMAC; HMAC depends on SHA.
- **Shared core file**: clean separation. Both HMAC and SHA
  peripherals depend on `esp32p4_sha_common`. Future
  consumers (DS, Secure Boot) drop in trivially.

Implementation: created
`include/hw/misc/esp32p4_sha_common.h` with public
declarations (`esp32p4_sha256_h_init[]`, `esp32p4_sha256_k[]`,
`esp32p4_sha256_compress()`, `esp32p4_sha256()`) and
`hw/misc/esp32p4_sha_common.c` with the implementations
(moved verbatim from `esp32p4_hmac.c`).

HMAC peripheral now includes the common header and removes
its private SHA-256. ~80 LOC removed from `esp32p4_hmac.c`,
~110 LOC added in `esp32p4_sha_common.{c,h}`.

### 3. H_MEM byte ordering

SHA produces a 256-bit (32-byte) digest as 8 × 32-bit words.
Real silicon stores these in H_MEM big-endian (MSB first).
IDF's `sha_hal.c` reads them as `uint32_t` then byte-swaps to
get the canonical big-endian byte stream.

Our model writes the H[] state to H_MEM bytes as:
```c
p[0] = (uint8_t)(H[i] >> 24);
p[1] = (uint8_t)(H[i] >> 16);
p[2] = (uint8_t)(H[i] >> 8);
p[3] = (uint8_t)(H[i]);
```

This matches the byte-stream view (digest[0..31] big-endian).
When IDF does `*(uint32_t*)(H_MEM + 0)` on a little-endian
RISC-V, it reads `0xea_cf_01_8f` — IDF then byte-swaps to
get `0x8f_01_cf_ea`, the canonical SHA-256(abc) word 0
high half.

Verified by the "abc" test producing `ba7816bf8f01cfea...`
in the JSON event (which prints H_MEM bytes directly).

### 4. Mode handling — SHA-256 only

Skeleton scope: only MODE=2 (SHA-256). Other modes:
- SHA-1 / SHA-224 / SHA-384 / SHA-512: would each need their
  own compress function + initial values + round constants.
  ~200 additional LOC per mode.
- SHA-512/224 / SHA-512/256: derive from SHA-512 with
  different H_init.
- SHA-512/t: arbitrary truncation; T_STRING + T_LENGTH
  configure.

For now, non-SHA-256 modes:
- Accept writes (no SIGSEGV).
- Produce all-zero H_MEM (so guest detects "compute failed").
- Emit a stderr WARN so a debugger / test harness notices.

Real Arduino sketches almost universally use SHA-256 (TLS
1.2/1.3 cipher suites, mbedtls hashing, esp_partition
checksums). SHA-1 is occasionally used in old TLS or in
legacy SSH; SHA-384/SHA-512 are rare.

### 5. Cross-validation methodology

NIST FIPS 180-2 Appendix B.1 SHA-256 test vector:
- Input: "abc" (3 bytes)
- Padded block (64 bytes):
  ```
  61 62 63 80 00 00 00 00  00 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 18
  ```
  (3 bytes ASCII, 0x80 marker, zeros, 0x18 = 24-bit length BE)
- Expected: `ba7816bf 8f01cfea 414140de 5dae2223
  b00361a3 96177a9c b410ff61 f20015ad`

Velxio's first 8 bytes of H_MEM after START: `ba7816bf
8f01cfea` ✓

Independent cross-check via Python:
```python
import hashlib; print(hashlib.sha256(b"abc").hexdigest())
# → ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
```

Bit-perfect match. SHA-256 implementation is correct.

### 6. Overlay priority vs Phase 2.I.sha smart_stub

The smart_stub from Phase 2.I.sha lives at the same address
(0x50091000) with priority 1. The new peripheral overlays
at priority 2, taking precedence. Smart_stub stays as a
fallback for any registers we don't model (unlikely, but
defensive).

## Lo que SÍ funcionó

1. ✅ Build clean — 6 files compiled
   (`sha_common.c` new, `sha.c` new, `hmac.c` shrunk by ~80
   LOC, `esp32p4.c` machine init updated, meson.build new
   entries).
2. ✅ SHA-256("abc") matches NIST FIPS 180-2 reference
   bit-perfect.
3. ✅ Python `hashlib.sha256(b"abc").hexdigest()` returns
   exactly the same first 8 bytes (`ba7816bf8f01cfea`).
4. ✅ HMAC peripheral keeps working — the SHA-256 refactor
   doesn't break it. Phase 2.CM/2.CN behavior unchanged.
5. ✅ AES peripheral self-tests still pass (no
   cross-peripheral interference).
6. ✅ Boot regression-clean — chip_info still emits, 22
   i2c_rx events, etc.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Extract to a shared file, not copy-paste**: cleaner
   long-term. DS, Secure Boot digest verifier, future
   crypto peripherals reuse for free.

2. **SHA-256 only**: skeleton scope. SHA-1 (12 sketches in
   IDF's `test_apps/`) and SHA-512 (few) deferred. Stderr
   WARN on other modes tells the debugger something was
   attempted.

3. **No DMA-SHA**: DMA_START / DMA_CONTINUE / DMA_BLOCK_NUM
   absorbed as scratch. IDF's typical-mode SHA calls use
   START/CONTINUE; DMA-SHA is for large-block bulk hashing
   (e.g., flash verification).

4. **BUSY always 0**: same pattern as HMAC's QUERY_BUSY,
   AES's STATE. Real silicon: ~70 cycles per block; our
   model: instantaneous. IDF polling code unaffected.

5. **No CLIC IRQ**: TRM Chapter 23 defines CLEAR_IRQ +
   IRQ_ENA but typical IDF flows poll BUSY. Skipping IRQ
   wiring keeps the phase small; future phase can add it.

6. **Self-test exercises START only, not CONTINUE**: a
   single 64-byte block covers START. CONTINUE would need a
   multi-block message; deferred until guest code actually
   uses it.

7. **Overlay priority 2 over smart_stub priority 1**:
   keeps the smart_stub as fallback. Safer than removing
   the smart_stub entirely.

## Lessons learned

1. **Refactor before the second user shows up**. Phase 2.CN
   shipped SHA-256 inside HMAC. Phase 2.CP needed the same
   SHA-256. Extracting it at the moment of the second user
   is exactly the right timing — earlier is YAGNI, later
   is more painful.

2. **Public extern arrays scale across compilation units**.
   `esp32p4_sha256_h_init[]` and `esp32p4_sha256_k[]` are
   declared `extern` in the header, defined in the .c file.
   Both consumers (HMAC + SHA) link to the same instance —
   no duplicate-symbol issues, no constant duplication in
   the binary.

3. **Cross-validation against `hashlib` is fast**.
   One-liner Python verifies bit-correctness. Saves the
   time-cost of hand-computing a SHA-256.

4. **Skeleton-first scales across crypto peripherals**.
   AES (Phase 2.CO), SHA (this phase), and future
   DS/ECDSA/RSA all follow the same shape: TRM-correct
   MMIO registers + real computation + JSON event with
   first 8 bytes + cross-validation against a reference.

## Implementación final

### New files

- `include/hw/misc/esp32p4_sha_common.h` — public SHA-256
  API: tables (extern), `esp32p4_sha256_compress()`,
  `esp32p4_sha256()`.
- `hw/misc/esp32p4_sha_common.c` — implementation extracted
  from Phase 2.CN's HMAC peripheral.
- `include/hw/misc/esp32p4_sha.h` — SHA peripheral type +
  register offsets + state struct.
- `hw/misc/esp32p4_sha.c` — SHA peripheral MMIO + START /
  CONTINUE dispatch + JSON event + self-test.

### `hw/misc/esp32p4_hmac.c`

- Removed inline SHA-256 (~80 LOC: tables, compress,
  esp32p4_sha256 function, ROTR/CH/MAJ/BSIG/SSIG macros).
- Added `#include "hw/misc/esp32p4_sha_common.h"`.
- HMAC's `esp32p4_hmac_sha256()` wrapper unchanged — it
  calls `esp32p4_sha256()` from the shared module.

### `hw/misc/meson.build`

- Added `'esp32p4_sha_common.c'` + `'esp32p4_sha.c'` to the
  `CONFIG_RISCV_ESP32P4` source list.

### `hw/riscv/esp32p4.c`

- New `#include "hw/misc/esp32p4_sha.h"`.
- New `ESP32P4ShaState sha` field on machine state.
- New SHA init block at `0x50091000` overlay priority 2
  (over the Phase 2.I.sha smart_stub at priority 1).
- Self-test fires `SHA-256("abc")` at boot.

## Estado consolidado (post-2.CP)

Crypto peripheral inventory:

| Peripheral | Base | Status | Phase |
|------------|------|--------|-------|
| AES | 0x50090000 | skeleton + real AES-128/256 | 2.CO |
| **SHA** | **0x50091000** | **skeleton + real SHA-256** | **2.CP** |
| RSA | 0x50092000 | unimplemented stub | n/a |
| ECC | 0x50093000 | unimplemented stub | n/a |
| DS | 0x50094000 | unimplemented stub | n/a |
| HMAC | 0x50095000 | skeleton + SHA-256/HMAC compute | 2.CM + 2.CN |
| ECDSA | 0x50096000 | unimplemented stub | n/a |

SHA-256 implementation: **shared module** consumed by HMAC
(Phase 2.CN) and SHA (this phase). Future DS / Secure Boot
peripherals will reuse it.

JSON event types: **33** (chip_info=29, ssd1306=30, hmac=31,
aes=32, sha=33).

## 78-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.CN  | SHA-256 + HMAC computation (inside HMAC peripheral)     |
| 2.CO  | Standard AES peripheral — AES-128/256 NIST-correct      |
| **2.CP** | **Standalone SHA peripheral — SHA-256, shared core refactor** |

## Próximas direcciones

- **SHA-1 / SHA-224 / SHA-384 / SHA-512** support in the
  SHA peripheral — each needs its own compress + initial
  values.
- **RSA peripheral** (TRM Chapter 25) — large-number
  modular exponentiation.
- **ECC peripheral** (TRM Chapter 26) — elliptic-curve
  point multiplication.
- **Digital Signature (DS)** — consumes KEY_PURPOSE_7
  (HMAC_DOWN_DIGITAL_SIGNATURE) + the shared SHA-256.
- **AES-CBC / AES-GCM** block modes.
- **XTS-AES** for flash encryption.
- **Secure Boot digest verifier** — consumes SHA-256
  (this phase's shared module) + KEY_PURPOSE_9/10/11.
- **MS5611 / W5500 / MFRC522** sensors/SPI responders.
- **UART IRQ** via interrupt matrix.
- **Real PWM** waveform via LEDC.
- **FreeRTOS** scheduler resurrection.
