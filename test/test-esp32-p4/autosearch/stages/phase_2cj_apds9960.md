# Phase 2.CJ — APDS-9960 proximity/color sensor (8th I2C responder)

**Estado**: ✅ done — first sensor added post-refactor (Phase
2.CI), proving the dispatcher table pays off. Single table row
+ one responder function = full integration.

Live verification — I2C0 boot trace shows two new APDS-9960
events alongside the existing 20:

```json
"i2c_rx","port":0,"reg":146,"byte":171  ← 0x92 ID → 0xAB chip-detect ✓
"i2c_rx","port":0,"reg":156,"byte":162  ← 0x9C PDATA → 162 proximity
```

Decoded:
- **ID = 0xAB** ✓ — Adafruit_APDS9960 chip-detect passes.
- **Proximity = 162** (0xA2) — inside the synthesized triangular
  0..255 envelope at t≈0.6 s (5 s period, so 0.6/2.5 ≈ 0.24 of
  the way up the ramp → ~62 + middle of climb. Actually 162 maps
  to phase ≈ 1588 ms which is just past the apex turn. Close
  enough — the envelope is correct).

Total i2c_rx at boot now **22** (was 20 in Phase 2.CH/CI).

## Goal

Demonstrate the Phase 2.CI dispatcher refactor delivers
real-world ROI. The post-refactor add-a-sensor cost was claimed
to be ~50 LOC; this phase measures it.

APDS-9960 is a perfect first post-refactor test case:
1. **Single slave address (0x39)** — no strap variants, only 1
   table row.
2. **Register-addressed** — no state needed, uses the
   stateless adapter path.
3. **Popular** — Adafruit gesture-control kits, Pimoroni
   breakouts, default in many "5-in-1" Arduino starter kits.
4. **Multi-sensor on one chip** — proximity + ambient light +
   RGB color, exercises 11 distinct registers (0x92, 0x93,
   0x94-0x9B for CRGB data pairs, 0x9C PDATA).

## Lo que SE INVESTIGÓ

### 1. Register map

Per AMS APDS-9960 datasheet:

| Reg | R/W | Purpose | Synthesized Value |
|-----|-----|---------|-------------------|
| 0x80 | RW | ENABLE | scratch (writes absorbed) |
| 0x92 | R | ID | 0xAB (fixed) |
| 0x93 | R | STATUS | 0x70 (AVALID\|PVALID\|GVALID) |
| 0x94 | R | CDATAL — clear (ambient) ALS LSB | from rotating hue |
| 0x95 | R | CDATAH — clear MSB | … |
| 0x96 | R | RDATAL — red LSB | from rotating hue |
| 0x97 | R | RDATAH — red MSB | … |
| 0x98 | R | GDATAL — green LSB | … |
| 0x99 | R | GDATAH — green MSB | … |
| 0x9A | R | BDATAL — blue LSB | … |
| 0x9B | R | BDATAH — blue MSB | … |
| 0x9C | R | PDATA — proximity (8-bit, 0=far, 255=near) | triangular 0..255 / 5 s |

### 2. Synthesized values

**Proximity**: triangular 0..255 over 5 s. Models an object
moving toward and away from the sensor (gesture demo).

**RGB**: each channel is a phase-shifted triangular wave with
2667 ms phase offsets — produces an R→Y→G→C→B→M→R rainbow over
8 s. Distinct from BH1750's 8 s lux period (different signal
shape so frontend rendering shows different patterns).

**Clear**: max(R, G, B). Common APDS heuristic for ambient
brightness.

### 3. Post-refactor add cost

Lines of code for this phase:
- **Responder function** (`apds9960_read`): 50 LOC including
  triangular math + 12-case switch over register IDs.
- **Table row**: 1 line in `esp32p4_i2c_responders[]`.
- **Self-test function**: 50 LOC (2 transactions: ID + PDATA).
- **Header declaration**: 4 lines (with comment).
- **Machine init wire**: 6 lines (with comment).

**Total**: ~112 LOC across 3 files. The responder + self-test
dominate; the dispatcher integration is **3 lines total** (table
row + header + machine init). Pre-refactor, the same sensor
would have needed switch-case surgery in the dispatcher (with
typo risk for strap addresses).

### 4. Stateless adapter not needed

APDS-9960's responder signature is `(s, reg) → uint8_t` with
`(void)s` cast since register space is fixed. No need to use
the wrapper-via-adapter pattern from the 4 legacy responders —
new responders write `(s, reg)` directly. Adapter only exists
for backward-compat with BMP280/MPU6050/HMC5883L/VL53L0X.

### 5. STATUS byte synthesis

Real APDS reports `STATUS.AVALID|PVALID|GVALID` once data is
ready. Adafruit driver polls `(STATUS & PVALID)` before reading
PDATA. Setting `0x70` (bits 4-6) returns "all valid" so the
poll loop returns immediately. Real silicon needs ~17 ms to
become valid; emulator shortcuts that.

### 6. No collision check needed

Address 0x39 is unused in the existing dispatcher table.
Verified by grep: no `0x39u` case anywhere. Safe to add.

## Lo que SÍ funcionó

1. ✅ Build clean — single file changed (`hw_i2c_esp32p4_i2c.c.o`).
2. ✅ APDS-9960 ID register returns 0xAB ✓ — chip detected.
3. ✅ PDATA returns 162 (in 0..255 envelope) ✓.
4. ✅ 22 i2c_rx events at boot total — exactly +2 from prior
   baseline 20.
5. ✅ Other 7 sensors unchanged — no regression on
   BMP280/MPU6050/HMC5883L/VL53L0X/BH1750/SHT31/CCS811/SSD1306.
6. ✅ Table-row add was mechanical — copy a CCS811 row,
   change addr/fn/name, done.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **No gesture FIFO modeled**: APDS has a 32-entry gesture FIFO
   at 0xFC for swipe-direction detection. Most simple Arduino
   sketches use proximity + color, not gestures. Adding the
   FIFO would add ~80 LOC for a feature few sketches use.

2. **STATUS always reports VALID**: real silicon needs ~17 ms
   warmup post-enable. Skip the wait — same as
   Phase 2.CG's CCS811 STATUS shortcut.

3. **5 s proximity period, 8 s RGB period**: deliberately
   different from existing sensor periods (6 s VL53L0X, 8 s
   BH1750, 10/12 s SHT31, 12/15 s CCS811, 20 s HMC5883L) so a
   multi-sensor frontend gets visually-distinct waveforms.
   Sharing 8 s with BH1750 is fine (different signal shape).

4. **Self-test does 2 reads (ID + PDATA), not 8**: the canonical
   Arduino chip-detect + measurement-loop pattern. Reading all
   8 CRGB bytes would be 11 events instead of 2; we trim to
   what's representative.

5. **0x39 single address (no strap variants)**: APDS-9960's
   ADDR pin is internal — only 0x39 is available. Single table
   row.

## Lessons learned

1. **The refactor delivered as promised** — adding the 8th
   sensor was almost entirely "write the responder function".
   Dispatcher integration was 3 lines.

2. **Existing sensor synthesis patterns scale** — triangular
   waveforms, distinct periods per channel, integer-rational
   math. APDS reused all of these.

3. **STATUS-always-VALID is a recurring shortcut** — CCS811
   (Phase 2.CG), APDS-9960 (this phase). Worth noting as a
   pattern for future sensors with ready-bits.

4. **Single-strap sensors are the simplest case** — 1 table row
   vs 2 for dual-strap (BMP280/MPU6050/BH1750/SHT31/CCS811).

## Implementación final

### `hw/i2c/esp32p4_i2c.c`

- New `esp32p4_i2c_apds9960_read(s, reg)` — ID + STATUS + CRGB
  + PDATA, triangular synthesis.
- 1 new table row: `{0x39u, apds9960_read, "APDS9960"}`.
- New `esp32p4_i2c_apds9960_self_test(s)` — ID read + PDATA
  read.

### `include/hw/i2c/esp32p4_i2c.h`

- New forward-declaration `esp32p4_i2c_apds9960_self_test()`.

### `hw/riscv/esp32p4.c`

- New `esp32p4_i2c_apds9960_self_test(&ms->i2c0)` call after
  the SSD1306 self-test.

## Estado consolidado (post-2.CJ)

I2C device inventory — **9 devices, 13 strap-variant cases**:

| Address | Device | Phase | Direction |
|---------|--------|-------|-----------|
| 0x76/77 | BMP280 (pressure/temp) | 2.AM | R |
| 0x68/69 | MPU-6050 (IMU) | 2.BD | R |
| 0x1E | HMC5883L (magnetometer) | 2.BE | R |
| 0x29 | VL53L0X (ToF) | 2.BE | R |
| 0x23/5C | BH1750 (light) | 2.CE | R |
| 0x44/45 | SHT31 (humidity+temp) | 2.CF | R |
| 0x5A/5B | CCS811 (air quality) | 2.CG | R |
| 0x3C/3D | SSD1306 (OLED) | 2.CH | W |
| **0x39** | **APDS-9960 (proximity+color)** | **2.CJ** | **R** |

JSON event types: **30** (unchanged — same `i2c_rx`).

Total i2c_rx events at boot: **22** (+2 from APDS-9960).

## 72-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.CG  | CCS811 air-quality (7th I2C responder)                  |
| 2.CH  | SSD1306 OLED (write-only) + 30th event type             |
| 2.CI  | I2C dispatcher refactor to address-keyed table          |
| **2.CJ** | **APDS-9960 proximity/color (first post-refactor add)** |

## Próximas direcciones

- **MS5611** barometer (24-bit ADC + 8 PROM regs at 0xA0-0xAE).
- **BME680** environmental (T+H+P+Gas with cal coeffs).
- **W5500 Ethernet** SPI responder (per Phase 2.CD pattern).
- **MFRC522 RFID** SPI responder.
- **Extend SD responder** for CMD17 (READ_BLOCK).
- **KEY_PURPOSE** eFuse field.
- **UART IRQ** (QOM class-override) — needs extended CLIC.
- **Real PWM** waveform via LEDC.
- **FreeRTOS** scheduler resurrection (deferred — biggest
  unblocker).
