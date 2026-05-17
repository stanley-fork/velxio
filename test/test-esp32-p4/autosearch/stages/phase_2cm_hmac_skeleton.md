# Phase 2.CM — HMAC peripheral skeleton (TRM Chapter 24) + eFuse loop closure

**Estado**: ✅ done — first peripheral that **consumes** the
Phase 2.CL KEY_PURPOSE infrastructure. Closes the eFuse →
peripheral silicon enforcement loop end-to-end: guest writes
KEY_PURPOSE in eFuse → HMAC reads it on every operation →
validates → rejects mismatches. **31st JSON event type**
(`hmac`).

Live verification (2026-05-17) — three scenarios cover the
full validation matrix:

| Scenario | eFuse `KEY_PURPOSE_0` | HMAC op `purpose` | Result |
|----------|----------------------|-------------------|--------|
| Default boot | 0 (USER) | 5 (HMAC_DOWN_ALL) | **ERROR** — mismatch |
| `VELXIO_EFUSE_KEY_PURPOSE_0=5` | 5 (HMAC_DOWN_ALL) | 5 (HMAC_DOWN_ALL) | **OK** — match |
| `VELXIO_EFUSE_KEY_PURPOSE_0=2` | 2 (XTS_AES_256_KEY_1) | 5 (HMAC_DOWN_ALL) | **ERROR** — wrong role |

Boot trace examples:
```
[esp32p4.hmac] op#1 key=0 purpose=5 (HMAC_DOWN_ALL)
  efuse_purpose=0 (USER) → ERROR (mismatch)

{"event":"hmac","op":1,"key":0,"purpose":5,
 "purpose_name":"HMAC_DOWN_ALL","efuse_purpose":0,"error":true}
```

The JSON event captures the full validation result so the
frontend can render "HMAC: rejected — key slot 0 not
provisioned for HMAC".

## Goal

Phase 2.CL added KEY_PURPOSE as **data** (eFuse fields with
env-var override + role-name decoder), but no peripheral was
**consuming** it. This phase adds the HMAC accelerator (TRM
Chapter 24) as the first consumer:

1. Models the MMIO region at HMAC_BASE = `0x50095000`
   (= `DR_REG_HPPERIPH0_BASE + 0x90000 + 0x5000` per IDF
   `reg_base.h`).
2. Decodes the canonical IDF `hmac_calculate()` register
   sequence: SET_PARA_PURPOSE → SET_PARA_KEY →
   SET_PARA_FINISH → WR_MESSAGE_MEM → SET_MESSAGE_ONE →
   SET_START.
3. On SET_START, reads the selected key's eFuse purpose via
   Phase 2.CL's `esp32p4_efuse_get_key_purpose(s, key)`
   accessor.
4. Validates: (a) requested purpose ∈ {HMAC_DOWN_ALL=5,
   HMAC_DOWN_JTAG=6, HMAC_DOWN_DS=7, HMAC_UP=8}, (b)
   eFuse-programmed purpose for the key matches the requested
   purpose.
5. Latches QUERY_ERROR (TRM Register 24.10) on mismatch.
   Emits a new `"hmac"` JSON event with full validation
   context.

This is the **silicon-faithful gate**: real chips refuse to
HMAC with a key whose KEY_PURPOSE wasn't programmed for
HMAC duties.

## Lo que SE INVESTIGÓ

### 1. HMAC base address derivation

IDF `components/soc/esp32p4/include/soc/reg_base.h:190` defines:
```c
#define DR_REG_HMAC_BASE  (DR_REG_CRYPTO_BASE + 0x5000)
```
where `DR_REG_CRYPTO_BASE = DR_REG_HPPERIPH0_BASE + 0x90000`
and `DR_REG_HPPERIPH0_BASE = 0x50000000`. Computed:
**0x50095000**.

Cross-checked: the crypto block sits adjacent to RSA
(0x50092000), ECC (0x50093000), DS (0x50094000), and ECDSA
(0x50096000) — all six crypto engines share a 0x10000-byte
window starting at `DR_REG_AES_BASE = 0x50090000`. HMAC is the
6th of 7 (AES/SHA/RSA/ECC/DS/HMAC/ECDSA).

### 2. Register layout from IDF hmac_reg.h

Mapped 17 registers across the 0x1000 MMIO region:

| Offset | Register | Direction | Purpose |
|--------|----------|-----------|---------|
| 0x40 | SET_START | W | trigger operation |
| 0x44 | SET_PARA_PURPOSE | W | requested purpose 0..15 |
| 0x48 | SET_PARA_KEY | W | key slot 0..7 (only 0..5 valid) |
| 0x4C | SET_PARA_FINISH | W | confirm parameter config |
| 0x50 | SET_MESSAGE_ONE | W | one-block mode |
| 0x54 | SET_MESSAGE_ING | W | continuation |
| 0x58 | SET_MESSAGE_END | W | last block |
| 0x5C | SET_RESULT_FINISH | W | ack result-read |
| 0x60 | SET_INVALIDATE_JTAG | W | clear JTAG soft-enable |
| 0x64 | SET_INVALIDATE_DS | W | clear DS input |
| 0x68 | QUERY_ERROR | R | bit 0 = key/purpose mismatch |
| 0x6C | QUERY_BUSY | R | bit 0 = op in progress |
| 0x80-0xBF | WR_MESSAGE_MEM | W | 64-byte message buffer |
| 0xC0-0xDF | RD_RESULT_MEM | R | 32-byte digest (SHA-256) |
| 0xF0 | SET_MESSAGE_PAD | W | padding control |
| 0xF4 | ONE_BLOCK | W | single-block flag |
| 0xF8 | SOFT_JTAG_CTRL | W | JTAG soft enable |

This phase models all 17 as either scratch storage or with
documented side effects. SHA-256 computation deferred — a
full implementation needs ~200 LOC of SHA-256 in addition
to this skeleton.

### 3. Valid KEY_PURPOSE values for HMAC

Per IDF `esp_efuse_chip.h:69-72` + TRM Chapter 24 § "Key
Purpose Selection":

```c
ESP_EFUSE_KEY_PURPOSE_HMAC_DOWN_ALL              = 5
ESP_EFUSE_KEY_PURPOSE_HMAC_DOWN_JTAG             = 6
ESP_EFUSE_KEY_PURPOSE_HMAC_DOWN_DIGITAL_SIGNATURE = 7
ESP_EFUSE_KEY_PURPOSE_HMAC_UP                    = 8
```

Any other purpose (USER, ECDSA_KEY, XTS_AES_*,
SECURE_BOOT_DIGEST_*, KM_INIT_KEY) → mismatch error.

Real silicon enforces this at two levels:
1. **Hard gate**: the key-routing matrix in silicon only
   wires keys-with-HMAC-purpose to the HMAC peripheral's
   key input. A USER-purpose key isn't physically connected.
2. **Software check**: the SW driver (`esp_hmac.c`) reads
   QUERY_ERROR after the op and rejects the result on
   non-zero.

The emulator models gate #2 — the QUERY_ERROR bit is what
guest code observes. Modeling gate #1 (physical routing)
isn't useful since we don't compute actual SHA-256.

### 4. Validation gate composition

Three failure modes for an HMAC op:
1. Requested purpose isn't an HMAC role (e.g., requesting
   purpose=2=XTS_AES on the HMAC peripheral).
2. Selected key slot's eFuse-programmed purpose doesn't
   match the requested purpose.
3. Selected key slot is out of range (6 or 7).

All three latch QUERY_ERROR. JSON event captures the
combined result; stderr trace shows the exact mismatch.

### 5. SHA-256 deferred

The skeleton intentionally **doesn't compute SHA-256**.
Real silicon: HMAC = SHA-256(opad || SHA-256(ipad || msg)).
That's:
- 2 invocations of SHA-256 per HMAC operation.
- ~200 LOC of SHA-256 round implementation in C (or link to
  libcrypto/gcrypt).
- Result buffer (32 bytes) populated with digest bytes.

For Phase 2.CM, the validation logic is the silicon-faithful
behavior of interest. RD_RESULT_MEM returns whatever was
last written (zeros after reset). When SHA-256 lands, the
result buffer becomes meaningful — but the gate behavior
won't change.

The skeleton-vs-full split lets this phase land cleanly. A
future Phase 2.CN could add SHA-256 computation.

### 6. QUERY_BUSY always 0 (instantaneous)

Real silicon takes ~70 cycles per 512-bit SHA-256 block.
Our model has no actual computation, so QUERY_BUSY always
reads 0. IDF driver code polls QUERY_BUSY in a while loop
— a guest test would never block on it.

This is a benign simplification: silicon → busy briefly,
emulator → never busy. Guest code sees the result faster but
behaves correctly otherwise.

### 7. eFuse reference wiring

The HMAC peripheral needs a pointer to the eFuse state to
call `esp32p4_efuse_get_key_purpose()`. Added `efuse` field
to ESP32P4HmacState, wired by machine init AFTER both
peripherals are realized:

```c
ms->hmac.efuse = &ms->efuse;
```

This is a runtime peripheral-to-peripheral reference, not
QOM-style parent/child. Same pattern as Phase 2.CC's
peripheral disable (`twai.disabled = efuse_get_dis_twai()`).

## Lo que SÍ funcionó

1. ✅ Build clean — meson reconfigured to include the new
   `esp32p4_hmac.c` source file. Three objects compiled
   (`hmac.c`, `efuse.c`, `esp32p4.c`).
2. ✅ Default boot: requested purpose=5 vs eFuse=USER → ERROR
   path fires correctly. JSON event has `error:true`.
3. ✅ `VELXIO_EFUSE_KEY_PURPOSE_0=5`: same op now succeeds.
   JSON event has `error:false`. Validates the gate accepts
   valid configurations.
4. ✅ `VELXIO_EFUSE_KEY_PURPOSE_0=2` (XTS_AES, valid eFuse
   role but wrong for HMAC): ERROR path fires. Validates
   the gate rejects non-HMAC roles even when eFuse is
   programmed.
5. ✅ stderr trace + JSON event both present — debuggable
   and frontend-renderable.
6. ✅ No regression in other peripherals (chip_info still
   emits, 22 i2c_rx events still fire, etc.).

## Lo que NO funcionó / decisiones tomadas

### Lo que casi falla

**meson.build forgot the new source file**. Initial build
attempt compiled the existing files but skipped
`esp32p4_hmac.c`, leading to link errors for
`esp32p4_hmac_self_test`.

Caught by remembering to add the new `.c` file to
`hw/misc/meson.build` under the
`CONFIG_RISCV_ESP32P4` block (alongside `esp32p4_rng.c`,
`esp32p4_rmt.c`, `esp32p4_twai.c`). Meson auto-reconfigured
on the next ninja run.

Lesson: new C files always need a meson.build entry. The
existing CLAUDE.md mentions QOM patterns but not meson —
worth a note for future peripheral additions.

### Decisiones tomadas

1. **Skeleton-vs-full split**: validation gate first
   (silicon-faithful behavior), SHA-256 computation deferred.
   ~250 LOC for this phase; full HMAC would be ~450 LOC.

2. **QUERY_BUSY always 0**: real silicon → ~70 cycles, our
   model → instantaneous. Benign for guest code that polls.

3. **eFuse pointer not QOM child**: matches the Phase 2.CC
   `twai.disabled` pattern. Lighter-weight than full QOM
   parent/child and works because both peripherals are
   long-lived sibling fields of the machine state.

4. **Two-mode self-test (auto error + opt-in OK)**: the
   default-boot self-test fires the ERROR path
   automatically, proving the gate works. Users explicitly
   provision `VELXIO_EFUSE_KEY_PURPOSE_0=5` to exercise the
   OK path. Avoids "always-succeeds" silent test.

5. **JSON event includes both requested AND eFuse purpose**:
   the frontend can render "requested HMAC_DOWN_ALL but key
   slot 0 has USER" without re-parsing. Helps debugging.

6. **No IRQ wiring**: TRM Chapter 24 doesn't define an HMAC
   interrupt line. The peripheral is polling-only via
   QUERY_BUSY. No CLIC cause to allocate.

## Lessons learned

1. **Closing eFuse → peripheral loops makes the eFuse work
   feel "alive"**. Phases 2.BW through 2.CL added eFuse
   fields that no peripheral consumed. Phase 2.CM is the
   first that actually uses one — and immediately
   demonstrates real silicon enforcement behavior.

2. **Skeleton-first lets validation logic ship before
   computation**: HMAC validation is ~50 LOC; SHA-256 is
   ~200 LOC. Splitting them lets this phase land with the
   silicon-faithful gate behavior, leaving computation for
   future work.

3. **meson.build is part of the new-file workflow**. New
   `.c` files MUST be added to the appropriate
   `meson.build` `system_ss.add(...)` block. Easy to forget
   when copying patterns from existing peripherals (which
   already exist in meson).

4. **Cross-peripheral references via QOM-sibling pointers**
   scale: eFuse is referenced by TWAI (Phase 2.CC), and now
   HMAC (this phase). The pattern is uniform.

## Implementación final

### `include/hw/misc/esp32p4_hmac.h`

- New `ESP32P4HmacState` struct with: storage[],
  latched purpose/key_slot/params_finished/error_latched/
  op_count, eFuse pointer, event_log/boot_ns.
- All 17 TRM register offsets defined.
- Field bit masks for PURPOSE (4-bit) and KEY (3-bit).
- Self-test forward declaration.

### `hw/misc/esp32p4_hmac.c`

- `esp32p4_hmac_purpose_is_hmac(p)` — checks p ∈ {5,6,7,8}.
- `esp32p4_hmac_purpose_name(p)` — local enum→string, falls
  back to Phase 2.CL accessor for non-HMAC roles.
- `esp32p4_hmac_validate_and_emit(s)` — the silicon gate:
  reads eFuse key purpose via Phase 2.CL accessor; checks
  key-in-range + purpose-is-HMAC + purpose-matches; latches
  QUERY_ERROR; emits stderr + JSON.
- `esp32p4_hmac_read/write()` — MMIO dispatch.
  QUERY_BUSY always 0; SET_START triggers validation.
- `esp32p4_hmac_self_test()` — drives the full IDF
  `hmac_calculate()` register sequence.

### `hw/misc/meson.build`

- Added `'esp32p4_hmac.c'` to the
  `CONFIG_RISCV_ESP32P4` source list.

### `hw/riscv/esp32p4.c`

- New `#include "hw/misc/esp32p4_hmac.h"`.
- New `ESP32P4HmacState hmac` field on machine state.
- New HMAC init block at 0x50095000 with eFuse-pointer
  wiring and self-test call (after the TWAI1/2 instantiation
  block).

## Estado consolidado (post-2.CM)

Crypto peripheral inventory:

| Peripheral | Base | Status | Phase |
|------------|------|--------|-------|
| AES | 0x50090000 | unimplemented stub | n/a |
| SHA | 0x50091000 | smart stub (SHA_BUSY=0 only) | 2.I.sha |
| RSA | 0x50092000 | unimplemented stub | n/a |
| ECC | 0x50093000 | unimplemented stub | n/a |
| DS | 0x50094000 | unimplemented stub | n/a |
| **HMAC** | **0x50095000** | **skeleton + KEY_PURPOSE validation** | **2.CM** |
| ECDSA | 0x50096000 | unimplemented stub | n/a |

eFuse → peripheral consumption chain:

| eFuse field | Phase | Consumed by | Phase |
|-------------|-------|-------------|-------|
| WDT_DELAY_SEL | 2.BW | RWDT Thold0 formula | 2.BW |
| WAFER_*/PKG | 2.BY+2.CA | chip_info self-test | 2.CB |
| DIS_TWAI | 2.CC | TWAI peripheral disable | 2.CC |
| **KEY_PURPOSE_0..5** | **2.CL** | **HMAC validation gate** | **2.CM** |

JSON event types: **31** (chip_info=29, ssd1306=30, hmac=31).

## 75-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.CK  | eFuse JTAG triplet (popcount anti-tamper)               |
| 2.CL  | eFuse KEY_PURPOSE 0..5 (crypto role routing)            |
| **2.CM** | **HMAC peripheral skeleton — closes eFuse loop end-to-end** |

## Próximas direcciones

- **SHA-256 computation for HMAC** (Phase 2.CN candidate) —
  populate RD_RESULT_MEM with real HMAC output.
- **AES-XTS engine** — would consume KEY_PURPOSE_2/3/4 for
  flash encryption keys.
- **Digital Signature peripheral** — would consume
  KEY_PURPOSE_7 (HMAC_DOWN_DS).
- **Secure Boot digest verifier** — would consume
  KEY_PURPOSE_9/10/11.
- **JTAG soft-enable wiring** — SET_INVALIDATE_JTAG +
  SOFT_JTAG_CTRL paths from this HMAC + Phase 2.CK's
  SOFT_DIS_JTAG / DIS_PAD_JTAG.
- **USB Serial/JTAG peripheral** — wires DIS_USB_*.
- **MS5611 / W5500 / MFRC522** sensors/SPI responders.
- **UART IRQ** via interrupt matrix.
- **FreeRTOS** scheduler resurrection.
