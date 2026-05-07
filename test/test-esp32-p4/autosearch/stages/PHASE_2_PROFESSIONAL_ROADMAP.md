# Phase 2 — Professional Implementation Roadmap

**Goal:** producir un emulador ESP32-P4 nivel-producción para QEMU, con periféricos implementados según TRM (no hacks, no patches al firmware, no overrides per-address). El IDF runtime debe correr exactamente igual que en silicio real — bootloader → setup() → loop() — sin parches.

## Principio rector

**Reemplazar todos los hacks de Phase 1 con implementaciones reales basadas en el TRM.** Cada hack actual está documentado; cuando su peripheral correspondiente se implementa, el hack se borra.

| Hack actual | Peripheral que lo reemplaza | Phase |
|---|---|---|
| `__assert_func` no-op patch | TIMG WDT + clock tree → no asserts | 2.B |
| `cache_hal_is_cache_enabled` patch | Cache MMU real | 2.A |
| `bootloader_flash_*` patches (3 funciones) | Cache MMU + flash blob loader | 2.A |
| `system_early_init` skip-core-1 patch | Multi-core HP CPU | 2.G |
| Smart-stub overrides (5 entries) | TIMG / Reset_Clock / HP_SYSREG reales | 2.B |
| HP ROM ret-fill | Real Espressif ROM ELF (ya cargado en Phase 1.E.bis) | done |
| ELF PF_X overlay pass | Cache MMU translate properly | 2.A |
| `-kernel` trampoline | Boot from real merged.bin via cache MMU | 2.A |

## Plan por fase

### Phase 2.A — Cache MMU + flash boot (THIS SESSION'S TARGET)

**Goal:** la CPU bootea desde `0x40000000+` (cache window) leyendo contenido de flash. El bootloader Espressif corre desde flash offset 0x2000.

**Artefactos:**
- `hw/misc/esp32p4_cache.c` — controller con registers MMU.
- `hw/misc/esp32p4_mspi.c` — MSPI controller (interfaz al flash physical).
- Modify `hw/riscv/esp32p4.c` — quitar PF_X overlay, quitar trampolín, quitar runtime patches relacionados con flash. Boot directo desde cache window.
- Aceptar `-drive file=merged.bin,if=mtd` y conectarlo via MSPI.

**Acceptance:** `qemu ... -drive file=merged.bin,if=mtd` (sin `-kernel`, sin `-bios` requerido si HP ROM blob está disponible) bootea hasta el bootloader stage 2 ejecutando contenido real de flash.

**Effort:** estimado 800-1200 LOC + ~3-5 días de implementación + debug.

### Phase 2.B — TIMG (Timer Group + WDT) real

**Goal:** WDT acepta unlock+disable correctamente. General-purpose timers cuentan ciclos. Genera IRQs cuando se programa.

**Artefactos:**
- `hw/timer/esp32p4_timg.c` — clone del C3 + adaptación para P4.
- `include/hw/timer/esp32p4_timg.h`.
- Wire IRQ lines (esperan a Phase 2.D).

**Acceptance:** test program escribe WDT disable sequence; QEMU acepta y no resetea. General timer `T0` cuenta correctamente.

**Effort:** ~400 LOC, 1-2 días.

### Phase 2.C — HP_SYSREG + Reset/Clock real

**Goal:** clock tree config real. PLL_LOCK se setea cuando software escribe PLL_EN. Peripheral clock gates funcionan.

**Artefactos:**
- `hw/misc/esp32p4_hp_sysreg.c` (TRM Cap 20).
- `hw/misc/esp32p4_pcr.c` — Power Control Register / Reset and Clock (TRM Cap 10).
- Borrar smart_stub overrides para estas direcciones.

**Acceptance:** `rtc_clk_init`, `esp_clk_init`, `bootloader_clock_configure` completan sin necesidad de overrides.

**Effort:** ~600 LOC, 2-3 días.

### Phase 2.D — CLIC + Interrupt Matrix

**Goal:** IRQs reales. Peripheral genera IRQ → INTMTX routes → CLIC → CPU vectors al handler correcto.

**Artefactos:**
- `hw/intc/esp32p4_clic.c` — RISC-V CLIC implementation (parte std, parte custom Espressif). TRM Cap 1.9.
- `hw/riscv/esp32p4_intmtx.c` — Interrupt Matrix (TRM Cap 12).
- `target/riscv/esp_cpu.c` — borrar custom CSR scratch hack para mtvt/mintstatus/etc, implementar real.
- Wire IRQ lines de UART, SYSTIMER, TIMG, etc.

**Acceptance:** FreeRTOS tick funciona. UART RX desde stdin genera IRQ y el sketch puede leer con `Serial.read()`.

**Effort:** ~1000 LOC, 3-5 días.

### Phase 2.E — eFuse extended

**Goal:** retornar valores realistas para chip rev, package version, MAC, BLK0 system data.

**Artefactos:**
- Extender `hw/nvram/esp32p4_efuse.c` con TRM Cap 8 register layout completo.

**Acceptance:** `esp_chip_info()` devuelve `{model: ESP32-P4, cores: 2, revision: 1.x}`. `esp_efuse_mac_get_default()` devuelve MAC válida.

**Effort:** ~250 LOC, 1 día.

### Phase 2.F — SYSTIMER complete

**Goal:** 3 comparadores + IRQs por unit. FreeRTOS tick + Arduino `millis()`/`micros()` funcionan.

**Artefactos:**
- Reemplazar `hw/timer/esp32p4_systimer.c` (actual mínimo) con clone full del C3 + adaptaciones P4 (TRM Cap 15).

**Acceptance:** FreeRTOS tick fires periódicamente, scheduler corre tasks.

**Effort:** ~600 LOC, 2 días.

### Phase 2.G — GPIO real + IO MUX (full)

**Goal:** `digitalWrite`, `digitalRead`, GPIO IRQs (rising/falling/level), IO MUX para cualquier pin → cualquier signal.

**Artefactos:**
- Extender `hw/gpio/esp32p4_gpio.c` con full pin set (55 GPIOs) + IRQ generation + IO MUX (TRM Cap 9).
- `hw/misc/esp32p4_io_mux.c`.

**Acceptance:** sketch puede usar `digitalRead(pin)` con valor controlado desde Velxio host. `attachInterrupt` funciona.

**Effort:** ~800 LOC, 3 días.

### Phase 2.H — UART complete (todos los puertos + IRQ wiring + RX desde host)

**Goal:** UART0..UART4 + LP_UART todos instanciados con IRQ wiring real. RX desde host stdin genera IRQ.

**Artefactos:**
- Update `hw/riscv/esp32p4.c` para instanciar todos UARTs.
- IRQ wiring (espera a Phase 2.D).

**Acceptance:** Serial Monitor de Velxio puede write Y read.

**Effort:** ~150 LOC + IRQ work.

### Phase 2.I — RNG, USB Serial/JTAG, miscellaneous

**Goal:** completar peripherals chicos que el IDF runtime usa.
- RNG (TRM Cap 33) — para `esp_random()`.
- USB Serial/JTAG (TRM Cap 51) — Arduino default Serial cuando `CDCOnBoot=cdc`.
- Cryptography accelerators (AES, SHA, RSA, HMAC) — clone del C3, mismo IP block.

**Effort:** ~800 LOC total, 3-4 días.

### Phase 2.J — Multi-core (HP CPU 1 + LP CPU)

**Goal:** dual-core HP + LP. Borrar `system_early_init: skip core-1 wait` patch.

**Artefactos:**
- `hw/riscv/esp32p4.c` — instanciar 2 HP cores + 1 LP core.
- Inter-core sync: LP Mailbox, IPI.

**Effort:** ~500 LOC, 2-3 días.

### Phase 2.K — General-purpose peripherals para Arduino

- I2C (TRM Cap 44) — para `Wire`.
- SPI master (TRM Cap 43) — para `SPI`.
- LEDC (TRM Cap 55) — para `ledcWrite()`.
- ADC (TRM Cap 62) — para `analogRead()`.
- RMT (TRM Cap 57) — para NeoPixel.

**Effort:** ~3000 LOC total, 1 semana.

## Out of scope — Phase 3+

- MIPI-CSI/DSI (TRM Cap 40): muy específicos, raramente usados.
- ISP, JPEG, H264 (TRM Cap 35-37, 39): out of scope.
- USB OTG HS/FS (TRM Cap 49-50): trabajo enorme.
- Ethernet RMII (TRM Cap 52).

## Estimación total Phase 2

~10000-12000 LOC, 4-6 semanas tiempo full-time. Con sesiones intermitentes ~2-3 meses calendario.

Cada peripheral se commitea por separado con tests dedicados. Al cierre de Phase 2:
- Cero hacks/patches/overrides en `esp32p4.c`.
- IDF runtime ejecuta exacto como real silicon.
- Blink end-to-end funciona desde merged.bin sin trampoline.
- Cualquier sketch Arduino IDF razonablemente complejo funciona.

## Quality bar

Para cada peripheral:
1. **TRM citation**: comentarios en código apuntando a Cap.Section específica.
2. **Register decoder por offset**: switch/case, no scratch RW.
3. **Bit-level field semantics**: cada bit definido en TRM tiene su comportamiento.
4. **Tests**: smoke tests que ejercitan registers principales.
5. **No hardcoded magic constants** — usar `#define` con nombres del TRM.
6. **IRQ wiring**: cada IRQ source conectado a INTMTX correctamente.

## Cómo medir progreso

Cada peripheral implementado:
- ✅ "Hacks removed" count: total al inicio = 5 (smart-stub overrides) + 5 (runtime patches) + 1 (PF_X overlay) + 1 (trampolín) = **12**. Goal: 0.
- ✅ Trace de IDF execution sin requerir patches.
- ✅ % de TRM Cap implementado por peripheral (tracked en cada `phase_2_X.md`).
