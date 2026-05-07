# Phase 2 — Arduino blink visible end-to-end

**Status:** ⏳ pending

## Goal

```
$ qemu-system-riscv32 -M esp32p4 -drive file=blink.merged.bin,if=mtd -nographic
ESP32-P4 blink starting
HIGH
LOW
HIGH
LOW
...
```

Full pipeline del Arduino IDE: arduino-cli compile → merged.bin → QEMU → bootloader runs → app runs → setup() → loop() → Serial.println via UART → digitalWrite via GPIO.

## Acceptance criteria

- Texto "ESP32-P4 blink starting" aparece en stdout.
- "HIGH" y "LOW" se imprimen alternando, cada ~500 ms (tiempo virtual QEMU).
- `[esp32p4.gpio] pin 2 -> 1` y `pin 2 -> 0` aparecen en log con la misma cadencia.

## Pre-requisitos

- ✅ Phase 0–1.E completadas
- ⏳ Phase 1.F (SPI flash)
- ⏳ Phase 1.G (cache MMU)
- ⏳ Phase 1.H (TIMG + WDT)
- ⏳ Phase 1.I (HP_SYSREG + Clock)
- ⏳ Phase 1.J (RNG + eFuse ext)
- ⏳ Phase 1.K (Interrupt matrix + UART IRQ wiring)

## Notes

- En este punto nos olvidamos del `-kernel` hack: usamos `-drive if=mtd` con el merged.bin entero, igual que silicon real.
- Si llega el ROM blob de Espressif (`esp32p4-rom.bin`), reemplazar el ret-fill con la blob real → el bootloader stage 0 ejecuta también.
- Esta es la fase "demo-able" — sirve para mostrarle al usuario y para integrar en Velxio backend.
