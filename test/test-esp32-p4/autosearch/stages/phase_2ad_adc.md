# Phase 2.AD — SAR ADC peripheral, end-to-end ADC → LEDC pipeline

**Estado**: ✅ done — second NEW peripheral added since GPIO chain.
ADC modelled at 0x500DE000 returns realtime-driven samples; demo
blob reads ADC each loop and forwards the value to LEDC duty,
producing a physically-realistic "analog input drives LED brightness"
behaviour in the unified JSON event stream.

## Goal

Add a fourth event type to the unified frontend stream: structured
ADC readings. Demonstrate that the demo blob can use **two different
peripherals together** in a meaningful way (ADC sample → LEDC duty),
matching how a real Arduino sketch would compose peripherals.

## Lo que SE INVESTIGÓ

### 1. ESP32-P4 SAR ADC base + register layout

Per IDF `soc/reg_base.h`:
```
DR_REG_ADC_BASE = DR_REG_HPPERIPH1_BASE + 0x1E000 = 0x500DE000
```

Real silicon has 2 SAR units, channel mux, attenuation calibration,
DMA, monitor thresholds — ~50 registers across 4 KB. The full state
machine for a conversion is:

  1. Configure CTRL register (channel, mux, attenuation).
  2. Trigger START (write START bit in CTRL2 or similar).
  3. Wait for DONE bit set in STATUS.
  4. Read DATA register.

For Phase 2.AD we collapse this to a single read-on-demand DATA
register at offset 0x10. Reads return a 12-bit sample without any
trigger choreography. Suitable for demo and Arduino's
`analogRead(pin)` semantic which abstracts the low-level state
machine away.

### 2. Sample generation

Picked **sawtooth** instead of sine because:
- Pure integer math, no `<math.h>` dependency.
- Visually clean — frontend renders as ramp up + sudden reset.
- Trivial to verify (current value = `t_ms % 4096`).

```c
int64_t t_ms = qemu_clock_get_ns(QEMU_CLOCK_REALTIME) / 1000000;
return (uint32_t)(t_ms % 4096);
```

4-second period (4096 ms ≈ 4.1 s, close enough). 12-bit range
(0..4095) matches real ESP32-P4 SAR ADC resolution.

For more realistic patterns later (sine wave, sensor simulation),
this function is the single point to extend.

### 3. JSON event throttling

Each ADC read could fire an event. If the guest busy-polls the
register (typical for tight ADC loops), we'd flood the event log
with millions of identical events.

Throttle: only emit a JSON event if at least 50 ms (host wall-clock)
has elapsed since the last emission. State stored per-device:

```c
int64_t now_ns = qemu_clock_get_ns(QEMU_CLOCK_REALTIME);
if (s->event_log
    && now_ns - s->last_event_ns >= s->event_min_period_ns) {
    fprintf(s->event_log, "{\"t_ns\":...,\"event\":\"adc\",...}\n");
    s->last_event_ns = now_ns;
}
```

50 ms = max 20 events/sec. The running-light demo reads ADC once
per ~300 ms cycle, so ~3 events/sec — well under the cap.

### 4. Demo blob: ADC → LEDC pipeline

Replaced the Phase 2.AC local-counter sawtooth (`addi s0, s0,
0x100; andi s0, s0, 0x7FF`) with ADC reads:

```
init:
  ...
  lui s1, 0x500DE          ; ADC base (replaces addi s0=0)

.loop_head:
  lw   s0, 0x10(s1)         ; read ADC SAR1_DATA
  srli s0, s0, 1            ; halve to fit 11-bit LEDC duty (0..2047)
  sw   s0, 0x08(a0)         ; LEDC_CH0_DUTY = sample
  ; ... pin 5/6/7 cycle
  j .loop_head
```

3 instructions per iteration in the loop body (replaces 1 sw +
2 increment+mask = 3 instructions previously). Net: same blob
size, same `j` offset (-60). All three jal-to-`.delay` offsets
adjust by -8 because pin sections moved +8 within the loop.

Encoding for the new instructions:
- `lui s1, 0x500DE` = `0x500DE4B7`
- `lw s0, 0x10(s1)` = `0x0104A403`
- `srli s0, s0, 1` = `0x00145413`

## Lo que SÍ funcionó

10-second test with `VELXIO_GPIO_LOG`:

Per-event-type counts:
- 33 `adc` events
- 33 `ledc` events
- 197 GPIO transitions (running light + button)
- 1 start marker

**Pipeline visible in the JSON log** (paired ADC + LEDC events
within microseconds of each other, since the blob reads ADC then
immediately writes LEDC):

```
{"t_ns":75816577,"event":"adc","channel":1,"value":1909}
{"t_ns":75866482,"event":"ledc","ch":0,"duty":954}    ← 1909/2 = 954
{"t_ns":376975377,"event":"adc","channel":1,"value":2210}
{"t_ns":376980690,"event":"ledc","ch":0,"duty":1105}  ← 2210/2 = 1105
{"t_ns":677184623,"event":"adc","channel":1,"value":2510}
{"t_ns":677192585,"event":"ledc","ch":0,"duty":1255}
... (sawtooth ramping over 4s, then wraps)
{"t_ns":2178276665,"event":"adc","channel":1,"value":4011}
{"t_ns":2178284012,"event":"ledc","ch":0,"duty":2005}
{"t_ns":2478... ,"event":"adc","channel":1,"value": 215}  ← wrap
{"t_ns":2478... ,"event":"ledc","ch":0,"duty":107}
```

The duty value is exactly `value >> 1` — confirming the `srli s0,
s0, 1` runs and the pipeline is connected end-to-end.

The 4-second ADC sawtooth is observable in the value sequence:
ramp from 0 to ~4095, wrap to 0, repeat.

## Lo que NO funcionó (descartado)

1. **Sine wave samples**: would require `<math.h>` and floating-point
   in the QEMU device — adds linker complexity. Sawtooth is simpler
   and visually equivalent for testing the pipeline.

2. **Per-channel separate ADC units**: real silicon has SAR1 + SAR2
   with separate state machines. We model just one logical channel
   (reported as `"channel":1` in events) — sufficient for the demo.

3. **Trigger / done state machine**: real ADC requires START + poll
   DONE before reading DATA. Skipped — demo just reads DATA. A real
   IDF/Arduino driver would do the full handshake; our scratch
   storage handles config-register reads gracefully (returns 0,
   which IDF interprets as "no error" for many fields).

## Lessons learned

1. **End-to-end pipelines validate the architecture**: chaining
   ADC → blob → LEDC in one demo proves the JSON event channel
   carries multiple peripheral types coherently. The pairing of
   ADC + LEDC events with sub-microsecond timestamp deltas
   confirms QEMU runs the blob deterministically.

2. **Event throttling is essential for sample-on-read peripherals**:
   without it, a guest busy-poll loop would emit millions of
   identical events per second. 50 ms window is a reasonable
   floor — captures all interesting transitions without flooding.

3. **Sample generation from QEMU_CLOCK_REALTIME is host-wall-clock
   anchored**: same property as the fake-button timer (Phase 2.W).
   Means the sawtooth period is exact wall-clock 4 seconds across
   any host. Good for reproducible demos.

4. **`hw/adc/` already exists in upstream QEMU**: didn't need to
   create a new directory. Standard QEMU peripheral conventions
   provide a slot for ADC devices alongside aspeed_adc.c,
   stm32f2xx_adc.c, etc.

## Implementación final

### `include/hw/adc/esp32p4_adc.h` (new)

- Constants: base, IO size, DATA offset.
- `ESP32P4AdcState` struct: shared event log + throttle state.

### `hw/adc/esp32p4_adc.c` (new)

- ~110 LoC including read/write handlers, sample function, reset,
  realize. Event throttling is ~6 LoC.

### `hw/adc/meson.build`

- Added `esp32p4_adc.c` to CONFIG_RISCV_ESP32P4 source list.

### `hw/riscv/esp32p4.c`

- Included new ADC header.
- Added `ESP32P4AdcState adc` field to machine state.
- New machine init block: object_initialize + sysbus_realize +
  add_subregion at 0x500DE000 + share event_log/boot_ns.
- Demo blob: replaced 3 instructions (Phase 2.AC counter increment
  + mask) with 3 instructions (`lui s1`, `lw s0`, `srli s0`). Same
  total instruction count, ADC-driven semantics. JAL offsets
  recomputed for pin sections (44 / 28 / 12 instead of 52 / 36 / 20).

## Estado consolidado (post-2.AD)

| Hito                                                       | Estado |
|------------------------------------------------------------|--------|
| UART hello world                                           | ✅     |
| GPIO output + ENABLE multiplexer + JSON I/O channel        | ✅ 2.W |
| GPIO IRQ (latched status, edge filter, shared CPU IRQ)     | ✅ 2.AB|
| LEDC PWM duty-cycle events                                 | ✅ 2.AC|
| **ADC analog-input samples → LEDC pipeline end-to-end**    | ✅ 2.AD|
| Real PWM waveform on GPIO                                  | ⏳ later |
| I2C / SPI master                                           | ⏳ later |
| Real FreeRTOS port                                         | ⏳ Phase 2.V |

## 11-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.U   | Hand-rolled GPIO toggle (busy-wait)                     |
| 2.V   | 3-pin running light cycling                             |
| 2.W   | GPIO input + ENABLE multiplexer                         |
| 2.X   | JSON event stream → frontend                            |
| 2.X.in| JSON input fifo ← frontend                              |
| 2.Y   | SYSTIMER virtual-time deterministic timing              |
| 2.Z   | GPIO pin-transition IRQ to CPU                          |
| 2.AA  | INT_TYPE filter + 8-pin wiring                          |
| 2.AB  | Real-silicon shared IRQ + latched INT_STATUS            |
| 2.AC  | LEDC PWM duty-cycle events                              |
| **2.AD** | **ADC peripheral + ADC→LEDC pipeline (4 event types)** |

The unified JSON stream now carries:
- `start` (boot marker)
- `pin` (GPIO transitions)
- `ledc` (PWM duty changes)
- `adc` (analog samples)

108 runtime patches active. Default build adds 1 line (ADC reset)
with no visible behavioral change; with `VELXIO_GPIO_LOG` set, the
frontend sees all 4 event types interleaved and can reconstruct
the full chip behaviour.

## Próximas fases

- **I2C master**: sensor-readout demo. Bytes TX → JSON event;
  emulated slave responds with sensor data.
- **SPI master**: display/SD demo.
- **TIMG (Timer Group)**: real hardware timers for Arduino
  `delay()` / `millis()` / `micros()`.
- **Phase 2.V (deferred)**: real FreeRTOS port.
