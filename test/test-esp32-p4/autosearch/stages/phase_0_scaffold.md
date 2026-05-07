# Phase 0 — Machine scaffold + memmap

**Status:** ✅ done — commit `d7969f43ec`

## Goal

Que `qemu-system-riscv32 -M esp32p4` registre la máquina, cree todas las regiones de memoria del TRM Cap 7, y la CPU se inicialice correctamente al reset address `0x4FC00000`.

## Acceptance criteria

```
$ qemu-system-riscv32 -M help | grep esp32p4
esp32p4              Espressif ESP32-P4 (...)

$ qemu-system-riscv32 -M esp32p4 -nographic
[esp32p4] machine init complete (...)
Invalid read at addr 0x0 ...   ← CPU running, ROM empty (expected)
```

## Archivos tocados

- `hw/riscv/esp32p4.c` (309 LOC) — machine reg + memmap + catch-all I/O
- `hw/riscv/Kconfig` — `config RISCV_ESP32P4`
- `hw/riscv/meson.build` — entry para esp32p4.c
- `configs/devices/riscv32-softmmu/default.mak` — `CONFIG_RISCV_ESP32P4=y`

## Memory map verificado (TRM Cap 7 §7.3.5)

| Región | Base | Tamaño |
|---|---|---|
| HP SPM | 0x30100000 | 8 KB |
| HP CPU peripherals | 0x3FF00000 | 128 KB (catch-all → real en 1.A+) |
| External flash | 0x40000000 | 64 MB (declarado, agregado en 1.D) |
| External RAM | 0x48000000 | 64 MB (declarado) |
| HP ROM | 0x4FC00000 | 128 KB |
| HP L2MEM | 0x4FF00000 | 768 KB |
| HP peripherals | 0x50000000 | 1 MB (catch-all) |
| LP ROM | 0x50100000 | 16 KB |
| LP SRAM | 0x50108000 | 32 KB |
| LP peripherals | 0x50110000 | 128 KB (catch-all) |

Reset vector: `0x4FC00000`.

## Notes

- Catch-all peripheral I/O: reads return 0, writes dropped. Reemplazado peripheral por peripheral en 1.A+.
- HP ROM creado como `memory_region_init_rom` (luego cambiado a RAM en 1.E para soportar el ret-fill).
