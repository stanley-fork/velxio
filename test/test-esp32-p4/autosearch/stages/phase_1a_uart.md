# Phase 1.A — UART0 real + `-bios` loader

**Status:** ✅ done — commit `24e67a8852`

## Goal

`Serial.println()` desde firmware RV32I hand-rolled aparece en stdout. Validar el pipeline completo: instrucción RISC-V → SW al MMIO UART0 → chardev backend → host stdout.

## Acceptance criteria

```
$ qemu-system-riscv32 -M esp32p4 -bios uart_test.bin -nographic
[esp32p4] loaded 32 bytes of BIOS '/tmp/uart_test.bin' at 0x4fc00000
[esp32p4] machine init complete (UART0 wired)
Hi
```

## Archivos tocados

- `hw/char/esp32p4_uart.c` (35 LOC) — TYPE_ESP32P4_UART subclase de TYPE_ESP32C3_UART
- `include/hw/char/esp32p4_uart.h` (45 LOC) — base addresses (UART0..4 + LP_UART)
- `hw/char/meson.build` — agregar al CONFIG_RISCV_ESP32P4
- `hw/riscv/esp32p4.c` — instanciar UART0, agregar `-bios FILE` loader

## Direcciones (TRM §7.3.5)

| Peripheral | Base |
|---|---|
| UART0 | 0x500CA000 |
| UART1 | 0x500CB000 |
| UART2 | 0x500CC000 |
| UART3 | 0x500CD000 |
| UART4 | 0x500CE000 |
| LP_UART | 0x50121000 |

Solo UART0 instanciado real (Arduino default Serial). UART1-4 + LP_UART caen en stubs (Phase 1.B).

## Notes

- ESP32-P4 UART block es register-compatible con ESP32-C3, así que el subclass es trivial (sin override de read/write).
- IRQ wiring NO conectado todavía — falta interrupt matrix (Phase 1.K).
- `-bios FILE` carga blob raw en HP ROM offset 0; usado para tests hand-rolled.
- Test program: `gen_uart_test.py` → 8 instrucciones RV32I que escriben "Hi\n" al FIFO 0x500CA000.
