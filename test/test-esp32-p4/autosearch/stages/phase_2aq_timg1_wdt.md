# Phase 2.AQ — TIMG1 WDT self-test mirror

**Estado**: ✅ done — both timer groups now demonstrate the canonical
"Arduino disableCoreNWDT" sequence at boot. JSON stream shows 8 total
WDT events (4 per group) instead of 4 (TIMG0 only). Validates the
WDT register paths work symmetrically across both TIMG instances.

## Goal

Phase 2.AP added WDT modelling and a self-test for TIMG0 only. TIMG1
WDT registers were reachable but no demo wrote to them — same
"unproven path" problem we had before Phase 2.AN added the parallel
TIMG1 instance.

This phase mirrors the self-test on TIMG1 by adding a single line to
machine init. Real Arduino-ESP32 disables both WDTs at boot
(`disableCore0WDT()` + `disableCore1WDT()`); we reproduce that.

## Lo que SE INVESTIGÓ

### 1. Real Arduino-ESP32 dual-WDT-disable pattern

`arduino-esp32`'s `esp32-hal-misc.c` defines:

```c
void disableCore0WDT(void) {
    TIMG_WDTWPROTECT(TIMG_REG(0)) = 0x50D83AA1;
    TIMG_WDTCONFIG0(TIMG_REG(0)) = 0;
    TIMG_WDTFEED(TIMG_REG(0)) = 1;
    TIMG_WDTWPROTECT(TIMG_REG(0)) = 0;
}
void disableCore1WDT(void) {
    TIMG_WDTWPROTECT(TIMG_REG(1)) = 0x50D83AA1;
    TIMG_WDTCONFIG0(TIMG_REG(1)) = 0;
    TIMG_WDTFEED(TIMG_REG(1)) = 1;
    TIMG_WDTWPROTECT(TIMG_REG(1)) = 0;
}
```

Same code pattern, different register base. Phase 2.AQ's machine init
calls the existing self-test helper twice — once per TIMG instance.

### 2. Per-instance group_num field carries through

Phase 2.AN added the `group_num` field that Phase 2.AP's WDT JSON
events use. So TIMG0's self-test emits `"grp":0` and TIMG1's emits
`"grp":1` automatically — no JSON format change needed.

This is the third instance of the per-group-num design paying off
(Phase 2.AN: alarm events differ; Phase 2.AN.irq: IRQ wiring
differs; Phase 2.AQ: WDT events differ). Same one-line refactor,
three reuses.

## Lo que SÍ funcionó

10-second live test (2026-05-08):

```
=== JSON event totals ===
Total lines: 440  (was 436 in Phase 2.AP; +4 new wdt events)

  "event":"ledc":     99    ← unchanged
  "event":"adc":      33    ← unchanged
  "event":"timg":     28    ← unchanged
  "event":"timg_irq": 38    ← unchanged
  "event":"i2c":       8    ← unchanged
  "event":"i2c_rx":    1    ← unchanged
  "event":"spi":       3    ← unchanged
  "event":"wdt":       8    ← was 4 (TIMG0 only); now 8 (4 per group)
  "event":"start":     1
  "pin":              210   ← unchanged
```

WDT events split by group:

```
grp 0:    grp 1:
  unlock    unlock
  disable   disable
  feed      feed
  lock      lock
─── 4 ───  ─── 4 ───
```

Sequence at boot (TIMG0 first, TIMG1 follows because it's
instantiated after TIMG0 in machine init):

```json
{"t_ns":403166,"event":"wdt","grp":0,"op":"unlock"}
{"t_ns":405549,"event":"wdt","grp":0,"op":"disable"}
{"t_ns":406407,"event":"wdt","grp":0,"op":"feed","count":1}
{"t_ns":437530,"event":"wdt","grp":0,"op":"lock"}
{"t_ns":535689,"event":"wdt","grp":1,"op":"unlock"}
{"t_ns":537098,"event":"wdt","grp":1,"op":"disable"}
{"t_ns":537704,"event":"wdt","grp":1,"op":"feed","count":1}
{"t_ns":548820,"event":"wdt","grp":1,"op":"lock"}
```

Both sequences identical except for `grp` field. Order matches the
machine-init order (TIMG0 realized first, then TIMG1).

No regression: every other event count identical to Phase 2.AP.

## Lessons learned

1. **Symmetric peripherals deserve symmetric demos**: Phase 2.AP
   self-tested only TIMG0. The "is the path actually validated?"
   question for TIMG1 was answered indirectly (Phase 2.AN proved
   per-instance state works). Phase 2.AQ closes the loop with a
   direct demonstration.

2. **One-line additions can be meaningful**: this phase is a single
   line of code in machine init. The doc is bigger than the
   change. That's fine — the doc value is in confirming the
   pattern works for both instances and citing the Arduino source
   pattern.

3. **Per-instance field design pays off cumulatively**: Phase 2.AN
   added `group_num`. Phase 2.AN was its first use (alarm grp);
   Phase 2.AN.irq the second (IRQ line); Phase 2.AP the third
   (WDT events); Phase 2.AQ the fourth (TIMG1 WDT events). Each
   reuse is essentially free.

## Implementación final

### `hw/riscv/esp32p4.c`

Single line added in TIMG1 init block:
```c
esp32p4_timg_wdt_self_test(&ms->timg1);
```

That's it. Total diff: 1 line of code + comment.

## Estado consolidado (post-2.AQ)

| Hito                                                          | Estado |
|---------------------------------------------------------------|--------|
| TIMG0 + TIMG1 hardware timers + alarms + IRQ + ISR             | ✅ 2.AG-AN.irq |
| TIMG0 + TIMG1 WDT register-level + write-protection            | ✅ 2.AP-AQ |
| WDT actual timeout / reset action                              | ⏳ later |
| RTC WDT + Super WDT                                              | ⏳ later |
| Sensors via I2C (BMP280)                                        | ✅ 2.AM-slave |
| Displays via SPI (ILI9341 init)                                  | ✅ 2.AO |
| Real PWM waveform on GPIO                                       | ⏳ later |
| UART RX path                                                     | ⏳ later |
| Real FreeRTOS port                                               | ⏳ Phase 2.V |

## 25-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.U-AB| GPIO + JSON event channel                               |
| 2.AC-AF| LEDC PWM + multi-channel rainbow                       |
| 2.AD  | ADC peripheral                                          |
| 2.AG-AI| TIMG hardware timer + DIVIDER                          |
| 2.AH-AN.irq | TIMG → IRQ → ISR (3-way dispatch, both groups)    |
| 2.AM-slave | I2C master + BMP280 responder                      |
| 2.AO  | SPI master skeleton                                     |
| 2.AP  | TIMG0 Watchdog (unlock/disable/feed/lock)               |
| **2.AQ** | **TIMG1 Watchdog (mirror of TIMG0)**                  |

JSON stream still 10 event types. Both TIMG groups now produce
matching wdt events.

## Próximas direcciones

- **Phase 2.AP.reset**: actual WDT timeout → CPU reset action.
- **RTC WDT** modelling at LP_WDT_BASE.
- **Super WDT** (TRM 17.3) — always-on, survives reset.
- **2.AO.slave**: synthetic ILI9341 SPI responder.
- **UART RX path** — bidirectional UART input.
- **Real PWM waveform on GPIO**.
- **HW Random Number Generator (RNG)**.
- **Real FreeRTOS port** (Phase 2.V deferred).
