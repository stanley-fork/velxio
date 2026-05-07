# Phase 5 — LP Core + USB Serial/JTAG completo

**Status:** ⏳ later

## Goal

Soporte para el Low-Power core del P4 (RISC-V single-core @ 40 MHz) + USB Serial/JTAG controller real (no stub). Ambas son features avanzadas que llegan después de Phase 4.

## LP Core

ESP32-P4 tiene un LP core RV32 que puede correr código mientras el HP core duerme. ESP-IDF lo expone vía `ulp_riscv_run()`.

### Implementation

- Segundo `EspRISCVCPU` con `mc->max_cpus = 2` (o 3 contando ambos HP cores + 1 LP).
- LP CPU mapea a LP ROM (0x50100000) y LP SRAM (0x50108000).
- Wake-up via "LP core start" register en LP_AON_CLKRST.
- Inter-core sync via LP Mailbox (0x50118000).

### Acceptance

- `ulp_riscv_run()` llamado desde HP core arranca LP core.
- LP core ejecuta código y comunica vía LP SRAM con HP.

## USB Serial/JTAG

Los Arduino sketches que usan `CDCOnBoot=cdc` envían `Serial.println` por USB-CDC, no por UART0. Necesitamos el USB Serial/JTAG controller para que se vean esos.

### Implementation

- Reusable: `hw/misc/esp32c3_jtag.c` del C3 (aunque P4 puede tener cambios; verificar TRM Cap 51).
- Bridge a chardev del host como UART0 actual.

### Notes

- USB OTG HS / FS completos (Cap 49-50) están out-of-scope. Solo el Serial/JTAG simple.
