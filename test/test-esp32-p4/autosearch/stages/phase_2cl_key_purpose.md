# Phase 2.CL — eFuse KEY_PURPOSE 0..5 (crypto key role routing)

**Estado**: ✅ done — completes the BLOCK0 eFuse coverage of
crypto-related fields. Six 4-bit fields, each encoding the
role of one of the six 256-bit crypto key slots (BLOCK4-9 in
real silicon). Values 0-12 map to named IDF crypto roles; 13-15
are reserved.

Live verification (2026-05-17) — representative production
crypto provisioning all 6 keys + invalid input rejection:

```
VELXIO_EFUSE_KEY_PURPOSE_0=2 (XTS_AES_256_KEY_1)
VELXIO_EFUSE_KEY_PURPOSE_1=6 (HMAC_DOWN_JTAG)
VELXIO_EFUSE_KEY_PURPOSE_2=9 (SECURE_BOOT_DIGEST0)
VELXIO_EFUSE_KEY_PURPOSE_3=1 (ECDSA_KEY)
WARN: VELXIO_EFUSE_KEY_PURPOSE_4='99' is not 0..15 — ignored
VELXIO_EFUSE_KEY_PURPOSE_5=12 (KM_INIT_KEY)
```

All 13 known values map to correct names; the sentinel value
13 falls back to `RESERVED_13`; invalid input (`99`) is
rejected with a WARN trace and the field remains 0.

## Goal

Phase 2.CK closed out the JTAG-disable triplet in DATA0; this
phase tackles the **other half of BLOCK0's security state**:
the per-key purpose codes that gate which crypto engine each
of the 6 user-programmable keys feeds. These are essential for
realistic Secure Boot / Flash Encryption / ECDSA / HMAC
provisioning state in the emulator.

Without modeling KEY_PURPOSE, any guest crypto code
(`esp_efuse_get_key_purpose()` in IDF) would always read 0
(USER) for all 6 slots, blocking Secure Boot / Flash Encryption
init paths that check whether a `SECURE_BOOT_DIGEST_N` or
`XTS_AES_256_KEY_N` purpose is programmed.

## Lo que SE INVESTIGÓ

### 1. Authoritative source: TWO IDF files needed

Unlike the simpler DATA0 fields (where one file = both layout
and semantics), KEY_PURPOSE requires reading two IDF files:

**File 1 — bit layout**:
`components/soc/esp32p4/include/soc/efuse_struct.h`
- KEY_PURPOSE_0: `rd_repeat_data1.key_purpose_0:4` at bits 24-27
- KEY_PURPOSE_1: `rd_repeat_data1.key_purpose_1:4` at bits 28-31
- KEY_PURPOSE_2: `rd_repeat_data2.key_purpose_2:4` at bits 0-3
- KEY_PURPOSE_3: `rd_repeat_data2.key_purpose_3:4` at bits 4-7
- KEY_PURPOSE_4: `rd_repeat_data2.key_purpose_4:4` at bits 8-11
- KEY_PURPOSE_5: `rd_repeat_data2.key_purpose_5:4` at bits 12-15

**File 2 — value semantics**:
`components/efuse/esp32p4/include/esp_efuse_chip.h:60-77`
defines `esp_efuse_purpose_t` enum mapping 0..15 to role names.

Splitting layout from semantics is silicon-correct: the
silicon just stores 4 bits, and the consuming peripheral
(HMAC engine, AES-XTS engine, ECDSA engine, etc.) is what
interprets the role. The emulator mirrors this split.

### 2. IDF role enum (authoritative table)

From `esp_efuse_chip.h`:

| Value | Role | Used for |
|-------|------|----------|
| 0 | `USER` | software-only key, no HW routing |
| 1 | `ECDSA_KEY` | ECDSA private key (LE order) |
| 2 | `XTS_AES_256_KEY_1` | flash/PSRAM encryption (half 1) |
| 3 | `XTS_AES_256_KEY_2` | flash/PSRAM encryption (half 2) |
| 4 | `XTS_AES_128_KEY` | flash/PSRAM encryption (128-bit) |
| 5 | `HMAC_DOWN_ALL` | HMAC Downstream — generic |
| 6 | `HMAC_DOWN_JTAG` | JTAG soft-enable key |
| 7 | `HMAC_DOWN_DIGITAL_SIGNATURE` | DS peripheral key |
| 8 | `HMAC_UP` | HMAC Upstream — generic |
| 9 | `SECURE_BOOT_DIGEST0` | Secure Boot key digest 0 |
| 10 | `SECURE_BOOT_DIGEST1` | Secure Boot key digest 1 |
| 11 | `SECURE_BOOT_DIGEST2` | Secure Boot key digest 2 |
| 12 | `KM_INIT_KEY` | Key Manager init key |
| 13-15 | (RESERVED) | undefined, MAX = 16 sentinel |

**Surprise**: `ECDSA_KEY = 1` (NOT 13 as my initial mental
model guessed). The task description I wrote upfront had this
wrong; double-checked the IDF source before implementing.

### 3. Two split layouts (DATA1 + DATA2)

Unlike Phase 2.CC's DATA0 fields (all in one register),
KEY_PURPOSE spans **two registers**:
- DATA1 (offset 0x34) holds KEY_PURPOSE_0/1 (high bits 24-31).
- DATA2 (offset 0x38) holds KEY_PURPOSE_2/3/4/5 (low bits 0-15).

Implementation pattern: a static const layout table
`{data_idx, shift}[6]` captures both the register-index and
bit-shift for each key. The accessor and env-var parser share
this table so layout knowledge lives in one place.

### 4. Per-key role-name lookup

Stderr traces and JSON events need a human-readable role name,
not a raw 0..15 value. Implemented a sparse static const array
keyed by purpose code, with explicit fallback for
RESERVED_13/14/15. Caller never sees NULL.

Designed for compactness:
```c
static const char *names[13] = {
    [0] = "USER", [1] = "ECDSA_KEY", ..., [12] = "KM_INIT_KEY",
};
if (purpose < 13) return names[purpose];
if (purpose < 16) return reserved[purpose - 13];
return "INVALID";
```

The C99 designated-initializer form makes the role-to-value
mapping unambiguous at the source level.

### 5. Env-var parser handles 6 fields with one loop

Instead of writing 6 separate parsers (one per
`VELXIO_EFUSE_KEY_PURPOSE_N`), one loop iterates 0..5,
constructs the env-var name dynamically with `snprintf`, and
applies the layout table. Adding a 7th key (impossible on
ESP32-P4 silicon but a useful pattern) would mean one new
layout-table row and one bump of the loop bound.

Validation: `strtol` with `*endp == '\0'` for full-string
consume, range check `0 <= v <= 15`. Out-of-range input gets a
WARN trace and the field stays at its default (0 = USER).

### 6. Default = 0 = USER = un-programmed eFuse

The `key_purpose:4 default: 0` annotation in the IDF struct
matches launch silicon: all 6 keys default to USER role, which
is the "key data isn't routed to any HW crypto engine"
sentinel. Real chips ship with this default; production
provisioning programs specific keys to specific purposes.

The emulator's factory default boot shows no KEY_PURPOSE
stderr noise (silent) — only the env-var-driven override case
emits traces. Same contract as Phase 2.BX silent-default.

## Lo que SÍ funcionó

1. ✅ Build clean — single file changed.
2. ✅ All 13 known IDF roles map to correct names
   (USER → KM_INIT_KEY).
3. ✅ Sentinel value 13 falls back to RESERVED_13.
4. ✅ Invalid input (99) rejected with WARN, field stays at 0.
5. ✅ Representative crypto provisioning (XTS_AES_256_KEY_1 +
   HMAC_DOWN_JTAG + SECURE_BOOT_DIGEST0 + ECDSA_KEY +
   KM_INIT_KEY) all parse and label correctly.
6. ✅ Default boot regression-clean — no KEY_PURPOSE stderr
   output, chip_info still emits.
7. ✅ Layout table cross-checked: KEY_PURPOSE_0 at DATA1
   shift 24, KEY_PURPOSE_5 at DATA2 shift 12 (highest 4-bit
   field in DATA2's low half).

## Lo que NO funcionó / decisiones tomadas

### Lo que casi falla

**Wrong ECDSA_KEY enum value in initial task description**.
The Phase 2.CL task subject said "ECDSA_KEY(13)" based on
muddled recall of another chip generation. The IDF enum on
ESP32-P4 puts ECDSA at index 1.

Caught by **explicitly searching `esp_efuse_chip.h` for the
enum BEFORE writing the names table**. Cost: 5 minutes of
research; saved a regression that would have made every
Secure Boot test fail silently (because the consuming HW
engine would see USER role instead of the configured one).

Documented in this autosearch so a future maintainer
extending this to ESP32-S3 or ESP32-C6 doesn't make the same
mistake — those chips have different enum tables.

### Decisiones tomadas

1. **Single per-key accessor with `key_idx` param** instead of
   6 individual accessors. Saves 5 forward-declarations.
   Bounds-checks `key_idx < 6` internally for safety.

2. **Separate role-name helper** instead of returning the
   name from the accessor. Caller can use raw value for
   register-encoding tests + name for stderr/JSON tracing
   without re-parsing.

3. **Static const layout table, not switch statement**:
   eliminates the "did I get bit-shift 12 vs 16 right for
   KEY_PURPOSE_4?" mental load. The table is authoritative.

4. **strtol with full-string consume**: rejects "12abc" or
   "12 13" — only accepts a clean decimal integer in
   [0, 15]. Out-of-range or non-numeric → WARN + default.

5. **Reserved values (13-15) labeled, not refused**: the
   silicon doesn't validate; consuming peripherals see an
   unknown purpose and fail. The model matches: env-var can
   set 13-15, accessor returns the value, name says
   RESERVED_N. Real-silicon-faithful.

6. **No JSON event for KEY_PURPOSE**: the value is set at
   boot and never changes. Chip_info-style on-demand reporting
   would be useful but requires a new event type. Deferred.

## Lessons learned

1. **Multi-file IDF source-of-truth is the norm for crypto
   fields**. Layout and semantics live in different headers
   (`soc/efuse_struct.h` for bits, `efuse/include/esp_efuse_chip.h`
   for value enums). Future crypto-related phases will
   probably need 2-3 IDF files read together.

2. **Don't trust task-description enum values without
   verification**. The autosearch pattern is "investigate
   first, implement second". Phase 2.CL caught the
   `ECDSA_KEY=1` correction precisely because the
   investigation step preceded the table coding.

3. **Static const dispatch tables scale** — same pattern as
   Phase 2.CI's I2C dispatcher, now applied to KEY_PURPOSE
   layout. A pattern that works at 12 entries (I2C devices)
   also works at 6 (KEY_PURPOSE) and would work at 30+.

4. **Per-key vs per-field accessor**: when a field is
   "fundamentally indexed" (6 keys, each identical except
   index), a single accessor with `idx` param beats 6 named
   accessors. When fields have different semantics (DIS_TWAI
   vs DIS_USB_JTAG), separate named accessors are clearer.

## Implementación final

### `include/hw/nvram/esp32p4_efuse.h`

- 6 new constant pairs (`KEY_PURPOSE_0_SHIFT/MASK` through
  `KEY_PURPOSE_5_SHIFT/MASK`) — split across DATA1 and DATA2.
- 2 new accessor declarations: `get_key_purpose(s, idx)` +
  `key_purpose_name(purpose) → const char *`.
- Inline header comment with the **full IDF role table** so
  the layout is self-documenting.

### `hw/nvram/esp32p4_efuse.c`

- New static const `esp32p4_key_purpose_layout[6]` mapping
  key index → `{data_idx, shift}`.
- New `esp32p4_efuse_get_key_purpose(s, key_idx)` accessor.
- New `esp32p4_efuse_key_purpose_name(purpose)` helper with
  13-entry static const name array + RESERVED_N fallback.
- New env-var parser loop in `apply_env_overrides` —
  iterates 0..5, builds `VELXIO_EFUSE_KEY_PURPOSE_N`
  dynamically, validates with strtol, writes through the
  shared layout table.

### No machine init changes

Pure eFuse model extension. Future crypto peripheral phases
will read via `get_key_purpose()` to decide whether to
service requests for a given key slot.

## Estado consolidado (post-2.CL)

eFuse BLOCK0 crypto-related field coverage:

| Field | Bit(s) | Register | Width | Encoding | Phase |
|-------|--------|----------|-------|----------|-------|
| WDT_DELAY_SEL | 17:16 | DATA1 | 2 | numeric | 2.BW |
| `KEY_PURPOSE_0` | 27:24 | **DATA1** | **4** | **role enum** | **2.CL** |
| `KEY_PURPOSE_1` | 31:28 | DATA1 | 4 | role enum | 2.CL |
| `KEY_PURPOSE_2` | 3:0 | DATA2 | 4 | role enum | 2.CL |
| `KEY_PURPOSE_3` | 7:4 | DATA2 | 4 | role enum | 2.CL |
| `KEY_PURPOSE_4` | 11:8 | DATA2 | 4 | role enum | 2.CL |
| `KEY_PURPOSE_5` | 15:12 | DATA2 | 4 | role enum | 2.CL |

eFuse model now demonstrates **5 encoding patterns**:
1. 1-bit boolean (DIS_TWAI / DIS_USB_JTAG etc.)
2. 2-bit numeric (WDT_DELAY_SEL)
3. 3-bit popcount-parity anti-tamper (SOFT_DIS_JTAG)
4. 3-bit split-encoding (WAFER_MAJOR)
5. 4-bit numeric role enum (KEY_PURPOSE_0..5)

JSON event types: **30** (unchanged — no new event type).

## 74-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.CC  | DIS_TWAI + DIS_USB_* eFuse fields                       |
| 2.CK  | JTAG triplet (popcount anti-tamper documented)          |
| **2.CL** | **KEY_PURPOSE 0..5 — crypto key role routing**       |

## Próximas direcciones

- **HMAC / Digital Signature peripheral models** — once
  modeled, they'd consume `get_key_purpose()` to decide
  whether a given key slot is routed to them.
- **AES-XTS engine for flash encryption** — same idea.
- **Secure Boot digest verifier** — would read SECURE_BOOT_DIGEST*
  KEY_PURPOSE values to find the digest slots.
- **USB Serial/JTAG peripheral model** — would wire
  DIS_USB_JTAG / DIS_USB_SERIAL_JTAG from Phase 2.CC.
- **JTAG bridge model** — would wire DIS_PAD_JTAG +
  SOFT_DIS_JTAG from Phase 2.CK + HMAC_DOWN_JTAG key
  purpose from this phase.
- **MS5611 barometer + W5500/MFRC522 SPI** sensors/peripherals.
- **UART IRQ** via interrupt matrix.
- **FreeRTOS** scheduler resurrection (biggest unblocker).
