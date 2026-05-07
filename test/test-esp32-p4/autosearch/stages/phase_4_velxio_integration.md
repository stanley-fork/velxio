# Phase 4 — Integración Velxio backend

**Status:** ⏳ pending

## Goal

El usuario en Velxio elige "ESP32-P4" del dropdown, escribe sketch en el editor, compila, corre — y ve LED parpadeando en el canvas + Serial Monitor mostrando output.

## Acceptance criteria

- `frontend/src/types/board.ts` tiene `'esp32-p4'` en `BoardKind`.
- Click "Run" lanza nuestra `qemu-system-riscv32 -M esp32p4` con el firmware compilado.
- LED del canvas refleja `digitalWrite(2, ...)` via los qemu_irq lines del GPIO.
- Serial Monitor muestra el output del UART0.

## Pre-requisitos

- ✅ Phase 0–1.E
- ⏳ Phase 1.F–1.K (para que IDF arranque)
- ⏳ Phase 2 (blink end-to-end)

## Cambios concretos

### Backend

`backend/app/services/esp_qemu_manager.py:41`:
```python
_MACHINE = {
    'esp32':    (QEMU_XTENSA,  'esp32'),
    'esp32-s3': (QEMU_XTENSA,  'esp32s3'),
    'esp32-c3': (QEMU_RISCV32, 'esp32c3-picsimlab'),
    'esp32-p4': (QEMU_RISCV32, 'esp32p4-picsimlab'),  # ← agregar
}
```

Si todavía no hicimos la variante `esp32p4_picsimlab.c` (con bridges Velxio), usar `esp32p4` directo.

`backend/app/services/arduino_cli.py`:
- Extender `_is_esp32c3_board` → `_is_esp32_riscv_board` (aceptar P4).
- `bootloader_offset = 0x0000` también para P4.

### Frontend

- `frontend/src/types/board.ts` — agregar `'esp32-p4'` a BoardKind, BOARD_KIND_LABELS, y `BOARD_SUPPORTS_MICROPYTHON`.
- `frontend/src/utils/boardPinMapping.ts` — pin map del Dev Module (55 pines).
- `frontend/src/components/components-wokwi/` — SVG/component visual nuevo (clonar ESP32-S3 hasta tener arte propio).

### CI / distribución

- Verificar que la CI del fork (`build-libqemu.yml`) ya está produciendo `libqemu-riscv32.so/dll/dylib` con `-M esp32p4`. Sí lo hace desde commit `b5d2fd7` (el trigger feat/**).
- Velxio backend debe descargar el release `qemu-prebuilt` de `davidmonterocrespo24/velxio` cuando se inicia el container.

## Notes

- Importante: `esp32p4_picsimlab.c` (variante con `velxio_*_export.c` bridge) es lo que va a usar Velxio para inyectar/recibir GPIO state en tiempo real. Sin esa variante, el LED del canvas no se actualiza.
- Si Velxio no tiene UI para "subir blob ROM", documentar que hasta tener `esp32p4-rom.bin` solo soportamos sketches que NO requieran ROM functions (que es la mayoría de Arduino sketches).
