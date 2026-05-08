# Phase 2.T-fix — Short-circuit `esp_ota_get_running_partition`

**Estado**: ✅ done — partition busy loop unblocked, exposed downstream
blocker (instruction fetch fault to `0x3FFFF820`).

## Goal

Cerrar el blocker identificado en Phase 2.T:
`esp_ota_get_running_partition` se queda en un `j -50` infinite loop
cuando `esp_partition_find` retorna NULL (partition list vacía + assert
patcheado a silent-ret).

## Lo que SE INVESTIGÓ

### 1. Función entry y flujo

Con `grep '^IN: esp_ota_get_running_partition'` en el log `-d in_asm`,
encontré que el entry de la función es `0x4000549C`. Disasm del
prologue:

```
0x4000549c: addi sp, sp, -32
0x4000549e: sw s3, 12(sp)
0x400054a0: lui s3, 327445             ; s3 = 0x4FF15000
0x400054a4: sw s1, 20(sp)
0x400054a6: lw s1, -1568(s3)           ; s1 = *(0x4FF149E0) = curr_partition static var
0x400054aa: sw ra, 28(sp)
0x400054ac: sw s0, 24(sp)
0x400054ae: sw s2, 16(sp)
0x400054b0: bnez s1, +122 → 0x4000552a ; if curr_partition != NULL, jump to return
```

Layout matches IDF source:
```c
static const esp_partition_t *curr_partition = NULL;
if (curr_partition != NULL) return curr_partition;
```

### 2. El loop real

`esp_partition_find` returns NULL → caller hits `assert(it != NULL)` →
patched silent-ret (Phase 2.K) → fall-through into the while loop
(skipped, it=0) → `abort()` → patched silent-ret again → compiler-
emitted `j -50` (at `0x4000550C`) jumps back to `0x400054DA` (the
assert/abort call site) → infinite loop.

### 3. Caller identification

`grep` para PCs que llaman `0x4000549C`:
```
0x40000dae: jal ra, 18158 → 0x4000549c
```

Caller = `initArduino` at `0x40000dae`. So the partition lookup is
called from initArduino (likely `loopTaskWDTEnabled` or similar
arduino-bridge code).

## Fix implementado

### Approach: replace function entry with 3-instruction stub

```c
0x4000549C: lui  a0, 0x4FFA0       ; a0 = 0x4FFA0000
0x400054A0: addi a0, a0, 0x30      ; a0 = 0x4FFA0030
0x400054A4: jalr x0, 0(ra)         ; ret
```

12 bytes total, overwrites the prologue cleanly. Since we don't touch
sp or callee-saved regs, the caller's frame stays intact.

### Fake `esp_partition_t` struct at `0x4FFA0030`

40 bytes (just past the hello-world string area at 0x4FFA0000-001B):

| Offset | Field      | Value     | Notes                       |
|--------|------------|-----------|-----------------------------|
| +00    | flash_chip | NULL      | many callers don't deref it |
| +04    | type       | APP (0)   | enum esp_partition_type_t   |
| +08    | subtype    | FACTORY 0 | enum esp_partition_subtype_t|
| +0C    | address    | 0x10000   | typical factory app start   |
| +10    | size       | 0x100000  | 1 MB                        |
| +14    | erase_size | 0x1000    | 4 KB                        |
| +18    | label[17]  | "factory" | label[8..16]=0              |
| +29    | encrypted  | 0         |                             |
| +2A    | readonly   | 0         |                             |

## Lo que SÍ funcionó (test con bypass dropped)

Comentando temporalmente Phase 2.N+2.O hello-world bypass para
ejercitar la patch, vimos:

**Antes (Phase 2.T baseline)**: stuck silently in
`esp_ota_get_running_partition::j -50` infinite loop, no UART output.

**Después (Phase 2.T-fix activa)**:
```
[esp32p4] machine init complete ...
Guru Meditation Error: Core  0 panic'ed (Instruction access fault).

Core  0 register dump:
MEPC    : 0x3ffff820  RA      : 0x40028330  SP      : 0x4ff7ffc0
TP      : 0x00000000  T0      : 0x7f7f7fff  T1      : 0x4ff01f68
...
MSTATUS : 0x00001800  MTVEC   : 0x4ff00003  MCAUSE  : 0x00000001
MTVAL   : 0x3ffff820

Stack memory:
... full stack dump ...
```

**Esto es PROGRESO ENORME**: el IDF panic handler completo se ejecutó —
register dump + stack memory dump + UART real, no nuestro inline
writer. Eso significa toda la cadena IDF está corriendo:
- esp_panic_handler ↑ se llamó por el fault.
- esp_console_iruart inicializó.
- printf/UART fueron driveados normalmente.
- vTaskGetSnapshot iteró tasks (aunque sin tasks reales).
- panic_print_str funcionó.

### Nuevo blocker (Phase 2.T-fix.next): PC=0x3FFFF820

`MCAUSE = 0x00000001` (synchronous exception), `MTVAL = 0x3FFFF820`,
`MEPC = 0x3FFFF820`. Eso es **instruction-fetch fault** — el CPU
intentó ejecutar código en `0x3FFFF820`, una dirección no mapeada.

Hipótesis sobre el origen:
- `A1 = 0x40030518`: pointer a un string o struct.
- `A0 = 0x40002FE4`: pointer a IRAM.
- `T1 = 0x4FF01F68`: address en IRAM.
- Maybe `initArduino` después de la fake partition intentó dispatch
  a un function pointer leído del fake struct (e.g., flash_chip→x), y
  ese campo está en NULL → `*(NULL + offset)` → leyó garbage como
  function pointer → jalr to garbage.

## Lo que NO funcionó (intentado)

1. **Pre-poblar `curr_partition` static var en .bss**: pensé en
   patchear `*0x4FF149E0 = 0x4FFA0030` para que el bnez early-exit del
   prologue dispare. RECHAZADO porque .bss se zero-inicializa al
   startup, sobrescribiendo nuestro patch antes de que la función se
   llame.

2. **Patchear `esp_partition_find` para retornar non-NULL**: descartado
   porque retorna un iterator opaco que callers dereferencian; un
   non-NULL garbage pointer crasharía downstream.

## Decisión: keep both demos viable

- **Phase 2.N+2.O hello-world bypass**: restored as default. Demo
  user-visible output preserved.
- **Phase 2.T-fix patches**: kept active in machine init. With the
  hello-world bypass replacing app_main entry, `initArduino` is never
  called, so `esp_ota_get_running_partition` is never invoked, so the
  fake-partition stub sits unused but harmless.
- **To exercise Phase 2.T-fix**: comment out Phase 2.N+2.O patches in
  esp32p4.c and rebuild. Will produce the panic-dump output.

## Lessons learned

1. **Function entry replacement preserves caller frame** as long as
   we only touch caller-saved registers (a0-a7, t0-t6). No need to
   set up our own stack — caller's `ra` is in a register, just `ret`
   to use it.

2. **Compiler emits `j -N` post-noreturn** when noreturn isn't
   declared on the function (or when the noreturn function is
   patched to return). Our silent-ret patches on `__assert_func`
   exposed this — the compiler treated it as "function may return"
   and emitted retry/loop control flow.

3. **Static function-locals in `.bss` are zeroed at C runtime
   startup**: for ESP32-P4 IDF, `__bss_start ... __bss_end` is
   memset-zeroed by the C startup. Pre-populating .bss via runtime
   patch fails. To override a static var, patch the FUNCTION CODE
   instead.

4. **Multiple level of bypass blockers**: peeling one (partition
   loop) reveals the next (instruction fetch fault). Each peel
   requires its own investigation. The PROGRESS metric is "how
   deep into the runtime we reach" — and with this fix, we reach
   the IDF panic handler, which is hundreds of LOC from app entry.

5. **IDF panic handler is excellent diagnostic output**: full
   register dump, stack memory dump, MCAUSE decoded, MTVAL shown.
   When debugging, panicking somewhere KNOWN is more useful than
   silent stalling.

## Next phase (Phase 2.T-fix.next)

Identify the source of the `0x3FFFF820` instruction fetch:
- Run with bypass dropped + `-d in_asm` capture.
- Find the LAST valid PC before MEPC=0x3FFFF820 (the call site that
  loaded the bad target).
- Disassemble around that site to identify what code computed the
  bad target.
- Likely culprits: function pointer read from the fake esp_partition_t
  (e.g., flash_chip→read), or partition iterator dereference.

Mitigation paths:
- Provide a more complete fake esp_partition_t with valid function
  pointers in flash_chip.
- Or patch the specific function that reads the bad pointer.

## Estado consolidado (post-2.T-fix)

| Hito                                                    | Estado       |
|---------------------------------------------------------|--------------|
| ROM banner                                              | ✅           |
| Bootloader runs 6.4s                                    | ✅           |
| App ELF runs (174 fns)                                  | ✅           |
| FreeRTOS scheduler entered                              | ✅           |
| `app_main` reached                                      | ✅           |
| Primer UART output (hello world)                        | ✅           |
| SYSTIMER tick wired                                     | ✅           |
| IRQ delivery a esp_cpu dispatcher                       | ✅ Phase 2.Q |
| Trap to `mtvec` firing (sin crash)                      | ✅ Phase 2.R |
| End-to-end IRQ con MIE persistente                      | ✅ Phase 2.R |
| mtvec mode 3 acceptable + CLIC mtvt dispatch            | ✅ Phase 2.S |
| IDF `_interrupt_handler` runs on every tick             | ✅ Phase 2.S |
| Cache MMU eager-copy translate                          | ✅ Phase 2.B |
| Partition busy-loop unblocked (fake esp_partition_t)    | ✅ Phase 2.T-fix |
| **Full IDF panic handler runs end-to-end**              | ✅ Phase 2.T-fix |
| Real `setup()` runs                                     | ❌ Phase 2.T-fix.next |
| `digitalWrite(LED)` blink visible                       | ❌ Phase 2.U |
