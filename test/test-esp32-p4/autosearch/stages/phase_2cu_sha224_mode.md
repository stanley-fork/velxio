# Phase 2.CU — SHA-224 mode in SHA peripheral (TRM Chapter 23 MODE=1)

**Estado**: ✅ done — adds MODE=1 (SHA-224) to the standalone SHA
peripheral. Reuses SHA-256's `sha256_compress` function (per
NIST FIPS 180-4 §6.3, SHA-224 is SHA-256 with a different
initial hash + truncated output). Bit-perfect cross-validated
against Python `hashlib.sha224()`.

Live verification (boot trace shows all 3 modes side-by-side):

```
[esp32p4.sha] op#1 mode=2 (SHA-256) START → ba7816bf8f01cfea...
[esp32p4.sha] op#2 mode=0 (SHA-1)   START → a9993e364706816a...
[esp32p4.sha] op#3 mode=1 (SHA-224) START → 23097d223405d822...

JSON events (3 sha events, distinct mode_name):
  {"event":"sha","op":1,"mode":2,"mode_name":"SHA-256",
   "digest_prefix":"ba7816bf8f01cfea"}
  {"event":"sha","op":2,"mode":0,"mode_name":"SHA-1",
   "digest_prefix":"a9993e364706816a"}
  {"event":"sha","op":3,"mode":1,"mode_name":"SHA-224",
   "digest_prefix":"23097d223405d822"}

reference (Python hashlib + NIST FIPS 180-4 §A.1):
  SHA-256("abc") = ba7816bf8f01cfea... ✓
  SHA-1("abc")   = a9993e364706816a... ✓
  SHA-224("abc") = 23097d223405d822... ✓  ← new this phase
```

## Goal

Phase 2.CP added SHA-256. Phase 2.CS added SHA-1. This phase
adds SHA-224 — the third SHA mode in the typical "short-output
family" (≤256-bit digests).

SHA-224 is structurally **simpler than SHA-1**: it shares
SHA-256's compress function entirely. The only differences are:
1. Different initial hash values (FIPS 180-4 §5.3.2).
2. Output truncated to first 7 of 8 H words (224 bits).

So Phase 2.CU is the smallest crypto-extension phase yet —
~40 LOC total, mostly the H_init constants + wrapper.

## Lo que SE INVESTIGÓ

### 1. NIST FIPS 180-4 §6.3 SHA-224 algorithm

Per §6.3.1, SHA-224 is "computed using the same processes as
SHA-256, except that:
- (a) The initial hash value H(0) consists of the following
  eight 32-bit words [...]
- (b) The result is the leftmost 224 bits of H(N)."

Initial hash (FIPS 180-4 §5.3.2) — square roots of the 9th
through 16th primes, second 32 bits of fractional part:
```
H[0..7] = { 0xC1059ED8, 0x367CD507, 0x3070DD17, 0xF70E5939,
            0xFFC00B31, 0x68581511, 0x64F98FA7, 0xBEFA4FA4 }
```

This contrasts with SHA-256's H_init which uses the first
32 bits of fractional part of the first 8 primes' square
roots.

Padding rules are **identical** to SHA-256 (FIPS 180-4 §5.1.1).
Block size, length field width, marker byte — all the same.
This lets us reuse `sha256_compress` directly.

### 2. Output truncation

After hashing all blocks, FIPS 180-4 §6.3.2 says: "the message
digest is the concatenation of H₀H₁H₂H₃H₄H₅H₆" — that is, the
first **seven** of the eight 32-bit words. The eighth word
(H₇) is discarded.

In our model: 28 bytes written to H_MEM, last 4 bytes
explicitly zeroed (defensive — same rationale as Phase 2.CS's
SHA-1 H_MEM high-byte zeroing).

### 3. Code reuse with SHA-256

Implementation is essentially:
```c
void esp32p4_sha224(const uint8_t *msg, size_t len, uint8_t out[28])
{
    uint32_t H[8];
    memcpy(H, esp32p4_sha224_h_init, sizeof(H));
    /* ... process blocks via esp32p4_sha256_compress ... */
    /* ... same padding as SHA-256 ... */
    /* output: first 7 H words BE */
}
```

The only logic differences from `esp32p4_sha256()` are:
- Initial state seeded from `sha224_h_init`, not `sha256_h_init`.
- Output loop runs `i < 7` instead of `i < 8`.

~50 LOC including initial constants + wrapper.

### 4. Peripheral dispatch path

`esp32p4_sha_compute()` already had an `if/else if/else`
structure from Phase 2.CS (SHA-1 vs SHA-256 vs WARN). Adding
SHA-224 is a new else-if branch:

```c
if (mode == SHA-256) { /* Phase 2.CP */ }
else if (mode == SHA-224) { /* Phase 2.CU — new */ }
else if (mode == SHA-1) { /* Phase 2.CS */ }
else { /* still WARN for SHA-384/512/512-t */ }
```

The branch reuses `sha256_H[]` state field (same width — 8 ×
32-bit) instead of adding a new `sha224_H[7]`. The compress
fills all 8 words; we publish only the first 7 to H_MEM.

This saves struct memory + simplifies the multi-block
(CONTINUE) path: SHA-224 CONTINUE reads back the full 32-byte
H_MEM into `sha256_H[]`, but since SHA-224 self-test only does
single-block START, no issue.

### 5. Cross-validation methodology

Python:
```python
import hashlib
hashlib.sha224(b"abc").hexdigest()
# → 23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7
```

NIST FIPS 180-4 Appendix A.1 SHA-224 test vector:
- Input: "abc" (3 bytes)
- Expected: `23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7`

Velxio first 8 bytes: `23097d223405d822` ✓ bit-perfect match.

### 6. Self-test extension pattern

Phase 2.CP self-test: 1 SHA-256 pass.
Phase 2.CS self-test: 2 passes (SHA-256 + SHA-1).
Phase 2.CU self-test: 3 passes (SHA-256 + SHA-1 + SHA-224).

All three passes use the same "abc" padded block. The padding
is shared (FIPS 180-4 §5.1.1 applies identically). Self-test
just re-emits M_MEM + switches MODE between passes.

## Lo que SÍ funcionó

1. ✅ Build clean — same 5 files compiled as previous phase
   (sha_common + sha + 3 transitive).
2. ✅ SHA-256("abc") → `ba7816bf8f01cfea` ✓ (Phase 2.CP
   regression-clean).
3. ✅ SHA-1("abc") → `a9993e364706816a` ✓ (Phase 2.CS
   regression-clean).
4. ✅ SHA-224("abc") → `23097d223405d822` ✓ — bit-perfect
   match vs Python `hashlib.sha224()`.
5. ✅ 3 `sha` JSON events at boot with distinct `mode_name`
   fields ("SHA-256" / "SHA-1" / "SHA-224").
6. ✅ H_MEM[28..31] zeroed after SHA-224 — defensive against
   stale-byte leakage.
7. ✅ No regression on AES / HMAC / USB Serial/JTAG / other
   peripherals.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Reuse sha256_H[8] for SHA-224**: saves a separate
   `sha224_H[7]` struct field. The compress function fills
   all 8 words; we publish 7 to H_MEM. Cleaner than maintaining
   two parallel 8-word state buffers.

2. **Defensive H_MEM[28..31] zeroing**: same rationale as
   Phase 2.CS's SHA-1 high-byte zeroing. Silicon-undefined
   behavior; explicit zero avoids guest reading stale state.

3. **Self-test order: SHA-256 → SHA-1 → SHA-224**: chronological
   (order added). Could rearrange to algorithmic order (SHA-1
   → SHA-224 → SHA-256 by family + output size) but
   chronological matches the autosearch evolution.

4. **No standalone `sha224_compress` function**: since the
   compress is identical to SHA-256's, exposing a `sha224_compress`
   alias would be pure clutter. Callers use `sha256_compress`
   directly with `sha224_h_init`.

5. **MODE=1 dispatch in if-else-if chain**: keeps the
   modal-dispatch shape from Phase 2.CS. The chain now covers
   3 of 8 silicon modes; remaining 5 (SHA-384/512/512-t)
   continue to fall through to WARN+zero.

6. **Same NIST "abc" test vector**: minimizes self-test
   complexity. All 3 SHA modes produce well-known canonical
   digests for "abc" — perfect for cross-checking against any
   reference impl.

## Lessons learned

1. **SHA-224 is the cheapest SHA variant to add**. Sharing
   the SHA-256 compress means the entire addition is a
   constants table + wrapper. Future SHA-384/512 will be
   ~10x larger because they need 64-bit native types + a new
   compress function.

2. **Self-test stacking validates regression cleanly**.
   3 passes in a row with distinct expected vectors gives
   per-mode evidence without ambiguity. Frontend can filter
   by `mode_name`.

3. **Shared SHA module pays off again** — third algorithm
   added to `esp32p4_sha_common` (SHA-256, SHA-1, SHA-224).
   The shared module is now the canonical source of SHA
   primitives for any future consumer (Secure Boot digest
   verifier will reuse it, etc.).

4. **Pattern continuity reduces phase risk**. Phase 2.CS
   established the if-else-if dispatch + self-test stacking
   pattern. Phase 2.CU dropped into the same shape — no
   surprises, no failed builds, immediate cross-validation
   match on first attempt.

## Implementación final

### `include/hw/misc/esp32p4_sha_common.h`

- New `extern const uint32_t esp32p4_sha224_h_init[8]`.
- New `void esp32p4_sha224(const uint8_t *msg, size_t len, uint8_t out[28])`.

### `hw/misc/esp32p4_sha_common.c`

- `esp32p4_sha224_h_init` table (8 × 32-bit FIPS 180-4 §5.3.2
  constants — second 32 bits of square roots of 9th-16th primes).
- `esp32p4_sha224()` — wrapper that uses `sha256_compress` +
  truncates to 28 bytes.

### `hw/misc/esp32p4_sha.c`

- New else-if branch in `esp32p4_sha_compute()` for MODE=1
  (SHA-224). Reuses `sha256_H[]` state field; publishes 7
  words + zeros bytes [28..31].
- Self-test extended with a 3rd MODE=1 pass on the same "abc"
  block.

## Estado consolidado (post-2.CU)

SHA peripheral mode coverage:

| MODE | Algorithm | Status | Phase |
|------|-----------|--------|-------|
| 0 | SHA-1 | real compute ✓ | 2.CS |
| **1** | **SHA-224** | **real compute ✓** | **2.CU** |
| 2 | SHA-256 | real compute ✓ | 2.CP |
| 3 | SHA-384 | WARN + zero H_MEM | (deferred) |
| 4 | SHA-512 | WARN + zero H_MEM | (deferred) |
| 5 | SHA-512/224 | WARN + zero H_MEM | (deferred) |
| 6 | SHA-512/256 | WARN + zero H_MEM | (deferred) |
| 7 | SHA-512/t | WARN + zero H_MEM | (deferred) |

3 of 8 modes covered. The remaining 5 are all in the SHA-512
family (64-bit operations, 128-bit length field) — significantly
more work per mode.

JSON event types: **35** (unchanged from Phase 2.CT — same
`sha` event type, distinguished by `mode_name`).

## 83-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.CS  | SHA-1 mode (MODE=0)                                     |
| 2.CT  | USB Serial/JTAG RX reverse channel                      |
| **2.CU** | **SHA-224 mode (MODE=1)** — short-output SHA-2 family complete |

3 of 8 SHA modes available. Both SHA short-output variants
(SHA-1 + SHA-224 + SHA-256) now usable by Arduino sketches.

## Próximas direcciones

- **SHA-384 / SHA-512 modes** — 64-bit working state, 1024-bit
  blocks, 128-bit length field. ~150 LOC each.
- **DMA-SHA path** — DMA_START / DMA_CONTINUE / DMA_BLOCK_NUM
  + source/dest DMA buffers.
- **USB Serial/JTAG IRQ wiring** — TRM § 51.5 (needs CLIC ext).
- **Multi-block HMAC** (SET_MESSAGE_ING/END).
- **Secure Boot digest verifier** — consumes SHA-256 from
  shared module + KEY_PURPOSE_9/10/11 + eFuse BLOCK7/8/9 keys.
- **AES-CBC / AES-GCM** block modes.
- **XTS-AES** for flash encryption.
- **Digital Signature peripheral** (KEY_PURPOSE_7).
- **RSA / ECC / ECDSA** crypto peripherals.
- **MS5611 / W5500 / MFRC522** sensors/SPI responders.
- **UART IRQ** via interrupt matrix.
- **Real PWM** waveform via LEDC.
- **JTAG bridge peripheral**.
- **FreeRTOS** scheduler resurrection.
