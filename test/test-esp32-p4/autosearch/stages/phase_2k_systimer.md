# Phase 2.K.systimer — SYSTIMER snapshot protocol

**Estado**: ✅ done · commit `e408a196d1`

## Goal

El SYSTIMER stub original sólo manejaba `R_UNIT0_VAL_HI` (0x40) y `R_UNIT0_VAL_LO` (0x44). Las lecturas de `R_UNIT0_OP` (0x04) devolvían 0. El IDF runtime, al hacer `systimer_hal_get_counter_value`:

```c
SYSTIMER.unit_op[unit].timer_update = 1;        // write bit 31
while (!SYSTIMER.unit_op[unit].timer_value_valid)  ;  // poll bit 30
hi = SYSTIMER.unit_value[unit].hi;
lo = SYSTIMER.unit_value[unit].lo;
```

Sin bit 30 (TIMER_VALUE_VALID) en el read de OP_REG, el while-loop spinea infinito.

## Fix

Modifiqué `esp32p4_systimer.c`:
1. **OP_REG read** (0x04 unit 0, 0x08 unit 1): siempre devuelve `OP_TIMER_VALUE_VALID_BIT` (bit 30 set) → poll exits inmediato.
2. **OP_REG write** con bit 31 set (TIMER_UPDATE): captura snapshot del counter en ese momento.
3. **VAL_HI read**: devuelve high 32 bits del snapshot. Si snapshot==0 (no fue request explícito), toma fresh sample como fallback.
4. **VAL_LO read**: devuelve low 32 bits + clear snapshot para próximo round.
5. Soporte para unit 1 (offsets 0x08, 0x48, 0x4C) symmetric a unit 0.

## Resultado

Las lecturas de SYSTIMER counter ahora retornan tiempo virtual real (16 MHz tick rate). IDF code que polleaba SYSTIMER ya no se atasca.

## Archivos tocados

- `hw/timer/esp32p4_systimer.c`: 41 LOC nuevos (definitions + read/write logic).
