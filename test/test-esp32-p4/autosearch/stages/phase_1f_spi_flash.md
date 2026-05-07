# Phase 1.F — SPI flash controller (NEXT)

**Status:** ⏭️ next

## Goal

Implementar suficiente del SPI flash controller para que `bootloader_flash_execute_command_common` pueda leer cabecera/datos del flash sin trapear. Esto desbloquea el bootloader stage 2 que carga la app desde flash.

## Acceptance criteria

CPU avanza past `bootloader_flash_execute_command_common` (PC ~0x4FF00446 antes del fix). Idealmente llega a `bootloader_init` o `start_cpu0` (la rutina principal del IDF).

## Estrategia

Clonar `hw/ssi/esp32c3_spi.c` → `hw/ssi/esp32p4_spi.c`. El SPI controller del P4 es similar al del C3 con diferencias de offsets/canales.

Real flash (m25p80) ya está en QEMU upstream. Necesitamos:
- SPI master controller que mapee a `0x500D0000` (GP-SPI2) y posiblemente al "SPI flash" controller dedicated (que en P4 está en otra base).
- Conectar el m25p80 como child device en el SPI bus.
- `-drive if=mtd` ya pasa el blob — el controller debe leerlo via el m25p80.

## Direcciones (TRM §7.3.5)

- GP-SPI2: `0x500D0000`
- GP-SPI3: `0x500D1000`
- (TRM Cap 43 listará el SPI flash controller separado si lo hay)

## Archivos a crear

- `hw/ssi/esp32p4_spi.c`
- `include/hw/ssi/esp32p4_spi.h`
- update `hw/ssi/meson.build` para CONFIG_RISCV_ESP32P4
- update `hw/riscv/esp32p4.c` → instanciar SPI master + flash, reemplazar stub gpspi2/3

## Pasos concretos

1. Leer TRM Cap 43 (SPI Controller) — extraer offsets de SPI_FLASH_BASE, register map mínimo.
2. Leer `hw/ssi/esp32c3_spi.c` (la implementación del C3) entero.
3. Copiar → renombrar tipos esp32c3 → esp32p4. Adjustar offsets si difieren.
4. Ver qué hace `esp32c3_init_spi_flash()` en `hw/riscv/esp32c3.c` — copiar a P4.
5. Build + correr blink.elf, ver hasta dónde llega ahora.

## Notes

- En esp32c3, `init_spi_flash` selecciona el modelo (`w25x16`, `gd25q32`, `gd25q64`, `is25lp128`) según el size del MTD. El P4 supports flash hasta 64 MB; agregar opción para `mx66u51235f` (64 MB) si llega.
- TRM Cap 43 puede mostrar que el P4 tiene cambios en el SPI flash mode (XIP, octal, etc.) — pueden requerir ajustes en m25p80 selection.
- Cuidado con el byteswapping del flash content vs cache window — esto se trata realmente en Phase 1.G (cache MMU).
- Para cuando esté listo: regenerar `merged.bin` con `arduino-cli compile blink` y probar `qemu ... -drive file=merged.bin,if=mtd,format=raw -kernel blink.elf` (combinado).
