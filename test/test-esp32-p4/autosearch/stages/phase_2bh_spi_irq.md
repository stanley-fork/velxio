# Phase 2.BH — SPI2 IRQ wiring

**Estado**: ✅ done — third backport of the IRQ template (after
TWAI 2.BF and I2C 2.BG). SPI2 USR transaction completion now sets
`INT_RAW.TRANS_DONE` (bit 0) and fires CLIC cause line 24. Arduino
interrupt-driven SPI sketches (`SPI.beginTransaction()` with
async callbacks, TFT_eSPI DMA-completion handlers) now work.

Live test (2026-05-08), 2 `spi_irq` events at boot:
```json
{"t_ns":1196686,"event":"spi_irq","port":2,"level":1}   ← USR txn done → IRQ raise
{"t_ns":1198348,"event":"spi_irq","port":2,"level":0}   ← INT_CLR ack  → IRQ clear
```

Stderr:
```
[esp32p4.spi2] CPU IRQ line -> 1 (int_raw=0x1 int_ena=0x1)
[esp32p4.spi2] CPU IRQ line -> 0 (int_raw=0x0 int_ena=0x1)
```

`int_raw=0x1` = `TRANS_DONE` bit. JSON event types now **22**.

## Goal

Phase 2.AO/2.AU established SPI2 with USR-trigger event emission
+ synthetic ILI9341 responder. The remaining gap was CPU IRQ
delivery — Arduino sketches using interrupt-driven SPI (DMA
transactions with `SPI.endTransaction()` callbacks, TFT_eSPI's
push functions in async mode) hung waiting for the completion
signal.

Phase 2.BH closes that gap. Pattern is identical to 2.BG (W1TC
INT_CLR, recompute on INT_ENA write), differing only in:
- Different register offsets (TRM 36 vs 35)
- Different INT bit (TRANS_DONE bit 0 vs END_DETECT|TRANS_COMPLETE)
- Different CLIC cause line (24 vs 22/23)

## Lo que SE INVESTIGÓ

### 1. SPI INT_RAW register bits (TRM 35.4)

Real ESP32 SPI lists ~20 interrupt bits including SLAVE / DMA /
parity / etc. For the master skeleton the canonical bit is:

- **bit 0: TRANS_DONE** — set when a USR transaction completes.

Other bits (SLV_RD/WR_BUF, MST_RX_AFIFO_WFULL, etc.) stay zero —
they're slave-mode or DMA-specific.

### 2. INT_CLR is W1TC (same as I2C, different from TWAI)

SPI uses the modern W1TC pattern (write 1-bits to clear), matching
I2C's INT_CLR behavior from Phase 2.BG. TWAI's clear-on-read INTR
is the SJA1000 legacy outlier.

### 3. Wiring point: end of fire_transaction()

The existing `esp32p4_spi_fire_transaction()` already runs at the
end of every USR-triggered CMD write. Adding the IRQ raise is two
lines: set `INT_RAW.TRANS_DONE`, call `update_irq`.

### 4. CLIC cause line allocation

After this phase:
- 17 SYSTIMER, 18 GPIO, 19 TIMG0, 20 TIMG1, 21 TWAI0, 22 I2C0,
  23 I2C1, **24 SPI2** (new). Free: 25 onwards (UART, RMT, ADC).

### 5. Self-test ack pattern

Mirror of 2.BG: write INT_ENA at the start (enable TRANS_DONE),
fire the existing USR transaction, then write INT_CLR to ack
the IRQ. This produces the 2-event raise/clear sequence at boot.

## Lo que SÍ funcionó

Live test (2026-05-08):
```
[esp32p4.spi2] CPU IRQ line -> 1 (int_raw=0x1 int_ena=0x1)
[esp32p4.spi2] CPU IRQ line -> 0 (int_raw=0x0 int_ena=0x1)
```

JSON: 2 `spi_irq` events with port=2 (SPI2). Build clean,
regression-clean.

Backport pattern productivity: SPI IRQ took **~50 lines of code +
~20 minutes of editing**. Compare to Phase 2.BF (TWAI IRQ) which
was a ~200-line + multi-hour effort designing the template from
scratch. The template-recipe approach pays off geometrically as
peripherals are added.

## Lo que NO funcionó / decisiones tomadas

1. **Only TRANS_DONE modeled**: SPI has many more interrupt bits
   (DMA done, RX/TX FIFO, parity error). All stay zero. Most
   Arduino SPI sketches only wait on TRANS_DONE; deeper coverage
   deferred to `2.BH.dma`.

2. **No SPI3 IRQ (no SPI3 instance yet)**: SPI3 hasn't been
   instantiated. If/when it is, gets cause 25.

## Implementación final

### `include/hw/ssi/esp32p4_spi.h`

- INT_RAW/CLR/ENA/ST register offsets (0xA0/A4/A8/AC).
- TRANS_DONE bit define.
- `intr_out` + `irq_level` fields on state.

### `hw/ssi/esp32p4_spi.c`

- `esp32p4_spi_update_irq()` helper (mirror of I2C/TWAI).
- INT_CLR W1TC handler in write op.
- INT_ENA write triggers update_irq.
- `fire_transaction()` sets INT_RAW.TRANS_DONE + update_irq.
- `realize`: gpio_out registration.
- `reset`: drop IRQ line.
- `self_test`: enable INT_ENA at start, ack via INT_CLR at end.

### `hw/riscv/esp32p4.c`

- SPI2 init block: connect intr_out to CLIC cause 24.

## Estado consolidado (post-2.BH)

CLIC cause map:

| Cause | Peripheral | Phase |
|-------|------------|-------|
| 17-20 | SYSTIMER/GPIO/TIMG0/TIMG1 | various |
| 21 | TWAI0 | 2.BF |
| 22 | I2C0 | 2.BG |
| 23 | I2C1 | 2.BG |
| **24** | **SPI2** | **2.BH** |
| 25+ | unallocated | — |

Peripherals with data + IRQ:
- TIMG, GPIO, TWAI, I2C × 2, **SPI2** (new). LEDC, ADC, UART,
  RMT remain TBD.

JSON event types: **22** (added `spi_irq`).

## Próximas direcciones

- UART IRQ wiring (cause 25, RX_FIFO_FULL / TX_DONE).
- RMT IRQ wiring (cause 26, TX_END / RX_END).
- ADC IRQ wiring (cause 27, sample done).
- WDT actual reset action.
- Real PWM waveform on GPIO via LEDC.
- BH1750/SHT31/CCS811 sensor adds.
- FreeRTOS scheduler resurrection.
