# emulator/ — implementación del emulador ESP32-P4 para Velxio

Folder de trabajo para la rama de **emulación**. La investigación inicial vive un nivel arriba en [`../autosearch/`](../autosearch/) y la decisión de no agregar P4 sin emulador queda registrada ahí.

## TL;DR de la decisión

Extender el fork existente **`davidmonterocrespo24/qemu-lcgamboa`** (clonado en `third-party/qemu-lcgamboa/`) con `hw/riscv/esp32p4.c` + `esp32p4_picsimlab.c` modelados sobre los archivos C3 análogos. El fork ya tiene la infra Velxio resuelta (libqemu, CI multi-plataforma, host-bridge pattern). Ver [`00_approach_decision.md`](00_approach_decision.md) para el porqué (vs forkear `espressif/qemu`, JS-from-scratch, TinyEMU/rvemu) y [`02_fork_inventory.md`](02_fork_inventory.md) para el inventario completo del fork.

## Estructura

```
emulator/
├── README.md                    # este archivo
├── 00_approach_decision.md      # comparación de las opciones, veredicto
├── 01_phase1_plan.md            # plan accionable Phase 1 (boot + blink + Serial)
├── 02_fork_inventory.md         # inventario del fork qemu-lcgamboa
├── 03_memory_map.md             # (TODO) tabla del memory map P4 desde TRM Cap 7
├── 04_peripheral_inventory.md   # (TODO) qué peripherals tocar / stubear
├── plan/                        # planes por fase (Phase 2, Phase 3 cuando aplique)
└── reference/                   # snippets/notas extraídas del esp32c3.c
```

## Specs descargados

En [`../specs/`](../specs/):
- `esp32-p4_technical_reference_manual_en.pdf` (21 MB, 3078 páginas)
- `esp32-p4_datasheet_en.pdf` (1.5 MB)
- `esp32-p4_hardware_design_guidelines_en.pdf` (1.8 MB)
- `_TRM_TOC.txt` — index completo del TRM (1713 líneas) para grep rápido

## Próximos pasos inmediatos

1. **Sanity build local** del fork (`bash third-party/qemu-lcgamboa/build_libqemu-esp32.sh` en Linux/macOS, o `build_libqemu-esp32-win.sh` en Windows). Si esto no funciona, el resto no funciona tampoco.
2. **Probar la integración actual de C3** end-to-end en Velxio para tener un baseline: compilar un blink C3, levantar Velxio, verificar Serial Monitor. Si C3 funciona, P4 va a funcionar igual una vez que esté.
3. **Llenar `03_memory_map.md`** leyendo TRM Cap 7. Único bloqueante de "información" — todo lo demás se deriva del template C3 del fork.
4. Crear branch `feat/esp32p4-machine` en `third-party/qemu-lcgamboa/` y empezar Phase 1 paso 1 de [`01_phase1_plan.md`](01_phase1_plan.md).
