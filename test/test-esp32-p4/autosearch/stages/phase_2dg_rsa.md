# Phase 2.DG — RSA Accelerator (TRM Chapter 28) — modexp / modmult / mult + self-contained bignum

**Estado**: ✅ done — replaces the smart_stub at `0x50092000` with a
real RSA accelerator implementing all three large-number operations
(MODEXP, MODMULT, MULT) on operands up to 4096 bits, backed by a
self-contained little-endian multiprecision bignum. First phase
driven end-to-end by **multi-agent workflow orchestration**
(ultracode): a research workflow resolved the decision-critical I/O
conventions before a line was written, and an adversarial verify
workflow fuzzed the math (16,343 cases) + reviewed the register
decode + independently re-derived the driver conventions before
commit.

Live verification (5 self-test vectors, all bit-perfect on the
FIRST build, Z prefix shown little-endian):

```
[esp32p4.rsa] op#1 modexp  N=1 → e60a0000  = 0x0AE6 = 2790   ✓ pow(65,17,3233)
[esp32p4.rsa] op#2 modexp  N=1 → 41000000  = 0x41   = 65     ✓ pow(2790,2753,3233)
[esp32p4.rsa] op#3 modmult N=1 → e5020000  = 0x02E5 = 741    ✓ (1234·5678) mod 3233
[esp32p4.rsa] op#4 mult    N=1 → 6824ce69ceab0000 = 0xABCE69CE2468  ✓ 0xABCD1234·0x10002
[esp32p4.rsa] op#5 modexp  N=2 → 5f885080efb0ac24 = 0x24ACB0EF8050885F ✓ pow(64-bit)

All cross-validated against Python pow()/%/* .
```

## Goal

The RSA accelerator (TRM Chapter 28) is the foundation for the
Digital Signature peripheral (TRM Chapter 30) and for TLS handshakes
in any IDF/mbedtls guest. It performs:

  - **MODEXP**  (`SET_START_MODEXP` @ 0x80C):  `Z = X^Y mod M`
  - **MODMULT** (`SET_START_MODMULT` @ 0x810): `Z = (X · Y) mod M`
  - **MULT**    (`SET_START_MULT` @ 0x814):    `Z = X · Y` (2N-word)

on operands up to 4096 bits (128 × 32-bit words). The single highest-
risk question — does MODMULT return a **plain** product or a
**Montgomery** product? — determines whether a guest's RSA/TLS works
or silently breaks. This phase resolves it adversarially.

## Workflow-driven methodology (ULTRACODE)

This phase was the first to use multi-agent orchestration end-to-end:

### Workflow 1 — `rsa-understand` (5 agents, ~375K tokens)

Four parallel readers + one synthesizer:
- **TRM Ch 28 reader** — algorithm description, operation flows,
  memory summary, register summary, acceleration options.
- **IDF register reader** — `rsa_reg.h`, `rsa_struct.h`, `mpi_ll.h`,
  `mpi_periph.c` → authoritative register map, MODE encoding,
  `MPI_LL_BLOCK_BASES` order, DATE default.
- **mbedtls driver reader** — `bignum_alt.c`, `esp_bignum.c` →
  the EXACT input/output convention of each operation (the ground
  truth for guest compatibility).
- **QEMU conventions reader** — existing AES/SHA peripherals →
  house style (register ops, JSON events, self-test, meson, machine
  init, IRQ wiring).
- **Synthesizer** — merged the four into one implementation spec,
  resolving cross-finding contradictions against the IDF source.

### Workflow 2 — `rsa-verify` (3 adversarial agents, ~180K tokens)

Three parallel verifiers (barrier — all verdicts before commit):
- **bignum fuzz** — extracted the bn_* functions verbatim into a
  standalone harness, fuzzed vs Python.
- **register-decode review** — audited the MMIO callbacks against
  the spec.
- **spec-conformance review** — independently re-derived the driver
  conventions from IDF source (not trusting the model's comments).

## Lo que SE INVESTIGÓ

### 1. Register / memory-bank layout (authoritative, from IDF)

Relative to `DR_REG_RSA_BASE = 0x50092000` (= HPPERIPH0 0x50000000
+ CRYPTO 0x90000 + 0x2000):

| Offset | Name | Behavior |
|--------|------|----------|
| 0x000 | M_MEM | modulus M (512 B / 128 words) |
| 0x200 | Z_MEM | result Z (also r²/Rinv input + MULT 2nd operand) |
| 0x400 | Y_MEM | operand Y (exponent for MODEXP) |
| 0x600 | X_MEM | operand X (base) |
| 0x800 | M_PRIME | Montgomery M′ constant (ignored — see below) |
| 0x804 | MODE | length: N=MODE+1 (modular), 2N=MODE+1 (MULT) |
| 0x808 | QUERY_CLEAN | RO → always 1 (mem ready) |
| 0x80C | SET_START_MODEXP | WT trigger |
| 0x810 | SET_START_MODMULT | WT trigger |
| 0x814 | SET_START_MULT | WT trigger |
| 0x818 | QUERY_IDLE | RO → always 1 (idle/done) |
| 0x81C | INT_CLR | WT clear |
| 0x820 | CONSTANT_TIME | R/W default 1 (timing only) |
| 0x824 | SEARCH_ENABLE | R/W (timing only) |
| 0x828 | SEARCH_POS | R/W (timing only) |
| 0x82C | INT_ENA | R/W gate |
| 0x830 | DATE | R/W default 0x20200618 |

**Note**: the QEMU-conventions agent's header *sketch* put the banks
at wrong offsets (M@0x00, X@0x200, …). The synthesizer caught this
and the implementation uses the authoritative `rsa_reg.h` offsets
above. **Lesson: cross-check every agent's claim against the
primary source; the synthesizer's contradiction-resolution earned
its keep here.**

### 2. THE critical question — MODMULT plain vs Montgomery product

`bignum_alt.c`'s `esp_mpi_mul_mpi_mod_hw_op` loads `Rinv = R² mod M`
into Z_MEM, then fires MODMULT. The hardware uses Montgomery
internally, so a *naive* reading says the result is the Montgomery
product `(X·Y·R⁻¹) mod M`.

**But** the spec-conformance verify agent re-derived from
`esp_bignum.c` `esp_mpi_mul_mpi_mod` (the caller): it reads Z back
via `mpi_ll_read_from_mem_block` and **only sets the sign**
(`Z->s = X->s · Y->s`) — there is **no** post-multiply by R or Rinv.
So the driver treats Z as the plain `(X·Y) mod M`.

Mechanism: with Z_MEM pre-loaded with `R² mod M`, the MODMULT
hardware performs an extra internal Montgomery step that cancels the
R⁻¹ factor, so the **net observable result** the driver reads is the
plain product. **Resolution: the model computes plain `(X·Y) mod M`.**
Confirmed bit-perfect by the self-test (op#3 = 741, the plain
product — not 135, the Montgomery product).

### 3. r² / M_PRIME independence (MODEXP)

`esp_mpi_exp_mod` reads Z back directly as `X^Y mod M` with no
Rinv/Mprime-dependent post-processing (only a sign flip for negative
X). So the model **ignores** M_PRIME, the r² in Z_MEM, CONSTANT_TIME,
and SEARCH_* — they're Montgomery/timing acceleration only and don't
affect the mathematical result. Confirmed by the fuzz (16,343 cases).

### 4. MULT operand placement — the famous quirk

`esp_mpi_mul_mpi_hw_op` loads X into X_MEM and the **second
multiplicand into Z_MEM at word offset N** (byte 0x200+4N), NOT into
Y_MEM. MODE encodes the *result* length 2N (= MODE+1), so the model
recovers N = (MODE+1)/2. The product (2N words) overwrites Z_MEM. The
model reads the 2nd operand from Z_MEM **before** overwriting it.

### 5. MODE encoding

ESP32-P4 writes MODE = num_words − 1 directly (`mpi_ll_set_mode`),
NOT `(num_words/16 − 1)` like the original ESP32. So N = MODE + 1
for modular ops; 2N = MODE + 1 for MULT.

### 6. QUERY_CLEAN / QUERY_IDLE polarity (verified directly)

`mpi_ll.h`:
```c
mpi_ll_check_memory_init_complete() { return REG_READ(QUERY_CLEAN) == 0; }
mpi_ll_get_int_status()            { return REG_READ(QUERY_IDLE)  == 0; }
```
`mpi_hal.c` loops `while(check_memory_init_complete())` and
`while(get_int_status())`. So the guest waits **while** the reg reads
0, exiting when it reads **non-zero**. Returning **1** for both makes
both poll loops exit immediately — correct for an instantaneous
model. (The verify agent flagged this as a possible polarity bug; I
read the LL + hal source directly and confirmed it's correct — the
function names are just confusingly inverted.)

## Lo que SÍ funcionó

1. ✅ **Bignum: 16,343 fuzz cases, ZERO mismatches** (verify
   workflow). Sizes {32,64,128,256,1024,2048}-bit. All edge cases:
   Y=0 (→1), Y=1, X=0, X=1, X>M, X=M, M=1 (→0), M even, M=0 (→0,
   silicon-undefined), 0^0 mod m=1. Carry propagation, shl1 limb
   growth at all word boundaries, mod bit-loop invariant, mul carry
   into the high slot — all hold.
2. ✅ **All 5 self-test vectors bit-perfect on the first build** —
   no debugging cycle. The synthesized spec + Python references were
   sufficient to write it correctly.
3. ✅ **MODMULT plain-product resolution confirmed** by the
   spec-conformance agent (driver reads Z directly, no post-multiply)
   AND by op#3 = 741.
4. ✅ Register decode: QUERY overrides before storage memcpy
   (unshadowable), triggers auto-clear, MULT B-read precedes Z
   overwrite, bounds all in-range, host-endian-independent byte
   assembly.
5. ✅ Build clean (meson auto-reconfigured for the new file). No
   regression on AES/SHA/HMAC/I2C/etc.
6. ✅ New `rsa` JSON event (`mode`, `words`, `z_prefix`). INT wired
   to CLIC cause 37.

## Lo que NO funcionó / decisiones tomadas

### Bug found by verify + fixed: reset IRQ deassert

The register-decode agent (verdict CONCERN) found a real latent bug:
`esp32p4_rsa_reset()` cleared the `irq_level` bool but never called
`qemu_set_irq(s->intr_out, 0)`. If reset fired while the completion
IRQ was asserted, the physical line would stay stuck high at the
interrupt controller, and `update_irq()`'s early-return-on-no-change
would prevent later correction. **Fixed**: added an unconditional
`qemu_set_irq(s->intr_out, 0)` in reset (idempotent; `intr_out` is
valid because `realize()` runs `sysbus_init_irq()` first).

### Decisiones tomadas

1. **Compute the plain arithmetic result; ignore Montgomery
   constants.** M_PRIME, r², CONSTANT_TIME, SEARCH_* don't change the
   math result — the driver reads back plain values. The model is
   silicon-output-compatible, not Montgomery-faithful. Matches the
   established AES/SHA "real output, not table-optimized" philosophy.

2. **Self-contained bignum, no GMP.** QEMU is plain C with no GMP
   dependency. Implemented a fixed-size `uint32_t[264]` LE bignum
   (264 words = 8448-bit headroom; covers 2N=256 words at 4096-bit +
   the shl1 +1-word growth). Schoolbook mul (O(n·m) uint64
   accumulator), binary long-division reduction (shift-and-subtract
   bit-by-bit), right-to-left binary modexp.

3. **Correctness over speed.** Binary long division is slow
   (O(bits²)) but provably correct for arbitrary 4096-bit moduli.
   The self-test uses tiny operands → instant. A real 4096-bit
   private-key modexp would block the QEMU thread for a moment
   during the triggering MMIO write (the guest polls QUERY_IDLE
   which we always return idle → it never hangs). A Montgomery/
   Barrett fast path is a documented future optimization.

4. **QUERY_CLEAN/QUERY_IDLE → always 1.** Instantaneous model; both
   poll loops exit immediately (polarity verified from LL/hal source).

5. **INT on CLIC cause 37.** First free cause after the Phase 2.CZ
   UART wiring (29, 32..36 used). TRM § 28.4 defines an RSA interrupt
   on completion; INT_ENA gates, INT_CLR clears the latch.

6. **No new shared module.** Unlike SHA (shared `sha_common`), the
   RSA bignum is RSA-specific and stays inside `esp32p4_rsa.c`.

## Lessons learned

1. **Workflow-driven research front-loads the hard decisions.** The
   MODMULT plain-vs-Montgomery question would have been a multi-hour
   trial-and-error debugging session if discovered after writing the
   code. The research workflow resolved it from source *before*
   implementation, and the verify workflow independently re-confirmed
   it — two independent derivations agreeing is far stronger than one.

2. **Adversarial fuzz catches what self-tests can't.** The 5
   hand-picked self-test vectors all passed first try, but the
   16,343-case fuzz across edge cases (M=0, M=1, Y=0, X>M, 2048-bit
   carry chains) is what actually licenses confidence in the bignum.
   A self-test proves "these 5 work"; the fuzz proves "the algorithm
   is correct."

3. **Verify agents can be overcautious — confirm their flags.** The
   spec-conformance agent flagged the QUERY polarity as a possible
   bug while hedging "happens to satisfy them." Reading the LL + hal
   source directly confirmed it's correct. **Trust but verify the
   verifier** — don't blindly act on a flagged "bug," and don't
   blindly dismiss it either.

4. **Cross-check every agent claim against the primary source.** The
   conventions agent's header offsets were wrong; the synthesizer
   caught it because it had the authoritative `rsa_reg.h` in hand.
   Multi-agent synthesis with a contradiction-resolution step is more
   robust than any single agent.

5. **One real bug found + fixed pre-commit.** The reset IRQ deassert
   would have been a hard-to-reproduce stuck-interrupt bug in the
   field. The register-decode review caught it before it ever shipped.

## Implementación final

### `include/hw/misc/esp32p4_rsa.h` (new)
- TYPE_ macro, register/bank offset #defines, `ESP32P4RsaState`
  (storage[0x1000], op_count, event_log, boot_ns, intr_out,
  irq_level, int_pending), self-test prototype.

### `hw/misc/esp32p4_rsa.c` (new, ~430 LOC)
- Self-contained LE bignum: `bn_t` + `bn_zero/norm/from_bank/
  to_bank/cmp/sub/shl1/mul/mod/modmul/modexp`.
- `do_modexp` / `do_modmult` / `do_mult` dispatchers.
- `update_irq` (int_pending latch, INT_ENA gate, edge-driven),
  `emit` (rsa JSON event + stderr + raise latch).
- read (QUERY_CLEAN/IDLE→1 overrides), write (trigger dispatch +
  auto-clear, INT_CLR, INT_ENA), reset (CONSTANT_TIME=1,
  DATE=0x20200618, **qemu_set_irq lower**), realize, class/type.
- 5-vector self-test driving the silicon register sequence.

### `hw/misc/meson.build`
- Added `esp32p4_rsa.c` to the `CONFIG_RISCV_ESP32P4` block.

### `hw/riscv/esp32p4.c`
- `#include esp32p4_rsa.h`; `ESP32P4RsaState rsa` field; replaced
  the 0x50092000 smart_stub with a real peripheral (priority-2
  overlay) + event_log/boot_ns + INT→cause 37 + self-test call.

## Estado consolidado (post-2.DG)

Crypto peripheral coverage:

| Peripheral | TRM Ch | Status |
|------------|--------|--------|
| AES | 25 (TRM)/22 (our note) | AES-128/192/256 ECB ✓ (2.CO) |
| SHA | 29 | 8/8 modes ✓ (2.CP..2.DD) |
| HMAC | 27 | HMAC-SHA-256 multi-block ✓ (2.CM..2.CV) |
| **RSA** | **28** | **MODEXP/MODMULT/MULT ✓ (this phase)** |
| Digital Signature (RSA_DS) | 30 | next — depends on RSA |
| ECC/ECDSA | — | deferred |

JSON event types: **37** (adds `rsa`).

## 95-Phase realism progression

| Phase | Capability |
|-------|------------|
| 2.DE | BME680 IAQ sensor |
| 2.DF | MS5611 CRC-4 PROM verification |
| **2.DG** | **RSA accelerator — modexp/modmult/mult (workflow-driven + adversarially verified)** |

A guest's `mbedtls_rsa_*` / TLS RSA handshake now has a working
hardware accelerator. The Digital Signature peripheral (Ch 30) can
build on it next.

## Próximas direcciones

- **Digital Signature peripheral (TRM Ch 30)** — consumes RSA modexp
  + eFuse KEY_PURPOSE=7 + the DS-encrypted private-key params. Now
  unblocked.
- **RSA Montgomery/Barrett fast path** — replace binary long-division
  reduction to make real 4096-bit private-key modexp fast (perf only,
  not correctness).
- **RSA-CRT** — the IDF DS path uses CRT; verify our plain modexp
  composes correctly under the driver's CRT decomposition.
- **BME688**, DMA-SHA, AES-CBC/GCM/XTS (needs DMA), ECC (TRM 26),
  UART RX chardev injection, `uart_irq` events, SHA dispatch
  table-refactor, W5500/MFRC522, FreeRTOS resurrection.
