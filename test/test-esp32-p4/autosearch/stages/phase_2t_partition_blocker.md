# Phase 2.T — Bypass-dropped flow blocker: partition table not loaded

**Estado**: 🔬 investigated — root cause identified, deferred to Phase 2.U.

## Goal original

"Cache MMU emulation for spi_flash_mmap path" — implementar suficiente
emulación del Cache MMU para que `spi_flash_mmap` funcione sin
bypass-patches y la app real Arduino corra.

## Lo que SE INVESTIGÓ

### 1. Estado actual del Cache MMU

`hw/riscv/esp32p4.c::esp32p4_mmu_eager_translate` (Phase 2.B.post_qio)
ya implementa una estrategia de **eager-copy**: cuando el guest escribe
una entrada MMU vía `0x5008C380` (index) + `0x5008C37C` (content), el
emulador inmediatamente memcpy 64 KB de flash al cache window. Esto da
~5x mejor performance que un MMIO overlay y ya cubre block IDs 0..1023.

### 2. Test: drop Phase 2.N + 2.O bypass

Comenté las patches Phase 2.N (hello-world inline UART writer) y Phase
2.O (CSR enables) — 19 patches comentados, dejando 40 activos. Build
limpio. Run con `-d in_asm -D /root/qkrn_in_asm.log`.

Resultado: la app llega más lejos que en Phase 2.P (que tenía el mismo
test sin CLIC), pero se queda pegada **silently** sin output a UART.

### 3. PC sampling — hot loop encontrado

Con `tail -5000 qkrn_in_asm.log | sort | uniq -c | sort -rn`, los PCs
más frecuentes son:

```
10 0x4ff03228   } loop body en rtc_clk_cpu_freq_to_cpll_mhz
10 0x4ff03226   } (clk_ll_bus_update — write/read/check/branch)
10 0x4ff03224
10 0x4ff03222
 7 0x40009084   } esp_cache_err_int_init
 7 0x40009080
```

Disasm del "busy loop" en clk_ll_bus_update:

```
0x4ff03220:  c3d8        sw   a4, 4(a5)        ; *0x500E6004 = a4|0x10
0x4ff03222:  43d8        lw   a4, 4(a5)        ; readback
0x4ff03224:  8311        srli a4, a4, 4
0x4ff03226:  8b05        andi a4, a4, 1
0x4ff03228:  ff6d        bnez a4, -6           ; branch back if bit 4 set
```

**Falso lead**: pensé que esto era el blocker. Verifiqué con un
`fprintf` diagnostic en `esp32p4_smart_stub_read` que el override
existente (`{ 0x500E6000, 0x004, 0, SMART_FIXED }`) SÍ retorna 0 — el
loop EXITS en cada iteración. La frecuencia alta de PCs se debe a que
`rtc_clk_cpu_freq_to_cpll_mhz` llama `clk_ll_bus_update()` ~3 veces, y
es una función llamada repetidamente durante init.

### 4. Real busy loop — esp_ota_get_running_partition

Mirando el TAIL del log (últimas TBs ejecutadas), el verdadero stuck
está en una cadena de funciones IDF:

```
spi_flash_mmap → heap_caps_calloc (×4) → ensure_partitions_loaded.part.0 →
  esp_log_cache_get_level → ensure_partitions_loaded → esp_partition_find →
  esp_ota_get_running_partition → ESP_LOG (calls esp_log_cache_get_level) →
  back to esp_ota_get_running_partition (j -50 to start of log call) → loop
```

Disasm relevante:

```
esp_partition_find @ 0x40005b76:
  d179      beqz a0, -58 → 0x40005b3c     ; not taken because a0 = found
                                          ; entry pointer (NULL though?)
  ...epilogue, ret a0=0...

esp_ota_get_running_partition @ 0x400054f4:
  842a      mv s0, a0                      ; s0 = result of esp_partition_find
  ed01      bnez a0, +24 → 0x4000550e      ; if found, exit; else fallthrough
0x400054f8:
  lui/addi setup ESP_LOGE arguments
0x4000550c:
  b7f9      j -50 → 0x400054da             ; LOOP: re-emit ESP_LOGE
0x400054da:
  lui/addi argument; auipc/jalr to esp_log_cache_get_level
```

**Diagnóstico**: `esp_partition_find` returns NULL (no se encontró la
partición "running"). `esp_ota_get_running_partition` interpreta esto
como un error y entra en un loop de error-logging — emite el mismo
mensaje vía `ESP_LOGE` repetidamente.

### 5. Por qué `esp_partition_find` retorna NULL

La función debería iterar sobre la lista global de particiones cargada
desde flash en `ensure_partitions_loaded`. Pero la lista está vacía
porque:

- `spi_flash_mmap` se llama para mapear el partition table (en flash
  offset `0x8000`, tamaño 0xC00).
- El mapeo via nuestra eager-copy DEBERÍA funcionar.
- Pero `ensure_partitions_loaded` luego llama `esp_partition_iterator_t`
  helpers que dependen de FreeRTOS locks/semaphores.
- Sin scheduler real (Phase 2.M bypass) los locks se comportan como
  no-op pero las estructuras de FreeRTOS asociadas no se inicializan
  correctamente.
- Result: la lista de particiones queda vacía o malformada.

## Lo que SÍ funcionó

| Verificado por                                       | Conclusión              |
|------------------------------------------------------|-------------------------|
| `[smart_stub] HP_CLKRST 0x500e6004` debug log        | Override SÍ aplica      |
| `[smart_stub] HP_CLKRST override match -> 00000000`  | Retorna 0 correctamente |
| `IN: rtc_clk_cpu_freq_to_cpll_mhz` aparece y avanza  | Init clock progresa     |
| `IN: spi_flash_mmap` aparece en el log               | spi_flash_mmap se llama |
| `IN: ensure_partitions_loaded.part.0` aparece        | flash mapping funciona  |
| Cache MMU eager-copy (Phase 2.B.post_qio)            | Sigue funcionando bien  |

## Lo que NO funcionó (y por qué)

1. **Asumí que el blocker era HP_SYS_CLKRST clock-update polling**: PC
   sampling de 5K líneas mostró esos PCs como hot. PERO eran del init
   PROGRESANDO normal, no de un loop infinito. El verdadero hot loop
   estaba al FINAL del log (esp_ota_get_running_partition error log).

2. **Cache MMU emulation no es el blocker**: la eager-copy ya cubre
   el range 0..1023 entries. spi_flash_mmap PUEDE mapear flash al
   cache window. El problema es DOWNSTREAM en la lectura/parsing de
   la partition table.

3. **CLIC dispatch (Phase 2.S) no destrabó esto**: esperaba que IRQ
   delivery + IDF interrupt handler permitiera al scheduler avanzar.
   No fue así — el blocker no es interrupt-driven, es lock/semaphore.

## Siguientes fases (priorizadas)

### Phase 2.T (deferred) — actual fix

El root cause es: **partition table no se carga / está malformada en
nuestro flash blob**. Posibles paths:

1. **Verify flash blob has valid partition table at offset 0x8000**.
   Usar `xxd` o esptool en el blob para confirmar magic+entries.
2. **Patch `ensure_partitions_loaded` para skip lock acquire** y
   forzar lectura directa.
3. **Patch `esp_ota_get_running_partition` to ret a known partition**
   sin pasar por la lista global.

### Phase 2.U — drop bypass + complete FreeRTOS

Implementar suficiente FreeRTOS para que locks/semaphores funcionen
de verdad. Esto destrabaría toda la cadena de partition + log + heap
sin parchear cada función.

### Phase 2.V — log helpers cooperate sin scheduler

Override `esp_log_cache_get_level` para retornar un valor sano sin
tocar locks. Permite que ESP_LOG en bucle de error termine
graciosamente.

## Lessons learned

1. **PC sampling da falsos positivos en init code**: las funciones de
   init son llamadas repetidamente y dominan los conteos. El verdadero
   stuck loop está al FINAL del log de TBs, no en el ranking por
   frecuencia.

2. **`-d in_asm` resuelve nombres de función automáticamente**: las
   secciones `IN: <nombre>` son CRÍTICAS para identificar contexto. No
   necesitamos objdump del ELF — QEMU ya extrajo los símbolos del
   ELF cargado.

3. **El cache MMU del Phase 2.B.post_qio era robusto**: nuestra
   eager-copy translate cubre TODO el rango de entries; spi_flash_mmap
   no es el blocker. Phase 2.A había evaluado bien las prioridades.

4. **Smart override SMART_FIXED no es read-only**: el scratch storage
   se escribe en cada `sw` pero la lectura lo ignora y retorna `value`.
   La inconsistencia entre lo que el guest escribe y lo que lee al
   poll es exactamente lo que necesitamos para pollings de "op done"
   sin hardware real detrás.

5. **El IDF panic-style logging IS un loop infinito**: si una API
   retorna error, el código de error a veces emite logs en un retry
   loop. Sin tasks reales para preempción, el log loop se perpetúa.

## Archivos tocados (todos REVERTIDOS post-investigación)

- `hw/riscv/esp32p4.c`:
  - Phase 2.N hello-world patches: comentados → restaurados.
  - Phase 2.O CSR enables: comentados → restaurados.
  - `esp32p4_smart_stub_read`: agregadas `fprintf` diag → eliminadas.
- `test/test-esp32-p4/autosearch/scripts/`:
  - `run_kernel_pc_sample.sh` — PC sampling helper, **kept** for future.
  - `run_kernel_tail.sh` — tail-of-log analysis helper, **kept**.

## Estado consolidado (post-2.T investigation)

| Hito                                                    | Estado       |
|---------------------------------------------------------|--------------|
| ROM banner                                              | ✅           |
| Bootloader runs 6.4s                                    | ✅           |
| App ELF runs (174 fns)                                  | ✅           |
| FreeRTOS scheduler entered                              | ✅           |
| `app_main` reached                                      | ✅           |
| Primer UART output (hello world)                        | ✅           |
| SYSTIMER tick wired                                     | ✅           |
| IRQ delivery a esp_cpu dispatcher                       | ✅ Phase 2.Q |
| Trap to `mtvec` firing (sin crash)                      | ✅ Phase 2.R |
| End-to-end IRQ con MIE persistente                      | ✅ Phase 2.R |
| mtvec mode 3 acceptable + CLIC mtvt dispatch            | ✅ Phase 2.S |
| IDF `_interrupt_handler` runs on every tick             | ✅ Phase 2.S |
| Cache MMU eager-copy translate                          | ✅ Phase 2.B |
| **Real-flow stuck point identified**                    | ✅ Phase 2.T |
| Partition table loaded properly (no error loop)         | ❌ Phase 2.T-fix |
| Real `setup()` runs                                     | ❌ Phase 2.U |
| `digitalWrite(LED)` blink visible                       | ❌ Phase 2.U |
