# Phase 1.H — TIMG (Timer Group) con WDT auto-disable

**Status:** ⏳ pending

## Goal

Implementar TIMG0/TIMG1 con: (1) general-purpose timers que pueden generar IRQs periódicas, (2) MWDT (machine watchdog) con secuencia unlock+disable que el bootloader hace al arrancar.

Sin esto, en silicon real el WDT mata el chip si la app no lo feedea — pero en QEMU si el firmware espera ver bits específicos en los regs de WDT (ej. después de un unlock, lee back para verificar), nuestro stub-zero falla.

## Acceptance criteria

- `bootloader_super_wdt_auto_feed` y los `wdt_hal_*` calls del IDF se completan sin trap.
- Counter de timer 0 en TIMG0 incrementa al ritmo apropiado.

## Direcciones

- TIMG0: 0x500C2000 (4 KB)
- TIMG1: 0x500C3000 (4 KB)
- LP_WDT: 0x50116000 (separado, ya tiene stub en 1.B)

## Estrategia

Clonar `hw/timer/esp32c3_timg.c` (756 LOC) → `esp32p4_timg.c`. C3 ya tiene WDT con unlock keys.

Mínimo para boot:
- Aceptar writes a `WDTWPROTECT` (unlock).
- Aceptar writes a `WDTCONFIG0` (disable when 0).
- Read-back retorna lo que se escribió.
- NO disparar reset jamás (basta para Phase 1).

Luego:
- General-purpose timer counter (T0/T1) que incrementa.

## Archivos a crear

- `hw/timer/esp32p4_timg.c`
- `include/hw/timer/esp32p4_timg.h`
- update `hw/timer/meson.build`
- update `hw/riscv/esp32p4.c` (reemplazar stubs `esp32p4.timg0/1` por instances reales)

## Notes

- WDT key del C3 es `0x50D83AA1`. Verificar si P4 cambia (TRM Cap 17).
- IRQ wiring se conecta cuando interrupt matrix esté lista (Phase 1.K).
