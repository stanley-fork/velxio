# 02 — Inventario del fork `davidmonterocrespo24/qemu-lcgamboa`

Fork inspeccionado en `C:/Desarrollo/velxio/third-party/qemu-lcgamboa/`. Branch: `picsimlab-esp32`. **43 commits ahead** de `lcgamboa/qemu` upstream, **0 behind** (base fija a un punto del upstream).

## Base QEMU

- **QEMU 8.1.3** (upstream actual: 9.2.2 en `espressif/qemu`).
- Diferencia QEMU 8.1 → 9.2 toca el framework (ARM/x86, virtio, meson). Para `hw/riscv/esp32*` el código es self-contained y portable. **No es un bloqueante, pero hay que tener presente** cuando algún día Espressif publique su `hw/riscv/esp32p4.c` y queramos cherry-pickear.

## Cadena de forks

```
qemu (upstream) → espressif/qemu → lcgamboa/qemu → davidmonterocrespo24/qemu-lcgamboa
                  (chip support)   (WiFi, ESPNOW,   (Velxio CI, libqemu builds,
                                    libqemu .so)     ESP32-CAM, ADC waveforms,
                                                     WiFi/BLE fixes)
```

## Chips soportados

| Chip | Arch | Estado | Archivos clave |
|---|---|---|---|
| **ESP32** | Xtensa LX6 | ✅ Estable + WiFi/BLE/CAM | `hw/xtensa/esp32.c`, `hw/xtensa/esp32_picsimlab.c` |
| **ESP32-C3** | RISC-V RV32IMC | ✅ Estable + WiFi | `hw/riscv/esp32c3.c` (634 LOC), `hw/riscv/esp32c3_picsimlab.c` (1083 LOC) |
| **ESP32-S3** | Xtensa LX7 | ❌ no soportado | — |
| **ESP32-P4** | RISC-V dual + LP | ❌ no soportado (objetivo) | (a crear) |

## Inventario completo de archivos `hw/.../esp32*` (60 archivos)

### `hw/riscv/` (RISC-V machines, lo más relevante para P4)

```
esp32c3.c                 634 LOC    ← TEMPLATE BASE para esp32p4.c
esp32c3_clk.c             179 LOC    ← template para esp32p4_clk.c
esp32c3_intmatrix.c       426 LOC    ← template para esp32p4_intmatrix.c
esp32c3_picsimlab.c      1083 LOC    ← variante con bridges Velxio (libqemu host calls)
boot.c                    misc       reusable as-is
```

### `hw/char/`
```
esp32_uart.c
esp32c3_uart.c            ← template para esp32p4_uart
```

### `hw/gpio/`
```
esp32_gpio.c
esp32c3_gpio.c            ← template para esp32p4_gpio (pero P4 tiene 55 pines vs 22)
```

### `hw/i2c/`
```
esp32_i2c.c
esp32_ov2640.c            ← agregado por el fork (no aplica a P4 directamente)
```

### `hw/timer/`
```
esp32_frc_timer.c
esp32_timg.c
esp32c3_systimer.c        ← template para esp32p4_systimer
esp32c3_timg.c            ← template para esp32p4_timg
```

### `hw/ssi/` (SPI)
```
esp32_spi.c
esp32_rmt.c
esp32c3_spi.c             ← template para esp32p4_spi
```

### `hw/dma/`
```
esp32c3_gdma.c            ← template para esp32p4_gdma (P4 tiene GDMA-AHB + GDMA-AXI + VDMA + 2D-DMA)
```

### `hw/nvram/`
```
esp32_efuse.c
esp32c3_efuse.c           ← template para esp32p4_efuse
```

### `hw/misc/` (peripherals varios; muchos reusables casi tal cual)
```
esp32c3_aes.c             ← reusable as-is (mismo IP block en P4)
esp32c3_ana.c
esp32c3_cache.c           ← P4 tiene cache distinta (más grande, MMU diferente)
esp32c3_ds.c              ← reusable (Digital Signature peripheral)
esp32c3_hmac.c            ← reusable
esp32c3_iomux.c           ← P4 tiene 55 pines, hay que extender
esp32c3_jtag.c            ← P4 cambia: USB-Serial/JTAG distinto + USB OTG HS/FS
esp32c3_ledc.c            ← reusable (8 canales en ambos)
esp32c3_pwrmng.c          ← reusable con ajustes
esp32c3_rsa.c             ← reusable
esp32c3_rtc_cntl.c        ← P4 tiene Low-Power Management distinto
esp32c3_saradc.c          ← P4 tiene 7×2 canales 12-bit (vs C3: 2×6)
esp32c3_sha.c             ← reusable
esp32c3_unimp.c           ← reusable as-is, registra peripherals stub
esp32c3_wifi.c            ← NO aplica (P4 sin radio)
esp32c3_xts_aes.c         ← reusable
```

## Features Velxio-específicos del fork (43 commits ahead)

### CI/Build infrastructure (la joya de la corona para Velxio)

`.github/workflows/build-libqemu.yml`:
- Compila **libqemu-xtensa.{so,dll,dylib} + libqemu-riscv32.{so,dll,dylib}** para 5 plataformas:
  - Linux amd64 (ubuntu:20.04 container)
  - Linux arm64 (ubuntu:22.04 container)
  - Windows x86_64 (MinGW)
  - macOS Intel
  - macOS Apple Silicon
- Auto-publica binarios a `davidmonterocrespo24/velxio` releases tag `qemu-prebuilt`.
- Trigger: push a `picsimlab-esp32` o manual dispatch.

**Para P4**: cualquier work nuevo en `hw/riscv/esp32p4*.c` se compila automáticamente para todas las plataformas y se publica como release. **Cero trabajo adicional de packaging**.

### `build_libqemu-esp32.sh` / `build_libqemu-esp32-win.sh`
Scripts shell que invocan `./configure` con flags exactos para Velxio:
```sh
./configure --target-list=xtensa-softmmu,riscv32-softmmu \
  --extra-cflags="-fPIC -DESP32_PICSIMLAB_SOFT_CACHE=1" \
  --disable-slirp --enable-tcg --enable-system \
  --disable-werror --enable-debug --enable-gcrypt
```
Para P4 no hay que cambiar nada — el target `riscv32-softmmu` ya cubre P4.

### Patrón `velxio_*_export.c` (host-bridge)
`hw/misc/velxio_camera_export.c` (agregado en commit `ff8eee0f8b`) define símbolos C exportados para que Velxio backend pueda inyectar datos en QEMU runtime. Patrón reutilizable para:
- Inyectar valores ADC (ya hay `velxio_adc_*` por el commit `81f87f158e` "ADC waveforms").
- Recibir GPIO writes en tiempo real (ya implementado).
- Para P4: el mismo patrón sirve para sensor injection, periféricos custom, etc.

### Otras mejoras útiles para P4
- **`feat: enhance ESP32 cache handling with soft cache option`** (`8bf910d780`) — patrón aplicable a la cache MMU del P4 (que es similar pero más grande).
- **`feat(walker): multi-lap descriptor ring`** (`eb8b7a5d96`) — DMA descriptor walker, P4 lo necesita para GDMA.
- **DMA ring fixes** (varios commits) — directo aplicable a `hw/dma/esp32c3_gdma.c` cuando se clone para P4.

### Features que NO aplican a P4
- WiFi/BLE/ESPNOW emulation (ESP32 Xtensa + C3 only — el P4 no tiene radio nativa).
- ESP32-CAM (OV2640 + I2S DVP) — específico a Xtensa ESP32, no aplica.

## Comparativa final como base para P4

| Criterio | `espressif/qemu` esp-develop | **`davidmonterocrespo24/qemu-lcgamboa`** |
|---|---|---|
| Base QEMU | 9.2.2 | 8.1.3 |
| Template `esp32c3*` para clonar | ✅ similar (~691 LOC) | ✅ similar (~634 LOC) |
| CI multi-plataforma | ❌ | ✅ Linux amd64+arm64, Win, mac Intel+ARM |
| Build como **librería** (libqemu) | ❌ binario | ✅ shared library |
| Auto-publish releases | ❌ | ✅ a `davidmonterocrespo24/velxio` |
| Host-bridge para Velxio | ❌ | ✅ `velxio_*_export.c` pattern |
| Owner controla pace | ❌ Espressif | ✅ vos |
| Track record agregando peripherals nuevos | ❌ | ✅ ESP32-CAM end-to-end |
| Camino a backporting upstream Espressif P4 (cuando llegue) | ✅ directo | ⚠️ rebase manual |

## Veredicto

**Usar `davidmonterocrespo24/qemu-lcgamboa` como base para el work del P4.** El esfuerzo de agregar `hw/riscv/esp32p4.c` es el mismo que sobre `espressif/qemu`, pero:
- La infraestructura de build, packaging y distribución para Velxio ya está resuelta.
- El patrón de host-bridge (`velxio_*_export.c`) que necesitamos para que el frontend reciba GPIO writes etc. ya existe.
- Vos ya demostraste que sabés agregar peripherals nuevos (ESP32-CAM end-to-end).

**Estrategia sugerida:**
1. Branch nueva sobre `picsimlab-esp32`: `feat/esp32p4-machine`.
2. Cuando `espressif/qemu` publique su P4 (issue #127), agregarlo como remote y cherry-pick lo aplicable.
3. Considerar trackear también `lcgamboa/qemu picsimlab-esp32` como upstream secundario para no divergir demasiado.
