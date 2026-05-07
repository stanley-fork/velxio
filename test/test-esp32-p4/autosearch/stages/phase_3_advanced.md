# Phase 3 — Peripherals avanzados

**Status:** ⏳ pending

## Goal

Soportar lo que el ecosistema Arduino/IDF realmente usa más allá de blink: I2C masters, SPI masters, LEDC PWM, ADC, RMT, USB Serial/JTAG.

## Sub-tasks (priorizado por uso típico Arduino)

### LEDC (LED PWM Controller)
- 8 canales, 14-bit resolution.
- TRM Cap 55, base 0x500D3000.
- Reusable: `hw/misc/esp32_ledc.c` y `esp32c3_ledc.c` (mismo IP block).

### I2C master
- 2 ports.
- TRM Cap 44, base 0x500C4000 / 0x500C5000.
- Reusable: `hw/i2c/esp32_i2c.c`.

### SPI master (general-purpose, no flash)
- GP-SPI2, GP-SPI3.
- TRM Cap 43, base 0x500D0000 / 0x500D1000.
- Diferente del SPI flash controller (Phase 1.F).

### ADC
- Continuous + one-shot modes.
- TRM Cap 62, base 0x500DE000.
- Reusable: `hw/misc/esp32c3_saradc.c` (con extensiones del fork — ADC waveform support).

### RMT (Remote Control / NeoPixel)
- 4 channels.
- TRM Cap 57, base 0x500A2000.
- Reusable: `hw/ssi/esp32_rmt.c`.

### USB Serial/JTAG
- TRM Cap 51, base 0x500D2000.
- Arduino default Serial usa esto cuando `CDCOnBoot=cdc` (en lugar de UART0).
- Importante para que Serial Monitor de Velxio funcione si el sketch declara CDC.

## Notes

- Mucho del trabajo es clonar+rename del C3. Los IP blocks del P4 son evoluciones del S3/C6, raramente del C3 directo. Validar register layout cuidadosamente con TRM antes de clonar.
- Cada peripheral necesita su `qemu_irq` connected a la INTMTX (Phase 1.K).
