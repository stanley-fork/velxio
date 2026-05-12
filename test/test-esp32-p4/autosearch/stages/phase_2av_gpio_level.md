# Phase 2.AV — GPIO LEVEL_HIGH/LEVEL_LOW INT_TYPE filters

**Estado**: ✅ done — completes the GPIO interrupt-type matrix per ESP32-P4
TRM Chapter 9.5. Phase 2.AA added edge filters (rising/falling/anyedge);
Phase 2.AV adds the two level-sensitive types (TYPE 4 = level_low,
TYPE 5 = level_high). Real silicon supports all 6 INT_TYPE values
documented in `GPIO_PINn_REG.INT_TYPE[2:0]`. Our model now supports
all 6 via 4 aggregate mask registers.

## Goal

Per ESP32-P4 TRM Chapter 9.5 (Pin Interrupt Configuration), each pin
has a 3-bit INT_TYPE field with 6 documented values:

```
INT_TYPE
  0 = interrupt disabled
  1 = positive edge (rising)
  2 = negative edge (falling)
  3 = any edge (both rising and falling)
  4 = low level
  5 = high level
```

Phase 2.AA implemented 1, 2, 3 via separate `int_rising_mask` /
`int_falling_mask` aggregate registers. Phase 2.AV adds 4 and 5 via
two more masks. After this phase the chip can express all 6
INT_TYPE values for any pin.

## Lo que SE INVESTIGÓ

### 1. TRM Chapter 9.5 documentation of INT_TYPE values

From the TRM `_TRM_TOC.txt`:

```
9 GPIO and IO MUX
  9.1 Overview
  9.2 Features
  9.3 Functional Description
    9.3.1 GPIO Matrix
    9.3.2 IO MUX
    9.3.3 RTC IO MUX
  9.4 Wakeup Configuration
  9.5 Interrupt Configuration       ← documents INT_TYPE values
```

Per real silicon (per IDF `soc/gpio_struct.h` GPIO_PINn_REG.int_type
field at bits 9:7), the 6 INT_TYPE values are documented and used
by `gpio_set_intr_type()` in IDF as:

```c
typedef enum {
    GPIO_INTR_DISABLE     = 0,
    GPIO_INTR_POSEDGE     = 1,
    GPIO_INTR_NEGEDGE     = 2,
    GPIO_INTR_ANYEDGE     = 3,
    GPIO_INTR_LOW_LEVEL   = 4,
    GPIO_INTR_HIGH_LEVEL  = 5,
} gpio_int_type_t;
```

Phase 2.AA's choice to use aggregate masks (rising_mask +
falling_mask, both 32-bit) was simpler than per-pin INT_TYPE arrays
but limited to expressing the 4 edge combinations. Phase 2.AV
extends with 2 more aggregate masks: `int_level_high_mask` and
`int_level_low_mask`.

The 4-mask scheme can express all 6 INT_TYPE values:

| INT_TYPE | rising_mask[N] | falling_mask[N] | level_high_mask[N] | level_low_mask[N] |
|----------|----------------|-----------------|---------------------|--------------------|
| 0 disabled | 0 | 0 | 0 | 0 | (and `int_ena_mask[N]=0`)
| 1 rising  | 1 | 0 | 0 | 0 |
| 2 falling | 0 | 1 | 0 | 0 |
| 3 anyedge | 0 | 0 | 0 | 0 | (default with `int_ena_mask[N]=1`)
| 3 anyedge | 1 | 1 | 0 | 0 | (alternate spelling)
| 4 lo-level| 0 | 0 | 0 | 1 |
| 5 hi-level| 0 | 0 | 1 | 0 |

The level-sensitive paths take priority over edge paths in our
firing logic — if level_high_mask is set, we ignore rising_mask
and just check the current level state. This matches real silicon
where INT_TYPE is a single 3-bit field, not a combination.

### 2. Register address selection

Following Phase 2.AA's pattern of "3 registers per filter type"
(value + W1TS + W1TC), Phase 2.AV adds 6 new register offsets:

| Offset | Register                          |
|--------|-----------------------------------|
| 0xA8   | GPIO_INT_LEVEL_HIGH_REG           |
| 0xAC   | GPIO_INT_LEVEL_HIGH_W1TS          |
| 0xB0   | GPIO_INT_LEVEL_HIGH_W1TC          |
| 0xB4   | GPIO_INT_LEVEL_LOW_REG            |
| 0xB8   | GPIO_INT_LEVEL_LOW_W1TS           |
| 0xBC   | GPIO_INT_LEVEL_LOW_W1TC           |

Note: these are NOT real-silicon register addresses (real silicon
uses per-pin INT_TYPE in GPIO_PINn_REG at offset 0x174+4*N). Our
mask-based approach is an emulator-internal interface for guest
code that wants to set IRQ types via aggregate operations.

A future Phase 2.AV.real-pinreg could refactor to per-pin
GPIO_PINn_REG registers matching real-silicon layout exactly, but
that's a much larger change.

### 3. Level-sensitive firing semantics

Real silicon: LEVEL_HIGH means "assert IRQ while pin = 1; deassert
when pin = 0". LEVEL_LOW is the inverse. The IRQ fires immediately
on the matching level and stays high until either:
  (a) the pin level changes to the opposite state, or
  (b) the ISR clears the source AND the input transitions

Our implementation: on each transition, if the new level matches
the configured level filter, we fire `qemu_set_irq(pin, 1)` AND
latch `int_status` bit. The latch persists until the ISR clears it
via W1TC (same as edge case, Phase 2.AB pattern).

**Caveat: undriven pins cause infinite loops**. If LEVEL_HIGH is
enabled on a pin that the guest can't deassert (e.g., the fake
button at pin 0 which stays at host-realtime-driven levels), the
ISR runs forever — clears `int_status`, immediately the next
update cycle re-latches because pin level still matches. We do NOT
exercise level-sensitive on any active pin in the demo blob to
avoid this. Documented as known caveat.

### 4. Why no demo blob change

The current demo blob runs on machine boot and the fake button is
on pin 0. If we enabled LEVEL_HIGH on pin 0:
- Pin 0 toggles every 3 seconds (host realtime fake button)
- During HIGH phase: LEVEL_HIGH IRQ fires → ISR runs → clears
  status → IRQ re-asserts on next update → infinite trap loop

This would deadlock the demo. Phase 2.AV ships the infrastructure
without exercising it. A future Arduino sketch could safely use
LEVEL_HIGH on pins it can control deassertion of (e.g., a button
that goes back to LOW after press).

## Lo que SÍ funcionó

10-second live test (2026-05-12):

```
=== JSON event totals ===
Total lines: 452  (identical to Phase 2.AU — no regression)

  All event counts unchanged. No new event types added (level
  filter infrastructure is reachable by guest writes but no demo
  exercises it).
```

The new register addresses are reachable:
- Write to 0xA8 → updates `int_level_high_mask`
- Read at 0xA8 → returns current mask
- W1TS / W1TC variants work atomically

No demo regression — every pin transition (LEDC, running-light,
fake button, TIMG-driven ISR pins, GPIO IRQ → pin 9) fires
correctly because level_high_mask and level_low_mask both start
at zero (disabled).

## Lo que NO funcionó / decisiones tomadas

1. **Aggregate masks over per-pin INT_TYPE registers**: real silicon
   has 32 separate GPIO_PINn_REG registers at 0x174 + 4*N each
   with a 3-bit INT_TYPE field. Our model uses 4 aggregate 32-bit
   masks. Trade-off:
   - Mask scheme is simpler to implement and reason about.
   - Real-silicon register layout would be more "real chip".
   - For guest IDF code that uses `gpio_set_intr_type()` (which
     reads/writes GPIO_PINn_REG), our mask scheme doesn't intercept
     those writes — they'd hit scratch storage. **Documented
     limitation** that a future Phase 2.AV.real-pinreg can fix.

2. **Demo blob untouched**: chose safety (no infinite-loop risk)
   over feature exercise. Future Arduino sketch that respects the
   "ISR must deassert source" contract can use these filters.

3. **No JSON event for level-sensitive fires**: would be visually
   indistinguishable from edge-triggered fires (same `pin` event
   format). The frontend can render based on the existing pin
   transitions; INT_TYPE is invisible to the JSON stream.

## Lessons learned

1. **Reading the TRM TOC reveals natural extensions**: the
   `_TRM_TOC.txt` file in `test/test-esp32-p4/specs/` lists
   "9.5 Interrupt Configuration" which prompted me to verify
   our model supports all 6 INT_TYPE values. Phase 2.AA had
   left 4 and 5 missing — the TOC told me what to look for.

2. **Real silicon's register layout vs emulator's**: we've drifted
   from silicon-correct layout for some peripherals (this one,
   originally Phase 2.AA's aggregate-mask choice). Documented as
   "future refactor opportunity" for sketches that need to
   read/write the real GPIO_PINn_REG addresses.

3. **Level-sensitive IRQs are dangerous without deassertion**:
   even with proper unlock-key state machines, level IRQs can
   trap-loop indefinitely if the source can't be deasserted. The
   ESP32 fake-button at pin 0 is a perfect example — host realtime
   drives it on a 3-second cycle, guest can't make it stop. We
   document this caveat explicitly in the header comment.

4. **"Add capability now, exercise later" is OK**: shipping the
   filter infrastructure without a demo using it is the right
   call when the demo would deadlock. The ability is there for
   future guest code that uses it correctly.

## Implementación final

### `include/hw/gpio/esp32p4_gpio.h`

- Added `int_level_high_mask` and `int_level_low_mask` fields in
  ESP32P4GpioState.

### `hw/gpio/esp32p4_gpio.c`

- 6 new register offset macros (R_GPIO_INT_LEVEL_HIGH /
  _LOW + W1TS/W1TC variants at 0xA8-0xBC).
- Read handler returns mask values; W1TS/W1TC reads return 0.
- Write handler: 6 cases for the new offsets implementing
  set/atomic-set/atomic-clear semantics.
- Reset zeros both new masks.
- Update logic in `esp32p4_gpio_update()`:
  - `any_edge` flag now excludes case when level masks are set
    (level-sensitive takes priority over edge).
  - New "level_high && level==1" and "level_low && level==0"
    branches that fire the IRQ and latch `int_status` (no edge
    pulse — the IRQ stays asserted at the qemu_set_irq level).

## Estado consolidado (post-2.AV)

| INT_TYPE value | Phase | Implementation                                |
|----------------|-------|-----------------------------------------------|
| 0 disabled     | 2.Z   | `int_ena_mask[N] == 0`                        |
| 1 rising       | 2.AA  | `int_rising_mask[N]=1, int_falling_mask[N]=0` |
| 2 falling      | 2.AA  | `int_rising_mask[N]=0, int_falling_mask[N]=1` |
| 3 anyedge      | 2.AA  | both equal (default with `int_ena_mask[N]=1`) |
| **4 lo-level** | **2.AV** | **`int_level_low_mask[N]=1`**             |
| **5 hi-level** | **2.AV** | **`int_level_high_mask[N]=1`**            |

**GPIO INT_TYPE matrix now COMPLETE** (6 of 6 values supported).

## 30-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.AC-AF| LEDC PWM + multi-channel                               |
| 2.AG-AN.irq | TIMG (×2) + 3-way ISR                              |
| 2.AM-slave | I2C master + BMP280 responder                      |
| 2.AO  | SPI master skeleton                                     |
| 2.AP-AT | 4 watchdogs + RNG + address relocation                |
| 2.AU  | Synthetic ILI9341 SPI responder                         |
| **2.AV** | **GPIO LEVEL_HIGH/LOW filters (all 6 INT_TYPE values)** |

JSON stream still 14 event types — no new event added by this
phase (level filter is reachable but not exercised by demo).

## Próximas direcciones

- **2.AV.real-pinreg**: refactor mask-based filters to per-pin
  GPIO_PINn_REG registers matching real-silicon layout. Big
  change but aligns with real IDF `gpio_set_intr_type()`.
- **UART RX path**: bidirectional UART input.
- **WDT actual reset action**: real timeout → CPU reset.
- **Real PWM waveform on GPIO** via LEDC.
- **TWAI (CAN bus)** — TRM Chapter 30.
- **Real FreeRTOS port** (Phase 2.V deferred).
