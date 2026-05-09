# Phase 2.AC — LEDC PWM peripheral with duty-cycle events

**Estado**: ✅ done — first NEW peripheral added since the GPIO-focused
2.U..2.AB chain. ESP32-P4 LEDC controller modeled at 0x500D3000 with
8 channels of duty-tracking + structured JSON event emission.

## Goal

Add a third peripheral type alongside UART and GPIO, demonstrating
that the velxio frontend bridge can carry events from arbitrary new
peripherals. LEDC was chosen because:

1. **Visual / intuitive**: PWM duty-cycle maps to LED brightness.
2. **Common Arduino API**: `ledcSetup`, `ledcWrite`, `analogWrite`.
3. **Contained scope**: 1 register-decode pattern + JSON event hook.
4. **No CPU IRQ wiring needed**: pure output peripheral, perfect
   showcase of the JSON event channel from Phase 2.X.

The demo blob now writes a **fade pattern** (duty 0 → 256 → 512 →
... → 1792 → wrap) — frontend can render this as a glowing LED.

## Lo que SE INVESTIGÓ

### 1. ESP32-P4 LEDC register layout (per IDF soc/ledc_reg.h)

`DR_REG_LEDC_BASE = 0x500D3000` (HPPERIPH1 + 0x13000).

Each channel has 5 registers spaced 0x14 bytes apart:

| Offset within channel | Register   | Notes              |
|-----------------------|------------|--------------------|
| +0x00                 | CHn_CONF0  | timer source, sig output enable |
| +0x04                 | CHn_HPOINT | high-time start point          |
| +0x08                 | CHn_DUTY   | **fractional duty (19-bit)**   |
| +0x0C                 | CHn_CONF1  | duty change config              |
| +0x10                 | CHn_DUTY_R | read-only duty                  |

So channel N's DUTY register is at `LEDC_BASE + 0x14*N + 0x08`:
- CH0 DUTY = 0x500D3008
- CH1 DUTY = 0x500D301C
- CH2 DUTY = 0x500D3030
- etc.

Real silicon also has 4 timer config registers, fade-config
registers, interrupt registers — all skipped in our Phase-1 model.

### 2. Minimum-viable model

`hw/timer/esp32p4_ledc.c`:
- 4 KB MMIO with scratch storage (any read returns last write).
- Write handler detects DUTY-register writes by offset pattern:
  ```c
  if (addr >= 0x08 && (addr - 0x08) % 0x14 == 0
      && (addr - 0x08) / 0x14 < 8) {
      int channel = (addr - 0x08) / 0x14;
      uint32_t duty = value & 0x7FFFF;
      // emit event
  }
  ```
- On match: emit stderr line `[esp32p4.ledc] ch N duty M` plus
  JSON line `{"t_ns":...,"event":"ledc","ch":N,"duty":M}` to the
  shared event log (set by the machine after GPIO realization).

No actual PWM waveform generation — that would require modeling
the timer source, counter update, and per-tick GPIO toggling
(thousands of transitions per second). For frontend rendering of
LED brightness the duty value alone is sufficient.

### 3. Sharing the event log

Both GPIO and LEDC peripherals emit JSON events. To unify them in
a single stream, the machine init copies the FILE pointer:

```c
ms->ledc.event_log = ms->gpio.event_log;
ms->ledc.boot_ns   = ms->gpio.boot_ns;
```

Both write to the same file independently (each has its own FILE
handle); QEMU is single-threaded for these handlers so no race.
When `VELXIO_GPIO_LOG` is unset, both peripherals fall back to
stderr-only output.

### 4. Demo blob fade pattern

Added 4 instructions to the running-light blob:

- 1 init: `lui a0, 0x500D3` (LEDC base).
- 1 init: `addi s0, x0, 0` (initialize duty counter).
- 1 per-loop: `sw s0, 0x08(a0)` (write LEDC_CH0_DUTY).
- 2 per-loop: `addi s0, s0, 0x100; andi s0, s0, 0x7FF`
  (increment by 256, mask 11-bit to wrap at 2048).

This produces a sawtooth fade: duty cycles 0, 256, 512, 768, 1024,
1280, 1536, 1792, then wraps to 0. With each iteration ~300 ms
(3 pins × 100 ms), the full fade cycle takes ~2.4 seconds.

### 5. ANDI imm caveat

`andi s0, s0, 0x7FF` works because 0x7FF fits in a 12-bit signed
immediate (sign bit clear → positive 2047). I-format immediates
are sign-extended to 32 bits, so `andi rd, rs1, 0xFFF` would
actually compute `rd = rs1 & 0xFFFFFFFF` (no-op). To mask 12-bit:
use `slli + srli` two-instruction sequence. We use 11-bit (0x7FF)
which fits and gives us 0..2047 range, plenty for visible fade.

## Lo que SÍ funcionó

10-second test with `VELXIO_GPIO_LOG=/tmp/velxio-gpio.jsonl`:

```
Hello from QEMU ESP32-P4!
[esp32p4.ledc] ch 0 duty 0          ← fade starts at 0
[esp32p4.gpio] pin 5 -> 1
[esp32p4.gpio] pin 5 -> 0
[esp32p4.gpio] pin 6 -> 1
... (running light continues)
[esp32p4.ledc] ch 0 duty 256        ← +256
... (running light)
[esp32p4.ledc] ch 0 duty 512        ← +256
... etc to 1792, then wraps
```

JSON event stream:
```
{"event":"start","source":"esp32p4.gpio","t_ns":0}
{"t_ns":94439056,"event":"ledc","ch":0,"duty":0}
{"t_ns":...,"pin":5,"level":1}      ← GPIO + LEDC interleaved
{"t_ns":395276807,"event":"ledc","ch":0,"duty":256}
{"t_ns":695496307,"event":"ledc","ch":0,"duty":512}
{"t_ns":995664920,"event":"ledc","ch":0,"duty":768}
{"t_ns":1295906224,"event":"ledc","ch":0,"duty":1024}
{"t_ns":1596073328,"event":"ledc","ch":0,"duty":1280}
{"t_ns":1896243949,"event":"ledc","ch":0,"duty":1536}
{"t_ns":2196521050,"event":"ledc","ch":0,"duty":1792}
{"t_ns":2496706432,"event":"ledc","ch":0,"duty":0}    ← wrap!
```

Total event counts in 10 seconds:
- 33 `ledc` events (matches the running-light cycle rate)
- 197 GPIO transitions (66+66+65 + 3 button)
- 1 start marker

The 300 ms gap between consecutive duty events matches the running-
light cycle (3 pins × 100 ms each), confirming the LEDC write is
synchronized with the loop.

## Lo que NO funcionó (descartado)

1. **Considered: actual PWM waveform on a GPIO pin**: would require
   modeling the LEDC timer source + counter + per-tick GPIO toggle.
   At 5 kHz PWM frequency × 12-bit duty resolution = millions of
   transitions per second. For frontend rendering of brightness the
   duty value alone suffices — full PWM would be Phase 2.AC.next.

2. **Considered: separate VELXIO_LEDC_LOG env var**: rejected for
   simplicity. Both peripherals share VELXIO_GPIO_LOG; events are
   distinguished by the `event` field (`"pin"` for GPIO, `"event":
   "ledc"` for LEDC). Unified stream is easier for frontend to
   consume.

3. **Tried: `andi s0, s0, 0xFFF`** for 12-bit mask. Failed because
   I-format imm is sign-extended; 0xFFF has bit 11 set, so it
   becomes -1 = no-op AND. Switched to 0x7FF (11-bit, positive)
   for a 0..2047 fade range.

## Lessons learned

1. **New peripheral = ~150 LoC**: a minimum-viable peripheral
   (header + .c + register decode + machine init wire) is a
   single-sitting contribution. Most of the work is the device
   skeleton; the actual semantic logic is small.

2. **`memcpy` to a scratch storage = correct read-after-write
   semantics for free**: most config registers behave this way.
   Only the registers you specifically care about need custom
   logic; everything else is automatic.

3. **Sharing a FILE pointer between devices works fine**: each
   device has its own FILE handle (independent buffering / fflush
   semantics). Writes interleave cleanly because QEMU's main loop
   is single-threaded for these write handlers.

4. **I-format ANDI/ORI/XORI sign-extend**: for masking, only
   imm < 0x800 (positive 12-bit) works directly. For larger masks
   either use shift pairs (slli/srli) or load via lui/addi into
   a register first.

## Implementación final

### `include/hw/timer/esp32p4_ledc.h` (new)

- Constants: base, IO size, channel stride, DUTY offset.
- `ESP32P4LedcState` struct: scratch storage + shared event log.

### `hw/timer/esp32p4_ledc.c` (new)

- ~110 LoC including read/write handlers, reset, realize,
  type registration. The duty-write detection + JSON emission is
  ~15 LoC of the total.

### `hw/timer/meson.build`

- Added `esp32p4_ledc.c` to the `CONFIG_RISCV_ESP32P4` source list.

### `hw/riscv/esp32p4.c`

- Included new LEDC header.
- Added `ESP32P4LedcState ledc` field to `Esp32P4MachineState`.
- New machine init block: object_initialize + sysbus_realize +
  add_subregion at 0x500D3000 + share event_log/boot_ns.
- Demo blob: 4 new instructions (lui a0, addi s0=0, sw s0 at
  loop head, addi+andi at loop tail). Full address layout
  recomputed; jal/j offsets updated.

## Estado consolidado (post-2.AC)

| Hito                                                      | Estado |
|-----------------------------------------------------------|--------|
| UART hello world                                          | ✅     |
| GPIO output (running light, deterministic timing)         | ✅ 2.Y |
| GPIO input + ENABLE multiplexer + JSON I/O channel        | ✅ 2.W/X |
| GPIO interrupts (latched status, edge filter, shared IRQ) | ✅ 2.AB|
| **LEDC PWM duty-cycle events**                            | ✅ 2.AC|
| Real PWM waveform on GPIO (timer + counter)               | ⏳ later |
| Other peripherals (I2C, SPI, ADC)                         | ⏳ later |
| Real FreeRTOS port                                        | ⏳ Phase 2.V |

## 10-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.U   | Hand-rolled GPIO toggle (busy-wait)                     |
| 2.V   | 3-pin running light cycling                             |
| 2.W   | GPIO input pads + ENABLE multiplexer                    |
| 2.X   | JSON output stream → frontend                           |
| 2.X.in| JSON input fifo ← frontend                              |
| 2.Y   | SYSTIMER virtual-time deterministic timing              |
| 2.Z   | GPIO pin-transition IRQ (single pin)                    |
| 2.AA  | INT_TYPE filter (RISING/FALLING) + 8-pin                |
| 2.AB  | Real-silicon shared IRQ + latched INT_STATUS            |
| **2.AC** | **LEDC PWM peripheral, duty-cycle events**           |

The emulator now has 3 peripheral types active (UART, GPIO, LEDC)
all feeding into a unified JSON event stream consumable by a
frontend. Total runtime patches: 108 (up from 103). 5 new patches
for the LEDC fade-pattern blob extension.

## Próximas direcciones

- **Phase 2.AD**: I2C master controller. Sensor readout demo —
  the frontend could stream "sensor reading X" events.
- **Phase 2.AE**: SPI master. Display drivers, SD cards.
- **Phase 2.AF**: ADC. Analog input → JSON event stream.
- **LEVEL_HIGH/LEVEL_LOW** for GPIO: completes the INT_TYPE set.
- **Phase 2.V (deferred)**: real FreeRTOS port. Multi-week.
