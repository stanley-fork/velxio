# Phase 2.AE — LEDC multi-channel demo (CH0 + CH1 inverse fade)

**Estado**: ✅ done — demo blob now drives two LEDC channels per loop
iteration. CH0 = ADC sample (sawtooth). CH1 = (max - sample) →
**inverse fade**, producing a crossfade pattern. Frontend sees
two duty events per cycle on different channels.

## Goal

Validate that the LEDC peripheral's multi-channel decode works
correctly for channels beyond CH0, and add a visually richer
demo: two simultaneously fading LEDs with complementary brightness
(when CH0 fades up, CH1 fades down). This is the typical "RGB-style
crossfade" pattern Arduino sketches use for color cycling.

## Lo que SE INVESTIGÓ

### 1. ESP32-P4 LEDC channel register stride

Per IDF `soc/ledc_reg.h` and the Phase 2.AC investigation:

```
LEDC_CH0_DUTY_REG = LEDC_BASE + 0x08
LEDC_CH1_DUTY_REG = LEDC_BASE + 0x14*1 + 0x08 = LEDC_BASE + 0x1C
LEDC_CH2_DUTY_REG = LEDC_BASE + 0x14*2 + 0x08 = LEDC_BASE + 0x30
...
```

Each channel takes 0x14 (20) bytes. Our LEDC model already
handles this stride generically:

```c
if (addr >= 0x08 && (addr - 0x08) % 0x14 == 0
    && (addr - 0x08) / 0x14 < 8) {
    int channel = (addr - 0x08) / 0x14;
    ...
}
```

So writing to offset 0x1C produces a `ch=1` event with no model
changes needed. Phase 2.AE validates this.

### 2. Inverse computation

For complementary fade we want CH1 = max - CH0. Using `0x7FF` as
"max" (matching the existing 11-bit duty fade range from Phase
2.AD's `srli s0, s0, 1`):

```
addi t1, x0, 0x7FF       ; t1 = 2047
sub  t1, t1, s0           ; t1 = 2047 - sample
sw   t1, 0x1C(a0)         ; LEDC_CH1_DUTY = inverse
```

Three new instructions inserted between the CH0 write and the
pin-5 section.

### 3. Encoding the new instructions

`addi t1, x0, 0x7FF`:
- imm=0x7FF, rs1=0, rd=t1=6, funct3=0
- (0x7FF << 20) | 0 | 0 | (6 << 7) | 0x13 = `0x7FF00313`

`sub t1, t1, s0` (R-type):
- funct7=0x20, rs2=s0=8, rs1=t1=6, funct3=0, rd=t1=6, op=0x33
- (0x20 << 25) | (8 << 20) | (6 << 15) | 0 | (6 << 7) | 0x33 = `0x40830333`

`sw t1, 0x1C(a0)`:
- imm=0x1C, rs2=t1=6, rs1=a0=10
- imm[11:5]=0, imm[4:0]=0x1C=28
- (0 << 25) | (6 << 20) | (10 << 15) | (2 << 12) | (28 << 7) | 0x23 = `0x00652E23`

### 4. Address shift discipline

Adding 3 instructions (12 bytes) shifts everything from pin 5
onwards by +12. JAL ra-to-`.delay` offsets stay the same (44, 28,
12) because both src and dst shift equally. The `j .loop_head`
offset increases from -60 to **-72** because the loop body length
grew by 12 bytes.

`j -72` = `0xFB9FF06F` (matches the same encoding used in the
original Phase 2.V running-light blob — full circle).

## Lo que SÍ funcionó

10-second test:

```
[esp32p4.ledc] ch 0 duty 1465
[esp32p4.ledc] ch 1 duty 582      ← 0x7FF - 1465 = 582 ✓
[esp32p4.gpio] pin 5 -> 1
... (running light)
[esp32p4.ledc] ch 0 duty 1615
[esp32p4.ledc] ch 1 duty 432      ← 0x7FF - 1615 = 432 ✓
... (every CH0/CH1 pair sums to 2047 = 0x7FF)
[esp32p4.ledc] ch 0 duty 17
[esp32p4.ledc] ch 1 duty 2030     ← 2047-17 = 2030 ✓ (post-wrap)
```

JSON event log counts (10-second test):
- 34 events with `"ch":0`  → CH0 duty writes
- 34 events with `"ch":1`  → CH1 duty writes (paired with CH0)
- 34 `"event":"adc"`         → ADC reads (one per loop)
- 68 `"event":"ledc"`        → CH0 + CH1 combined

Pairing verified: every CH0 / CH1 event pair has timestamps within
~2 µs of each other (the 3 instructions between them execute in
that window). Mathematical relationship confirmed:
**CH0_duty + CH1_duty == 0x7FF** for every pair.

## Lo que NO funcionó / decisiones tomadas

1. **Considered: 3-channel demo (CH0/CH1/CH2 with phase shifts)**:
   would need extra arithmetic for phase rotation (e.g.,
   `(s0 + 0x2AA) & 0x7FF`). Decided two channels is enough to
   validate multi-channel decode and demonstrate crossfade. The
   pattern generalizes trivially.

2. **Considered: actual PWM waveform on a GPIO pin**: would need
   a QEMUTimer in LEDC firing at the PWM frequency, generating
   GPIO transitions on a wired pin. Adds complexity (frequency
   choice, throttling event spam). Deferred to a future phase.
   The duty-event stream is enough for frontend rendering of LED
   brightness without modeling the actual square wave.

3. **Considered: removing the previous CH0 sw before adding CH1
   computation**: tempting to think "we already have CH0 setup,
   just add CH1 after". But s0 holds the ADC sample after `srli`,
   and we need it for both CH0 (direct) and CH1 (subtract). The
   add-3-instructions approach keeps both writes minimal.

## Lessons learned

1. **Multi-channel peripherals validate the decode logic**: if
   the model handles CH0 correctly, CH1/CH2/... should work
   automatically given the offset arithmetic. Phase 2.AE
   confirmed this for LEDC at no model-side cost.

2. **Sub-microsecond event pairing reflects guest blob
   determinism**: CH0 and CH1 events are emitted by 3
   instructions running at TCG speed — the ~2 µs delta in JSON
   timestamps shows QEMU schedules the writes back-to-back as
   intended.

3. **Address shift cascade is predictable**: insert N bytes,
   shift everything past it by N. JAL offsets unchanged when
   src and dst both shift; J offset to a target outside the
   shifted region adjusts by +N. Done this 4 times now (Phase
   2.W.next, 2.Z, 2.AA, 2.AE) — feels routine.

## Implementación final

### `hw/riscv/esp32p4.c`

Three new patches in the demo blob:
- `addi t1, x0, 0x7FF` at 0x40400134
- `sub t1, t1, s0`     at 0x40400138
- `sw t1, 0x1C(a0)`     at 0x4040013C

All subsequent blob addresses shifted +12. JAL offsets unchanged.
J `.loop_head` offset updated from -60 to -72 (encoding
`0xFD1FF06F` → `0xFB9FF06F`).

No changes to LEDC device — multi-channel handling was already
generic.

## Estado consolidado (post-2.AE)

| Hito                                                         | Estado |
|--------------------------------------------------------------|--------|
| UART hello world                                             | ✅     |
| GPIO output + ENABLE multiplexer + JSON channel              | ✅ 2.W |
| GPIO IRQ (latched status, edge filter, shared CPU IRQ)       | ✅ 2.AB|
| LEDC PWM single-channel duty events                          | ✅ 2.AC|
| ADC analog samples → LEDC pipeline                           | ✅ 2.AD|
| **LEDC multi-channel crossfade (CH0 + CH1 inverse)**         | ✅ 2.AE|
| Real PWM waveform on GPIO                                    | ⏳ later |
| I2C master / SPI master / TIMG real timers                   | ⏳ later |
| Real FreeRTOS port                                           | ⏳ Phase 2.V |

## 12-Phase realism progression

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
| 2.AD  | ADC peripheral + ADC→LEDC pipeline                      |
| **2.AE** | **LEDC multi-channel crossfade (2 channels)**         |

JSON stream now carries 4 event types (start, pin, ledc, adc) with
LEDC events distinguished per channel. **111 runtime patches**
active. Frontend can render two simultaneous LED brightnesses
that crossfade in real-time.

## Próximas direcciones

- **3-channel RGB fade**: extend to CH0/CH1/CH2 with phase shifts.
  Frontend would render an RGB color cycle.
- **Real PWM waveform on GPIO**: timer-driven pulse generation.
- **I2C master**: sensor-readout demo.
- **SPI master**: display/SD demo.
- **TIMG real timers**: foundation for `delay()`/`millis()`.
- **Phase 2.V (deferred)**: real FreeRTOS port.
