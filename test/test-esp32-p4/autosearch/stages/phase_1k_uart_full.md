# Phase 1.K — UART real-completo (IRQ wiring) + Interrupt Matrix

**Status:** ⏳ pending

## Goal

Wiring completo de IRQs entre peripherals → interrupt matrix → CPU. Phase 1.A instanció UART0 pero no conectó la IRQ line — `Serial.println` con FIFO empty IRQ no funciona, ni `Serial.read()` sobre interrupciones.

## Acceptance criteria

- UART RX desde stdin del host genera una IRQ que el IDF runtime maneja.
- Serial Monitor de Velxio puede escribir Y leer.
- TIMG/SYSTIMER IRQs se rutean al CPU para que FreeRTOS tick funcione.

## Estrategia

Implementar mínimamente la INTMTX (peripheral en `0x500D6000`) que routea ~80 source lines a las inputs CLIC del CPU.

Reusable del C3:
- `hw/riscv/esp32c3_intmatrix.c` (426 LOC) — pattern de routing.

P4 differences:
- P4 usa CLIC además de intmtx; las interrupts pasan por intmtx → CLIC inputs → CPU.
- En CLIC mode, el CPU lee `mtvt` para vector dispatch.

## Archivos

- `hw/riscv/esp32p4_intmatrix.c` (clonado del C3, ajustar source count + base)
- `include/hw/riscv/esp32p4_intmatrix.h`
- update `hw/riscv/esp32p4.c`:
  - reemplazar stub `intmtx`
  - conectar `uart0` IRQ → intmtx source 67 (UART0_INTR_SOURCE)
  - conectar `systimer` IRQs → intmtx
  - conectar `timg` IRQs → intmtx
  - conectar intmtx outputs a CPU's input IRQ lines (named `ESP_CPU_IRQ_LINES_NAME`)

## Notes

- Para UART RX desde stdin: el chardev backend ya está conectado en Phase 1.A. Falta nomás que el RX FIFO IRQ se levante cuando llega un byte.
- CLIC vs PLIC: en CLIC mode el CPU usa `mtvt` (que ya aceptamos como CSR scratch en Phase 1.E). Si las IRQs no llegan, primero verificar que `mtvec` está set + en modo CLIC (3) + que `mintstatus` permite el priority level.
