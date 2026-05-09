# Phase 2.AR — HW Random Number Generator (RNG)

**Estado**: ✅ done — RNG peripheral mounted at 0x500FC400. Reads return
fresh random uint32 values from QEMU's host PRNG. Self-test reads 3
values at boot to demonstrate the path. Foundation for Arduino
`esp_random()`/`random()` and any IDF code needing entropy.

## Goal

Per ESP32-P4 TRM Chapter 33 (Random Number Generator), the chip has
a dedicated hardware RNG that mixes ADC noise + thermal noise + ring
oscillators. Real-silicon entropy is genuinely random.

For emulation we don't have the physical noise sources, so we use
QEMU's `qemu_guest_getrandom_nofail()` which derives from the host
OS's CSPRNG (`/dev/urandom`, `getrandom(2)`, etc.). Cryptographically
sufficient for any guest-side use.

Without this peripheral, Arduino sketches calling `esp_random()` /
`random()` would either fault or return zero. The ESP32-IDF
`esp_random()` reads `RNG_DATA_REG` directly — that register write
must be reachable.

## Lo que SE INVESTIGÓ

### 1. ESP32-P4 TRM Chapter 33 (RNG)

```
33 Random Number Generator (RNG)
  33.1 Introduction
  33.2 Feature List
  33.3 Functional Description
  33.4 Programming Procedure
  33.5 Register Summary
  33.6 Registers
```

The RNG block has a single user-facing register: **RNG_DATA_REG**.
Each read returns a fresh 32-bit pseudo-random value seeded by
hardware noise sources.

The ESP32-P4 specifically also exposes a control register for clock
gating / power, but per IDF behaviour it's optional — guest code
just reads RNG_DATA without touching control. Phase 2.AR doesn't
model the control register.

### 2. Address selection

Per IDF `soc/reg_base.h` for ESP32-P4 (verified via the
"create_unimplemented_device" stubs already in the machine code), the
HP region addresses 0x500B*-0x500F* are largely peripherals. The
RNG region per IDF is `DR_REG_RNG_BASE` somewhere in HP_RNG; pinning
this exactly without the full IDF reg_base header is uncertain.

We use **0x500FC400** as a pragmatic placeholder. If real silicon's
exact address is later confirmed, a one-line change in machine init
moves the device. Self-test addressing is offset-relative so it
doesn't matter.

The address doesn't conflict with any existing devices we've
instantiated (TIMG/LEDC/ADC/I2C/SPI/GPIO are all below 0x500F0000
or in LP region above 0x50100000).

### 3. QEMU RNG primitive

QEMU exposes `qemu_guest_getrandom_nofail(buffer, len)` from
`qemu/guest-random.h`. It abstracts over the host OS's RNG (libc
`getrandom`, `/dev/urandom`, etc.) and never fails. Existing ESP32
RNG (`hw/misc/esp32_rng.c`) uses this exact pattern — we follow it.

### 4. JSON event throttle

Real Arduino code that fills a buffer with random bytes calls
`esp_random_buffer(out, N)` which reads RNG_DATA in a tight loop.
Without throttling, the JSON event stream would flood. We use the
same 50 ms throttle as I2C/ADC/LEDC etc.

The `count` field in the JSON event is the running total of reads
since boot — useful for "how much entropy has been consumed"
dashboards.

## Lo que SÍ funcionó

10-second live test (2026-05-08):

```
=== JSON event totals ===
Total lines: 443  (was 440 in Phase 2.AQ; +3 from RNG self-test)

  "event":"ledc":     99    ← unchanged
  "event":"adc":      33    ← unchanged
  "event":"timg":     28    ← unchanged
  "event":"timg_irq": 38    ← unchanged
  "event":"i2c":       8    ← unchanged
  "event":"i2c_rx":    1    ← unchanged
  "event":"spi":       3    ← unchanged
  "event":"wdt":       8    ← unchanged
  "event":"rng":       3    ← NEW (self-test)
  "event":"start":     1
  "pin":              210
```

RNG events at t≈2.5 ms (machine init):

```json
{"t_ns":2517541,"event":"rng","value":2911184294,"count":1}
{"t_ns":2535285,"event":"rng","value":3767836582,"count":2}
{"t_ns":2547863,"event":"rng","value":2416039804,"count":3}
```

Each value is genuinely random — different on every boot (verified
by running the test twice and observing different values).

`count` increments correctly across the 3 self-test reads (1 → 2 →
3). Future Phase that exposes this counter to the frontend can
dashboard "entropy consumption" over time.

No regression: every other event count identical to Phase 2.AQ.

## Lo que NO funcionó / decisiones tomadas

1. **Address is a placeholder, not real silicon**: documented above.
   0x500FC400 is in an unused area of the HP region; doesn't
   conflict with any current device. If a future Arduino sketch
   tries to access RNG at the IDF-defined address (which we don't
   know exactly), it would hit the unimplemented_device stub
   instead of our model. Future Phase 2.AR.relocate fixes this once
   the right address is confirmed.

2. **No control register modelling**: real silicon has a control
   register for clock gating / power. We don't model it.
   `esp_random()` doesn't touch it; only some specialized power-
   management code does.

3. **No actual hardware noise sources**: we're using host OS PRNG.
   Cryptographically secure but not "true" random in the same way
   real silicon's noise-derived entropy is. For non-security-
   critical uses (game randomness, jitter, etc.) this is exactly
   what guest code expects.

4. **Reads always succeed instantly**: real silicon may have a
   "ready" status bit guest needs to poll. We always return a fresh
   value. If guest code has a poll-ready loop it'll exit
   immediately because we don't expose a status register that
   could read 0.

## Lessons learned

1. **Existing-peripheral templates accelerate development**: the
   `esp32_rng.c` (5-line read function!) gave us the QEMU primitive
   immediately. The new code mostly just adds JSON event emission
   on top.

2. **Throttling matters at the application level**: Arduino's
   `esp_random_buffer(N)` calls would fire `N/4` reads in tight
   sequence. Throttling at the device level gives the frontend a
   tractable event stream while still showing "RNG was used".

3. **Placeholder addresses are sometimes the right call**: without
   a definitive reference for the exact ESP32-P4 RNG address (the
   TRM table doesn't repeat addresses, just register names), using
   a non-conflicting placeholder lets us proceed. A future phase
   can move the device once the address is confirmed.

## Implementación final

### `include/hw/misc/esp32p4_rng.h` (new, ~50 LoC)

- Constants: base size (0x100), TYPE name.
- `ESP32P4RngState`: state with read_count + event throttle.
- `esp32p4_rng_self_test()` declaration.

### `hw/misc/esp32p4_rng.c` (new, ~100 LoC)

- `esp32p4_rng_read()`: calls `qemu_guest_getrandom_nofail`, emits
  throttled JSON, increments count.
- `esp32p4_rng_write()`: silent (RNG_DATA is read-only).
- Standard QOM realize/reset/class_init.
- `esp32p4_rng_self_test()`: 3 reads at boot, bypasses throttle.

### `hw/misc/meson.build`

- New `system_ss.add(when: 'CONFIG_RISCV_ESP32P4', if_true:
  files('esp32p4_rng.c'))` block.

### `hw/riscv/esp32p4.c`

- Header include.
- `ESP32P4RngState rng` field in machine state.
- Init block at 0x500FC400, calls self-test post-realize.
- Init log message updated to mention RNG.

## Estado consolidado (post-2.AR)

| Hito                                                          | Estado |
|---------------------------------------------------------------|--------|
| GPIO + LEDC + ADC + I2C + 2× TIMG + WDT + multi-source ISR    | ✅ 2.W-AQ |
| SPI master skeleton                                             | ✅ 2.AO |
| **HW RNG (entropy source for esp_random / random)**            | ✅ 2.AR |
| RNG actual control register                                    | ⏳ later |
| WDT actual reset action                                         | ⏳ later |
| RTC WDT + Super WDT                                              | ⏳ later |
| 2.AO.slave (ILI9341 SPI responder)                              | ⏳ later |
| UART RX path                                                     | ⏳ later |
| Real PWM waveform on GPIO                                       | ⏳ later |
| Real FreeRTOS port                                               | ⏳ Phase 2.V |

## 26-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.U-AB| GPIO + JSON event channel                               |
| 2.AC-AF| LEDC PWM + multi-channel rainbow                       |
| 2.AD  | ADC peripheral                                          |
| 2.AG-AN.irq | TIMG hardware timers + 3-way ISR (both groups)    |
| 2.AM-slave | I2C master + BMP280 responder                      |
| 2.AO  | SPI master skeleton                                     |
| 2.AP-AQ | TIMG Watchdog (both groups) with write-protection     |
| **2.AR** | **HW Random Number Generator**                        |

JSON stream now carries 11 event types: `start | pin | ledc | adc |
timg | timg_irq | i2c | i2c_rx | spi | wdt | rng`.

## Próximas direcciones

- **Phase 2.AS**: peripheral address relocation to real-silicon
  addresses (per IDF reg_base.h) — TIMG0 → 0x500C2000, TIMG1 →
  0x500C3000, I2C0 → 0x500C4000, SPI2 → 0x500D0000, etc. Currently
  we use placeholders that work for self-tests but wouldn't be
  reachable from guest IDF code. Cost: medium, mostly mechanical
  +update demo blob ISR `lui` instructions.
- **2.AP.reset**: actual WDT timeout → CPU reset action.
- **RTC WDT** modelling at LP_WDT_BASE (0x50116000 per stubs).
- **Super WDT** (TRM 17.3).
- **2.AO.slave**: ILI9341 synthetic SPI responder.
- **UART RX path**: bidirectional UART input (existing UART is
  TX-only).
- **Real PWM waveform on GPIO**.
- **FreeRTOS port** (Phase 2.V — large effort, deferred).
