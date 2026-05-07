# Phase 1.C — eFuse + SYSTIMER + GPIO reales

**Status:** ✅ done — commit `b9abf3712a`

## Goal

Reemplazar 3 stubs por sysbus devices reales con backing state, capaces de responder a reads/writes con valores semánticamente correctos. Cubrir lo que la app Arduino mínima va a tocar: chip ID/MAC, contador para `delay()`, pin state para `digitalWrite()`.

## Acceptance criteria

138 instrucciones RV32I hand-rolled validan los 3:

```
$ qemu-system-riscv32 -M esp32p4 -bios full_test.bin -nographic
M==>:=;>7<                            ← MAC = 0xDEADBE7C ✓
T=O                                   ← SYSTIMER avanza entre lecturas ✓
G1[esp32p4.gpio] pin 2 -> 1            ← W1TS bit 2 ✓
G0[esp32p4.gpio] pin 2 -> 0            ← W1TC bit 2 ✓
DONE
```

## Archivos creados

| Peripheral | .c | .h | LOC | Base |
|---|---|---|---|---|
| eFuse | `hw/nvram/esp32p4_efuse.c` | `include/hw/nvram/esp32p4_efuse.h` | ~95 | 0x5012D000 |
| SYSTIMER | `hw/timer/esp32p4_systimer.c` | `include/hw/timer/esp32p4_systimer.h` | ~105 | 0x500E2000 |
| GPIO Matrix | `hw/gpio/esp32p4_gpio.c` | `include/hw/gpio/esp32p4_gpio.h` | ~110 | 0x500E0000 |

Plus updates en los respectivos `meson.build`.

## Decisiones implementación

- **eFuse**: MAC fijo `0xDEADBE7C` / `0x0000A1DF` en regs `0x44`/`0x48`, resto de RD area = 0. Writes ignorados.
- **SYSTIMER**: counter 16 MHz desde `qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL)`. Read VAL_HI snapshot → consistencia con VAL_LO. Comparators/IRQs deferred.
- **GPIO**: track 32 bits de OUT register, W1TS/W1TC honorados, qemu_irq named-out por pin para bridge futuro a Velxio. Pins 32-54 deferred.

## Notes

- SYSTIMER stub returna 0 antes; si firmware espera tick > 0 antes de proceder (ej. `delay(0)` que verifica), ahora pasa.
- GPIO solo output. `digitalRead()` retornaría siempre 0. Input + interrupt matrix vienen en Phase 1.K.
- eFuse solo MAC. Si firmware lee `EFUSE_RD_REPEAT_DATA*_REG` para chip rev / pkg version, devuelve 0 — el runtime lo acepta.
