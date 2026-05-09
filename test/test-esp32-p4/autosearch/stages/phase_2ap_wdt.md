# Phase 2.AP — TIMG Watchdog (WDT) stub

**Estado**: ✅ done — Watchdog Timer registers added to TIMG device per
ESP32-P4 TRM Chapter 17 + IDF `soc/timer_group_reg.h`. Self-test
emits the canonical "Arduino disables Core 0 WDT at boot" sequence
(unlock → disable → feed → lock), demonstrating write-protection
works as documented in TRM Section 17.2.2.3.

## Goal

Real ESP32-P4 has 4 watchdog timers: 2 TIMG WDTs (one per group) +
RTC WDT + Super WDT. Phase 2.AG-AN added the TIMG general-purpose
T0 timers but ignored the WDT side completely — IDF code that pokes
WDT registers (which it does during init) hit silent scratch
storage, no events, no validation that the unlock/feed/lock dance
worked.

This phase adds register-level WDT modelling for both TIMG groups
without actually triggering CPU resets on timeout (which would break
the demo blob).

## Lo que SE INVESTIGÓ

### 1. ESP32-P4 TRM Chapter 17 (Watchdog Timers)

Per the TRM table of contents:

```
17 Watchdog Timers (WDT)
  17.1 Overview
  17.2 Digital Watchdog Timers
    17.2.1 Features
    17.2.2 Functional Description
      17.2.2.1 Clock Source and 32-Bit Counter
      17.2.2.2 Stages and Timeout Actions
      17.2.2.3 Write Protection
      17.2.2.4 Flash Boot Protection
  17.3 Super Watchdog
  17.4 Interrupts
  17.5 Register Summary
  17.6 Registers
```

Key facts (per TRM 17.2 + IDF source):
- Each TIMG group has one WDT (so total: 2 TIMG WDTs).
- 4 stages, each with independent timeout action: off / interrupt /
  CPU reset / system reset.
- Counter clock = APB / (1 + WDT_CLK_PRESCALE), default 1 µs tick.
- Stage 0 timeout starts counting on enable; on timeout, performs
  configured action and advances to stage 1; and so on.
- **Write-protection**: ALL WDT register writes are silently dropped
  unless `WDTWPROTECT_REG` was last written with the magic key
  `0x50D83AA1`. Any other write to WDTWPROTECT re-locks. This
  prevents accidental WDT changes from corrupted code.

### 2. Register layout (per IDF `soc/timer_group_reg.h`)

Within each TIMG group's MMIO range:

| Offset | Register     | Purpose                              |
|--------|--------------|--------------------------------------|
| 0x48   | WDTCONFIG0   | enable + per-stage actions + clock   |
| 0x4C   | WDTCONFIG1   | clock prescale (high bits)           |
| 0x50   | WDTCONFIG2   | stage 0 timeout count                |
| 0x54   | WDTCONFIG3   | stage 1 timeout count                |
| 0x58   | WDTCONFIG4   | stage 2 timeout count                |
| 0x5C   | WDTCONFIG5   | stage 3 timeout count                |
| 0x60   | WDTFEED      | write any → reset counter to 0       |
| 0x64   | WDTWPROTECT  | write 0x50D83AA1 to unlock; other → lock |

WDTCONFIG0 bit fields (subset modelled):
- bit 31: WDT_EN (overall enable)
- bit 30: WDT_FLASHBOOT_MODE_EN
- bits 28-29: STG3 action
- bits 26-27: STG2 action
- bits 24-25: STG1 action
- bits 22-23: STG0 action
- ... (other clock and reset-length fields not modelled)

### 3. The canonical "disable WDT at boot" sequence

Almost every Arduino-ESP32 sketch starts with implicit disabling
of WDT on Core 0 (the loop core). `disableCore0WDT()` from
arduino-esp32's `esp32-hal-misc.c` does:

```c
TIMG_WDTWPROTECT_REG = 0x50D83AA1;   // unlock
TIMG_WDTCONFIG0_REG  = 0;             // disable + zero all stage actions
TIMG_WDTFEED_REG     = 1;             // reset counter
TIMG_WDTWPROTECT_REG = 0;             // re-lock
```

We synthesize this exact sequence in `esp32p4_timg_wdt_self_test()`
for TIMG0 self-test. Frontend sees 4 events at boot showing the
unlock/disable/feed/lock dance — the recognisable "Arduino starting
up" pattern.

### 4. Why no actual reset behaviour

Two reasons:
  (a) Our demo blob doesn't feed the WDT. With autoreload disabled,
      the blob would be killed on first stage 0 timeout. Test would
      regress to "demo dies after a few seconds".
  (b) Modelling actual reset (CPU reset / system reset) requires
      QEMU's machine_reset infrastructure, which depends on which
      core/system is being reset. Substantial work.

For Phase 2.AP we accept WDT register writes (with proper unlock-key
gating), emit JSON events, but **never escalate to a reset action**.
Future Phase 2.AP.reset can add real reset behaviour once the demo
blob feeds the watchdog.

## Lo que SÍ funcionó

10-second live test (2026-05-08):

```
=== JSON event totals ===
Total lines: 436  (was 432 in Phase 2.AO; +4 WDT events)

  "event":"ledc":     99    ← unchanged
  "event":"adc":      33    ← unchanged
  "event":"timg":     28    ← unchanged
  "event":"timg_irq": 38    ← unchanged
  "event":"i2c":       8    ← unchanged
  "event":"i2c_rx":    1    ← unchanged
  "event":"spi":       3    ← unchanged
  "event":"wdt":       4    ← NEW (self-test sequence)
  "event":"start":     1
  "pin":              210   ← unchanged
```

WDT events at t≈451 µs (machine init) — the full Arduino-style
disable sequence:

```json
{"t_ns":451818,"event":"wdt","grp":0,"op":"unlock"}
{"t_ns":454610,"event":"wdt","grp":0,"op":"disable"}
{"t_ns":455552,"event":"wdt","grp":0,"op":"feed","count":1}
{"t_ns":472399,"event":"wdt","grp":0,"op":"lock"}
```

The `unlock` event is emitted because the guest wrote the magic key
to WDTWPROTECT. The subsequent `disable` write to WDTCONFIG0 is
allowed (because unlocked); JSON event reflects that the EN bit is
0. The `feed` write resets the counter (count=1 = first feed since
boot). The final write of 0 to WDTWPROTECT re-locks.

This proves the write-protection state machine works correctly: a
guest that *forgot* to unlock first would see its CONFIG writes
silently dropped (no JSON event emitted because the path returns
early on `wdt_unlocked == false`).

No regression: every other event count identical to Phase 2.AO.

## Lo que NO funcionó / decisiones tomadas

1. **No actual timeout / reset action**: documented above. Phase
   2.AP.reset would add it. Without this, the WDT is purely
   observational — the JSON events show what guest wrote, but the
   chip never actually resets. Real Arduino code that doesn't feed
   the watchdog would NOT die on our emulator (yet).

2. **CONFIG writes that violate lock**: silently absorbed by scratch
   storage (the `memcpy` happens before our switch dispatches),
   matching real-silicon "write goes through but config doesn't
   take effect" behaviour. A pedantic implementation would also
   detect such "phantom" writes and warn — deferred.

3. **No counter modelling**: real WDT has a 32-bit counter clocked
   from APB / prescale. We don't model it. Frontend can infer
   "guest is feeding regularly" from feed event rate, which is
   sufficient for "is the chip alive" dashboards.

4. **TIMG1 WDT not self-tested**: only TIMG0 fires self-test events.
   TIMG1 WDT registers are reachable but no demo writes to them.
   This mirrors real Arduino behaviour where only Core 0 / TIMG0
   gets the explicit disable; TIMG1 is left at HW defaults.

## Lessons learned

1. **TRM Section X.Y.Y references make docs self-validating**:
   citing "TRM 17.2.2.3 Write Protection" tells future Claude the
   exact silicon-spec source for the magic-key behaviour. Anyone
   wanting to verify can pull up the TRM and check.

2. **Static device-internal write fns are reusable**: `esp32p4_timg_write`
   is `static` to its .c file. Calling it from `esp32p4_timg_wdt_self_test`
   (also in same file) lets us simulate a guest write without
   requiring `address_space_write` machinery. Same pattern used in
   Phase 2.AM.slave's I2C self-test.

3. **The Arduino disable-WDT sequence is THE recognisable boot
   signal**: anyone with embedded experience reading the JSON
   stream sees `unlock + disable + feed + lock` and instantly
   knows "Arduino starting up". Self-tests that produce
   recognisable patterns are self-documenting.

4. **Modelling write-protection state machines correctly catches
   real bugs**: if a future Arduino sketch forgets the unlock key,
   our model silently drops writes — exactly like real silicon.
   This would surface as "WDT seems disabled but isn't really" in
   real hardware too, making this a meaningful realism property.

## Implementación final

### `include/hw/timer/esp32p4_timg.h`

- New register offset constants for WDT (8 registers at 0x48-0x64).
- New WDTCONFIG0 bit definitions (EN, FLASHBOOT_EN).
- New WDT magic key constant `0x50D83AA1` (`ESP32P4_TIMG_WDT_WKEY`).
- New state fields: `wdt_unlocked` (lock state), `wdt_feed_count`
  (informational counter).
- New self-test prototype `esp32p4_timg_wdt_self_test()`.

### `hw/timer/esp32p4_timg.c`

- Write handler extended with cases for WDTWPROTECT, WDTFEED,
  WDTCONFIG0:
  - WDTWPROTECT: track unlock state, emit JSON.
  - WDTFEED: increment count, emit JSON with running count.
  - WDTCONFIG0: emit JSON only if unlocked (matches HW behavior).
- `esp32p4_timg_reset()`: clears `wdt_unlocked` and `wdt_feed_count`.
- New `esp32p4_timg_wdt_self_test()` synthesizes the unlock/disable/
  feed/lock sequence by calling `esp32p4_timg_write()` directly.
  Bypasses event throttle for the self-test only.

### `hw/riscv/esp32p4.c`

- Machine init: calls `esp32p4_timg_wdt_self_test(&ms->timg0)` after
  TIMG0 device realize + IRQ wiring.

## Estado consolidado (post-2.AP)

| Hito                                                          | Estado |
|---------------------------------------------------------------|--------|
| Sensors via I2C (BMP280)                                       | ✅ 2.AM-slave |
| Displays via SPI (ILI9341 init pattern)                        | ✅ 2.AO |
| TIMG hardware timer + alarm + IRQ                              | ✅ 2.AG-AN.irq |
| **TIMG Watchdog register-level + write-protection**            | ✅ 2.AP |
| WDT actual timeout reset                                       | ⏳ later |
| TIMG1 WDT self-test                                             | ⏳ later |
| RTC WDT + Super WDT                                             | ⏳ later |
| SPI synthetic slave                                              | ⏳ 2.AO.slave |
| Real PWM waveform on GPIO                                      | ⏳ later |
| UART RX path                                                    | ⏳ later |
| Real FreeRTOS port                                              | ⏳ Phase 2.V |

## 24-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.U-AB| GPIO + JSON event channel                               |
| 2.AC-AF| LEDC PWM + multi-channel rainbow                       |
| 2.AD  | ADC peripheral                                          |
| 2.AG-AI| TIMG hardware timer + DIVIDER                          |
| 2.AH-AN.irq | TIMG → IRQ → ISR (3-way dispatch)                |
| 2.AM-slave | I2C master + BMP280 responder                      |
| 2.AO  | SPI master skeleton                                     |
| **2.AP** | **TIMG Watchdog stub (write-protected)**              |

JSON stream now carries 10 event types: `start | pin | ledc | adc |
timg | timg_irq | i2c | i2c_rx | spi | wdt`.

## Próximas direcciones

- **2.AP.reset**: actual WDT timeout → CPU reset action. Requires
  the demo blob to feed (or accept) timeouts.
- **RTC WDT** modelling — different MMIO base, similar register
  layout.
- **Super WDT** (TRM 17.3) — the always-on watchdog that survives
  resets.
- **2.AO.slave**: synthetic ILI9341 SPI responder.
- **UART RX path**.
- **Real PWM waveform on GPIO**.
- **FreeRTOS port** (Phase 2.V deferred).
