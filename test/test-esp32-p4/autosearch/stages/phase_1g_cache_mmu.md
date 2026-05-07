# Phase 1.G — Cache MMU (flash window translation)

**Status:** ⏳ pending

## Goal

Cuando el firmware lee una dirección en el cache window (`0x40000000-0x43FFFFFF`), QEMU debe traducirla a una read del SPI flash backing y devolver el byte correcto. Esto reemplaza el hack actual donde extflash es RAM plana populada por el ELF loader.

## Acceptance criteria

- Con `-drive file=merged.bin,if=mtd` (sin `-kernel`), la CPU bootea desde `0x40000000` y ejecuta el bootloader+app reales.
- Sin necesidad del PF_X overlay hack de Phase 1.E (porque cache MMU separa cleanly text de rodata).

## Estrategia

QEMU tiene varios approaches:
- a) MMIO region con read callback que hace SPI bus reads.
- b) DirectMap: poblar la región una vez con todo el contenido del flash al boot.
- c) Cache MMU registers + page table walking (real silicon behavior).

Para Phase 1 lo más simple es **(b)**: copiar entero el contenido de `merged.bin` a la región extflash al machine_init. Suficiente para ejecutar firmware estático (sin OTA).

## Archivos a tocar

- `hw/riscv/esp32p4.c` — handler de `-drive if=mtd` que lee el blob y lo escribe a 0x40000000+.
- (si hace falta más adelante) `hw/misc/esp32p4_cache.c` — MMU registers reales.

## Pasos concretos

1. En `esp32p4_machine_init`, después de crear la región extflash, leer `drive_get(IF_MTD, 0, 0)`.
2. Si hay drive: `blk_pread()` su contenido entero a la dirección 0x40000000.
3. Smoke test: `qemu ... -M esp32p4 -drive file=merged.bin,if=mtd,format=raw -nographic` (sin `-kernel`).
4. Verificar que el CPU arranca en flash 0x40000000+offset y ejecuta bootloader→app.

## Notes

- El bootloader Espressif espera el ESP image format header en flash offset 0 (magic 0xE9). El `merged.bin` que produce arduino-cli ya tiene esto.
- La app se carga via DRAM segments declarados en el header — esto requiere que el bootloader corra correctamente. Por eso Phase 1.F+1.G+1.H+1.I deben estar todas listas para que el path completo funcione.
- Si seguimos con `-kernel` por ahora (saltando bootloader), no necesitamos cache MMU completa — el ELF loader ya pone los datos donde van.
