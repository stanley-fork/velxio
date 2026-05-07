# Phase 1.E — 4 unblocks consecutivos

**Status:** ✅ done — commit `b0c4aad8f5`

## Goal

Después de Phase 1.D el ELF cargaba pero la CPU se trababa casi inmediato. Resolver los 4 bloqueantes secuenciales que aparecieron al iterar con `-d int,guest_errors`.

## Acceptance criteria

CPU ejecuta past `pmu_lp_system_init`, `pmu_init`, varias funciones de boot del IDF, hasta llegar a `bootloader_flash_execute_command_common` (siguiente bloqueante = Phase 1.F).

## Los 4 unblocks

### 1. SP init en el trampolín

**Síntoma:** store fault a `0xFFFFFFFC` en PC `0x4FF00C44` (`sw ra, 28(sp)`).
**Causa:** `sp = 0` al reset → `sp - 32 = 0xFFFFFFE0` → SW a `0xFFFFFFFC` falla.
**Fix:** trampolín ahora setea `sp = 0x4FF80000` antes del JR. Crece a 6 instrucciones.

### 2. Custom CSRs + CLIC standard como scratch RW

**Síntoma:** illegal_instruction trap en `csrrs a5, 0x7C1, a5`, después en `csrrw zero, mtvt(0x307), a5`.
**Causa:** Espressif usa CSRs custom 0x7C0-0x7FF (CLIC + cache + perf) y CLIC standard 0x307/0x345-0x349/0xFB1; QEMU upstream no los conoce.
**Fix:** `target/riscv/esp_cpu.c` — registrar el rango entero como scratch RW, backed por array `custom_csr[0x48]` en `EspRISCVCPU`.

### 3. HP ROM lleno de `ret`

**Síntoma:** trap en `0x4FC00018` (PC saltó al boot ROM Espressif).
**Causa:** IDF llama a `esp_rom_delay_us`, `ets_*`, etc. en addresses fijas dentro del HP ROM. Sin la blob oficial, esas addresses son cero (illegal).
**Fix:** llenar los 128 KB de HP ROM con `0x00008067` (`jalr x0, 0(ra)` = `ret`). Trampoline overlay en offset 0. Toda llamada a ROM retorna inmediatamente.

### 4. PF_X overlay pass

**Síntoma:** illegal_instruction en `pmu_init` (0x4000BB90), aunque el ELF tiene código válido ahí.
**Causa:** ESP-IDF emite `.flash.text` (R-X) y `.flash.rodata` (RW) ambos en VA `0x40000020`. En real silicon la cache MMU los separa; en nuestra extflash plana, segment 3 sobreescribe segment 2.
**Fix:** después de `load_elf_ram_sym`, segundo pase manual del ELF que re-escribe SOLO segments con flag PF_X. Código gana sobre datos cuando colisionan.

## Archivos tocados

- `hw/riscv/esp32p4.c` (~+90 LOC) — SP en trampolín, ROM ret-fill, PF_X overlay.
- `target/riscv/esp_cpu.c` (~+45 LOC) — custom CSR + CLIC standard handlers + register list.
- `target/riscv/esp_cpu.h` (+8 LOC) — `custom_csr[0x48]` en EspRISCVCPU.

## Notes

- Los 4 fixes son hacks pragmáticos, no implementaciones reales. Cada uno tiene una versión "right" pendiente:
  - (1) → real bootloader stage 1 inicializa SP.
  - (2) → CLIC modeling completo.
  - (3) → blob real `esp32p4-rom.bin` de Espressif.
  - (4) → cache MMU emulada para que las dos VAs apunten a diferentes regiones físicas.
- Para verificar si la session actual avanza más allá: `timeout 5 qemu-system-riscv32 -M esp32p4 -kernel blink.ino.elf -nographic -monitor none -d int,guest_errors -D /tmp/qint.txt 2>&1` y mirar `head /tmp/qint.txt`.
