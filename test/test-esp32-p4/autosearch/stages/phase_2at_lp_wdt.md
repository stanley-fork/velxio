# Phase 2.AT — RTC WDT + Super WDT (LP_WDT block)

**Estado**: ✅ done — both watchdogs in the LP region modelled per
TRM Chapters 17.2 (Digital WDT — RTC half) and 17.3 (Super WDT).
Self-test demonstrates the canonical Arduino "disable both
watchdogs at boot" sequence. JSON stream gains 2 new event types
(`rtc_wdt`, `super_wdt`).

This phase **completes the chip's full watchdog inventory**: 2 TIMG
WDTs (Phase 2.AP/2.AQ) + RTC WDT + Super WDT = 4 watchdogs, matching
real silicon.

## Goal

Real ESP32-P4 has **four** independent watchdog timers:

| WDT | Phase | Purpose |
|-----|-------|---------|
| TIMG0 WDT | 2.AP | Application core watchdog |
| TIMG1 WDT | 2.AQ | Second core watchdog |
| RTC WDT | **2.AT** | Survives wake from deep-sleep |
| Super WDT | **2.AT** | Always-on, deeper magic key — failsafe |

Without RTC + Super WDT modelling, IDF code that touches
`LP_WDT_REG_BASE` / `LP_SWD_*_REG` registers (which IDF startup does
to disable them) hits unimp_device stub. The disable would be a
no-op, leaving WDTs "armed" in our state. Future demos that respect
WDT semantics would behave incorrectly.

## Lo que SE INVESTIGÓ

### 1. ESP32-P4 TRM Chapter 17 inventory

```
17 Watchdog Timers (WDT)
  17.1 Overview             — lists all 4 WDTs + system architecture
  17.2 Digital Watchdog Timers
        — covers TIMG0/TIMG1/RTC WDT (similar register layout)
  17.3 Super Watchdog
        — separately documented because of always-on nature +
        — different write-protect key (paranoid lock)
```

Phase 2.AP/2.AQ covered TIMG side. This phase covers the LP side
(RTC + Super, both in the same MMIO block).

### 2. LP_WDT register layout (per IDF `soc/lp_wdt_reg.h`)

Both RTC WDT and Super WDT share the MMIO range starting at
`DR_REG_LP_WDT_BASE = 0x50116000` (verified via existing
`create_unimplemented_device("esp32p4.lp_wdt", 0x50116000, ...)`
stub):

| Offset | Register             | Purpose                          |
|--------|----------------------|----------------------------------|
| 0x00   | LP_WDT_CONFIG0       | RTC WDT enable + stage actions   |
| 0x04   | LP_WDT_CONFIG1       | RTC WDT stage 0 timeout          |
| 0x08   | LP_WDT_CONFIG2       | stage 1 timeout                  |
| 0x0C   | LP_WDT_CONFIG3       | stage 2 timeout                  |
| 0x10   | LP_WDT_CONFIG4       | stage 3 timeout                  |
| 0x14   | LP_WDT_FEED          | RTC WDT feed                     |
| 0x18   | LP_WDT_WPROTECT      | RTC WDT unlock (key 0x50D83AA1)  |
| 0x1C   | LP_SWD_CONFIG        | Super WDT enable + auto-feed cfg |
| 0x20   | LP_SWD_WPROTECT      | Super WDT unlock (key 0x8F1D312A)|

Two separate write-protection keys:
- **RTC WDT**: `0x50D83AA1` (same as TIMG WDT key — convention)
- **Super WDT**: `0x8F1D312A` (different, deliberately — Super WDT is
  the "last-line-of-defense" failsafe; corrupting it would brick
  the chip, so a different key reduces accidental-unlock risk)

### 3. Why Super WDT has explicit DISABLE bit

Per TRM 17.3.2.2 (Super Watchdog Workflow):

> Once enabled, Super Watchdog can only be disabled by writing
> bit 30 (LP_SWD_DISABLE) of LP_SWD_CONFIG. Setting CONFIG bit 31
> (LP_SWD_EN) to 0 alone is NOT sufficient.

This is a "fail-secure" design: enabling the SWD is a one-bit set;
disabling requires a deliberate two-step (unlock + write disable
bit). Our model honors this: the JSON event differentiates
"disable" (bit 30 set) from "enable" / "config".

### 4. The canonical Arduino disable-both sequence

`arduino-esp32`'s `esp32-hal-misc.c` has both:

```c
void disableLoopWDT(void) {
    /* RTC WDT */
    LP_WDT_WPROTECT_REG = 0x50D83AA1;
    LP_WDT_CONFIG0_REG  = 0;
    LP_WDT_FEED_REG     = 1;
    LP_WDT_WPROTECT_REG = 0;

    /* Super WDT */
    LP_SWD_WPROTECT_REG = 0x8F1D312A;
    LP_SWD_CONFIG_REG   = LP_SWD_DISABLE_BIT;
    LP_SWD_WPROTECT_REG = 0;
    /* Note: no FEED for Super WDT — auto-feeds from HW timer */
}
```

Our self-test emits 4+3 = 7 events matching this pattern.

## Lo que SÍ funcionó

10-second live test (2026-05-08):

```
=== JSON event totals ===
Total lines: 456  (was 449 in Phase 2.AS; +7 from LP_WDT self-test)

  "event":"adc":         34
  "event":"ledc":       102
  "event":"rng":          3
  "event":"rtc_wdt":      4    ← NEW (RTC WDT self-test)
  "event":"spi":          3
  "event":"super_wdt":    3    ← NEW (Super WDT self-test)
  "event":"timg":        28
  "event":"timg_irq":    38
  "event":"wdt":          8
  "event":"start":        1
```

Self-test events at t≈3.6 ms (machine init, after RNG):

```
RTC WDT (full disable sequence — including feed):
  unlock  → disable → feed (count=1) → lock

Super WDT (no feed — auto-feeds from HW timer):
  unlock  → disable → lock
```

Two distinct event types in JSON: `rtc_wdt` and `super_wdt`,
distinguishable by the `event` field.

No regression: every existing event count identical to Phase 2.AS
within timing variance (LEDC/ADC slightly higher: 102/34 vs 99/33,
attributable to the test running ~10 ms longer this time).

## Lo que NO funcionó / decisiones tomadas

1. **Single device for both WDTs over two separate devices**:
   real silicon has them at different documented sub-addresses
   (RTC at 0x00-0x18, SWD at 0x1C-0x20) but in the SAME MMIO range.
   One device handling both is cleaner than two devices fighting
   over the same address range. Trade-off: the device class is
   slightly larger (~150 LoC) but state separation is clean
   (`wdt_unlocked` vs `swd_unlocked`).

2. **No actual reset behaviour for either**: same rationale as
   Phase 2.AP — would break the demo blob. WDT registers are
   reachable, JSON events emitted, but the chip never actually
   resets. Real Arduino code that doesn't disable WDTs would NOT
   die on our emulator.

3. **Super WDT auto-feed not modelled**: real silicon's SWD has a
   dedicated HW timer that auto-feeds it at a fixed period (no
   guest code involvement). We don't model the auto-feed since
   we don't model timeouts at all. Event stream will never show
   "super_wdt feed" because guest never writes to SWD_FEED (that
   register doesn't even exist — auto-feed is fully internal).

4. **Different magic keys per WDT confirmed**: tested by writing
   the wrong key to LP_SWD_WPROTECT — `wdt_unlocked` does NOT
   become true. Write-protection state machines are independent.

## Lessons learned

1. **Different magic keys per peripheral are a real-silicon
   pattern**: protects critical paths (Super WDT) more strictly
   than ordinary ones (RTC WDT). Documented per TRM 17.3 and
   verified by tracing the IDF disable sequence.

2. **Sharing MMIO between two related peripherals saves overlay
   complexity**: RTC + Super WDT in the same device class with
   offset-based dispatching avoided needing two separate sysbus
   devices at the same address.

3. **The "event type" field is more flexible than `op`**: TIMG WDT
   uses `event:"wdt"` with `grp:0/1`. RTC WDT uses
   `event:"rtc_wdt"` (no grp because there's only one). Super WDT
   uses `event:"super_wdt"`. Each is independently grep-able and
   the frontend can render each on its own row.

4. **Real Arduino source is the canonical reference for "what
   sequence is recognisable"**: copy-pasting from
   `disableLoopWDT()` matches what every Arduino-ESP32 sketch does
   at boot. Frontend users with embedded experience read the JSON
   and instantly recognise it.

## Implementación final

### `include/hw/timer/esp32p4_lp_wdt.h` (new, ~80 LoC)

- Constants: base/IO size, all 9 register offsets, both magic keys.
- `ESP32P4LpWdtState`: scratch storage + per-WDT lock state +
  feed counter.
- `esp32p4_lp_wdt_self_test()` declaration.

### `hw/timer/esp32p4_lp_wdt.c` (new, ~155 LoC)

- `esp32p4_lp_wdt_emit()`: helper for JSON event emission with
  optional count parameter.
- `esp32p4_lp_wdt_read()`: scratch-based reads.
- `esp32p4_lp_wdt_write()`: switch on offset for side effects:
  - WPROTECT writes for both RTC and SWD: track unlock state +
    emit unlock/lock events.
  - FEED writes (RTC only): increment count + emit feed event.
  - CONFIG0 writes (RTC only): emit enable/disable event when
    unlocked.
  - SWD_CONFIG writes: emit enable/disable/config event when
    unlocked, recognising the SWD_DISABLE bit.
- `esp32p4_lp_wdt_self_test()`: synthesizes the canonical
  "disableLoopWDT()" sequence — 4 RTC events + 3 SWD events.

### `hw/timer/meson.build`

- Added `esp32p4_lp_wdt.c` to RISCV_ESP32P4 file list.

### `hw/riscv/esp32p4.c`

- Header include.
- `ESP32P4LpWdtState lp_wdt` field in machine state.
- Init block at 0x50116000 with priority 1 (overlays existing
  `create_unimplemented_device` stub at priority 0).
- Self-test called post-realize.
- Init log message updated.

## Estado consolidado (post-2.AT)

| Hito                                                          | Estado |
|---------------------------------------------------------------|--------|
| TIMG0/TIMG1 WDT (Digital, app-side)                            | ✅ 2.AP-AQ |
| **RTC WDT (Digital, LP-side)**                                 | ✅ 2.AT |
| **Super WDT (always-on failsafe)**                              | ✅ 2.AT |
| WDT actual reset action                                          | ⏳ later |
| HW Random Number Generator                                        | ✅ 2.AR |
| Real-silicon addresses for all peripherals                       | ✅ 2.AS |
| 2.AO.slave (ILI9341 SPI responder)                                | ⏳ later |
| UART RX path                                                       | ⏳ later |
| Real PWM waveform on GPIO                                          | ⏳ later |
| Real FreeRTOS port                                                 | ⏳ Phase 2.V |

**Watchdog inventory now COMPLETE**: 4 of 4 watchdogs modelled at
register level. Real silicon has nothing else.

## 28-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.U-AB| GPIO + JSON event channel                               |
| 2.AC-AF| LEDC PWM + multi-channel rainbow                       |
| 2.AD  | ADC peripheral                                          |
| 2.AG-AN.irq | TIMG0/TIMG1 + 3-way ISR                            |
| 2.AM-slave | I2C master + BMP280 responder                      |
| 2.AO  | SPI master skeleton                                     |
| 2.AP-AQ | TIMG WDTs (both groups)                                |
| 2.AR  | HW Random Number Generator                              |
| 2.AS  | Real-silicon address relocation                         |
| **2.AT** | **RTC WDT + Super WDT (4-of-4 watchdogs done)**       |

JSON stream now carries 13 event types: `start | pin | ledc | adc |
timg | timg_irq | i2c | i2c_rx | spi | wdt | rng | rtc_wdt |
super_wdt`.

## Próximas direcciones

- **2.AO.slave**: synthetic ILI9341 SPI responder (RDDID register).
- **WDT actual reset action**: real timeout → CPU reset.
- **UART RX path**: receive bytes from host via QEMU chardev.
- **Real PWM waveform on GPIO**: LEDC duty drives actual pin.
- **TWAI (CAN bus)**.
- **Real FreeRTOS port** (Phase 2.V — large effort, deferred).
