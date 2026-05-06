# 00 — Decisión de approach: ¿cómo emular el ESP32-P4?

## Las 4 opciones reales

| Opción | Lenguaje | Esfuerzo Phase 1 | Esfuerzo total | Integra a Velxio | Veredicto |
|---|---|---|---|---|---|
| **A0**. Forkear `davidmonterocrespo24/qemu-lcgamboa` (tu fork) | C | **2-5 sem** | 3-6 meses | ya integrado vía libqemu | ✅ **GANADOR** |
| A1. Forkear `espressif/qemu` upstream | C | 3-6 sem | 3-6 meses | 1 línea + setup CI/build | ⚠️ peor que A0 |
| B. Forkear `lcgamboa/qemu` upstream | C | 4-7 sem | 4-7 meses | 1 línea + setup CI/build | ❌ |
| C. Modificar rvemu / riscv-rust / TinyEMU | Rust → WASM | 4-7 meses | 12-18 meses | reescribir bridge | ❌ |
| D. Escribir desde cero estilo `avr8js`/`rp2040js` | TS | 6-9 meses | 16-24 meses | nativo browser | ❌ corto plazo, ✅ largo plazo (ver hybrid) |

> **Update 2026-05-06**: revisé `davidmonterocrespo24/qemu-lcgamboa` (43 commits ahead de lcgamboa). El fork **ya tiene toda la infra Velxio**: libqemu shared library, CI multi-plataforma (Linux amd64+arm64, Windows, macOS Intel+ARM), host-bridge `velxio_*_export.c`, ESP32-CAM end-to-end como prueba de capacidad. **Por eso A0 gana a A1**: agregar `hw/riscv/esp32p4.c` es el mismo trabajo, pero acá la distribución, packaging y bridge a Velxio ya están resueltos. Detalle completo en [`02_fork_inventory.md`](02_fork_inventory.md).

## Por qué A0 (forkear tu propio `qemu-lcgamboa`) gana, sin discusión

1. **El CPU ya está hecho y bien.** QEMU upstream emula RV32IMAFC + Zb + A perfectamente. Toda la complejidad del decoder, pipeline, MMU, exceptions, atomics — ya resuelta. **No tiene sentido reimplementar lo más difícil**.

2. **Velxio ya integra el fork.** El backend usa `libqemu-riscv32.{so,dll,dylib}` que sale de la CI del fork. Sumar P4 al backend es agregar `'esp32-p4': (..., 'esp32p4')` al `_MACHINE` dict y la nueva binary se distribuye automáticamente. UART, GPIO chardev, hot-reload, WebSocket bridge, host-call exports — todo gratis.

3. **`esp32c3.c` del fork es un template casi listo.** Verificado:
   - 634 líneas de C en `hw/riscv/esp32c3.c` + 1083 en `esp32c3_picsimlab.c` (variante con bridges Velxio).
   - Pattern muy mecánico: declarar memory regions (irom, drom, iram, dram, rtcram), mapear peripherals a `DR_REG_*` addresses, wire interrupts, instanciar UART/GPIO/SPI/I2C/RNG/AES/SHA/HMAC/RSA/RTC.
   - **AES, SHA, RSA, HMAC, eFuse, LEDC, DS, XTS_AES**: mismo IP block en C3 y P4 → reutilizables casi tal cual.
   - **GPIO, UART, SPI, I2C, Timer Group, SAR ADC**: mismo IP, distinta cantidad/direcciones → adaptar memory map.

4. **Vos ya demostraste capacidad de agregar peripherals nuevos.** Commit `ff8eee0f8b` agrega ESP32-CAM end-to-end (OV2640 SCCB + I2S DVP + VSYNC IRQ + descriptor walker) — exactamente el mismo patrón requerido para los peripherals nuevos del P4 (MIPI-CSI, USB OTG HS, etc., aunque esos quedan para Phase 3+).

5. **CI auto-compila para 5 plataformas.** Cualquier commit a `picsimlab-esp32` (o branch derivada) dispara build de libqemu para Linux amd64+arm64, Windows, macOS Intel+ARM, y publica binarios a `davidmonterocrespo24/velxio` releases tag `qemu-prebuilt`. **Cero trabajo adicional de packaging para distribuir el P4 a deployments Velxio**.

6. **Compilable a WASM.** El mismo fork se puede compilar con Emscripten (ya hay precedente en `test/esp32-emulator/qemu-wasm/Dockerfile`). Si en el futuro queremos correr P4 100% en browser, el path está abierto.

7. **Cherry-pick desde `espressif/qemu` cuando publiquen P4.** Espressif tiene [issue #127](https://github.com/espressif/qemu/issues/127) abierto pidiendo soporte oficial. Cuando aterrice (meses/años), agregamos `espressif/qemu` como remoto secundario y mergeamos lo aplicable. La base QEMU del fork (8.1.3) vs Espressif (9.2.2) puede requerir ajustes menores, pero el código de `hw/riscv/esp32*` es self-contained.

## Por qué descartar las otras

### B. Forkear `lcgamboa/qemu`

`lcgamboa/qemu` es un fork de `espressif/qemu` que agrega:
- Compilación como librería dinámica (para PICSimLab).
- WiFi y ESPNOW en `esp32_wifi` / `esp32c3_wifi` NIC models.

**El P4 no tiene radio nativa** (depende de un ESP32-C6 externo por SDIO). Las patches de WiFi de lcgamboa **no aportan nada** al P4. Forkear desde `lcgamboa` te hereda divergencia con upstream sin beneficio. Veredicto: forkear directo `espressif/qemu`.

### C. rvemu / riscv-rust / TinyEMU

| Proyecto | Lo que da | Lo que falta para P4 |
|---|---|---|
| `d0iasm/rvemu` (Rust→WASM) | RV64GC, Sv39, virtio devices | swap **TODO** el device model. ~80% del trabajo de QEMU. |
| `takahirox/riscv-rust` (Rust→WASM) | RV64IMAFD | idem. |
| `TinyEMU` (Bellard, C→WASM) | RV32IMA + RV64GC, virtio | idem. |

El CPU se obtiene gratis igual que QEMU, **pero las peripherals — que son el 80% del trabajo — hay que escribirlas igual**. Y encima:
- Pierdes la madurez de QEMU (caches, debug, GDB stub, plugins).
- Sumás el costo de integrar Rust+WASM al pipeline TS de Velxio.

No hay ahorro real.

### D. Desde cero TS estilo avr8js/rp2040js

| Comparación | avr8js | rp2040js | esp32p4 |
|---|---|---|---|
| ISA | AVR 8-bit, 131 instrucciones | ARMv6-M Cortex-M0+, single-issue | RV32IMAFC + Zb + custom HW loop, dual-core HP + LP |
| Periféricos críticos | PORTB/C/D, ADC, Timer | GPIO, PIO, ADC, UART, SPI, I2C | 55 GPIO + matrix, UART×5, SPI×3, I2C×2, I2S×3, USB OTG HS/FS, ETH, SDIO, MIPI-CSI/DSI, ISP, JPEG, H264, AES, SHA, ECC, RSA, HMAC, RNG, ADC, LEDC, MCPWM, RMT, PCNT, TWAI, Touch... |
| LOC del emulador | ~5K | ~10K | estimado **50K-80K** sin MIPI/H264 |
| Tiempo estimado primera ejecución | 6 meses | 1-2 años (Wokwi reportó esto) | **3-5 años** para 1 persona |

Reescribir QEMU en TypeScript es académicamente interesante y prácticamente irrelevante. Out.

## Roadmap recomendado (Phase 1: blink + Serial.println)

Ver `01_phase1_plan.md` para detalle. Resumen:

| # | Tarea | Effort | Capítulo TRM |
|---|---|---|---|
| 1 | Fork `espressif/qemu` rama `esp-develop`, crear branch `feat/esp32p4-machine` | 1h | — |
| 2 | Crear `hw/riscv/esp32p4.c` desde el template de `esp32c3.c` | 3 días | Ch 7 (memmap), Ch 11 (boot) |
| 3 | Implementar Reset + Clock subsystem mínimo | 2 días | Ch 10 |
| 4 | Implementar GPIO matrix + IO MUX | 4 días | Ch 9 |
| 5 | Implementar UART0 (chardev) | 2 días | Ch 42 |
| 6 | Implementar System Timer (para `delay()`) | 2 días | Ch 15 |
| 7 | Implementar CLIC + CLINT (estándar RISC-V; QEMU tiene base) | 3 días | Ch 1.9, Ch 12 |
| 8 | Implementar Watchdog (para que el bootloader no se cuelgue) | 1 día | Ch 17 |
| 9 | Implementar eFuse stub (boot necesita leer chip ID) | 2 días | Ch 8 |
| 10 | Compilar, ejecutar `merged.bin` de Arduino, verificar `Serial.println` aparece en UART0 | 2 días | — |
| 11 | Wire en Velxio: `_MACHINE['esp32-p4']`, board element, pin map | 1 día | — |

**Total Phase 1: ~22 días-persona** (3-6 semanas a tiempo parcial). Phases 2 y 3 quedan para otro plan.

## Decisión final

**Path A: forkear `espressif/qemu`** y agregar `hw/riscv/esp32p4.c` modelado sobre `esp32c3.c`.

Próximos pasos concretos en [`01_phase1_plan.md`](01_phase1_plan.md).

## Material de referencia descargado en `../specs/`

- `esp32-p4_technical_reference_manual_en.pdf` — 21 MB, 3078 páginas, 63 capítulos. Index completo en `_TRM_TOC.txt`.
- `esp32-p4_datasheet_en.pdf` — 1.5 MB.
- `esp32-p4_hardware_design_guidelines_en.pdf` — 1.8 MB.
