# Phase 2.AF — LEDC 3-channel RGB rainbow fade

**Estado**: ✅ done — live-verified. Demo blob now drives THREE LEDC
channels per loop iteration: CH0 = sample, CH1 = inverse, CH2 =
phase-shifted. Three duty events per cycle on three different
channels. Frontend can render an "RGB rainbow / chase" pattern.

## Goal

Validate that the LEDC peripheral's per-channel decode works for
channels beyond CH0/CH1. Add the canonical embedded 3-LED demo: three
fading LEDs at 0°/120°/240° relative phase. Each Arduino sketch that
ever drove an RGB LED uses this exact pattern, so getting the JSON
event stream to express it is the next visible-frontend milestone.

## Lo que SE INVESTIGÓ

### 1. ESP32-P4 LEDC channel 2 register address

Reusing the stride formula from Phase 2.AC/2.AE:

```
LEDC_CHN_DUTY_REG = LEDC_BASE + 0x14*N + 0x08
LEDC_CH2_DUTY_REG = LEDC_BASE + 0x28 + 0x08 = LEDC_BASE + 0x30
```

So the new write target is **offset 0x30**. Our LEDC model already
matches the generic pattern — no model-side change needed (Phase 2.AE
already proved this for CH1).

### 2. Phase-shifted sawtooth

Real RGB rainbow uses 3 sinusoids 120° apart. Pure-integer alternative:
3 sawtooths offset by 1/3 of their period. With period = 0x800 (2048),
1/3 ≈ 0x2AA, 2/3 ≈ 0x555. Combinations:

```
CH0 = sample
CH1 = (0x7FF - sample)              ; Phase 2.AE legacy
CH2 = ((sample + 0x555) & 0x7FF)    ; Phase 2.AF — 240° offset
```

CH1 is technically NOT 120° offset — it's the inverse. But visually
the trio still produces a chase/rainbow effect: at any time exactly
one channel is bright, one is fading up, one is fading down.

If we wanted true 120°/240° offsets we'd compute:
- `CH1' = (sample + 0x2AA) & 0x7FF`
- `CH2' = (sample + 0x555) & 0x7FF`

But that loses the inverse-fade demo from Phase 2.AE. Keeping CH1 as
inverse + adding CH2 as 240°-offset gives us **3 distinct duty curves**
visible side-by-side without removing prior work.

### 3. Encoding the new instructions

Picked **a1 (x11)** as scratch register. a0 = LEDC base, s0 = ADC
sample, s1 = ADC base, t1 = CH1 inverse compute, t2 = GPIO base
(can't touch). a1 was unused from the start.

`addi a1, x0, 0x555` (I-type):
- imm=0x555=1365 (12-bit signed positive, fits cleanly), rs1=0,
  funct3=0, rd=11, op=0x13
- (0x555 << 20) | (11 << 7) | 0x13 = `0x55500593`

`add a1, s0, a1` (R-type):
- funct7=0, rs2=11, rs1=8, funct3=0, rd=11, op=0x33
- (11<<20) | (8<<15) | (11<<7) | 0x33 = `0x00B405B3`

`andi a1, a1, 0x7FF` (I-type):
- imm=0x7FF (positive — no sign-extension landmine), rs1=11,
  funct3=7, rd=11, op=0x13
- (0x7FF<<20) | (11<<15) | (7<<12) | (11<<7) | 0x13 = `0x7FF5F593`

`sw a1, 0x30(a0)` (S-type):
- imm=0x30=48, imm[11:5]=1, imm[4:0]=16, rs2=11, rs1=10, funct3=2
- (1<<25) | (11<<20) | (10<<15) | (2<<12) | (16<<7) | 0x23 = `0x02B52823`

### 4. Address shift discipline (now +28 cumulative)

Phase 2.AE shifted the pin section by +12 (3 instructions). Phase 2.AF
adds 4 more = +16 = **+28 cumulative shift since Phase 2.AD**.

| Symbol            | 2.AD addr   | 2.AE addr   | 2.AF addr   |
|-------------------|-------------|-------------|-------------|
| .loop_head        | 0x40400128  | 0x40400128  | 0x40400128  |
| Pin 5 section     | 0x40400134  | 0x40400140  | 0x40400150  |
| Pin 7 OFF         | 0x40400160  | 0x4040016C  | 0x4040017C  |
| j .loop_head      | 0x40400164  | 0x40400170  | 0x40400180  |
| .delay subroutine | 0x40400168  | 0x40400174  | 0x40400184  |

JAL ra-to-`.delay` offsets unchanged (44/28/12) — both src and dst
shifted equally. J `.loop_head` offset goes from -72 to -88.

`j -88` encoding (re-derived):
- 21-bit two's complement: 0x1FFFA8
- imm[20]=1, imm[19:12]=0xFF, imm[11]=1, imm[10:1]=0x3D4
- = (1<<31) | (0x3D4<<21) | (1<<20) | (0xFF<<12) | (0<<7) | 0x6F
- = `0xFA9FF06F`

## Lo que SÍ funcionó

Test invocation (after fresh WSL session needs the recovery steps in
[`autosearch/build_environment_gotchas.md`](../build_environment_gotchas.md)):

```bash
bash test/test-esp32-p4/scripts/run_phase2af_test.sh
# or directly:
VELXIO_GPIO_LOG=/tmp/velxio-gpio.jsonl timeout 10 \
    $HOME/qemu-p4-build/qemu-system-riscv32 \
    -M esp32p4 -nographic -monitor none \
    -kernel test/test-esp32-p4/sketches/blink/build/esp32.esp32.esp32p4/blink.ino.elf
```

**10-second live run on 2026-05-08:**

```
=== JSON event totals ===
Total lines: 333
  "event":"ledc":        99
  "event":"adc":         33
  "event":"start":       1
  "ch":0:                33
  "ch":1:                33
  "ch":2:                33      ← NEW (Phase 2.AF)
  "pin":                 200      ← running-light @ ~3.3 Hz
```

**Per-cycle math verification** (first two LEDC trios from JSON log):

| t_ns        | CH0 duty | CH1 duty | CH2 duty | Math check                         |
|-------------|----------|----------|----------|-------------------------------------|
| 151,287,861 | 185      | 1862     | 1550     | 2047-185=1862 ✓; (185+1365)&2047=1550 ✓ |
| 452,817,571 | 335      | 1712     | 1700     | 2047-335=1712 ✓; (335+1365)&2047=1700 ✓ |

**Inter-event timing** (per trio): CH0→CH1 = ~3 µs, CH1→CH2 = ~5 µs.
The full 9-instruction CH0+CH1+CH2 sequence completes within ~8 µs at
TCG speed. JSON timestamps are tight enough to confirm back-to-back
guest execution.

Mathematical relationships proven per cycle:
- `CH0_duty + CH1_duty == 0x7FF`                       (legacy 2.AE)
- `(CH0_duty + 0x555) & 0x7FF == CH2_duty`             (new 2.AF)

These hold for every one of the 33 cycles in the test run.

## Lo que NO funcionó / decisiones tomadas

1. **Considered: replacing CH1 with 120°-offset to make true RGB
   trio (0°/120°/240°)**: would lose the inverse-fade visualization
   from Phase 2.AE. Kept CH1 as inverse and added CH2 as 240° offset
   — still gives a 3-channel fade where every duty value is unique.

2. **Considered: picking t0 instead of a1 as scratch**: t0 is used
   inside `.delay` (lw t0, 0x44(t4) for SYSTIMER snapshot). Could
   have worked since `.delay` reloads t0 first thing, but a1 is
   cleaner because it's truly unused throughout the entire blob.

3. **Considered: adding a 4th channel (CH3)**: 8 channels exist on
   real silicon; could keep going. Decided 3 channels is the
   "RGB / 3-phase" sweet spot; further channels would need a
   purpose (audio? motor PWM?) to justify the blob bloat.

4. **Considered: andi with imm = 0x800 to test wrap-around**: but
   0x800 in 12-bit signed = -2048 (sign extends to 0xFFFFF800), the
   classic RISC-V sign-extension gotcha (Phase 2.M). Stuck with
   0x7FF which is positive in 12-bit signed — masks correctly to
   the bottom 11 bits without the sign-extension landmine.

## Lessons learned

1. **Multi-channel decode is generic by construction**: Phase 2.AE
   confirmed CH1 worked. Phase 2.AF needed zero LEDC model changes
   for CH2 — the formula `(addr - 0x08) % 0x14 == 0` already covers
   all 8 channels. Validates the Phase 2.AC architectural decision
   to use a generic decoder instead of per-channel switch cases.

2. **a1 is the safest scratch register in this blob**: a0 (LEDC),
   s0 (sample), s1 (ADC), t0/t1 (delay state), t2 (GPIO), t3 (pin
   mask), t4 (SYSTIMER), t5/t6 (delay snapshot), ra (return). a1
   and a2..a7 remain free for future phases. Future blob extensions
   should prefer aN over tN to preserve the delay subroutine state.

3. **Small inserts cascade cleanly when JAL targets shift in
   lockstep**: the delay subroutine's location changes with each
   blob extension, but the JAL offsets from each pin section stay
   constant (+44/+28/+12). Only the J back to .loop_head needs
   re-encoding because the `.loop_head` target stays put while the
   J instruction itself shifts. This pattern has held across phases
   2.W.next, 2.Z, 2.AA, 2.AE, 2.AF — feels mechanically correct.

## Implementación final

### `hw/riscv/esp32p4.c`

Four new patches inserted between CH1 sw and Pin 5 section:
- `addi a1, x0, 0x555` at 0x40400140 — load phase-shift offset
- `add  a1, s0, a1`     at 0x40400144 — sample + offset
- `andi a1, a1, 0x7FF`  at 0x40400148 — wrap to 11-bit
- `sw   a1, 0x30(a0)`   at 0x4040014C — write LEDC_CH2_DUTY

All subsequent blob addresses shifted +16. JAL offsets unchanged.
J `.loop_head` offset updated from -72 to -88 (encoding
`0xFB9FF06F` → `0xFA9FF06F`).

No changes to LEDC device — multi-channel decode was already generic.

## Estado consolidado (post-2.AF)

| Hito                                                          | Estado |
|---------------------------------------------------------------|--------|
| UART hello world                                              | ✅     |
| GPIO output + ENABLE multiplexer + JSON channel               | ✅ 2.W |
| GPIO IRQ (latched status, edge filter, shared CPU IRQ)        | ✅ 2.AB|
| LEDC PWM single-channel duty events                           | ✅ 2.AC|
| ADC analog samples → LEDC pipeline                            | ✅ 2.AD|
| LEDC 2-channel crossfade (CH0 + CH1 inverse)                  | ✅ 2.AE|
| **LEDC 3-channel rainbow (CH0 + CH1 inverse + CH2 phase)**    | ✅ 2.AF|
| Real PWM waveform on GPIO                                     | ⏳ later |
| TIMG hardware timers (millis/delay)                           | ⏳ later |
| I2C master / SPI master                                       | ⏳ later |
| Real FreeRTOS port                                            | ⏳ Phase 2.V |

## 13-Phase realism progression

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
| 2.AE  | LEDC 2-channel crossfade (CH0 + CH1)                    |
| **2.AF** | **LEDC 3-channel rainbow (CH0 + CH1 + CH2)**          |

JSON stream still carries 4 event types (start, pin, ledc, adc) but
LEDC events now span 3 channels. **115 runtime patches** active
(was 111 in Phase 2.AE). Frontend can drive 3 simultaneous LED
brightness levels for an RGB rainbow visualization.

## Próximas direcciones (sin orden)

- **TIMG (Timer Group)** — hardware timer peripheral foundation for
  Arduino `millis()`/`micros()`/`delay()`. Highest impact: replaces
  the busy-wait .delay subroutine with real-silicon timer reads.
- **Real PWM waveform on GPIO** — make LEDC drive an actual GPIO pin
  with a square wave at the configured frequency. Closes the loop
  between LEDC duty events and visible-pin transitions.
- **I2C master** — sensor-readout demo. Bytes TX → JSON event;
  emulated slave responds with sensor data (BMP280, OLED, etc.).
- **SPI master** — display/SD demo.
- **Phase 2.V deferred** — real FreeRTOS port (large effort, deferred
  since the demo blob path produces visible output without it).
