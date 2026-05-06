# 01 — Phase 1: boot + blink + Serial.println

Goal de Phase 1: que el `merged.bin` que ya genera `arduino-cli` arranque en QEMU, llame a `setup()`, `pinMode(2, OUTPUT)`, y vuelque "ESP32-P4 blink starting" + "HIGH/LOW" sobre UART0.

**Crítico**: NO emular nada del SoC que no sea estrictamente necesario para boot + GPIO + UART + delay. Stubs `qemu_log_unimp()` para todo lo demás.

## 1. Branch inicial

Base = el fork del usuario, ya clonado en `third-party/qemu-lcgamboa/` (43 commits ahead de upstream lcgamboa, branch `picsimlab-esp32`). Ver inventario completo en [`02_fork_inventory.md`](02_fork_inventory.md).

```bash
cd third-party/qemu-lcgamboa
git remote add espressif https://github.com/espressif/qemu.git   # para cherry-pick futuros
git checkout -b feat/esp32p4-machine
```

> No se está forkeando un repo nuevo — extendemos el fork ya existente. Las CI workflows actuales (`build-libqemu.yml`) automáticamente compilan `feat/esp32p4-machine` cuando hagamos push, gracias al matcher de branches del workflow (necesita check; si no, ajustar).

## 2. Build local sanity-check (compilar el C3)

Antes de tocar nada, verificar que el build local funciona usando los scripts del fork:

```bash
# Linux/macOS (build-libqemu local)
cd third-party/qemu-lcgamboa
bash build_libqemu-esp32.sh

# Windows
bash build_libqemu-esp32-win.sh
```

Esto produce `libqemu-xtensa.{so,dll,dylib}` + `libqemu-riscv32.{so,dll,dylib}`.

Para test funcional del C3 con binario standalone (no library):
```bash
./configure --target-list=riscv32-softmmu --disable-werror --enable-debug
ninja -C build qemu-system-riscv32
./build/qemu-system-riscv32 -M esp32c3 -nographic
```

Si compila y arranca C3 → entorno ok. Si no → arreglar antes de intentar P4.

## 3. Memory map del P4 (TRM Cap. 7)

Direcciones críticas (extraer del TRM al iniciar; estos son rangos típicos de la familia):

| Región | Base | Tamaño | Notas |
|---|---|---|---|
| ROM (boot ROM Espressif) | `0x4FC00000` | ~256 KB | hay que extraer de un chip real o usar el de `pc-bios/` |
| HP SRAM (L2MEM) | `0x4FF00000` | 768 KB | accesible como cache + código + datos |
| TCM RAM | `0x40800000` | 8 KB | zero-wait |
| Cache MMU window (PSRAM/Flash) | `0x40000000` (instr), `0x48000000` (data) | hasta 32 MB | XIP via cache |
| Peripheral DR_REG | `0x500_0000`–`0x5FF_FFFF` | depende del peripheral | mismo patrón que C3/S3 |

**Acción**: leer Cap. 7.3 del TRM y volcar la tabla completa en `02_memory_map.md`.

## 4. Scope de peripherals para Phase 1

| # | Peripheral | Por qué se necesita | Archivos QEMU a crear/copiar |
|---|---|---|---|
| 1 | **HP CPU core 0** (RV32IMAFC + Zb + Zc) | ejecuta el sketch | reusar `target/riscv/` upstream + posibles custom CSRs (HW loop) |
| 2 | **Memory regions** | irom/drom/iram/dram según memmap | `hw/riscv/esp32p4.c::esp32p4_machine_init()` |
| 3 | **Reset + Clock** (subset) | bootloader primero deshabilita WDT, luego configura PLL | `hw/riscv/esp32p4_clk.c` (mínimo: PLL_FREQ ≈ 400 MHz, XTAL=40 MHz) |
| 4 | **CLIC + CLINT** | interrupts arquitectónicas RV | upstream QEMU tiene CLINT; CLIC posiblemente faltante para P4 (verificar) |
| 5 | **Interrupt Matrix (PERI→CLIC)** | route peripheral IRQ lines | `hw/riscv/esp32p4_intmatrix.c` |
| 6 | **Watchdog (RTC + TIMG)** | hay que poder feed/disable o el reset es infinito | `hw/watchdog/esp32p4_wdt.c` (stub: aceptar writes, ignorar) |
| 7 | **eFuse** (read-only stub) | boot ROM lee CHIP_ID, MAC, package version | `hw/nvram/esp32p4_efuse.c` (stub con valores de un chip real) |
| 8 | **System Timer (SYSTIMER)** | `delay()` y `millis()` | `hw/timer/esp32p4_systimer.c` |
| 9 | **GPIO Matrix + IO MUX** | `digitalWrite()`, `pinMode()` | `hw/gpio/esp32p4_gpio.c` |
| 10 | **UART0** | `Serial.println` | `hw/char/esp32p4_uart.c` (chardev sobre TCP, igual que C3) |
| 11 | **USB Serial/JTAG (Cap 51)** | Arduino default uses USB CDC for Serial when `CDCOnBoot=cdc` | nice-to-have Phase 1, mandatory Phase 2 |

**No tocar en Phase 1**: AES/SHA/RSA/HMAC/ECC, DMA, USB OTG, Ethernet, MIPI, ISP, JPEG, ADC, I2C, SPI, I2S, LEDC, MCPWM, Touch, Temp sensor, RNG, RTC, BitScrambler.

Estrategia para esos: crear `hw/misc/esp32p4_unimp.c` que registra una `MemoryRegion` por base del peripheral, retorna 0 en lecturas y log warning en escrituras. Así el bootloader/IDF arranca sin colgarse.

## 5. Cambios en `hw/riscv/` (relativos a `third-party/qemu-lcgamboa/`)

Archivos nuevos:
- `esp32p4.c` — derivado de `esp32c3.c` (634 LOC base). Renombrar `Esp32C3MachineState` → `Esp32P4MachineState`, ajustar `memmap[]`, instanciar peripherals según tabla §4.
- `esp32p4_picsimlab.c` — derivado de `esp32c3_picsimlab.c` (1083 LOC). Variante con bridges Velxio (host-call exports). **Esta es la que Velxio cargará como libqemu**.
- `esp32p4_clk.c` / `.h` — derivar de `esp32c3_clk.c` (179 LOC). PLL targets distintos: 400 MHz HP, 40 MHz LP, XTAL típicamente 40 MHz.
- `esp32p4_intmatrix.c` / `.h` — derivar de `esp32c3_intmatrix.c` (426 LOC). Verificar TRM Cap 12: el P4 tiene Interrupt Matrix + CLIC + CLINT (los tres). El intmatrix routea peripheral IRQs a CLIC inputs.

Archivos a modificar:
- `hw/riscv/meson.build` — agregar `'esp32p4.c', 'esp32p4_clk.c', 'esp32p4_intmatrix.c', 'esp32p4_picsimlab.c'` con flag `CONFIG_ESP32P4`.
- `hw/riscv/Kconfig` — `config ESP32P4 bool select RISCV32_CPU select ESP32P4_PERIPHS`.
- `configs/devices/riscv32-softmmu/default.mak` — `CONFIG_ESP32P4=y`.

Archivos del lado del bridge Velxio (siguiendo el patrón de `velxio_camera_export.c`):
- `hw/misc/velxio_p4_export.c` — host-call symbols para inyectar/recibir GPIO writes, ADC values, sensor data desde Velxio backend.

## 6. Validación

### Smoke 1: ROM boot loop
QEMU arranca sin firmware. Output esperado: el bootloader stage 0 inmediatamente intenta leer flash y logea por UART. Mensaje "ESP-ROM:..." debería aparecer.

### Smoke 2: Stage 2 bootloader corre
Cargar `merged.bin` (4 MB con `boot+partitions+app`) vía:
```bash
qemu-system-riscv32 -M esp32p4 -drive file=merged.bin,if=mtd,format=raw -nographic
```
Output esperado: log de Espressif "rst:0x1 (POWERON_RESET), boot:..." en UART. Boot ROM → bootloader → partition table.

### Smoke 3: setup() ejecuta
El log debería mostrar el `Serial.println("ESP32-P4 blink starting")` del sketch.

### Smoke 4: GPIO toggle visible
Activar trace en GPIO writes (`-d unimp,trace:esp32p4_gpio_*`). Verificar que cada `digitalWrite(2, HIGH)` provoca write a `GPIO_OUT_W1TS_REG` con bit 2 seteado.

## 7. Integración Velxio (después de Smoke 3)

Como Velxio carga `libqemu-riscv32` directamente (no spawn de proceso), la integración es:

`backend/app/services/esp_qemu_manager.py`:
```python
_MACHINE = {
    'esp32':    ('xtensa',  'esp32_picsimlab'),
    'esp32-c3': ('riscv32', 'esp32c3_picsimlab'),
    'esp32-p4': ('riscv32', 'esp32p4_picsimlab'),  # ← una línea
}
```

Bootloader offset en P4 (verificar contra `flash_args` que produce `arduino-cli` — ver `03_compilation_test.md` §6 del autosearch).

`frontend/src/types/board.ts`: agregar `'esp32-p4'`. `boardPinMapping.ts`: 55 pines según datasheet.

CI auto-compila la nueva binary y la publica al release `qemu-prebuilt` cuando hagamos push de `feat/esp32p4-machine` a `picsimlab-esp32` (vía PR merge), gracias al workflow `build-libqemu.yml`.

## 8. Cuándo Phase 1 está hecho

✅ Compilamos blink con `arduino-cli compile --fqbn esp32:esp32:esp32p4`
✅ Lanzamos `qemu-system-riscv32 -M esp32p4 -drive file=merged.bin,if=mtd -nographic`
✅ Vemos "ESP32-P4 blink starting" + "HIGH" + "LOW" alternándose cada 500 ms en stdout
✅ Velxio dropdown muestra "ESP32-P4" → click Run → mismo output en Serial Monitor

## Referencias

- `../specs/esp32-p4_technical_reference_manual_en.pdf` — fuente única de verdad para memory map y registros
- `../specs/_TRM_TOC.txt` — índice del TRM (1713 entradas)
- `https://github.com/espressif/qemu/blob/esp-develop/hw/riscv/esp32c3.c` — template
- `https://github.com/espressif/qemu/issues/127` — issue oficial pidiendo P4 support
- `https://www.qemu.org/docs/master/devel/qom.html` — QEMU Object Model (necesario para device hierarchy)
