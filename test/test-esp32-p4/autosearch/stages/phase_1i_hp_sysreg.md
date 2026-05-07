# Phase 1.I — HP_SYSREG + Reset/Clock

**Status:** ⏳ pending

## Goal

Stubs reales para los registers de `HP_SYSREG` (0x500E5000) y `Reset and Clock` (0x500E6000). El IDF runtime lee/escribe muchos de estos durante init: clock-tree config, sub-system reset gating, peripheral clock enables.

## Acceptance criteria

Función `bootloader_clock_configure` (o equivalente del IDF P4) completa sin trap. Algunos clock-status reads devuelven "ready" (sino el código loopea esperando un bit).

## Estrategia

Phase 1: simple sysbus device con array de uint32_t backing all reads/writes. Algunos regs especiales tienen "always ready" bit para que polls succeed.

Phase 2 (luego): modelar mínimamente el clock tree para que:
- Lectura de SYSCLK_CONF devuelve 400 MHz.
- PLL_LOCK bit se setea automáticamente al escribir PLL_EN.

## Direcciones

- HP_SYSREG: 0x500E5000 (TRM Cap 20)
- Reset and Clock (PCR): 0x500E6000 (TRM Cap 10)

## Archivos a crear

- `hw/misc/esp32p4_sysreg.c`
- `include/hw/misc/esp32p4_sysreg.h`
- update `hw/misc/meson.build`
- update `hw/riscv/esp32p4.c` (reemplazar stubs `hp_sysreg`, `reset_clock`)

## Pasos concretos

1. Leer TRM Cap 20 (HP SYSREG) y Cap 10 (Reset and Clock).
2. Identificar los regs con "STATUS"/"DONE"/"READY" que el IDF poll-ea.
3. Hacer que esos retornen 1 inmediatamente al ser leídos (después de cualquier write a "ENABLE").
4. Resto = scratch RW.

## Notes

- HP_SYSREG es 4 KB — algunos regs son security/permission, otros system control.
- Reset+Clock controla la PLL master, dividers para sub-systems. Solo importa lo que usa el bootloader y FreeRTOS init.
- Con esto + Phase 1.F (SPI) + Phase 1.G (cache MMU) + Phase 1.H (WDT), el bootloader debería completar.
