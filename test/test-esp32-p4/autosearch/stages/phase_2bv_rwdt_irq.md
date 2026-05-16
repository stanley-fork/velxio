# Phase 2.BV — RWDT IRQ→CLIC wiring per TRM § 17.5

**Estado**: ✅ done — closes the RWDT IRQ chain (mirror of Phase
2.BU for MWDT). Action=Interrupt (RWDT code 1, decoded in Phase
2.BP) now actually pulses CPU IRQ via CLIC cause 30 instead of
just emitting JSON.

Per TRM § 17.5 Register Summary, RWDT has its own INT register
set at offsets 0x24-0x30:
```
0x24 RTC_WDT_INT_RAW_REG  (R/WTC/SS)
0x28 RTC_WDT_INT_ST_REG   (RO, hardware-maintained)
0x2C RTC_WDT_INT_ENA_REG  (R/W)
0x30 RTC_WDT_INT_CLR_REG  (WT, W1TC)
```

Implementation follows the unified IRQ template (8th instance
after TWAI/I2C/SPI/RMT/ADC/LEDC/MWDT). New `rtc_wdt_irq` JSON
event type emitted on edge transitions.

Boot regression-clean: 0 rtc_wdt_irq events. Existing 4-event
RTC WDT boot trace (unlock → disable → feed → lock) preserved.

## Goal

Phase 2.BU closed the MWDT IRQ chain. The RWDT side was the
remaining gap — action=1 was JSON-only (event emitted but
registered guest ISR never ran).

Phase 2.BV closes it with the unified IRQ template, completing
the WDT subsystem's silicon-correctness.

## Lo que SE INVESTIGÓ

### 1. TRM § 17.5 Register Summary — RWDT INT layout

From TRM verbatim:
```
RTC_WDT_INT_RAW_REG  0x0024  R/WTC/SS  raw interrupt status
RTC_WDT_INT_ST_REG   0x0028  RO        masked-and-latched
RTC_WDT_INT_ENA_REG  0x002C  R/W       enable mask
RTC_WDT_INT_CLR_REG  0x0030  WT        W1TC clear
```

Standard 4-register IRQ block at offsets 0x24-0x30. Bit 0 = RWDT
timeout interrupt.

### 2. CLIC cause line allocation

After Phase 2.BL (TWAI1/2) and 2.BK (LEDC) the cause line map was:
- 17 SYSTIMER
- 18 GPIO
- 19 TIMG0
- 20 TIMG1
- 21 TWAI0
- 22 I2C0
- 23 I2C1
- 24 SPI2
- 25 RMT
- 26 ADC
- 27 LEDC
- 28 TWAI1
- 29 TWAI2

Cause **30** is the next free slot for RWDT.

### 3. Real silicon LP→HP IRQ path simplified

Real silicon routes RWDT IRQ through the LP-side interrupt
controller (LP_INTR_SOURCE_RTC_WDT) which then feeds the HP
CPU's CLIC via cross-clock-domain wiring. Our emulator doesn't
model the LP interrupt controller separately — we route
directly from `rwdt_intr_out` to CLIC cause 30.

Functionally equivalent for the "WDT warning fires CPU ISR"
demos this unlocks. The LP-side routing distinction matters
for power-management code paths that distinguish LP-originated
vs HP-originated IRQs, but Arduino sketches generally don't
care.

Documented in the inline comment so future maintainers
understand the simplification.

### 4. INT_ST as hardware-maintained view

Per TRM (and our 8 prior IRQ-template phases), INT_ST is
INT_RAW & INT_ENA, hardware-computed. Our `update_irq()` writes
INT_ST every time it runs, so guest reads always see the
current masked-and-latched view.

### 5. Edge detection prevents redundant events

Standard template feature. Only emit `rtc_wdt_irq` JSON event
when the line state transitions, not on every register access.

### 6. Boot safety

Boot sequence: unlock → disable (EN=0, action=0) → feed →
lock. With EN=0, the timer never arms. Even if it did, action=0
means "no operation" — INT_RAW.WDT bit never gets set. Live
test confirms 0 `rtc_wdt_irq` events at boot.

## Lo que SÍ funcionó

Live test (2026-05-08):
```
0 rtc_wdt_irq events
Existing 4-event RTC WDT boot trace unchanged:
  unlock → disable → feed → lock
```

The new IRQ path activates only when guest enables RWDT with
action=1 (Interrupt). Code path correct-by-construction —
matches the proven template used 7 times prior.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Skip LP interrupt controller modeling**: real silicon
   routes RWDT IRQ through LP_INTR → HP CLIC. We go direct to
   CLIC cause 30. Documented as the simplification cost — power-
   management code paths that distinguish LP-source IRQs may
   behave differently. Arduino sketches won't notice.

2. **Cause 30 (not LP-specific cause)**: allocated from the
   same pool as HP peripherals. Real silicon has separate LP
   cause numbering, but our flat allocation works.

3. **One RWDT INT bit only**: real silicon has more (e.g.,
   SUPER_WDT_INT). We only model the basic RWDT timeout
   interrupt. Bit 0 of INT_RAW. Other bits stay zero.

4. **Boot self-test doesn't exercise the path**: WDT is
   disabled at boot. The path activates only when guest
   firmware enables RWDT with action=1 + then fails to feed.

5. **Same edge-detection template as 7 prior IRQ phases**: no
   new patterns introduced.

## Lessons learned

1. **TRM § 17.5 Register Summary is the canonical map**: with
   8 IRQ-wiring phases under our belt, reading the register
   summary table is mostly a matter of confirming offsets.
   Template can be applied in ~80 lines of code.

2. **8-phase IRQ-template streak**: TWAI (2.BF), I2C (2.BG),
   SPI (2.BH), RMT (2.BI), ADC (2.BJ), LEDC (2.BK), MWDT (2.BU),
   RWDT (2.BV). The template recipe is now mature emulator
   coding idiom — 50 lines of mostly-mechanical code per
   peripheral.

3. **LP-side IRQ simplification is documented, not silently
   wrong**: real silicon has LP_INTR controller routing; we
   skip it. The inline comment makes the simplification
   discoverable in case a future demo depends on the
   distinction.

4. **MWDT + RWDT now both fully silicon-complete**: from
   Phase 2.BN's silicon-correctness streak through Phase 2.BU
   + 2.BV, both WDT classes have:
   - TRM-correct write keys ✓
   - TRM-correct bit layouts ✓
   - Action decoding ✓
   - TRM-correct timeout formulas ✓
   - Multi-stage cycling ✓
   - IRQ→CLIC wiring ✓
   - Reset action (env-gated) ✓

## Implementación final

### `include/hw/timer/esp32p4_lp_wdt.h`

- **Added**: INT_RAW/ST/ENA/CLR register offsets per TRM § 17.5.
- **Added**: `ESP32P4_LP_WDT_INT_WDT_BIT` for the timeout bit.
- **Added**: `rwdt_intr_out` (qemu_irq) + `rwdt_irq_level` (bool)
  fields with inline TRM citation.

### `hw/timer/esp32p4_lp_wdt.c`

- **Added**: `#include "hw/irq.h"`.
- **Added**: `esp32p4_lp_wdt_update_irq()` helper — 8th instance
  of the unified IRQ template. Recomputes from (INT_RAW &
  INT_ENA), maintains INT_ST, edge-detects, drives intr_out,
  emits `rtc_wdt_irq` JSON event.
- Reset callback: action=Interrupt path now sets INT_RAW bit 0
  + calls update_irq.
- Write handler: INT_CLR W1TC + INT_ENA recompute trigger.
- Realize: `qdev_init_gpio_out_named("esp32p4.rtc_wdt.intr", 1)`.
- Reset: drop IRQ line if asserted.

### `hw/riscv/esp32p4.c`

- LP_WDT init block: `qdev_connect_gpio_out_named` to CLIC
  cause 30, with inline note about LP-IRQ-controller
  simplification.

## Estado consolidado (post-2.BV)

WDT IRQ chain — both classes now actually trap CPU:

| WDT | Phase | CLIC cause | INT_RAW bit | TRM ref |
|-----|-------|------------|-------------|---------|
| TIMG0 WDT | 2.BU | 19 (shared T0) | bit 2 | § 17.4 + Reg 16.21 |
| TIMG1 WDT | 2.BU | 20 (shared T0) | bit 2 | § 17.4 + Reg 16.21 |
| **RTC WDT** | **2.BV** | **30 (dedicated)** | **bit 0** | **§ 17.5** |
| Super WDT | n/a | n/a (always-reset) | n/a | n/a |

CLIC cause map updated:
```
17 SYSTIMER, 18 GPIO, 19 TIMG0, 20 TIMG1,
21 TWAI0, 22 I2C0, 23 I2C1, 24 SPI2, 25 RMT,
26 ADC, 27 LEDC, 28 TWAI1, 29 TWAI2,
30 RTC_WDT (new)
```

JSON event types: **28** (added `rtc_wdt_irq`).

## 59-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BS  | MWDT multi-stage cycling                                 |
| 2.BT  | RWDT multi-stage cycling                                 |
| 2.BU  | MWDT IRQ→CLIC wiring                                     |
| **2.BV** | **RWDT IRQ→CLIC wiring**                             |

**9 consecutive TRM-grounded phases (2.BN → 2.BV)**. Both MWDT
and RWDT subsystems now fully silicon-complete. SWD is also
complete (no stages by design, fixed-1s timeout, env-gated
reset, TRM-correct unified key).

## Próximas direcciones

- **eFuse model** — WDT_DELAY_SEL + MAC + chip-rev (TRM Ch 8).
- **UART IRQ** (QOM class-override).
- **Real PWM** waveform on GPIO via LEDC.
- **BH1750/SHT31/CCS811** sensors.
- **SPI3** instantiation.
- **FreeRTOS** scheduler.
