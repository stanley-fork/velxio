# Phase 1.J — RNG + eFuse extendido + segundo HP core (opcional)

**Status:** ⏳ pending

## Goal

Cosas chicas que el IDF runtime necesita pero no encajan en otras fases.

## Sub-tasks

### RNG (Random Number Generator)
- Stub que devuelve valor random distinto cada read.
- Base: TRM Cap 33 (probablemente en HP CPU peripherals).
- Implementation: ~30 LOC; cada read usa `qemu_clock_get_ns` o `g_random_int`.

### eFuse extendido
- Phase 1.C tiene MAC fijo. Si el IDF lee chip rev / pkg version y se queja, agregar valores razonables:
  - `EFUSE_RD_REPEAT_DATA0_REG (0x30)` con bits para wafer version, package, etc.
- Bits específicos por leer del TRM Cap 8 §8.3.5.

### Segundo HP core (HP CPU 1)
- ESP32-P4 tiene 2 HP cores. Por ahora solo modelamos 1.
- El bootloader estándar solo arranca core 0 inicialmente y luego despierta core 1 vía un IPI.
- Para Phase 1 podemos saltearlo: mantener `mc->max_cpus = 1`. Si el firmware intenta despertar core 1, el wake-up call irá a un peripheral stub que ignora — el IDF runtime probablemente continúa en single-core.

### LP CPU (low-power core)
- Out of scope para Phase 1, listado separadamente en Phase 5.

## Archivos potenciales

- `hw/misc/esp32p4_rng.c` (~30 LOC)
- update `hw/nvram/esp32p4_efuse.c` (agregar más fields)

## Notes

- RNG es importante para `esp_fill_random()` que el IDF usa en setup. Sin RNG real, retorna 0 → puede afectar random init de Wi-Fi/BT (no aplica al P4 sin radio, pero igual lo llaman).
