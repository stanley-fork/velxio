# Phase 2.CW — MS5611 barometric pressure + temperature sensor (9th I2C responder + env-var dispatcher override)

**Estado**: ✅ done — adds MS5611-01BA01 to the I2C responder
inventory. First sensor in the project that **collides** with an
existing dispatcher entry: both BMP280 (Phase 2.AM) and MS5611
own the only two valid I2C addresses 0x76 (CSB-high) and 0x77
(CSB-low). Solved with a clean env-var dispatcher override that
routes the chosen sensor at runtime — mirrors how a real board
forces the user to pick one or the other.

Live verification (boot with `VELXIO_I2C_SENSOR_AT_77=ms5611`):

```
[esp32p4.i2c0] addr 0x77 = MS5611 (VELXIO_I2C_SENSOR_AT_77 override)

JSON i2c_rx events at I2C0 (decoded):
  reg=162 (0xA2), byte=156 (0x9C)  ← C1 SENS_T1 MSB
  reg=163 (0xA3), byte=191 (0xBF)  ← C1 SENS_T1 LSB  → C1 = 0x9CBF = 40127 ✓
  reg=0/1/2,    bytes 124/0/0      ← D1 raw 0x7C0000 (pressure, after CONVERT 0x48)
  reg=0/1/2,    bytes 131/224/0    ← D2 raw 0x83E000 (temperature, after CONVERT 0x58)

ms5611_last_d toggle confirmed: first ADC burst returns D1,
second returns D2 — the CONVERT command latches via the
FIFO_DATA write hook before the master sends ADC_READ.

Default behavior (no env var): no MS5611 events emitted —
BMP280 still owns 0x76/0x77 and the Phase 2.AM..2.CJ
regression chain passes clean.
```

## Goal

Add the **MS5611 (TE Connectivity barometric pressure + temperature
sensor, 5 mbar / 0.01 °C resolution)** as the 9th I2C responder
in the dispatcher. This is the first sensor in the project that
collides with an existing dispatcher entry — both BMP280 and
MS5611 use 0x76 (CSB-high) and 0x77 (CSB-low) per datasheet. A
real board has CSB hard-wired to VCC or GND and physically can
only have one or the other on the bus.

The phase therefore has **two parts**:
1. **Sensor implementation** — MS5611's command-based protocol
   (RESET / READ_PROM / CONVERT_D1 / CONVERT_D2 / ADC_READ) with
   realistic factory PROM coefficients + synthetic 24-bit raw
   values that decode to ~25 °C / ~1013 hPa.
2. **Dispatcher override architecture** — env-var-driven
   `addr76_is_ms5611` / `addr77_is_ms5611` bools per I2C instance,
   consulted **before** the linear table scan. Default routes
   stay BMP280 (preserves Phase 2.AM..2.CJ regression).

## Lo que SE INVESTIGÓ

### 1. MS5611-01BA01 datasheet — command-based protocol

Per the TE Connectivity MS5611-01BA01 datasheet § "I²C Commands":
- The MS5611 is **not** register-mapped like BMP280 / SHT31. The
  bytes the master writes to the slave are **command opcodes**:

  | Cmd       | Meaning                                                    |
  |-----------|------------------------------------------------------------|
  | 0x1E      | RESET — reloads PROM into shadow RAM, ~2.8 ms              |
  | 0xA0..0xAE| READ_PROM — 8 × 16-bit coefficients at offsets 0/2/4/.../14|
  | 0x40..0x48| CONVERT_D1 (pressure raw, OSR 256/512/1024/2048/4096)      |
  | 0x50..0x58| CONVERT_D2 (temperature raw, same OSR ladder)              |
  | 0x00      | ADC_READ — returns 24-bit result of last CONVERT           |

- PROM read flow: master writes `0xA0..0xAE`, then issues a
  restart + 2-byte read. The peripheral returns the 16-bit
  coefficient at index `(cmd - 0xA0) / 2`, MSB first.
- ADC_READ flow: after waiting the OSR-dependent conversion time
  (~0.6..8.22 ms), master writes `0x00`, then issues a restart +
  3-byte read. The peripheral returns the 24-bit raw value of
  whichever D was last converted (D1 or D2).
- The peripheral must remember whether the last CONVERT was D1
  or D2 — this is the **only** piece of cross-transaction state
  in the protocol.

### 2. PROM calibration coefficients

Per § "Calibration Data" of the datasheet, the 8 × 16-bit PROM
stores factory-trimmed values:

| Idx | Name      | Meaning                                      |
|-----|-----------|----------------------------------------------|
| C0  | factory   | reserved + 4-bit CRC nibble (typically 0)    |
| C1  | SENS_T1   | pressure sensitivity at reference temp       |
| C2  | OFF_T1    | pressure offset at reference temp            |
| C3  | TCS       | temp coeff of pressure sensitivity           |
| C4  | TCO       | temp coeff of pressure offset                |
| C5  | T_REF     | reference temperature                        |
| C6  | TEMPSENSE | temp coeff of temperature                    |
| C7  | serial    | serial code + 4-bit CRC                      |

Chose typical values from a real Adafruit MS5611 breakout (the
datasheet's § A.1 worked example):
```
C1 = 40127  C2 = 36924  C3 = 23317  C4 = 23282
C5 = 33464  C6 = 28312  C7 = 0x0F00
```

### 3. Driver-side decoding formulas

From § "Pressure and Temperature Calculation":
```
dT   = D2 - C5 * 256
TEMP = 2000 + dT * C6 / 2^23                    (centi-°C)

OFF  = C2 * 65536 + (C4 * dT) / 128
SENS = C1 * 32768 + (C3 * dT) / 64
P    = (D1 * SENS / 2^21 - OFF) / 2^15          (0.01 hPa)
```

Picked D1 = 0x7C0000 and D2 = 0x83E000 to produce reasonable
room-temperature / sea-level pressure outputs when run through
the driver's decoding. Not bit-perfect physics — the point is
"the driver sees a valid 24-bit number and decodes to a sensible
physical quantity", not exact match against a real sensor's
output (we have no real sensor in QEMU's loop).

### 4. Address collision with BMP280

BMP280 datasheet § 5.2 "I²C Interface": addresses 0x76 (SDO=GND)
and 0x77 (SDO=VCC). MS5611-01BA01 datasheet § 4.2: addresses
0x76 (CSB=VCC) and 0x77 (CSB=GND).

**Same address space, mutually exclusive on a physical bus.**

This is the first such collision in the project (BMP280, MPU6050,
HMC5883L, VL53L0X, BH1750, SHT31, CCS811, SSD1306, APDS-9960 all
have distinct addresses). Future collisions will include BME280
(also 0x76/0x77), MPL3115A2 (0x60), etc. — so any architecture
chosen here sets a precedent.

### 5. Architecture options for the collision

**A. Put MS5611 entry in the table after BMP280**
- Linear scan returns first match → BMP280 always wins → MS5611
  unreachable. Bad.

**B. Put MS5611 entry before BMP280**
- MS5611 always wins → BMP280 unreachable + Phase 2.AM..2.CJ
  self-tests break. Bad.

**C. Different address for MS5611 (e.g. 0x70)**
- No collision, but doesn't match real Arduino sketches that hard-code
  0x76/0x77. Unrealistic — fails the "as close to real silicon as
  possible" goal.

**D. Env-var-driven per-instance override (chosen)**
- Default: BMP280 owns 0x76/0x77 (preserves regression).
- `VELXIO_I2C_SENSOR_AT_77=ms5611` switches 0x77 to MS5611.
- `VELXIO_I2C_SENSOR_AT_76=ms5611` switches 0x76 to MS5611.
- Real Arduino sketches at the standard addresses see whichever
  the user configured for that boot.
- Future collisions get one new bool + one new env-var per pair.

Chose **D** — matches the eFuse env-var pattern (VELXIO_EFUSE_*),
fits the project's "real-board" model (the user picks which sensor
is on the bus, just like wiring CSB on a real PCB), and preserves
all existing regression coverage.

### 6. CONVERT-command latch design

The peripheral must remember whether the last CONVERT was D1 or D2.
Options:

- **In-responder static state**: Doesn't survive between sensor
  instances; OK for our single-I2C0 setup but fragile.
- **Pass via tx_history**: The CONVERT byte is already there
  (tx_history[1] after slave+W). Responder could inspect it on
  each ADC_READ. **But** the master sends `slave+W, 0x00, restart,
  slave+R` for ADC_READ, so by the time the responder is called
  the convert byte has been overwritten by the 0x00 ADC_READ
  command. Doesn't work.
- **Per-instance state field `ms5611_last_d`** (chosen): updated
  in the FIFO_DATA write hook when a CONVERT byte is detected;
  consumed by the responder during ADC_READ. Survives across
  transactions because it lives in `ESP32P4I2cState`.

Detection logic in the FIFO_DATA write hook:
```c
uint8_t prev_slave_w = s->tx_history[1];
bool is_ms5611_addr =
    (prev_slave_w == 0xECu && s->addr76_is_ms5611) ||  /* 0x76 << 1 */
    (prev_slave_w == 0xEEu && s->addr77_is_ms5611);    /* 0x77 << 1 */
if (is_ms5611_addr && byte >= 0x40u && byte <= 0x58u) {
    s->ms5611_last_d = (byte & 0x10u) ? 1u : 0u;
}
```

Bit 4 (0x10) of the convert byte cleanly distinguishes D1 (clear)
from D2 (set). Lower 4 bits encode OSR (0/2/4/6/8 → 256/.../4096)
but we don't model conversion latency, so OSR is informational
only.

### 7. Self-test sequence design

Following the Adafruit_MS5611 driver pattern + the datasheet
worked example, the self-test drives all 4 distinct code paths:

1. **RESET (0x1E)** — write-only, no response. Exercises the
   FIFO_DATA write path for the MS5611 address.
2. **READ_PROM C1 (0xA2 + 2-byte burst)** — exercises the PROM
   code path (MSB then LSB of pressure sensitivity).
3. **CONVERT_D1_OSR_4096 (0x48)** — exercises the CONVERT-D1
   latch (`ms5611_last_d = 0`).
4. **ADC_READ + 3-byte D1 burst (0x00)** — exercises the D1 ADC
   path; returns 0x7C0000.
5. **CONVERT_D2_OSR_4096 (0x58)** — exercises the CONVERT-D2
   latch (`ms5611_last_d = 1`).
6. **ADC_READ + 3-byte D2 burst (0x00)** — exercises the D2 ADC
   path; returns 0x83E000.

Total: 8 i2c events + 8 i2c_rx events. Covers PROM read,
CONVERT-latch state machine (both D1 and D2 paths), and ADC_READ
multi-byte burst.

To exercise the FIFO_DATA write hook (the CONVERT latch), the
self-test calls `esp32p4_i2c_write(s, ESP32P4_I2C_FIFO_DATA, ...)`
directly — same approach as the SSD1306 self-test (Phase 2.CH)
which also drives writes through the static MMIO write callback.
This proves the latch path works end-to-end without needing a
guest sketch.

## Lo que SÍ funcionó

1. ✅ Build clean — 3 files changed (i2c.c + i2c.h header + machine
   init wiring). meson.build untouched (no new files).
2. ✅ PROM read: reg=0xA2/0xA3 returns 0x9C/0xBF (= 40127 = C1
   SENS_T1) ✓ matches the static `prom[]` table.
3. ✅ CONVERT-D1 latch: after writing 0x48 to FIFO_DATA, ADC_READ
   burst returns 0x7C/0x00/0x00 (= 0x7C0000) ✓.
4. ✅ CONVERT-D2 latch: after writing 0x58, ADC_READ burst returns
   0x83/0xE0/0x00 (= 0x83E000) ✓ — proves the latch is
   correctly toggled between transactions.
5. ✅ Env-var override active: `[esp32p4.i2c0] addr 0x77 = MS5611
   (VELXIO_I2C_SENSOR_AT_77 override)` printed at boot.
6. ✅ **Regression-clean default**: without `VELXIO_I2C_SENSOR_AT_77`,
   no MS5611 events emitted — BMP280 still owns 0x76/0x77 and the
   Phase 2.AM..2.CJ self-test events stream as before.
7. ✅ Both addresses configurable independently: env var can switch
   0x76 alone, 0x77 alone, or both. Self-test picks 0x77 if set,
   else 0x76 if set.
8. ✅ No regression on AES / SHA / HMAC / USB Serial/JTAG / other
   peripherals.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Env-var override (D), not different-address fudge (C)**:
   sets the project's pattern for handling shared-address sensors,
   future-proof for BME280, MPL3115A2, BMP180, etc. The cost is
   one new state field + one env-var read per address.

2. **Override checked before the linear table scan**: keeps the
   table semantics simple (still "first match wins" for everything
   in the table). The override is a separate fast-path; if no
   override applies, the existing dispatcher behavior is unchanged.

3. **CONVERT latch in the FIFO_DATA write hook, not in the
   responder**: the responder is only called for **reads**;
   CONVERT is a write-only command. The latch must happen during
   the master's write, before the subsequent ADC_READ.

4. **Latch gated on MS5611 being the configured sensor at the
   address**: if BMP280 is at 0x76, the user shouldn't accidentally
   latch `ms5611_last_d` when BMP280 driver writes to that address.
   The is_ms5611_addr guard means the latch only fires when MS5611
   is the configured responder.

5. **Synthetic D1/D2 static values, not time-varying**: real-world
   Arduino_MS5611 examples read once + decode. A time-varying
   pattern (like SHT31's 10-second triangular sweep) would be
   nicer but isn't necessary for the canonical demo. Trivial to
   add later if a multi-second sketch demands it.

6. **PROM values from the datasheet § A.1 worked example, not
   randomized**: gives the project a deterministic reference set
   that can be cross-checked against the datasheet's printed
   decoded values. Randomization would obscure the trace.

7. **Self-test calls `esp32p4_i2c_write` directly for CONVERT
   commands**: mirrors the SSD1306 self-test (Phase 2.CH) pattern.
   The alternative — emitting JSON events + calling the read path
   only — wouldn't exercise the FIFO_DATA write hook where the
   latch lives. Going through the real write path proves the
   silicon-equivalent behavior.

8. **`strcasecmp` for env-var value matching**: matches the eFuse
   env-var pattern. Accepts "ms5611", "MS5611", "Ms5611", etc.
   More forgiving than the EnvVar value would otherwise need to be.

9. **Only I2C0 wired to MS5611 in machine init**: keeps the
   bring-up minimal. I2C1 can be wired later if a multi-bus demo
   needs MS5611 on Wire1 instead of Wire.

10. **No "ms5611" JSON event type — reuse the existing `i2c` /
    `i2c_rx` envelope**: MS5611's protocol is well-served by the
    generic `reg`/`byte` shape. Adding a dedicated event type
    would force the frontend to special-case decoding when the
    same byte stream already conveys the needed info.

## Lessons learned

1. **Shared-address sensors are inevitable in a real I2C ecosystem.**
   The architecture chosen here (per-address override in
   `ESP32P4I2cState` + env-var-driven selection) sets the precedent
   for future BME280 / MPL3115A2 / BMP180 additions. Each new
   collision is one bool + one env-var, no dispatcher refactor.

2. **Cross-transaction state belongs in the device struct, not
   in static-local responder state.** The CONVERT latch survives
   across multiple I2C transactions (CONVERT → wait → ADC_READ),
   so it has to live where the responder can read it without
   being initialized. `ESP32P4I2cState` is the right place.

3. **Hooking writes for state, hooking reads for responses.** The
   I2C master's writes and reads are separate code paths;
   command-based slaves (MS5611, future similar parts) need state
   updated during writes that's consumed during reads. The
   FIFO_DATA write hook is the canonical place to update slave
   state — the SSD1306 wiring already established this pattern.

4. **Env-var overrides scale.** This is the 6th env-var pattern
   in the project (after VELXIO_EFUSE_*, VELXIO_GPIO_*,
   VELXIO_USB_SERIAL_JTAG_INPUT, VELXIO_TWAI_RX, VELXIO_GPIO_LOG).
   The mental model "edit env var to configure synthetic hardware"
   is increasingly cheap to extend.

5. **Datasheet § A.1 worked examples are gold for picking
   synthetic values.** Reading the manufacturer's own example
   gives values that any standard driver implementation will
   decode to sensible physical quantities. Random values would
   work but obscure the trace.

## Implementación final

### `include/hw/i2c/esp32p4_i2c.h`

- Added `uint8_t ms5611_last_d` to `ESP32P4I2cState` — latched
  by FIFO_DATA write hook when a CONVERT command is detected.
- Added `bool addr76_is_ms5611` / `bool addr77_is_ms5611` to
  `ESP32P4I2cState` — set at machine init from env vars.
- Added `void esp32p4_i2c_ms5611_self_test(ESP32P4I2cState *s)`
  prototype following the per-sensor self-test convention.

### `hw/i2c/esp32p4_i2c.c`

- Added `esp32p4_i2c_ms5611_read(s, reg)` responder fn with
  PROM (0xA0..0xAF) + ADC_READ (0x00..0x02) paths.
- Added 6-line override gate at the top of
  `esp32p4_i2c_responder_read()` (before the linear table scan).
- Added CONVERT-command latch in the FIFO_DATA write hook
  (gated on the per-address `is_ms5611` config).
- Added `esp32p4_i2c_ms5611_self_test()` driving the 6-step
  RESET → PROM → CONVERT_D1 → ADC_READ → CONVERT_D2 → ADC_READ
  sequence.
- Documented in the responder table comment that 0x76/0x77 are
  shared with MS5611 via override (no table entry needed).

### `hw/riscv/esp32p4.c`

- Added env-var read for `VELXIO_I2C_SENSOR_AT_76` and
  `VELXIO_I2C_SENSOR_AT_77` (`strcasecmp` against "ms5611").
- Set `addr76_is_ms5611` / `addr77_is_ms5611` accordingly on
  I2C0.
- Conditional self-test invocation: only fires when at least
  one of the addresses is configured for MS5611.

## Estado consolidado (post-2.CW)

I2C dispatcher inventory:

| Addr     | Sensor      | Phase | Class           |
|----------|-------------|-------|-----------------|
| 0x76/77  | BMP280      | 2.AM  | env-var-default |
| 0x68/69  | MPU6050     | 2.BD  | always-on       |
| 0x1E     | HMC5883L    | 2.BE  | always-on       |
| 0x29     | VL53L0X     | 2.BE  | always-on       |
| 0x23/5C  | BH1750      | 2.CE  | always-on       |
| 0x44/45  | SHT31       | 2.CF  | always-on       |
| 0x5A/5B  | CCS811      | 2.CG  | always-on       |
| 0x3C     | SSD1306     | 2.CH  | always-on (write-only) |
| 0x39     | APDS-9960   | 2.CJ  | always-on       |
| **0x76/77** | **MS5611** | **2.CW** | **env-var-override** |

9 distinct sensors, 10 slots in the responder dispatcher.

JSON event types: **35** (unchanged — MS5611 uses the existing
`i2c` / `i2c_rx` envelopes).

## 85-Phase realism progression

| Phase | Capability                                                |
|-------|-----------------------------------------------------------|
| 2.CU  | SHA-224 mode (MODE=1) — short-output SHA-2 family complete|
| 2.CV  | Multi-block HMAC — closes Phase 2.CN limitation           |
| **2.CW** | **MS5611 + env-var dispatcher override for shared addresses** |

First sensor in the project that handles a real-bus collision.
Pattern established: future BME280 / MPL3115A2 / BMP180 follow
the same `addr_HH_is_<sensor>` bool + env-var-override approach.

## Próximas direcciones

- **BME280** — humidity-aware sibling of BMP280, same 0x76/0x77.
  Plug into the same env-var override slot. ~120 LOC (richer
  command set than MS5611, register-table-ish).
- **MPL3115A2** — Freescale altimeter at 0x60. No collision —
  simple table entry.
- **VEML6075 / VEML7700** — UV / ambient light at 0x10. No
  collision.
- **Time-varying MS5611 D1/D2** — synthesize altitude-varying
  pressure for "weather station" demos. Trivial extension.
- **MS5611 over SPI** — the part also supports SPI; would belong
  to the SPI responder dispatcher (Phase 2.CD pattern).
- **PROM CRC-4 verification** — drivers often verify the C7 CRC
  before using the calibration data. We currently emit C7 = 0x0F00
  which won't pass the CRC check. Compute the real CRC for the
  emitted PROM and stash in the C7 nibble.
- **HMAC streaming refactor** — remove the Phase 2.CV 1024-byte cap.
- **SHA-384/512/512-t modes** — 64-bit working state + 128-bit
  length field.
- **AES-CBC / AES-GCM / XTS-AES** block modes (needs DMA).
- **Secure Boot digest verifier** — TRM Chapter 29.
- **Digital Signature peripheral** — KEY_PURPOSE=7 plumbing.
- **RSA / ECDSA / ECC** crypto peripherals.
- **USB Serial/JTAG IRQ wiring** — needs free CLIC cause.
- **W5500 / MFRC522** sensors/SPI responders.
- **UART IRQ** via interrupt matrix.
- **Real PWM** waveform via LEDC.
- **JTAG bridge peripheral**.
- **FreeRTOS** scheduler resurrection.
