# Phase 1.B — 22 named peripheral stubs

**Status:** ✅ done — commit `c976734cc2`

## Goal

Reemplazar las regiones catch-all genéricas con stubs nombrados (uno por peripheral del TRM §7.3.5) usando `create_unimplemented_device()`. Ventaja: mejor logging y `info mtree` muestra cada peripheral por nombre.

## Acceptance criteria

- `info mtree` lista las 22 regiones `esp32p4.<name>`.
- Un programa que toca SYSTIMER read + GPIO write no crashea (vs antes era `Invalid write` log).

## Archivos tocados

- `hw/riscv/esp32p4.c` — 22 calls a `create_unimplemented_device()` después del UART.

## Stubs registrados

**HP peripherals (0x500_xxxx):**
timg0, timg1, i2c0, i2c1, gpspi2, gpspi3, usb_serial_jtag, ledc, intmtx, adc, gpio_matrix, io_mux, systimer, hp_sysreg, reset_clock

**LP peripherals (0x501_xxxx):**
lp_sysreg, lp_aon_clkrst, lp_timer, pmu, lp_wdt, lp_uart, lp_efuse

## Notes

- En Phase 1.C (siguiente), 3 de estos (gpio_matrix, systimer, lp_efuse) se reemplazan por implementaciones reales.
- Algunos stubs van a desaparecer cuando agregue impl real: timg* (1.H), hp_sysreg (1.I), io_mux (parte de 1.K).
- Los stubs son "free" — `create_unimplemented_device()` está en QEMU upstream y solo agrega una `MemoryRegion` con read=0/write-log por nombre.
