# Phase 2.AS — Relocate peripherals to real-silicon addresses

**Estado**: ✅ done — TIMG0/TIMG1/I2C0/SPI2 moved from placeholder
addresses to the actual ESP32-P4 silicon addresses per IDF
`reg_base.h`. Bonus: discovered (and fixed) a memory-region priority
collision and the bootloader rtc_clk_cal_done bit dependency on the
overlaid smart_stub. Final test reproduces all Phase 2.AR event
counts with peripherals at silicon-correct locations.

## Goal

Phase 2.AR identified that several of our peripheral devices were at
placeholder addresses, not the addresses real ESP32-P4 silicon (and
therefore real Arduino IDF code) uses. Without relocation, any future
guest sketch that touches `TIMG0_REG_BASE` or `I2C0_REG_BASE` would
hit unimplemented_device stubs instead of our models — silently
absorbing writes, returning zero on reads.

This phase fixes the addressing.

## Lo que SE INVESTIGÓ

### 1. Real ESP32-P4 silicon addresses (per IDF reg_base.h)

The existing `create_unimplemented_device("...", BASE, SIZE)` calls in
the same file revealed the IDF-canonical addresses:

| Peripheral | Phase  | Old address (ours) | Real silicon (IDF) |
|------------|--------|--------------------|--------------------|
| TIMG0      | 2.AG   | 0x500BC000         | **0x500C2000**     |
| TIMG1      | 2.AN   | 0x500C0000         | **0x500C3000**     |
| I2C0       | 2.AM   | 0x500D2000         | **0x500C4000**     |
| SPI2       | 2.AO   | 0x500CC000         | **0x500D0000**     |
| LEDC       | 2.AC   | 0x500D3000         | 0x500D3000 ✓       |
| ADC        | 2.AD   | 0x500DE000         | 0x500DE000 ✓       |

LEDC and ADC happened to be at the right addresses already (the
`create_unimplemented_device` stubs at those addresses were named
matching our devices and at the same MMIO bases — pure coincidence).

The placeholder I2C address `0x500D2000` was particularly wrong —
that's actually the **USB Serial/JTAG** controller region per IDF.

### 2. Memory-region priority collision

After moving TIMG0 to 0x500C2000 and TIMG1 to 0x500C3000, the test
broke: timg_irq events dropped from 38 to 2 (only level=1
transitions, no level=0 paired with them — meaning ISR's INT_CLR
write wasn't reaching our TIMG).

Root cause traced to existing `esp32p4_install_smart_stub()` calls
at the same addresses (line 614 of `hw/riscv/esp32p4.c`):

```c
memory_region_add_subregion_overlap(sys_mem, base, mr, 2);  // priority 2
```

Our peripheral overlays were using priority 1. **Smart_stub priority
2 wins over our priority 1**, so guest writes hit the smart_stub
(scratch storage) instead of our TIMG.

Fix: bumped our TIMG overlays from priority 1 to priority 3, so
they override the smart_stubs.

### 3. The rtc_clk_cal_done bit gotcha

After fixing the priority, a second regression emerged: total events
dropped from 443 to 57. LEDC + ADC + running-light all silent. CPU
appeared to be stuck somewhere.

Looking at the existing smart_stub overrides table (line 234):

```c
{ 0x500C2000, 0x080, 0x1, SMART_FIXED, "TIMG0: rtc_clk_cal done bit" },
```

The bootloader's `rtc_clk_cal_internal()` polls bit 0 of
`0x500C2080` (TIMG0 + 0x80) in a tight loop expecting "calibration
done = 1". The smart_stub provided this override at offset 0x80
returning 0x1.

When our TIMG model overlaid the smart_stub at priority 3, our scratch
storage at offset 0x80 returned 0 (default) — bootloader infinite-
looped, never reached our demo blob.

Fix: added a special-case in `esp32p4_timg_read()` for offset 0x80:

```c
case 0x80:
    /* rtc_clk_cal done bit — bootloader polls in tight loop */
    return 0x1u;
```

This restores the smart_stub's behaviour inside our TIMG model. The
bootloader's poll exits immediately with cal-done=1.

### 4. Demo blob ISR address fix

The TIMG ISR handlers in the demo blob hardcoded the OLD TIMG bases:

```
Phase 2.AJ ISR: lui a2, 0x500BC (TIMG0 base) — was 0x40400210
Phase 2.AN.irq ISR: lui a2, 0x500C0 (TIMG1 base) — was 0x4040025C
```

Updated to:

```
lui a2, 0x500C2 → encoded 0x500C2637
lui a2, 0x500C3 → encoded 0x500C3637
```

Without these updates, the ISR's INT_CLR writes would have gone to
the OLD addresses (now defunct), so INT_RAW would never clear.

## Lo que SÍ funcionó

10-second live test (2026-05-08) post-relocation + fixes:

```
=== JSON event totals ===
Total lines: 449  (was 443 in Phase 2.AR; +6 timing variance only)

  "event":"ledc":     99    ← unchanged
  "event":"adc":      33    ← unchanged
  "event":"timg":     28    ← unchanged (14 grp:0 + 14 grp:1)
  "event":"timg_irq": 38    ← unchanged (full pairing 0/1 transitions)
  "event":"i2c":       8    ← unchanged
  "event":"i2c_rx":    1    ← unchanged
  "event":"spi":       3    ← unchanged
  "event":"wdt":       8    ← unchanged
  "event":"rng":       3    ← unchanged
  "event":"start":     1
  "pin":              210   ← unchanged
```

Pin distribution showing all 4 ISR-driven pins:
- pin 8 @ 1 Hz (TIMG0 ISR via cause 19) ← unchanged
- pin 9 on rising-edges (GPIO ISR via cause 18) ← unchanged
- pin 10 @ 2 Hz (TIMG1 ISR via cause 20) ← unchanged

All paired `timg_irq` 0↔1 transitions confirm both peripherals'
INT_CLR is being correctly written to the new addresses.

No regression: every functional aspect of the system identical to
Phase 2.AR, just at silicon-correct addresses.

## Lo que NO funcionó / decisiones tomadas

1. **Priority 1 was wrong (silent collision)**: smart_stub priority
   2 was the de-facto override level. Our peripheral overlays at
   priority 1 LOST silently when overlaid on smart_stubs. No error
   message, just silently routed writes to scratch. Bumping to
   priority 3 fixed it.

2. **Bootloader still polls TIMG0+0x80 even in our bypass flow**:
   surprising — I'd expected the bypass to skip all bootloader
   code. The fact that the rtc_clk_cal poll happens means SOME
   pre-bypass code runs. Documented as "bootloader poll exists in
   our flow, mitigated by 0x80 override".

3. **No regression test for placeholder addresses**: until Phase 2.AR
   noticed the discrepancy, our peripherals had been at wrong
   addresses for 7 phases (2.AG through 2.AR). All self-tests
   passed because they wrote to the wrong addresses too. A future
   "address sanity" check (validate device base matches IDF
   constant) would catch this regression class.

4. **Used `case 0x80: return 0x1u;` shortcut over re-implementing
   smart_stub overrides**: the original smart_stub had a more
   general override mechanism. We pinned the one specific override
   that mattered (bootloader rtc_clk_cal). If future bootloader
   poll loops hit other offsets we'd need to add more case
   handlers. Documented as a quick-fix that'll grow over time.

5. **I2C0 was at the WORST possible placeholder**: 0x500D2000 is
   the USB Serial/JTAG region per IDF. Any IDF code touching USB
   Serial/JTAG (which is heavily used for debugging) would have
   hit our I2C model and emitted spurious i2c events. Lucky we
   weren't running real IDF in the demo.

## Lessons learned

1. **`create_unimplemented_device` calls are documentation**: the
   existing stub list in this file was the SOURCE OF TRUTH for
   real-silicon addresses. We should have consulted it before
   choosing peripheral addresses in earlier phases.

2. **Memory-region priorities silently override**: QEMU doesn't
   warn when a higher-priority overlay swallows a lower-priority
   one. Always check what's already at an address before adding
   a new device. Use priority 3+ to override smart_stubs.

3. **Two-stage debugging beats one-stage**: priority bug → events
   drop / TIMG silent. After fixing priority: cal-done bug → demo
   blob never runs. Each problem was a clean signal once the
   previous fix was applied. Trying to fix both at once would
   have been confusing.

4. **Bypass flow has tendrils**: even though we "bypass the
   bootloader", some early-init code paths still run and depend
   on register behaviour we'd designed-around. The smart_stub
   override at TIMG0+0x80 is one such tendril. Future "real chip"
   work needs to map all such poll dependencies.

## Implementación final

### `hw/riscv/esp32p4.c`

**Address relocations:**
- TIMG0: `0x500BC000` → `0x500C2000` (priority 1 → 3)
- TIMG1: `0x500C0000` → `0x500C3000` (priority 1 → 3)
- I2C0:  `0x500D2000` → `0x500C4000` (priority 1)
- SPI2:  `0x500CC000` → `0x500D0000` (priority 1)

**Demo blob ISR:**
- `lui a2, 0x500BC` (encoded `0x500BC637`) → `lui a2, 0x500C2` (`0x500C2637`)
- `lui a2, 0x500C0` (encoded `0x500C0637`) → `lui a2, 0x500C3` (`0x500C3637`)

### `hw/timer/esp32p4_timg.c`

New case in read handler:
```c
case 0x80:
    return 0x1u;  /* rtc_clk_cal done bit */
```

Salvages the bootloader poll-loop dependency that the smart_stub
used to provide.

## Estado consolidado (post-2.AS)

| Hito                                                          | Estado |
|---------------------------------------------------------------|--------|
| GPIO + LEDC + ADC + I2C + 2× TIMG + WDT + ISR + RNG + SPI      | ✅ 2.W-AR |
| **All peripherals at real-silicon (IDF) addresses**            | ✅ 2.AS |
| 2.AO.slave (ILI9341 SPI responder)                              | ⏳ later |
| WDT actual reset                                                  | ⏳ later |
| RTC WDT + Super WDT                                              | ⏳ later |
| UART RX path                                                      | ⏳ later |
| Real PWM waveform on GPIO                                        | ⏳ later |
| Real FreeRTOS port                                               | ⏳ Phase 2.V |

## 27-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.U-AB| GPIO + JSON event channel                               |
| 2.AC-AF| LEDC PWM + multi-channel rainbow                       |
| 2.AD  | ADC peripheral                                          |
| 2.AG-AN.irq | TIMG hardware timers + 3-way ISR                  |
| 2.AM-slave | I2C master + BMP280 responder                      |
| 2.AO  | SPI master skeleton                                     |
| 2.AP-AQ | TIMG WDT (both groups)                                 |
| 2.AR  | HW Random Number Generator                              |
| **2.AS** | **Real-silicon address relocation (all peripherals)** |

Functional behaviour identical to Phase 2.AR. The change is
"locational" — peripherals are now where Arduino IDF code expects
them. Future guest sketches will work without per-peripheral
address-rewrite shims.

JSON stream still 11 event types: `start | pin | ledc | adc | timg
| timg_irq | i2c | i2c_rx | spi | wdt | rng`.

## Próximas direcciones

- **WDT timeout actual reset action**.
- **RTC WDT / Super WDT** modelling.
- **2.AO.slave**: synthetic ILI9341 SPI responder.
- **UART RX path**.
- **Real PWM waveform on GPIO**.
- **FreeRTOS port** (Phase 2.V deferred).
