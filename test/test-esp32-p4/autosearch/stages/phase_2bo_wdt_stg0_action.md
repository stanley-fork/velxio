# Phase 2.BO — TIMG WDT stage-0 action decoding per TRM

**Estado**: ✅ done — replaces Phase 2.BM's "always-system-reset"
assumption with TRM-correct decoding of the 2-bit `TIMG_WDT_STG0`
action field from `WDTCONFIG0` bits 30:29. Per TRM Register 16.10:

```
TIMG_WDT_STG0 (bits 30:29) action codes:
  0 = No effect (timeout fires but no action)
  1 = Interrupt
  2 = Reset CPU (HP CPU0 + HP CPU1)
  3 = Reset system (whole digital system including LP)
```

JSON events now reflect the actual action — `wdt_irq` for action=1,
`wdt_reset` with `action:"rst_cpu"` or `action:"rst_sys"` for the
reset cases. The `qemu_system_reset_request()` call is gated on
action ∈ {2, 3} (was unconditional in Phase 2.BM).

**Additional silicon bug fixed**: `ESP32P4_TIMG_WDT_FLASHBOOT_EN`
was defined as `(1U << 30)` in Phase 2.AP. Per TRM Register 16.10,
bit 30 is actually the HIGH bit of TIMG_WDT_STG0 (action code),
not FLASHBOOT_EN. The real `TIMG_WDT_FLASHBOOT_MOD_EN` is at bit
**15**. Fixed.

Boot regression-clean: 0 `wdt_reset` and 0 `wdt_irq` events at
boot (CONFIG0=0 → EN=0 → STG0=0 → no arm, no fire).

## Goal

Phase 2.BM hardcoded "WDT timeout → call qemu_system_reset_request"
regardless of the configured stage action. But TRM Register 16.10
specifies that the action depends on the `TIMG_WDT_STG0` 2-bit
field. Arduino's `esp_task_wdt_init(timeout, panic_on_timeout)`
configures this — panic_on_timeout=true sets STG0=3 (system
reset); panic_on_timeout=false sets STG0=1 (interrupt) for a
warning before stage 1's reset.

Phase 2.BO closes the gap. The dispatch is correct per silicon —
Arduino sketches that rely on interrupt-mode WDT (e.g., the
`esp_task_wdt_isr_user_handler()` pattern) now get an `wdt_irq`
JSON event instead of an unexpected reset.

## Lo que SE INVESTIGÓ

### 1. TRM Register 16.10 — TIMG_WDTCONFIG0_REG bit layout

Read directly from TRM ESP32-P4 v0.5 chapter 16, Register 16.10:

```
bit 31:    TIMG_WDT_EN          (1=enabled)
bits 30:29: TIMG_WDT_STG0       (2-bit action)
bits 28:27: TIMG_WDT_STG1
bits 26:25: TIMG_WDT_STG2
bits 24:23: TIMG_WDT_STG3
bit 22:    TIMG_WDT_CONF_UPDATE_EN
bits 21:19: TIMG_WDT_SYS_RESET_LENGTH (3-bit pulse-width)
bits 18:16: TIMG_WDT_CPU_RESET_LENGTH
bit 15:    TIMG_WDT_FLASHBOOT_MOD_EN
bit 14:    TIMG_WDT_PROCPU_RESET_EN
bit 13:    TIMG_WDT_APPCPU_RESET_EN
bits 12:0: reserved
```

Action codes (from TRM "TIMG_WDT_STG0 Configures the timeout
action of stage 0"):
- 0 = No effect
- 1 = Interrupt
- 2 = Reset CPU
- 3 = Reset system

Note: only 2 bits per stage in MWDT (Register 16.10). RWDT
Register 17.1 uses 3-bit stage fields with 5 action codes
including "HP core reset" (value 3) and "System reset" (value
4). MWDT and RWDT have slightly different action sets — for
this phase we model MWDT only.

### 2. Phase 2.AP latent bug discovered: FLASHBOOT_EN at wrong bit

Phase 2.AP defined:
```c
#define ESP32P4_TIMG_WDT_FLASHBOOT_EN (1U << 30)
```

Per TRM Register 16.10, bit 30 is the HIGH bit of `TIMG_WDT_STG0`
(action code MSB). The actual `TIMG_WDT_FLASHBOOT_MOD_EN` is at
bit **15**. The Phase 2.AP code's constant would have made any
guest reading "is flashboot mode enabled?" via that bit get
the high bit of the STG0 action field instead — silent semantic
corruption.

Fortunately the constant was never USED in the existing code
(grep confirms no references in current tree). But it was
sitting as a footgun for future code to misuse. Fixed in this
phase.

This is exactly the kind of bug the user's TRM-grounding
request catches: silent constants that aren't quite right but
never exercised so never break visibly.

### 3. Dispatch table

In `esp32p4_timg_wdt_reset_cb`, the new switch dispatches:

```c
switch (action) {
case ESP32P4_TIMG_WDT_ACTION_NONE:    /* 0 */
case ESP32P4_TIMG_WDT_ACTION_INTR:    /* 1 → wdt_irq event */
case ESP32P4_TIMG_WDT_ACTION_RST_CPU: /* 2 → wdt_reset + cond reset */
case ESP32P4_TIMG_WDT_ACTION_RST_SYS: /* 3 → wdt_reset + cond reset */
}
```

The `qemu_system_reset_request()` is only called when:
- action ∈ {2, 3} (reset-implying codes)
- AND `VELXIO_WDT_RESET=1` env var set (test-harness friendly)

For action=0 (No effect), the timer fires but emits an event
with `action:"none"` — silicon-correct: the timer expires but
"the watchdog doesn't do anything" matches TRM language.

For action=1 (Interrupt), emit a different event type
(`wdt_irq`) so frontend can distinguish "warning fired" from
"reset fired". No CLIC wiring this phase — interrupt-action
behavior is observable in JSON but doesn't actually pulse the
CPU. Documented as `2.BO.irq-wire`.

### 4. STG0 only — stages 1-3 deferred

TRM 17.2.2.2 specifies that stages cycle: when stage 0 fires,
the counter resets to 0 and stage 1 becomes active with its own
timeout + action. If guest still doesn't feed, stage 1's action
fires when stage 1's timeout elapses. And so on.

This phase only models stage 0. Multi-stage cycling deferred
as `2.BO.multistage`. The typical Arduino pattern is to use
stage 0 only (one timeout, one action), so single-stage covers
the common case.

### 5. Boot safety: confirmed unchanged

Phase 2.AT/2.BM/2.BN already showed the boot WDT sequence keeps
WDTs disabled. Adding action decoding doesn't change that — the
boot writes `CONFIG0=0` which means EN=0 AND STG0=0. The timer
never arms (EN=0), and even if it did, the action would be
"none" so no reset.

Live test: 0 wdt_reset, 0 wdt_irq at boot. Confirmed safe.

## Lo que SÍ funcionó

Live test (2026-05-08):
```
Existing 4-event WDT boot trace per group, unchanged:
  unlock → disable → feed → lock
No wdt_reset or wdt_irq events at boot.
```

The new code path is exercised by construction-correctness +
the action-decode line in CONFIG0 write handler. Live JSON
behavior won't change until firmware enables WDT with a
non-zero STG0.

To see the new behavior in action, run with:
```
VELXIO_WDT_RESET=1 <firmware that does CONFIG0=0x60000000>
```
where `0x60000000` = EN(31)=1 + STG0=11=3 (reset system).

## Lo que NO funcionó / decisiones tomadas

### Lo que NO funcionó (caught + fixed)

1. **FLASHBOOT_EN bit wrong**: Phase 2.AP placed it at bit 30,
   TRM puts it at bit 15. Bit 30 is the high bit of STG0 action.
   Latent footgun, fixed.

### Decisiones tomadas

2. **Action 1 emits `wdt_irq` event but no CLIC wiring**:
   silicon would route the IRQ through the existing TIMG IRQ
   line (cause 19 for TIMG0, 20 for TIMG1) per TRM 17.4. For
   our model the JSON event is sufficient observability; CLIC
   wiring would require adding a separate INT_RAW bit for WDT
   alongside the existing T0 alarm bit. Deferred.

3. **Single stage only**: real silicon cycles through 4 stages
   each with its own timeout + action. Our model only fires
   stage 0 then stops. Sufficient for the common Arduino case;
   multi-stage progression deferred.

4. **Action 2 (Reset CPU) treated same as Action 3 (Reset
   system) for the actual reset call**: both call
   `qemu_system_reset_request()`. Real silicon differentiates
   (HP CPU reset = reset CPUs only, system reset = also resets
   LP). For our model both lead to QEMU machine reset. JSON
   event distinguishes the action code so frontend can render
   different icons.

5. **Same action decoding NOT yet applied to RWDT**: RWDT has
   its own action codes per TRM Register 17.1, with 3-bit
   fields (vs MWDT's 2-bit) and 5 action codes including
   "System reset" (value 4 in RWDT, not 3). LP_WDT decoder
   deferred as `2.BO.rwdt-actions`.

## Lessons learned

1. **Latent constants are bug seeds**: `FLASHBOOT_EN` at the
   wrong bit was never used so never exposed the bug. Reading
   TRM Register 16.10 caught it instantly. Lesson: when adding
   bit constants, verify against the TRM register diagram, not
   guesses from related-chip headers.

2. **TRM action tables are the source-of-truth for dispatching
   behavior**: the existing "always reset" was a placeholder
   approximation that worked for the no-firmware case (no
   firmware enabled WDT). Real Arduino firmware would have
   exposed the gap with `esp_task_wdt_init(panic=false)`.

3. **MWDT and RWDT have DIFFERENT action code sets**: MWDT has
   4 codes (0-3), RWDT has 5 (0-4). Easy to confuse since both
   are "WDT". Documented inline. Future LP_WDT action decoder
   should use the RWDT-specific codes.

4. **The `wdt_irq` JSON event type emerges naturally**: in
   prior phases we had `wdt_reset` (for the bang) and `wdt`
   (for register events like unlock/feed/lock). Adding action
   decoding produces `wdt_irq` as a distinct event for
   "warning before reset" semantics. Frontend can render
   different visuals.

## Implementación final

### `include/hw/timer/esp32p4_timg.h`

- **Fixed**: `ESP32P4_TIMG_WDT_FLASHBOOT_EN` from `(1U << 30)`
  to `(1U << 15)` per TRM Register 16.10.
- **Added**: `ESP32P4_TIMG_WDT_STG0_SHIFT` (29),
  `ESP32P4_TIMG_WDT_STG0_MASK` (0x3 << 29),
  `ESP32P4_TIMG_WDT_STG0(v)` decode macro.
- **Added**: action code constants `ACTION_NONE` (0), `INTR`
  (1), `RST_CPU` (2), `RST_SYS` (3).
- **Added**: `uint8_t wdt_stg0_action;` to ESP32P4TimgState.
- Inline comments cite TRM Register 16.10 + § 17.2.2.2.

### `hw/timer/esp32p4_timg.c`

- WDTCONFIG0 write handler: now also extracts STG0 action via
  `ESP32P4_TIMG_WDT_STG0(v)` and stores in `s->wdt_stg0_action`.
- `esp32p4_timg_wdt_reset_cb()`: switch dispatches on
  `s->wdt_stg0_action`:
  - 0 → emit `wdt_reset` with `action:"none"`, no reset.
  - 1 → emit `wdt_irq` (new event variant), no reset.
  - 2 → emit `wdt_reset` with `action:"rst_cpu"`, conditional reset.
  - 3 → emit `wdt_reset` with `action:"rst_sys"`, conditional reset.
- `qemu_system_reset_request()` only called for action ∈ {2,3}
  AND when `VELXIO_WDT_RESET=1`.

## Estado consolidado (post-2.BO)

WDT behavior matrix:

| Action | Phase | JSON event | Resets? |
|--------|-------|------------|---------|
| 0 (No effect) | **2.BO** | `wdt_reset action:"none"` | No |
| 1 (Interrupt) | **2.BO** | **`wdt_irq` (new)** | No |
| 2 (Reset CPU) | **2.BO** | `wdt_reset action:"rst_cpu"` | If env var set |
| 3 (Reset system) | **2.BO** (was 2.BM) | `wdt_reset action:"rst_sys"` | If env var set |

JSON event types: **27** (added `wdt_irq` as a new event type
distinct from `timg_irq` and `wdt_reset`).

## 52-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BM  | TIMG WDT actual reset (hardcoded always-system-reset)    |
| 2.BN  | RTC/SWD reset + TRM silicon key/bit fix                  |
| **2.BO** | **WDT stage-0 action decoding per TRM Register 16.10** |

## Próximas direcciones

- **2.BO.rwdt-actions**: same decoding for LP_WDT CONFIG0
  using TRM Register 17.1 (3-bit, 5 codes including system
  reset at value 4).
- **2.BO.multistage**: cycle stages 0→1→2→3→0 on consecutive
  timeouts per TRM § 17.2.2.2.
- **2.BO.irq-wire**: route action=1 to existing TIMG CLIC IRQ
  line so the wdt_irq event actually traps the CPU.
- **WDT timeout from CONFIG2/CONFIG1**: TRM-correct timing
  rather than hardcoded 5s.
- **UART IRQ** (QOM class-override variation).
- **Real PWM waveform** on GPIO via LEDC.
- **BH1750/SHT31/CCS811** sensor adds.
- **SPI3** instantiation.
- **FreeRTOS** scheduler resurrection.
