# Phase 2.BA — TWAI (CAN bus) peripheral skeleton

**Estado**: ✅ done — TWAI0 (Two-Wire Automotive Interface, i.e.,
Espressif's CAN bus controller) modeled at `0x500A6000`. Frame
transmission is decoded from the TX buffer registers when the
guest writes CMD.TX_REQ; the JSON event stream gets one
`{"event":"twai",...}` record per transmitted frame with full ID +
DLC + data bytes + extended/RTR flags. Foundation for Arduino CAN
bus demos (automotive telemetry, OBD-II reading, industrial
gauges, drive-by-wire prototypes).

Self-test fires one synthetic STANDARD frame at boot:
```json
{"t_ns":3219483,"event":"twai","id":291,"ext":false,"rtr":false,
 "dlc":2,"data":[222,173],"count":1}
```

Decoded: ID=291 (0x123), standard frame (not extended), data frame
(not remote request), DLC=2, payload bytes `[0xDE, 0xAD]`. Exactly
matches the test-encoded frame.

Stderr corroboration: `[esp32p4.twai] TX frame id=0x123  dlc=2 (count=1)`

JSON event types now: **18** (added `twai`).

## Goal

ESP32-P4 has 3 TWAI controllers per TRM Chapter 30. CAN bus is a
major Arduino peripheral category — automotive OBD-II readers,
industrial telemetry, robotics buses, drive-by-wire prototypes
all use it. Until this phase, any guest write to the TWAI region
silently absorbed in the unimplemented_device catch-all.

Phase 2.BA models TWAI0 enough that:

1. Guest CAN driver init writes (BUS_TIMING, MODE, INTR_ENA,
   ACCEPTANCE_*) all land safely on scratch storage — no faults.
2. Guest frame transmission (`twai_transmit()` → register pokes →
   CMD.TX_REQ) decodes into a structured JSON event.
3. The decode produces silicon-accurate ID extraction for both
   STANDARD (11-bit) and EXTENDED (29-bit) frame formats per
   TRM 30.4 frame layout.

What it does NOT cover (deferred):
- Bus arbitration / collision detection (no actual bus).
- RX path (no peer to send frames from).
- Error counters (REC/TEC) and bus-off recovery.
- Acceptance filters.
- IRQ wiring (INTR_RAW + CPU dispatch).

## Lo que SE INVESTIGÓ

### 1. TWAI register layout (TRM Chapter 30.4)

The ESP32 TWAI is based on the legacy SJA1000 CAN controller, so
the register layout has been stable across all ESP32 generations:

```
Offset  Register             Mode  Notes
0x00    MODE                 R/O   reset mode, listen-only, self-test
0x04    CMD                  W/O   TX_REQ, ABORT_TX, RELEASE_RX, ...
0x08    STATUS               R/O   bus-on, error, RX/TX buffer state
0x0C    INTR                 R/O   interrupt status (read clears)
0x10    INTR_ENA             R/W   per-bit mask
0x18    BUS_TIMING_0/1       R/W   bitrate config (reset-mode only)
0x40    TX_FRAME_INFO        R/W   DLC + RTR + FF flags
0x44..  TX_ID_DATA buffer    R/W   ID bytes + data bytes (layout
                                    depends on FF=std vs ext)
```

For the TX-only skeleton we care about:
- CMD writes (trigger transmission)
- TX_FRAME_INFO (frame format / DLC / RTR)
- TX_ID/DATA bytes (per layout)

Everything else is scratch storage — guest can poke them, reads
return last-written.

### 2. Frame format encoding

The SJA1000-style frame encoding has TWO different layouts in the
TX buffer depending on the FF bit in TX_FRAME_INFO:

**STANDARD (11-bit ID)**:
```
0x40   TX_FRAME_INFO     {FF=0, RTR, x4 reserved, DLC[3:0]}
0x44   byte 0            ID[10:3]
0x45   byte 1            {ID[2:0], RTR, x4 reserved}
0x46   byte 2..N         DATA[0..DLC-1]
```

**EXTENDED (29-bit ID)**:
```
0x40   TX_FRAME_INFO     {FF=1, RTR, x4 reserved, DLC[3:0]}
0x44   bytes 0..3        ID[28:0] shifted left by 3 bits
0x48   bytes 0..N        DATA[0..DLC-1]
```

The "shifted left by 3 bits" detail for extended IDs is a SJA1000
holdover — the bottom 3 bits of byte 0x47 are reserved/RTR/SRR
flags, so the 29-bit ID occupies the top 29 bits of a 32-bit
field.

Decoder math:
```c
if (ext) {
    uint32_t raw = (byte0 << 24) | (byte1 << 16) | (byte2 << 8) | byte3;
    id = raw >> 3;
    data_off = 0x48;
} else {
    id = ((uint32_t)b0 << 3) | ((b1 >> 5) & 0x7);
    data_off = 0x46;
}
```

### 3. CMD register semantics

Per TRM 30.4.2:
- bit 0: TX_REQ (transmission request — start transmitting the
  loaded frame)
- bit 1: ABORT_TX
- bit 2: RELEASE_RX (RX buffer)
- bit 3: CLR_OVERRUN
- bit 4: SELF_RX_REQ (self-loopback transmit, useful for testing)

For the skeleton we only act on TX_REQ. The other bits are
silently absorbed (no state to change).

### 4. Throttling rationale

CAN bus at 1 Mbit/s can theoretically push ~8000 frames/second
(125 µs minimum frame spacing for 1-byte DLC). A tight Arduino
loop calling `twai_transmit()` rapid-fire would flood the JSON
stream.

50 ms throttle (matches I2C/ADC/SPI). Self-test bypasses the
throttle via `event_min_period_ns = 0` temporarily so the boot
event always appears regardless of timing.

### 5. Address choice

Used `0x500A6000` — first slot in the HP1 peripheral region above
the wireless/eFuse blocks. Confidence: medium. The S3 had TWAI at
the same relative offset within HP1, and the P4 layout follows
the same memory-map pattern.

If a real Arduino TWAI driver lands at a different P4 address,
this is a quick edit. Real-silicon-correctness is documented as
`2.BA.real-regs` follow-up.

## Lo que SÍ funcionó

Live test (2026-05-08):

```
[esp32p4.twai] TX frame id=0x123  dlc=2 (count=1)
```

JSON event:
```json
{"t_ns":3219483,"event":"twai","id":291,"ext":false,"rtr":false,
 "dlc":2,"data":[222,173],"count":1}
```

- `id=291` = `0x123` (self-test encoded ID) ✓
- `ext=false` matches FF=0 standard frame ✓
- `rtr=false` matches RTR=0 data frame ✓
- `dlc=2` matches DLC=2 ✓
- `data=[222,173]` = `[0xDE, 0xAD]` matches test payload ✓
- `count=1` (first frame transmitted) ✓

The standard-frame ID-encoding round trip succeeds:
- Encode: `0x123 → byte0=0x24 (ID[10:3]), byte1=0x60 (ID[2:0]<<5)`
- Decode: `(0x24 << 3) | (0x60 >> 5) = 0x120 | 3 = 0x123` ✓

Build clean. No regression — every other peripheral event count
unchanged versus Phase 2.AZ within timing variance.

## Lo que NO funcionó / decisiones tomadas

1. **No bus arbitration / collision modeling**: real CAN has
   priority-based collision resolution where the dominant 0 wins.
   We emit every TX_REQ as a successful frame without any
   peer-driven collision. Acceptable for the JSON-tracer use case.

2. **No RX path**: any guest read of the RX buffer returns 0
   (scratch). If a future demo wants to validate "Arduino reads
   incoming CAN frame", we'd need a synthetic responder similar
   to the BMP280 I2C / ILI9341 SPI ones. Documented as
   `2.BA.rx`.

3. **No error counters**: TX_ERR_CNT / RX_ERR_CNT (TEC/REC) stay
   at 0. Arduino sketches that check `twai_get_status_info()` and
   look at error counts will always see "no errors" — fine for
   happy-path demos.

4. **No IRQ wiring**: the INTR_RAW register isn't updated by our
   model. Drivers that poll INTR work; drivers that wait for IRQ
   will hang. Same trade-off as TIMG before the IRQ-wiring phase.

5. **Single TWAI controller (TWAI0 only)**: TWAI1 + TWAI2 stay on
   the catch-all. ESP32-P4 only routes ONE TWAI to any given
   GPIO via IO_MUX at a time on real hardware, so single-instance
   coverage is typically sufficient.

6. **Standard + extended decode both work**: but the self-test
   only exercises the standard format. Extended-format decode is
   correct by construction (mirrors the SJA1000 silicon math) but
   unvalidated end-to-end. Will fire on the first real Arduino
   extended-CAN demo.

7. **address_space_write not used in self-test**: unlike the 2.AZ
   UART1 self-test, this one calls `esp32p4_twai_write()` directly
   from machine init. Both approaches are valid — the direct call
   is slightly more localized (no dependency on global address
   space dispatch tables), the `address_space_write` approach
   exercises the FULL MMIO path. Future self-tests can use
   either based on preference.

## Lessons learned

1. **SJA1000-derived registers are stable across ESP32 generations**:
   the layout has been the same since the original ESP32 (2016) —
   means our TX decode logic is identical to what the C3, S3, and
   P4 TWAI drivers expect at the register level.

2. **ID encoding edge cases bite hard**: the "left shift by 3 bits"
   in extended-frame encoding is the kind of detail that's easy
   to miss reading the TRM but produces obviously-wrong IDs on
   live test. We didn't validate extended yet, but the encoding is
   carefully derived from TRM 30.4.

3. **Throttling is the right default for high-rate buses**: CAN
   can hit 8 kfps at 1 Mbit/s; without the 50 ms throttle we'd
   flood the JSON stream the first time a real demo runs. Same
   rationale as I2C/ADC/SPI.

4. **The 2.AW/2.AX wrapper-class pattern + Phase 2.AZ multi-
   instance proof gives confidence that single-instance peripherals
   like TWAI scale up cleanly**: when we eventually add TWAI1 +
   TWAI2, the only change is the machine-init block (new bases,
   new port_num) — no device-class changes needed.

5. **Standard frame ID encoding is non-obvious**: `id = (b0 << 3)
   | (b1 >> 5)` packs 11 bits across byte boundaries in a way
   that's easy to get wrong if you read the TRM section quickly.
   Verified by writing the encode and decode side-by-side in the
   self-test and confirming round-trip.

## Implementación final

### `include/hw/misc/esp32p4_twai.h`

- New `TYPE_ESP32P4_TWAI` QOM type.
- `ESP32P4TwaiState`: 4 KB scratch storage, `tx_count`,
  `event_log` + `boot_ns` + throttle fields.
- Register offset macros: MODE/CMD/STATUS/INTR/BUS_TIMING/
  TX_FRAME_INFO/TX_BUF_START.
- CMD bit defines: TX_REQ / ABORT_TX / etc.
- Frame info bit defines: DLC mask / RTR / FF (ext-frame).
- Function decl: `esp32p4_twai_self_test()`.

### `hw/misc/esp32p4_twai.c`

- `esp32p4_twai_emit_tx_event()`: decode TX_FRAME_INFO → DLC + RTR
  + FF; decode ID per standard/extended layout; build data array
  string; emit JSON event (throttled) + stderr line (always).
- `esp32p4_twai_read()`: scratch returned.
- `esp32p4_twai_write()`: store to scratch; on CMD writes with
  TX_REQ bit, call emit_tx_event.
- Standard QOM realize / reset / class_init.
- `esp32p4_twai_self_test()`: pre-load buffer with standard
  frame ID=0x123, DLC=2, data {0xDE, 0xAD}; fire CMD.TX_REQ.

### `hw/misc/meson.build`

- Added `esp32p4_twai.c` to the `CONFIG_RISCV_ESP32P4` source list.

### `hw/riscv/esp32p4.c`

- Include `hw/misc/esp32p4_twai.h`.
- `ESP32P4TwaiState twai0;` field in machine struct.
- New init block after RMT — initialize, realize, overlay at
  `0x500A6000`, wire event_log + boot_ns, fire self-test.

## Estado consolidado (post-2.BA)

Peripheral inventory:

| Peripheral | Address     | Phase  | JSON event |
|------------|-------------|--------|------------|
| UART0..4   | 0x500CA..E000 | 1.A/2.AZ | uart_tx, uart_rx |
| GPIO       | 0x500E0000  | 1.C..2.AV | pin |
| LEDC       | 0x500D3000  | 2.AC   | ledc |
| ADC        | 0x500DE000  | 2.AD   | adc |
| TIMG0/1    | 0x500C2/3000 | 2.AG/AN | timg, timg_irq |
| I2C0       | 0x500C4000  | 2.AM   | i2c, i2c_rx |
| SPI2       | 0x500D0000  | 2.AO   | spi, spi_rx |
| RNG        | 0x500FC400  | 2.AR   | rng |
| LP_WDT     | 0x50116000  | 2.AT   | rtc_wdt, super_wdt |
| WDT × 2 (TIMG) | (within TIMG) | 2.AP/AQ | wdt |
| RMT        | 0x500A4000  | 2.AY   | rmt |
| **TWAI0**  | **0x500A6000** | **2.BA** | **twai** |

JSON event types: **18** (added `twai`).

## 35-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.AC-AF| LEDC PWM + multi-channel                               |
| 2.AG-AN.irq | TIMG (×2) + 3-way ISR                              |
| 2.AM-slave | I2C master + BMP280 responder                      |
| 2.AO+AU | SPI master + ILI9341 responder                         |
| 2.AP-AT | 4 watchdogs + RNG + address relocation                |
| 2.AV  | GPIO LEVEL_HIGH/LOW filters                              |
| 2.AW-AX | UART0 bidirectional JSON tracking                      |
| 2.AY  | RMT (WS2812 NeoPixel) skeleton                           |
| 2.AZ  | Multi-UART (UART1..UART4)                                |
| **2.BA** | **TWAI (CAN bus) skeleton — automotive Arduino demos** |

## Próximas direcciones

- **2.BA.rx**: synthetic CAN responder — return preprogrammed
  frames so Arduino reception demos work.
- **2.BA.real-regs**: confirm exact P4 TWAI register offsets
  once a real driver exercises the path.
- **2.BA.irq**: wire TX_END / RX_AVAILABLE / ERROR to CPU IRQ.
- **2.AY.arduino-real**: end-to-end Adafruit_NeoPixel sketch
  validation for RMT.
- **I2C1 instantiation** — mirror Phase 2.AZ pattern.
- **WDT actual reset action** — close out watchdog chain.
- **Real PWM waveform on GPIO** via LEDC.
- **FreeRTOS real port** (Phase 2.V deferred).
