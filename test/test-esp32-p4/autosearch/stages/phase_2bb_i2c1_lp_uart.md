# Phase 2.BB — I2C1 + LP_UART instantiation

**Estado**: ✅ done — I2C1 (0x500C5000) and LP_UART (0x50121000)
instantiated as distinct instances of their existing device classes.
Each gets its own `port_num` for JSON disambiguation. Self-tests
fire on each at boot: I2C1 reads the BMP280 chip-id (same pattern
as I2C0 via the existing responder); LP_UART writes "L0" via
`address_space_write`.

Fills the last inventory gaps for the dual-instance peripherals:
**6 of 6 UARTs reachable** (UART0..4 + LP_UART), **2 of 2 I2C buses
reachable**. This phase doesn't add new event types — it adds
instances of existing peripherals at silicon-correct addresses.

Log proof (2026-05-08):

```
I2C1 (port=1) self-test events:
  {"t_ns":770373,"event":"i2c","port":1,"fifo_tx":236}   ← 0xEC = (0x76<<1) | 0 write addr
  {"t_ns":771030,"event":"i2c","port":1,"fifo_tx":208}   ← 0xD0 = BMP280 chip-id reg
  {"t_ns":771646,"event":"i2c","port":1,"cmd":"rstart",...}
  {"t_ns":772248,"event":"i2c","port":1,"cmd":"write","slot":1,"byte_num":2,...}
  {"t_ns":772809,"event":"i2c","port":1,"cmd":"rstart","slot":2,...}
  ... full 6-cmd transaction

LP_UART (port=5) self-test events:
  {"t_ns":892639,"event":"uart_tx","port":5,"byte":76,"count":1}  → 'L'
  {"t_ns":894618,"event":"uart_tx","port":5,"byte":48,"count":2}  → '0'
```

I2C events doubled (9 from I2C0 + 9 from I2C1 = 18 total); uart_tx
events grew from 28 to 30 (+2 from LP_UART "L0").

## Goal

ESP32-P4 has **2 I2C controllers** (I2C0 + I2C1) and **6 UART
controllers** (UART0..4 HP-side + 1 LP-side). Phases 2.AM/2.AW
established UART0 and I2C0; Phase 2.AZ added UART1..UART4. Two
inventory gaps remained:

1. **I2C1**: Arduino sketches use `Wire1` for buses that have
   address conflicts on Wire (e.g., two BMP280s at 0x76 and 0x77,
   or display + sensor sharing addresses).
2. **LP_UART**: Some IDF sleep-aware code paths route debug
   output through LP_UART because the HP UARTs are gated off in
   deep sleep. Also referenced by `esp_pm_*` lock managers.

Phase 2.BB fills both gaps with the multi-instance pattern proven
in 2.AZ — single QOM class, distinct state per instance,
disambiguated in JSON by `port_num`.

## Lo que SE INVESTIGÓ

### 1. I2C1 base address

Per IDF `components/soc/esp32p4/include/soc/reg_base.h`:
```c
#define DR_REG_I2C0_BASE  0x500C4000
#define DR_REG_I2C1_BASE  0x500C5000
```

Confirmed by the existing `create_unimplemented_device "esp32p4.i2c1"`
stub at exactly this address (line 927 of `esp32p4.c`). Our
overlay at priority 1 takes precedence.

### 2. LP_UART base address

Per IDF `reg_base.h`:
```c
#define DR_REG_LP_UART_BASE  0x50121000
```

Already an unimplemented_device stub. Our priority-1 overlay
replaces it.

### 3. Reusing existing device class for distinct instances

For both I2C1 and LP_UART, the existing `TYPE_ESP32P4_I2C` /
`TYPE_ESP32P4_UART` QOM class is reused. The class-level
indirection (BMP280 responder in I2C, parent_write/read wrappers
in UART) covers all instances automatically. Per-instance state:

- `event_log`, `boot_ns`, `port_num`, `tx_count`/`rx_count` for UART
- `event_log`, `boot_ns`, `port_num`, `tx_history`, `read_active` for I2C

This is Phase 2.AZ's pattern, now applied across two device
classes simultaneously.

### 4. I2C1 + BMP280 responder share storage

Each I2C instance has its own `tx_history` and `read_active` —
they're not shared between I2C0 and I2C1. So the same self-test
sequence (BMP280 chip-id read at slave 0x76) works independently
on each bus. Frontend can show two bus monitors with different
sensors attached to each.

### 5. LP_UART port_num = 5

UART0..UART4 are HP-side, port_num 0..4. LP_UART gets port_num=5
to keep the namespace contiguous and avoid future collision when
HP UARTs are extended (which won't happen — 5 HP UARTs is the
P4 cap — but 0..4 + 5 is the cleanest mapping).

### 6. Tested at scale

This is the second time the multi-instance class pattern has been
exercised:
- Phase 2.AZ: 1 → 5 UART instances
- Phase 2.BB: I2C 1 → 2 + UART 5 → 6 instances

Pattern scales linearly. No new code in the device classes
themselves — pure machine-init boilerplate.

## Lo que SÍ funcionó

Live test (2026-05-08):

**I2C1** — 9 events with port=1, mirroring the I2C0 self-test:
```
{"t_ns":770373,"event":"i2c","port":1,"fifo_tx":236}   ← 0xEC slave_addr+W
{"t_ns":771030,"event":"i2c","port":1,"fifo_tx":208}   ← 0xD0 BMP280 chip-id reg
{"t_ns":771646,"event":"i2c","port":1,"cmd":"rstart",...}
{"t_ns":772248,"event":"i2c","port":1,"cmd":"write","slot":1,"byte_num":2,...}
{"t_ns":772809,"event":"i2c","port":1,"cmd":"rstart","slot":2,...}
{"t_ns":773336,"event":"i2c","port":1,"cmd":"write","slot":3,"byte_num":1,...}
{"t_ns":773870,"event":"i2c","port":1,"cmd":"read","slot":4,"byte_num":1,...}
{"t_ns":774341,"event":"i2c","port":1,"cmd":"stop",...}
{"t_ns":774876,"event":"i2c_rx","port":1,"reg":208,"byte":88}  ← 0x58 BMP280 chip_id
```

Last line confirms the responder actually fired for I2C1 — `byte=88`
is `0x58`, the canonical BMP280 chip_id. Arduino `Adafruit_BMP280
.begin(0x76, &Wire1)` would now succeed.

**LP_UART** — 2 events with port=5:
```
{"t_ns":892639,"event":"uart_tx","port":5,"byte":76,"count":1}  → 'L'
{"t_ns":894618,"event":"uart_tx","port":5,"byte":48,"count":2}  → '0'
```

Count is per-instance: LP_UART's count starts at 1, not 31 (which
would happen if instances shared state).

**Cumulative session totals**:
- 30 uart_tx events (26 port=0 + 2 port=1 + 2 port=5)
- 18 i2c events (9 port=0 + 9 port=1)
- 2 i2c_rx events (1 port=0 + 1 port=1)

Build clean, no regression. Other peripheral event counts identical
to Phase 2.BA within timing variance.

## Lo que NO funcionó / decisiones tomadas

1. **No chardev for LP_UART**: same rationale as UART1..UART4 from
   2.AZ. Real silicon routes LP_UART to a dedicated pad pin via
   the LP IO MUX. Without modeling LP IO MUX, the bytes just
   appear in JSON and nowhere on host stdio. Acceptable.

2. **Self-test on I2C1 uses same slave address as I2C0 (0x76)**:
   real demos with two BMP280s would address them at 0x76 + 0x77,
   but the responder doesn't know about addresses (it just inspects
   the `reg` byte). For the self-test, using 0x76 for both means
   we exercise the SAME responder path — proves the I2C1 instance
   reaches its own responder state correctly. A future phase could
   add a 0x77-tagged BMP280 variant if needed.

3. **I2C1 doesn't have a different sensor**: could have used a
   different synthetic responder (e.g., MPU6050 at 0x68) to show
   the multi-bus / multi-sensor pattern. Deferred — the goal here
   is INSTANCE PROOF, not sensor diversity. Future phase 2.BB.x:
   add second responder class.

4. **No CPU IRQ wiring for I2C1 / LP_UART**: same as their primary
   siblings (I2C0 / UART0..4) — IRQ wiring is a separate phase
   when needed.

5. **Could have bundled into 2.AZ**: I2C1 + LP_UART naturally
   belong with 2.AZ's multi-UART work. But splitting into 2.BB
   gives clear commit boundaries — 2.AZ proves the architectural
   pattern, 2.BB applies it across two more peripherals. Easier to
   bisect if anything breaks.

## Lessons learned

1. **Multi-instance pattern is now load-tested**: 6 UART instances
   + 2 I2C instances all sharing class-level state correctly. No
   cross-instance leaks observed.

2. **`port_num` is now an unambiguous frontend disambiguator**:
   UART events range 0..5, I2C events range 0..1. Frontend can
   render N independent monitors keyed on `(event, port)`.

3. **Self-test boilerplate has stabilized**: the pattern is now
   ~5 lines:
   - `object_initialize_child`
   - `sysbus_realize`
   - `memory_region_add_subregion_overlap` at priority 1
   - Wire `event_log`, `boot_ns`, `port_num`
   - Call `_self_test()` or direct `address_space_write`
   
   Adding the next instance (say, SPI3) is now a 10-minute
   exercise.

4. **The unimplemented_device stubs are good fallback**: I2C1 and
   LP_UART both had stubs at their addresses before this phase.
   Replacing a stub with a real device is a priority-1 overlay
   — the stub stays in place but our device wins reads/writes.
   No need to delete stubs explicitly.

## Implementación final

### `hw/riscv/esp32p4.c`

- Added `ESP32P4I2cState i2c1;` and `ESP32P4UARTState lp_uart;` to
  `ESP32P4State`.
- New I2C1 init block after I2C0:
  - Initialize, realize, overlay at `0x500C5000` priority 1
  - Wire event_log, port_num=1
  - Fire `esp32p4_i2c_self_test(&ms->i2c1, 0x76)`
- New LP_UART init block after I2C1:
  - Initialize, realize, overlay at `0x50121000` priority 1
  - No chardev
  - Wire event_log, port_num=5
  - Self-test: write 'L', '0' via `address_space_write` to LP_UART_BASE

### No header / device-class changes

The existing `TYPE_ESP32P4_I2C` and `TYPE_ESP32P4_UART` types
already accept multiple instances — exercised in 2.AZ. This phase
just adds machine-init code.

## Estado consolidado (post-2.BB)

**Bus controller inventory:**

| Port  | Type | Base       | Phase | JSON port_num |
|-------|------|------------|-------|---------------|
| UART0 | UART | 0x500CA000 | 1.A   | 0 |
| UART1 | UART | 0x500CB000 | 2.AZ  | 1 |
| UART2 | UART | 0x500CC000 | 2.AZ  | 2 |
| UART3 | UART | 0x500CD000 | 2.AZ  | 3 |
| UART4 | UART | 0x500CE000 | 2.AZ  | 4 |
| LP_UART | UART | 0x50121000 | 2.BB | 5 |
| I2C0 | I2C | 0x500C4000  | 2.AM  | 0 |
| I2C1 | I2C | 0x500C5000  | 2.BB  | 1 |
| SPI2 | SPI | 0x500D0000  | 2.AO  | (single) |

All P4 UARTs reachable (6/6); both I2C buses reachable (2/2).

JSON event types: 18 (unchanged — instances, not types).

## 36-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.AW-AX | UART0 bidirectional JSON tracking                      |
| 2.AY  | RMT (WS2812 NeoPixel) skeleton                           |
| 2.AZ  | Multi-UART (UART1..UART4)                                |
| 2.BA  | TWAI (CAN bus) skeleton                                  |
| **2.BB** | **I2C1 + LP_UART — bus controller inventory complete** |

## Próximas direcciones

- **2.BA.rx**: synthetic CAN responder — return preprogrammed
  frames to validate Arduino reception demos.
- **TWAI1 + TWAI2** instantiation — mirror this phase's pattern
  for the remaining CAN controllers.
- **WDT actual reset action** — close out watchdog chain.
- **Real PWM waveform on GPIO** via LEDC.
- **2.BB.lp-chardev**: wire LP_UART to a `-chardev file` so its
  output goes somewhere visible on the host (currently JSON-only).
- **FreeRTOS real port** (Phase 2.V deferred).
