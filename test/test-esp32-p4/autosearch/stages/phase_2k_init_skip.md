# Phase 2.K.init_skip — Skip do_system_init_fn calls in start_cpu0

**Estado**: ✅ done · commit `53f8358abb`

## Goal

El IDF runtime's `start_cpu0_default` (en `0x400091e8`) llama dos veces a `do_system_init_fn` que itera sobre todas las funciones registradas como `__esp_system_init_fn_*`. Bajo TCG sin peripherals completos, cada init function ejecuta lentamente y el grand total es prohibitivo (heap_caps_init sola hacía memcpy de KB sin terminar en wall time razonable).

## Fix

Runtime patches: NOP de los dos `jal do_system_init_fn`:
- `0x400091F2`: `0xf59ff0ef` (jal -167) → `0x00000013` (nop)
- `0x4000923A`: `0xf11ff0ef` (jal -239) → `0x00000013` (nop)

`start_cpu0` ahora salta directo a:
1. `__register_frame_info` (registra exception frames)
2. C++ init array iteration (static constructors)
3. `startup_resume_other_cores` (no-op para single-core)
4. `s_system_full_inited = 1`
5. `esp_startup_start_app` → `vTaskStartScheduler`

## Resultado

Skipea ~30+ init functions que estaban consumiendo segundos de wall time cada una. El app **alcanza el C++ static init array** y los **constructors estáticos ejecutan**:
- `pthread_mutex_init_if_static`, `pthread_mutex_init`
- `pthread_mutex_lock`, `pthread_mutex_unlock`
- FreeRTOS port functions: `xPortSetInterruptMaskFromISR`, `vPortClearInterruptMaskFromISR`, `xPortEnterCriticalTimeout`, `xPortInIsrContext`

Esto es código **post-`do_system_init_fn`** que antes nunca alcanzábamos. La app está iterando muchos C++ constructors con thread-safe singleton init.

## Trade-off

Sin `do_system_init_fn`, peripherals quedan parcialmente inicializados:
- Heap caps no completamente registrado (puede fallar mallocs grandes).
- Peripheral clocks no enabled (puede fallar UART/SPI/I2C).
- App info, cpu freq, efuse checks no ejecutados.

Pero la base **CPU + memory + cache MMU + SYSTIMER + flash blob** ya está working. Si el app code (Arduino blink) sólo usa GPIO (LED toggle) sin malloc grande ni periphs sofisticados, debería funcionar.

## Próximo blocker

Después de los C++ constructors, `esp_startup_start_app` llama `vTaskStartScheduler`. Eso necesita:
1. CLIC interrupt delivery al CPU (M-mode external IRQ).
2. SYSTIMER comparator → IRQ tick para preemption.
3. FreeRTOS port idle/main task crear y schedulear.

Phase 2.K.scheduler implementa esto. Estimado ~150-300 LOC.

## Archivos tocados

- `hw/riscv/esp32p4.c`: 24 LOC nuevos (2 runtime patches + comments).
