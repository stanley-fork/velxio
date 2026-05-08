# Phase 2.W — GPIO input register + external "fake button" pads

**Estado**: ✅ done — `R_GPIO_IN` reads work, external input pads are
exposed via `qdev_init_gpio_in_named`, and a built-in fake button on
pin 0 visibly pulses every 3 seconds (host wall-clock) alongside the
running-light demo from Phase 2.V.

## Goal

Lift the GPIO model from "output-only" to a more realistic
input/output peripheral that:
1. Lets guest code read pin levels via `R_GPIO_IN_REG = 0x3C`.
2. Accepts external drives (buttons, sensors, future chardev/socket
   bridges) via `qdev_init_gpio_in_named` input pads.
3. Demonstrates concurrent guest-output + external-input by adding
   a built-in fake button that pulses pin 0 every 3 s of host
   wall-clock.

## Lo que SE INVESTIGÓ

### 1. ESP32-P4 GPIO register layout

Per TRM Cap 9, the GPIO Matrix block at `0x500E0000` exposes:

| Offset | Register          | RW | Notes                                |
|--------|-------------------|----|--------------------------------------|
| 0x04   | GPIO_OUT_REG       | RW | Direct output level for pins 0-31    |
| 0x08   | GPIO_OUT_W1TS_REG  | W1 | Atomic set bits in GPIO_OUT          |
| 0x0C   | GPIO_OUT_W1TC_REG  | W1 | Atomic clear bits in GPIO_OUT        |
| 0x20   | GPIO_ENABLE_REG    | RW | Output enable per pin                |
| 0x3C   | GPIO_IN_REG        | RO | Live pin level for pins 0-31         |
| ...    | (more)             |    | DR/IRQ status, interrupt config, etc.|

For Phase 2.W we add `R_GPIO_IN` reads. Output enable is still
implicit (W1TS/W1TC drive the pin regardless of ENABLE state) — full
ENABLE-gating would be Phase 2.W.next.

### 2. Effective pin level model

Real silicon has a 2-input multiplexer per pin: output driver vs
external pad. For our Phase-1 model we simply OR the two together:

```c
effective_level = (gpio_out | external_input) >> pin & 1;
```

This works fine for "guest drives + external observer reads"
patterns and for "external drives + guest reads" patterns. It would
need extension for proper ENABLE gating ("output drives only when
enabled, otherwise external wins") — deferred.

### 3. External input wiring

Standard QEMU pattern: the GPIO device exposes 32 input pads via
`qdev_init_gpio_in_named(dev, handler, "esp32p4.gpio.input", 32)`.
External devices can then call:

```c
qdev_get_gpio_in_named(gpio_dev, "esp32p4.gpio.input", N);
qemu_set_irq(input_pad_N, level);
```

Our `esp32p4_gpio_input_handler` updates the `external_input` mask
and triggers `esp32p4_gpio_update`. Same logging path as guest
writes, so the user sees uniform `[esp32p4.gpio] pin N -> M` lines.

### 4. Fake button periodic timer

To demonstrate the input path without yet wiring a chardev/socket
bridge to the velxio frontend, the GPIO device spawns a QEMUTimer
that toggles pin 0 every 3 seconds of host wall-clock. Uses
`QEMU_CLOCK_REALTIME` (wall-clock locked) — see Lessons #2 below.

## Lo que SÍ funcionó

10-second test run with the fake button at 3 s period:

```
[esp32p4] machine init complete ...
Hello from QEMU ESP32-P4!
[esp32p4.gpio] pin 5 -> 1
[esp32p4.gpio] pin 5 -> 0
[esp32p4.gpio] pin 6 -> 1
[esp32p4.gpio] pin 6 -> 0
[esp32p4.gpio] pin 7 -> 1
... (running light cycling)
[esp32p4.gpio] pin 0 -> 1     ← fake button press at ~3 s
... (more running light)
[esp32p4.gpio] pin 0 -> 0     ← fake button release at ~6 s
... (more running light)
[esp32p4.gpio] pin 0 -> 1     ← second press at ~9 s
```

Per-pin transition count over 10 s wall-clock:

| Pin | Count | Source                                    |
|-----|-------|-------------------------------------------|
| 0   | 3     | Fake button (3 s period → ~3 events / 10s)|
| 5   | 66    | Running light                             |
| 6   | 66    | Running light                             |
| 7   | 65    | Running light                             |

The pin-0 transitions interleave naturally with the running-light
cycle, demonstrating that external input affects the GPIO state
machine concurrently with guest output.

## Lo que NO funcionó (intentado y descartado)

### 1. `prev = s->gpio_out` in `esp32p4_gpio_write` (BUG)

First version had a stale-prev bug:
```c
uint32_t prev = s->gpio_out;       /* BAD — misses external_input */
...
esp32p4_gpio_update(s, prev);       /* compares against gpio_out|ext */
```

When the fake button was active (external_input bit 0 set), every
guest write triggered `update` with `prev` missing the button bit
and `curr` containing it. The XOR claimed pin 0 had "changed" on
every running-light toggle, so the log spammed `pin 0 -> 1` 22×
per running-light cycle.

**Fix**: `prev = s->gpio_out | s->external_input`. Single pin-0
transition per actual button event.

Symptom before fix:
```
3-pin running light: ~66 transitions / 10 s
fake button:         ~89 transitions / 10 s   ← SHOULD BE 3
```

After fix:
```
fake button:         3 transitions / 10 s     ← matches 3 s period
```

### 2. `QEMU_CLOCK_VIRTUAL_RT` for the fake button

Initially used `QEMU_CLOCK_VIRTUAL_RT` for the timer. Over 10 s
host wall-clock, the timer fired ~9 times (instead of the expected
3 with a 3-second period) — virtual-RT outpaces wall-clock by ~3×
when the guest is in tight busy-wait loops with no idle.

**Fix**: switched to `QEMU_CLOCK_REALTIME` (host monotonic). Fires
exactly at wall-clock interval, matching how a human would press
a physical button.

## Lessons learned

1. **Always include external state in `prev`**: when computing
   "what changed since last update", the snapshot must cover ALL
   sources that contribute to the effective output, not just the
   one being modified. Otherwise XOR-based change detection
   spuriously flags external bits as having toggled.

2. **VIRTUAL_RT clock outpaces wall-clock under TCG busy-wait**:
   the guest's tight loop drives QEMU TCG to issue TBs flat-out,
   and VIRTUAL_RT is anchored to that rate rather than to host
   monotonic time. For external "human-time" events
   (buttons, sensors, network), use `QEMU_CLOCK_REALTIME` instead.
   The systimer at 100 Hz uses VIRTUAL_RT and matches reasonably,
   but a 3 s timer drifts noticeably.

3. **`qdev_init_gpio_in_named` is the standard QEMU pattern for
   external input pads**: 32 named input lines is plenty for
   GPIOs, and the handler receives the pin number + level
   directly — no need for the device to inspect `qemu_irq` levels
   or maintain external state separately from the model's internal
   register file.

4. **Effective-level model with OR is sufficient for Phase-1**:
   real silicon has more nuance (ENABLE gating, push-pull vs
   open-drain, pull-up/down resistors), but for visible demos and
   for `gpio_get_level()` semantics in Arduino code, the OR model
   gives correct behaviour.

## Implementación final

### `include/hw/gpio/esp32p4_gpio.h`

- Updated docstring (was "output-only", now "output + input read").
- Added fields:
  - `uint32_t external_input;` — external drive mask.
  - `QEMUTimer *fake_button_timer;` — periodic toggle.
  - `uint64_t fake_button_period_ns;` — period (default 3 s).
  - `bool fake_button_state;` — state machine.
- Added `ESP32P4_GPIO_INPUT_NAME` macro for the input-pad name.

### `hw/gpio/esp32p4_gpio.c`

- `esp32p4_gpio_update` now takes a `prev` snapshot from
  `gpio_out | external_input` and emits transitions for either
  source.
- `esp32p4_gpio_input_handler` (new): callback for input pads;
  updates `external_input` mask and calls update.
- `esp32p4_gpio_fake_button_tick` (new): periodic toggle of pin 0,
  reschedules itself every `fake_button_period_ns` on
  `QEMU_CLOCK_REALTIME`.
- `R_GPIO_IN` (0x3C) reads return `gpio_out | external_input`.
- `esp32p4_gpio_realize` now calls `qdev_init_gpio_in_named` and
  starts the fake button timer.
- `esp32p4_gpio_reset` clears `external_input` and the button
  state.

## Estado consolidado (post-2.W)

| Hito                                                    | Estado       |
|---------------------------------------------------------|--------------|
| Hello-world demo (default build)                        | ✅           |
| 3-pin running light @ ~3.5 Hz                           | ✅ Phase 2.V |
| **GPIO_IN register read works**                         | ✅ Phase 2.W |
| **External input pads exposed (qdev_get_gpio_in_named)**| ✅ Phase 2.W |
| **Fake button toggles pin 0 every 3 s wall-clock**      | ✅ Phase 2.W |
| **Concurrent guest-output + external-input demo**       | ✅ Phase 2.W |
| Real ENABLE-gating (output suppressed when disabled)    | ⏳ Phase 2.W.next |
| Frontend bridge (chardev/socket → input pads)           | ⏳ Phase 2.X |
| Real SYSTIMER-based delays (replace busy-wait)          | ⏳ Phase 2.Y |

## Próximas fases

- **Phase 2.W.next**: enforce GPIO_ENABLE register. Currently W1TS/
  W1TC drive the pin regardless of enable state. Real silicon
  ignores OUT writes for input-only pins. Enforcement would let
  Arduino's `pinMode(pin, INPUT)` actually disable the output
  driver.

- **Phase 2.X**: bridge GPIO transitions to a chardev/socket so
  the velxio frontend can both subscribe to LED state changes and
  push button presses. This is the "frontend integration" milestone
  — closes the loop from emulator to web UI.

- **Phase 2.Y**: replace the busy-wait delay in the running-light
  blob with reads from `SYSTIMER_UNIT0_VALUE_LO/HI`. Current timing
  depends on host CPU speed; SYSTIMER is virtual-time-locked so
  deterministic timing would result.
