# Phase 2.L.next — Bump allocator + vSystimerSetup bypass

**Estado**: ✅ done · commit `08e104d6bb`

## Goal

Después de Phase 2.L (idle task con buffers estáticos), los siguientes blockers eran:
1. `pvPortMalloc` → `heap_caps_malloc` returnaba NULL para todas las allocs subsecuentes (tasks, queues) → `heap_caps_alloc_failed` → abort.
2. `vSystimerSetup` (FreeRTOS port tick setup) llamaba `esp_intr_alloc` que fallaba → `_esp_error_check_failed` → abort.

## Fixes

### Fix 1 — Inline bump allocator (replaces pvPortMalloc)

Reemplazo `pvPortMalloc` con un bump allocator inline en iram0.text. Layout:

- `pvPortMalloc[0]` (`0x4FF06FF6`): `c.j +18` (`0xA809`) jumps to bump alloc.
- `xPortCheckValidListMem` (`0x4FF07004`): stub `c.li a0, 1; c.ret` (`0x80824505`) — siempre valida.
- `bump_alloc` (`0x4FF07008-0x4FF07037`, 48 bytes): 12 instrucciones implementan bump alloc con state en `0x4FF61000` (4-byte word) y pool en `0x4FF61010..0x4FF80000` (~125 KB).

**Bug histórico**: encoder de `bgeu t1, t2, +4` (offset incorrecto) → corregido a `+8` para correctamente skipear el init-mv.

**PMP gotcha**: primer intento puso bump_alloc en `0x4FF65000` que falló con PMP violation. La región IDF allow-execute es solamente iram0.text. Mover el código a `0x4FF07008` (dentro de iram0.text) lo arregló.

### Fix 2 — vSystimerSetup ESP_ERROR_CHECK bypass

`vSystimerSetup` (FreeRTOS port @ `0x4FF070BC`) llama `esp_intr_alloc` para SysTick handler. Sin CLIC IRQ routing real, falla. Patch `c.beqz a0, 0x4FF0710E` (`0xC10D`) con `c.j +34` (`0xA00D`) en `0x4FF070EC` para skipear el error path.

## Resultado

- **`vTaskStartScheduler` runs to completion + returns**.
- `xPortStartScheduler` ejecuta totalmente: `vListInitialise`, `vListInitialiseItem`, `vPortYield`, `vPortSetupTimer`, `systimer_hal_init`, `xTimerCreateTimerTask`, etc.
- **138 unique IDF runtime functions** ejecutan.
- **No abort, no panic, no PMP violations**.
- CPU termina en busy-loop `j 0x4000925a` después de que `start_cpu0_default` recupera tras vTaskStartScheduler return.

## Próximo blocker

`main_task` aún no ejecuta. La razón: el FreeRTOS port-level context switch usa interrupts CLIC para el primer task dispatch. Sin IRQ delivery real al CPU, `portRESTORE_CONTEXT` (asm) no puede saltar al primer task.

**Phase 2.M** — implementar real CLIC IRQ delivery:
1. Extender `Esp32P4Clic` con `qemu_irq cpu_irq` output.
2. Connectarlo a `qdev_get_gpio_in(cpu, IRQ_M_EXT)`.
3. Cuando se setea un IRQ pending+enabled en CLIC, raise el output.
4. SYSTIMER alarm comparator → IRQ pending (FreeRTOS tick).

Estimado ~150-300 LOC. Esa es la pieza FINAL que destrabaría task switching → main_task → app_main → setup() → loop() → primer UART output.

## Estado consolidado

| Métrica | Sesión inicio | Sesión fin |
|---|---|---|
| ROM banner imprime | ❌ panic | ✅ |
| FreeRTOS scheduler entered | ❌ | ✅ |
| Tasks creadas | ❌ | ✅ via bump alloc |
| `xPortStartScheduler` ejecutado | ❌ | ✅ end-to-end |
| `main_task` ejecuta | ❌ | ⏭️ Phase 2.M (CLIC IRQ) |
| `app_main` / `setup()` | ❌ | ⏭️ después de 2.M |

**Estamos a UNA pieza de implementación de ver el primer UART output del Arduino blink**.
