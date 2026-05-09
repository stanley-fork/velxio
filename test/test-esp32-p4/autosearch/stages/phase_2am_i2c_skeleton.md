# Phase 2.AM — I2C master peripheral skeleton

**Estado**: ✅ done — I2C0 peripheral mounted at 0x500D2000 with FIFO
+ CMD register decoding, JSON event emission, and a machine-side
self-test that produces 8 i2c events at boot. First peripheral that
opens the door to sensor demos (BMP280, OLED, EEPROM, RTC).

## Goal

Add the first I2C controller. Without I2C, the chip can't talk to
any I2C-bus sensors — BMP280, SHT3x, MPU6050, SSD1306, etc. — which
is the bulk of the Arduino ecosystem. This phase delivers:

  - The peripheral at the real silicon address.
  - JSON event emission for FIFO_DATA writes (TX bytes) and CMD
    register writes (bus operations).
  - A self-test that fires a "read BMP280 chip-id" transaction at
    boot so the JSON stream demonstrates the path is live.

Future phases extend this with: synthetic slave responders (returning
sensor-like data), CPU IRQ wiring, real Arduino sketch using
`Wire.begin()` / `Wire.requestFrom()`.

## Lo que SE INVESTIGÓ

### 1. ESP32-P4 I2C0 register layout

Per IDF `soc/i2c_reg.h`:

```
DR_REG_I2C_BASE  = HPPERIPH1 + 0x12000 = 0x500D2000   (I2C0)
DR_REG_I2C1_BASE = HPPERIPH1 + 0x16000 = 0x500D6000   (NOT modelled)
```

Key registers (offsets from I2C0_BASE):

| Off  | Register        | Purpose                                |
|------|-----------------|----------------------------------------|
| 0x00 | SCL_LOW_PERIOD  | clock generator (scratch)              |
| 0x04 | CTR             | bus mode + FSM enable (scratch)        |
| 0x10 | SLAVE_ADDR      | master mode slave addr (scratch)       |
| 0x18 | FIFO_ST         | FIFO status                            |
| 0x1C | FIFO_CONF       | FIFO config (RX/TX threshold)          |
| **0x20** | **FIFO_DATA** | **read/write 32-byte FIFO (TRACED)**   |
| 0x24 | FIFO_RST        | one-shot reset                         |
| 0x28 | INT_RAW         | raw interrupt status                   |
| 0x2C | INT_CLR         | W1TC clear                             |
| 0x30 | INT_ENA         | interrupt enable                       |
| 0x34 | INT_ST          | latched status (raw & ena)             |
| **0x58..0x74** | **CMD0..CMD7** | **command queue 8 slots (TRACED)** |

### 2. CMD register decode

Each 32-bit CMD slot:

```
[31]    done           (HW-set when slot completes)
[13:11] op_code        (0=RSTART, 1=WRITE, 2=READ, 3=STOP, 4=END)
[10]    ack_value      (R/W direction in some IDF revisions)
[9]     ack_exp         (expected ACK)
[8]     ack_check_en    (check ACK from slave)
[7:0]   byte_num        (number of bytes to TX/RX, 0..255)
```

A typical "read BMP280 chip ID" transaction uses 6 CMD slots:

```
CMD0:  RSTART           ; START condition
CMD1:  WRITE byte_num=2 ; TX slave_addr+W, reg 0xD0
CMD2:  RSTART           ; repeated START
CMD3:  WRITE byte_num=1 ; TX slave_addr+R
CMD4:  READ  byte_num=1 ; RX response byte
CMD5:  STOP             ; STOP condition
```

The TX bytes go through the FIFO_DATA register before the CMD slots
are programmed. So the frontend tracker would see:

```
fifo_tx: 0xEC     (slave_addr 0x76 << 1)
fifo_tx: 0xD0     (BMP280 chip_id register)
cmd: rstart slot=0
cmd: write  slot=1 byte_num=2
cmd: rstart slot=2
cmd: write  slot=3 byte_num=1
cmd: read   slot=4 byte_num=1
cmd: stop   slot=5
```

### 3. Why a self-test?

Phase 2.AC (LEDC), 2.AD (ADC), 2.AG (TIMG) all added peripherals
that produced visible JSON events at boot via either:
  - LEDC: demo blob writes happen each loop iteration (33+ events/run)
  - ADC: demo blob reads happen each loop iteration (33+ events/run)
  - TIMG: machine-init self-test pre-programs the alarm (9 events/run)

I2C is a request-response peripheral — without a guest sketch
issuing transactions, the device sits dormant. Two options:

  (a) Add demo blob extension that does I2C transactions
  (b) Have the machine itself synthesize a transaction at boot

Picked **(b)** because:
  - Demo blob extension would need ~10 instructions = +40 byte shift
    + bookkeeping for every existing JAL/branch
  - Machine-side self-test is a clean ~30 LoC `esp32p4_i2c_self_test()`
    function called once after device realize
  - The self-test pattern (1-shot pre-program) is consistent with
    Phase 2.AG's TIMG approach

The self-test fires a "BMP280 chip-id read" sequence — recognisable
as the first thing every BMP280 sketch does (`if (chip_id != 0x58)
fail`). Frontend can decode it as "user is checking for BMP280 at
0x76".

### 4. JSON event format

```json
{"event":"i2c","port":0,"fifo_tx":236}
{"event":"i2c","port":0,"cmd":"rstart","slot":0,"byte_num":0,"ack_check":1}
```

Two flavours:
  - **fifo_tx**: `byte` payload, the value written to FIFO_DATA
  - **cmd**: `op` string (rstart/write/read/stop/end), `slot`,
    `byte_num`, `ack_check`

Frontend can stitch these into per-transaction summaries (a series
of fifo_tx events followed by a series of cmd events = one bus
transaction).

`port` field always 0 in this phase (I2C0 only). Phase 2.AM.timg1
or wherever I2C1 is added will set port=1.

### 5. CONFIG_I2C dependency

The QEMU upstream gates the I2C subsystem on `CONFIG_I2C`. Our
machine didn't have it set, so `i2c/core.c` etc. weren't built —
linker would fail. Fixed by adding `select I2C` to the
`RISCV_ESP32P4` Kconfig stanza. This pulls in `i2c/core.c` even
though we don't use the QEMU I2C bus model directly (we're a plain
sysbus device with our own register decoder).

Could have avoided `select I2C` by putting `esp32p4_i2c.c` in
`hw/timer/` or somewhere unguarded, but `hw/i2c/` is the right
home semantically. Worth the one-line Kconfig change.

## Lo que SÍ funcionó

10-second live test (2026-05-08):

```
=== JSON event totals ===
Total lines: 379  (was 369 in Phase 2.AL — +8 i2c + 2 timing variance)

  "event":"ledc":     99   ← unchanged
  "event":"adc":      33   ← unchanged
  "event":"timg":      9   ← unchanged
  "event":"timg_irq": 18   ← unchanged
  "event":"i2c":       8   ← NEW (self-test)
  "event":"start":     1
  "pin":              200  ← unchanged (running light + pin 8/9 ISR)
```

Self-test events (all at t≈1.9 ms, machine-init time):

```json
{"t_ns":1929075,"event":"i2c","port":0,"fifo_tx":236}
{"t_ns":1948795,"event":"i2c","port":0,"fifo_tx":208}
{"t_ns":1951317,"event":"i2c","port":0,"cmd":"rstart","slot":0,
              "byte_num":0,"ack_check":1}
{"t_ns":1953164,"event":"i2c","port":0,"cmd":"write","slot":1,
              "byte_num":2,"ack_check":1}
{"t_ns":1954659,"event":"i2c","port":0,"cmd":"rstart","slot":2,
              "byte_num":0,"ack_check":1}
{"t_ns":1955999,"event":"i2c","port":0,"cmd":"write","slot":3,
              "byte_num":1,"ack_check":1}
{"t_ns":1957320,"event":"i2c","port":0,"cmd":"read","slot":4,
              "byte_num":1,"ack_check":1}
{"t_ns":1958611,"event":"i2c","port":0,"cmd":"stop","slot":5,
              "byte_num":0,"ack_check":1}
```

Decoded:

  - `fifo_tx 236` = 0xEC = (0x76 << 1) = slave addr 0x76 + WRITE bit
  - `fifo_tx 208` = 0xD0 = BMP280 chip-id register address
  - 6 CMD slots execute the standard "register read" I2C dance

This pattern is recognisable to any embedded engineer — a frontend
parser could label it "BMP280 chip-id check" automatically.

No regression: every other event count identical to Phase 2.AL
(within timing variance for TIMG ticks).

## Lo que NO funcionó / decisiones tomadas

1. **No actual I2C bus simulation**: bytes don't actually travel to
   a slave. FIFO_DATA reads return 0xFF (typical "no slave"
   pull-up). Phase 2.AM.slave will add a synthetic responder via
   env var (e.g., `VELXIO_I2C_SLAVE=0x76:0xD0=0x58` to script "at
   address 0x76, register 0xD0 returns 0x58"). For now the JSON
   event stream is all the frontend gets.

2. **No CPU IRQ wiring**: I2C has its own per-source IRQ (cause TBD,
   probably 21 — 17 SYSTIMER, 18 GPIO, 19 TIMG, 20 reserved for
   TIMG1, 21 free). Phase 2.AM.irq adds it. Real Arduino code
   often polls instead of using IRQ for I2C, so this is not
   blocking visible demos.

3. **Throttle bypassed for self-test**: self-test fires 8 events
   within ~30 µs at boot. The 50 ms throttle would drop 7 of 8.
   Bypassed only for the self-test; runtime guest writes still
   throttle.

4. **`select I2C` in Kconfig pulls in core.c we don't use**: the
   QEMU upstream `i2c/core.c` is the bus-master abstraction. We
   don't use it (our peripheral is a sysbus stub that emits JSON,
   not a bus master that talks to slave devices). Including it
   adds ~50 KB to the binary. Tradeoff: simpler than rewriting
   the Kconfig hierarchy. Future phase that adds a real slave
   responder would actually use core.c.

5. **One I2C0 only, not I2C1**: real chip has both. Adding I2C1 is
   a copy-paste like TIMG1 would be. Deferred.

## Lessons learned

1. **Sysbus device with a public helper is the cleanest way to do
   machine-init self-tests**: rather than `address_space_write`
   tricks or moving init logic out of the device, a plain
   `esp32p4_i2c_self_test()` non-static function in the device .c
   file is clean. Header declares it; machine init calls it after
   wiring `event_log`.

2. **Default-to-tracking-everything is wrong for I2C**: emitting an
   event for every register write (CTR, SCL_PERIOD, FILTER_CFG,
   etc.) would flood. Selectively tracking FIFO_DATA + CMD only
   captures the meaningful bus activity. IDF's I2C driver writes
   to ~15 config registers during init — none are events.

3. **The 0xEC byte encoding (`addr << 1 | W/R`) is core to I2C**:
   anyone with embedded experience reads `fifo_tx 0xEC` and
   instantly knows "writing to slave 0x76". This is why we emit
   the raw byte and let the frontend decode rather than computing
   the addr in JSON — preserves audit trail.

## Implementación final

### `include/hw/i2c/esp32p4_i2c.h` (new, ~110 LoC)

- Constants: base addr, IO size, register offsets, op_code values.
- `ESP32P4I2cState`: scratch storage + event log + port_num.
- `esp32p4_i2c_self_test()` declaration.

### `hw/i2c/esp32p4_i2c.c` (new, ~190 LoC)

- `esp32p4_i2c_op_name()`: opcode → string lookup.
- `esp32p4_i2c_read()`: scratch reads; FIFO_DATA returns 0xFF.
- `esp32p4_i2c_write()`: scratch + side-effect dispatch on
  FIFO_DATA / CMD0..CMD7.
- `esp32p4_i2c_emit_event()`: throttled JSON emission.
- `esp32p4_i2c_self_test()`: synthesises 8-event "BMP280 read"
  sequence, bypassing throttle.
- Standard QOM realize/reset/class_init.

### `hw/i2c/meson.build`

Added `esp32p4_i2c.c` under `CONFIG_RISCV_ESP32P4`.

### `hw/riscv/Kconfig`

Added `select I2C` to `RISCV_ESP32P4` (pulls in I2C subsystem).

### `hw/riscv/esp32p4.c`

- Header include.
- `ESP32P4I2cState i2c0` field in machine state.
- Init block at 0x500D2000, port_num=0, calls self-test post-realize.
- Init log message updated to mention I2C0.

## Estado consolidado (post-2.AM)

| Hito                                                          | Estado |
|---------------------------------------------------------------|--------|
| GPIO + LEDC + ADC + TIMG + ISR chain                           | ✅ 2.W-AL|
| **I2C0 master peripheral skeleton + self-test**                | ✅ 2.AM|
| I2C synthetic slave responder                                  | ⏳ 2.AM.slave |
| I2C CPU IRQ wiring                                              | ⏳ 2.AM.irq |
| TIMG1 + watchdog                                                | ⏳ later|
| SPI master                                                       | ⏳ later|
| Real PWM waveform on GPIO                                      | ⏳ later|
| Real FreeRTOS port                                              | ⏳ Phase 2.V |

## 20-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.U-AB| GPIO output/input/IRQ, JSON event channel               |
| 2.AC-AF| LEDC PWM + multi-channel rainbow                       |
| 2.AD  | ADC peripheral                                          |
| 2.AG-AI| TIMG hardware timer + DIVIDER                          |
| 2.AH  | TIMG → CPU IRQ wiring                                   |
| 2.AJ-AK| Full attachInterrupt() chain (TIMG only)               |
| 2.AL  | Multi-source ISR (TIMG + GPIO)                          |
| **2.AM** | **I2C master skeleton (FIFO + CMD events)**           |

JSON stream now carries 7 event types: `start | pin | ledc | adc |
timg | timg_irq | i2c`. The frontend can render an "I2C bus tracer"
view alongside the existing GPIO/LEDC/ADC views.

## Próximas direcciones

- **Phase 2.AM.slave**: synthetic I2C slave responder. `VELXIO_I2C_SLAVE`
  env var maps slave addresses → register-value scripts. BMP280 returns
  realistic temperature/pressure data over time. Brings sensor demos
  to life.
- **Phase 2.AM.irq**: wire I2C transaction-end IRQ to a free CLIC cause
  (likely 21). Enables real Arduino `Wire.onReceive()` etc.
- **Phase 2.AN candidate**: SPI master (similar architecture — TX/RX FIFO
  + CMD register pattern). Opens display/SD demos.
- **TIMG1 + WDT**, real PWM, FreeRTOS — same as before.
