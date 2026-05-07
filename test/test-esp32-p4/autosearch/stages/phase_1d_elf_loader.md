# Phase 1.D — `-kernel` ELF loader + extflash + trampolín

**Status:** ✅ done — commit `cd03e7a73a`

## Goal

Cargar el `blink.ino.elf` real (compilado por `arduino-cli` para `esp32:esp32:esp32p4`) y arrancar la CPU en su entry point. Resolver el problema de que QEMU no permite cambiar el resetvec post-realize.

## Acceptance criteria

```
$ qemu-system-riscv32 -M esp32p4 -kernel blink.ino.elf -nographic
[esp32p4] loaded ELF '/root/blink.elf' (521210 bytes), entry 0x4ff00c40
[esp32p4] machine init complete (...)
```

CPU ejecuta `call_start_cpu0` en `0x4FF00C40`. Verificado con `-d in_asm,nochain`.

## Cosas nuevas

1. **Memory region 64 MB en 0x40000000** (ESP32P4_MEMREGION_EXTFLASH) — RAM-backed para que el ELF loader pueda escribir los segmentos `.flash.text` y `.flash.rodata`.
2. **`-kernel` handler** en `esp32p4_machine_init` usando `load_elf_ram_sym(load_rom=false)`. El flag `load_rom=false` evita ROM-overlap detection que dispararía por los dos LOAD a misma VA (ESP-IDF quirk).
3. **Trampolín en HP ROM** de 12 bytes (3 instr): `LUI t0, hi20; ADDI t0, t0, lo12; JR t0`. Compensa sign extension de ADDI cuando bit 11 está set. (En Phase 1.E expandido a 6 instr para incluir SP init.)

## Archivos tocados

- `hw/riscv/esp32p4.c` — extflash region + ELF loader + trampoline.

## Notes

- `qdev_prop_set_uint64(..., "resetvec", entry)` solo funciona ANTES de `qdev_realize`. Por eso usamos trampoline en vez de override directo.
- `load_elf_ram_sym(... load_rom=false ...)` escribe directo a address space, sin registrar como ROM blob — así no hay overlap detection.
- Encoding helper: `lo12 = entry & 0xFFF; hi20 = entry >> 12; if (lo12 & 0x800) hi20 += 1;`
