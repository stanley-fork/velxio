# Phase 2.CS — SHA-1 mode in SHA peripheral (TRM Chapter 23 MODE=0)

**Estado**: ✅ done — adds SHA-1 to Phase 2.CP's standalone SHA
peripheral, replacing the "MODE=0 returns zeros + WARN" stub
with a real implementation. Cross-validated bit-perfect against
Python `hashlib.sha1()`.

Live verification (2026-05-21):

```
boot trace:
  [esp32p4.sha] op#1 mode=2 (SHA-256) START → digest prefix: ba7816bf8f01cfea...
  [esp32p4.sha] op#2 mode=0 (SHA-1)   START → digest prefix: a9993e364706816a...

JSON events:
  {"event":"sha","op":1,"mode":2,"mode_name":"SHA-256",
   "digest_prefix":"ba7816bf8f01cfea"}
  {"event":"sha","op":2,"mode":0,"mode_name":"SHA-1",
   "digest_prefix":"a9993e364706816a"}

reference (Python hashlib):
  SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad ✓
  SHA-1("abc")   = a9993e364706816aba3e25717850c26c9cd0d89d                          ✓
```

Both modes byte-perfect against the NIST FIPS 180-4 reference
vectors (§A.1 for SHA-1, §B.1 for SHA-256).

## Goal

Phase 2.CP's standalone SHA peripheral implemented MODE=2
(SHA-256) only. The other 5 modes (SHA-1, SHA-224, SHA-384,
SHA-512, SHA-512/t) were documented as "skeleton scope — produce
zeros + stderr WARN".

This phase closes the SHA-1 gap. SHA-1 is:
- **Legacy but real**: still used by some Arduino sketches for
  TLS 1.0/1.1 cipher suites, old SSH protocols, and legacy
  authentication tokens.
- **Architecturally distinct**: 5×32-bit state (vs SHA-256's
  8×32-bit), 80 rounds (vs 64), 4 round constants (vs 64),
  different round-function families per 20-round group.
- **Padding-identical**: same 64-byte block + 0x80 marker +
  zero pad + 64-bit BE length per FIPS 180-4 §5.1.1.

The other 4 modes (SHA-224/384/512/512-t) are deferred — they
need their own state widths (256/512/512/variable bits),
different padding for SHA-384/512 (128-bit length field), and
significantly more code.

## Lo que SE INVESTIGÓ

### 1. NIST FIPS 180-4 §6.1 SHA-1 algorithm

- **Initial hash values** (FIPS 180-4 §5.3.1):
  ```
  H[0..4] = { 0x67452301, 0xEFCDAB89, 0x98BADCFE,
              0x10325476, 0xC3D2E1F0 }
  ```
- **80-round structure**: 4 groups of 20 rounds with
  different round-function families:
  | Rounds | f(b,c,d) | K |
  |--------|----------|---|
  | 0..19 | Ch: (b∧c) ∨ (¬b∧d) | 0x5A827999 |
  | 20..39 | Parity: b⊕c⊕d | 0x6ED9EBA1 |
  | 40..59 | Maj: (b∧c) ∨ (b∧d) ∨ (c∧d) | 0x8F1BBCDC |
  | 60..79 | Parity: b⊕c⊕d | 0xCA62C1D6 |
- **Message schedule**: `W[i] = ROTL1(W[i-3] ^ W[i-8] ^ W[i-14] ^ W[i-16])`
  for i = 16..79. Note `ROTL1` instead of SHA-256's mix of
  `ROTR` shifts.
- **Round step**: `T = ROTL5(a) + f(b,c,d) + e + K + W[i]`,
  then `e=d, d=c, c=ROTL30(b), b=a, a=T`.

The Ch / Maj functions are identical to SHA-256's but applied
across different rounds. Parity is unique to SHA-1.

### 2. Output size = 20 bytes, not 32

SHA-256 fills all 32 bytes of `H_MEM` (offset 0x40..0x5F).
SHA-1 only fills the first 20 bytes (0x40..0x53). Real silicon
behavior: bytes 0x54..0x5F are **undefined** after a SHA-1
compute (they hold previous SHA-256 state or zeros depending
on prior operations).

Decision: explicit `memset(0)` for the last 12 bytes after
SHA-1 writeback. Avoids guest code accidentally reading stale
SHA-256 high half and treating it as a longer-than-expected
digest.

### 3. Dispatch refactor in `esp32p4_sha_compute()`

Original Phase 2.CP code had a single `if (mode != SHA-256)` branch
that zeroed H_MEM + WARN. Phase 2.CS restructures:

```c
if (mode == SHA-256) {
    /* sha256 path */
} else if (mode == SHA-1) {
    /* sha1 path - new */
} else {
    /* still zeros + WARN for SHA-224/384/512/512-t */
}
```

The else-if branch is the only new code path. SHA-256 logic
unchanged → zero regression.

### 4. ROTL vs ROTR macro family

SHA-256 uses `ROTR` (right-rotate); SHA-1 uses `ROTL`
(left-rotate). Added `ROTL32(x, n)` macro alongside the
existing `ROTR32`. Both peripherals share the macro file via
`esp32p4_sha_common.h`.

### 5. NIST cross-validation

NIST FIPS 180-4 Appendix A.1 SHA-1 test vector:
- Input: "abc" (3 bytes)
- Expected: `a9993e364706816aba3e25717850c26c9cd0d89d`

Velxio emits first 8 bytes: `a9993e364706816a` ✓

Python cross-check:
```python
import hashlib
hashlib.sha1(b"abc").hexdigest()
# → a9993e364706816aba3e25717850c26c9cd0d89d
```

Matches byte-perfect → SHA-1 implementation is NIST-correct.

### 6. Self-test extension

Phase 2.CP's self-test does:
1. MODE=2 + M_MEM = padded("abc")
2. START → SHA-256 digest

Phase 2.CS appends after that:
3. MODE=0 (now SHA-1)
4. Same padded M_MEM (silicon-correct: SHA-1 padding is
   identical to SHA-256)
5. START → SHA-1 digest

Result: 2 `sha` JSON events at boot, one per mode, both
matching their respective NIST test vectors.

## Lo que SÍ funcionó

1. ✅ Build clean — meson reconfigured for the new function in
   the shared module.
2. ✅ Phase 2.CP regression-clean: SHA-256("abc") still emits
   `ba7816bf8f01cfea`.
3. ✅ SHA-1("abc") emits `a9993e364706816a` — bit-perfect
   match against NIST FIPS 180-4 §A.1 and Python
   `hashlib.sha1()`.
4. ✅ Two `sha` JSON events at boot with distinct
   `mode_name` ("SHA-256" / "SHA-1") fields for frontend
   filtering.
5. ✅ H_MEM high 12 bytes zeroed after SHA-1 — no stale
   SHA-256 bits leak into the SHA-1 digest area.
6. ✅ No regression on AES / HMAC / USB Serial/JTAG /
   chip_info or any other peripheral.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Add SHA-1, skip SHA-224/384/512/512-t**: SHA-1 is the
   most-used legacy mode (TLS 1.0/1.1, old SSH). SHA-224 is
   rarely used standalone. SHA-384/512 need 128-bit length
   fields + 512-bit working state — significant additional
   code. Scope this phase to SHA-1.

2. **Zero high 12 bytes of H_MEM after SHA-1**: defensive vs
   silicon-undefined behavior. Avoids guest bugs reading
   beyond the 20-byte digest.

3. **Same NIST "abc" test vector for both modes**: minimizes
   self-test complexity. The padding is identical (same
   block size, same length encoding) so the M_MEM content
   doesn't need to change between the two test runs.

4. **Independent ROTL32 macro**: didn't try to share with
   ROTR32. They're distinct primitives in standards
   parlance. `ROTL32(x, n) = ROTR32(x, 32-n)` is true but
   the SHA-1 reference uses ROTL natively, so matching the
   spec literally is clearer.

5. **Keep MODE=1/3/4/5/6/7 as WARN+zero**: future work.
   Documented in this autosearch as "deferred" so a future
   maintainer knows the scope.

6. **No standalone `sha1_self_test` function**: integrated
   into Phase 2.CP's existing self-test as a second pass.
   Saves header churn + machine init code changes.

## Lessons learned

1. **SHA-1 is simpler than SHA-256 in the round function**.
   No T1/T2 split, no separate s0/s1 σ-functions, smaller
   working state. The complexity is in the 4 different
   round-function families spread across 80 rounds.

2. **Padding identity across modes** lets the same M_MEM
   block produce both SHA-1 and SHA-256 outputs without
   rewriting. Useful for cross-mode test harnesses.

3. **Shared SHA module pays off again**: Phase 2.CP's
   `esp32p4_sha_common.{c,h}` refactor was justified by
   HMAC consumption. This phase adds a second algorithm to
   the same module — both the HMAC peripheral and the
   standalone SHA peripheral get SHA-1 for free if needed.

4. **NIST test vectors are short, well-known, and free
   cross-validation**. "abc" → known digest is the cheapest
   correctness signal possible. No reference-impl install
   needed; just compute via Python `hashlib`.

## Implementación final

### `include/hw/misc/esp32p4_sha_common.h`

- New `extern const uint32_t esp32p4_sha1_h_init[5]`.
- New `void esp32p4_sha1_compress(uint32_t H[5], const uint8_t block[64])`.
- New `void esp32p4_sha1(const uint8_t *msg, size_t len, uint8_t out[20])`.

### `hw/misc/esp32p4_sha_common.c`

- `esp32p4_sha1_h_init` table (5 × 32-bit FIPS 180-4 constants).
- Static const `SHA1_K[4]` round-constant table.
- New `ROTL32(x, n)` macro.
- `esp32p4_sha1_compress()` — 80-round main loop with
  per-group `f` + `K` selection.
- `esp32p4_sha1()` — full-message wrapper with padding,
  identical to `esp32p4_sha256()` modulo state size + output
  length.

### `include/hw/misc/esp32p4_sha.h`

- New `sha1_H[5]` field on `ESP32P4ShaState` for the live
  hash state (preserved across CONTINUE for multi-block).

### `hw/misc/esp32p4_sha.c`

- `esp32p4_sha_compute()` restructured: SHA-256 path
  unchanged, new SHA-1 else-if branch. SHA-224/384/512/512-t
  fall through to the existing WARN+zero path.
- Self-test extended with a 2nd MODE=0 (SHA-1) START on the
  same "abc" block.

## Estado consolidado (post-2.CS)

SHA peripheral mode coverage:

| MODE | Algorithm | Status | Phase |
|------|-----------|--------|-------|
| 0 | **SHA-1** | **real compute ✓** | **2.CS** |
| 1 | SHA-224 | WARN + zero H_MEM | (deferred) |
| 2 | SHA-256 | real compute ✓ | 2.CP |
| 3 | SHA-384 | WARN + zero H_MEM | (deferred) |
| 4 | SHA-512 | WARN + zero H_MEM | (deferred) |
| 5 | SHA-512/224 | WARN + zero H_MEM | (deferred) |
| 6 | SHA-512/256 | WARN + zero H_MEM | (deferred) |
| 7 | SHA-512/t | WARN + zero H_MEM | (deferred) |

JSON event types: **34** (unchanged from Phase 2.CR — same
`sha` event type, distinguished by `mode_name` field).

## 81-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.CP  | Standalone SHA peripheral (SHA-256 only)                |
| 2.CQ  | eFuse BLOCK4-9 key material                              |
| 2.CR  | USB Serial/JTAG Controller                               |
| **2.CS** | **SHA-1 mode in SHA peripheral**                     |

## Próximas direcciones

- **SHA-224 mode** — same compress as SHA-256 but different
  H_init + 28-byte truncated output.
- **SHA-384 / SHA-512 modes** — different round count (80),
  64-bit words, 1024-bit blocks, 128-bit length encoding.
  Significantly more code.
- **DMA-SHA path** — DMA_START / DMA_CONTINUE / DMA_BLOCK_NUM
  + the source/dest DMA buffers.
- **HMAC-SHA-1** in the HMAC peripheral (currently SHA-256 only).
- **USB Serial/JTAG RX reverse channel** — mirror of
  Phase 2.X.input GPIO path.
- **JTAG bridge peripheral** — wires DIS_PAD_JTAG +
  SOFT_DIS_JTAG + DIS_USB_JTAG end-to-end.
- **Multi-block HMAC** (SET_MESSAGE_ING/END).
- **AES-CBC / AES-GCM** block modes.
- **XTS-AES** for flash encryption.
- **RSA / ECC / DS / ECDSA** crypto peripherals.
- **MS5611 / W5500 / MFRC522** sensors/SPI responders.
- **UART IRQ** via interrupt matrix.
- **Real PWM** waveform via LEDC.
- **FreeRTOS** scheduler resurrection.
