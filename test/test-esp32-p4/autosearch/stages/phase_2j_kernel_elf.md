# Phase 2.J — Direct ELF kernel boot path

**Estado**: ✅ done · commit `887d5d16fc`

## Discovery

Pivot estratégico: en vez de pelear con el bootloader Espressif (post_qio stuck en SW SHA), uso el path `-kernel ELF` para cargar `blink.elf` directamente.

```bash
qemu-system-riscv32 -M esp32p4 \
  -kernel /root/blink.elf \
  -drive file=/root/blink.merged.bin,if=mtd,format=raw \
  -nographic
```

`blink.elf` tiene:
- `setup()` @ 0x40000020
- `loop()` @ 0x4000006a
- `app_main()` @ 0x4000303e
- ESP-IDF + Arduino linked statically (~7.3 MB ELF, ~520 KB cargados)

## Resultado

- ✅ ELF loads (521210 bytes)
- ✅ PF_X overlay pass re-writes 3 executable segments
- ✅ Trampoline en reset vector salta al entry (0x4FF00C40)
- ✅ CPU ejecuta IDF runtime startup
- ⚠️ Llega a `system_early_init` y llama `abort()` por un check fallido

## Análisis del abort

```
0x40008060: addi a5, zero, 233       ; a5 = 0xE9 (ESP image magic)
0x40008064: beq a4, a5, +40          ; if a4 == 0xE9, ok
0x40008068: lw a5, -1972(gp)          ; otherwise check global var
0x4000806c: beqz a5, abort path      ; if zero → abort
...
0x40007ef4: jalr ets_printf            ; print error
0x40007efc: jalr abort                 ; → terminate
```

El check espera leer `0xE9` (magic byte de un ESP image) en algún registro/memory. Probablemente está leyendo el primer byte del bootloader image o app image desde flash via cache window. Con nuestro flash blob lineal en RAM, virtual `0x40002000` (donde está el bootloader) tiene `0xE9`, pero virtual `0x40000000` tiene `0xFF` (erased).

Si el check lee desde `0x40000000`, falla. Si lee desde `0x40002000`, pasa. La diferencia depende de si ROM o IDF runtime configura el cache MMU para mapear correctly.

## Resolución

**Causa raíz**: el check lee de `0x40030000` (linker put image header allí). Con linear flash blob, virtual `0x40030000 = flash[0x30000]` que tiene bytes random (post-partition table area). En real silicon, el bootloader programa cache MMU para mapear `0x40030000 → flash[0x10000]` (app partition).

**Fix — runtime patch en app code**:
```
0x40008064: beq a4, a5, +40   → j +40   (always taken)
encoding:   0x02f70463         → 0x0280006F
```

Skipea la comparación, system_early_init avanza al siguiente paso.

## Resultado

App code progresa a `pmu_hp_system_init` (~0x4000B7CA+). CPU ejecuta init real:
- PMU register R-M-W loops (`0x4000b9e0-0x4000b9f4`).
- Calls `efuse_hal_chip_revision` (lee chip rev de eFuse).
- Calls `esp_cache_err_int_init`.
- Calls `esp_deep_sleep_wakeup_io_reset` (conditional).

## Phase 2.J.next — CPU1 wait loop bypass (commit `1f06095`)

Después del magic check bypass, `system_early_init` setea `s_cpu_inited=1` y entra a un loop en `0x4000809A` esperando `s_cpu_inited & s_resume_cores` ambos non-zero. `s_resume_cores` lo setea `startup_resume_other_cores` que corre en HP_CPU1 (AP CPU). Sin multi-core emulation, CPU1 nunca corre eso, loop infinito.

**Fix**: en `0x40008096` reemplazo `sb zero, 4(sp)` (`0x00010223`) con `j +10` (`0x00A0006F`) para skipear loop init y body, salta directo al epilogue.

**Resultado**: app corre por **~30 IDF runtime init functions**:
- `call_start_cpu0`, `start_cpu0_default`
- `cache_hal_init`, `cache_hal_init_l2_cache`, `s_cache_hal_init_ctx`
- `bootloader_init_mem`, `bootloader_flash_update_id`
- `core_intr_matrix_clear`, `do_system_init_fn`
- `__esp_system_init_fn_init_*` (heap, app_info, cpu_freq, efuse, etc.)
- `efuse_hal_chip_revision`, `efuse_hal_blk_version`, etc.
- `rtc_clk_*` (cpu_freq config, slow clock select)
- `spi_flash_init_chip_state`, `spi_flash_enable_high_performance_mode`
- `wdt_hal_config_stage`, `xPortEnterCriticalTimeout`
- `soc_get_available_memory_regions`

Hot PCs son `0x4000b9xx` (PMU init) y `0x4000a214` (memory regions). CPU está ejecutando código real de IDF.

## Phase 2.J.uart — Próximo blocker

**No hay UART output después de 60s wall time** a pesar de que `__esp_system_init_fn_init_show_app_info` aparece en el trace (esa función llama a printf("ESP-IDF X.Y.Z")...). Posibles causas:
1. CPU stuck en algún loop antes de llegar al print real.
2. UART output va a un base address diferente que no modelamos.
3. printf falla porque stdout no está inicializado.
4. La función show_app_info tiene un check de log_level que silencia.

Investigar:
- Tracear PC al final de la corrida (no por aggregate, sino last 100 lines).
- Buscar referencias a `uart_write_bytes`, `console_*`, `_putchar`.
- Verificar si esp_log_default_level (variable global en GP) está en valor adecuado.

## Notas

- Esta vía bypassea TOTALMENTE el bootloader Espressif (que estaba stuck en SW SHA).
- Si funciona, `setup() + loop()` → LED blink → milestone Phase 2 complete.
- El path es complementario al bootloader path; ambos tienen mérito (ROM testing vs app testing).
