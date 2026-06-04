/**
 * Retro Intel/Zilog CPU examples.
 *
 * These projects place Velxio's bundled "i8080 mini-computer" custom chips
 * on the canvas pre-wired to Arduino Uno boards. Because custom chips are
 * shipped as C source (the WASM is compiled on demand by the backend), each
 * example arrives with sourceC + chipJson populated and wasmBase64 empty —
 * the user clicks the chip and hits "Compile" once to materialize the WASM.
 *
 * After that the project runs end-to-end: the i8080-repl example streams a
 * banner + uptime counter via UART to the Serial Monitor, and the
 * i8080-counter example uses two pushbuttons to drive an 8-LED counter.
 *
 * Sources for the chip programs live alongside the chip in
 * `frontend/src/components/customChips/examples/intel/`, with the original
 * 8080 assembly under `scripts/repl-rom.s` and `scripts/counter-rom.s`.
 */
import type { ExampleProject } from './examples';

// We re-import the chip sources here so the example payload is fully
// self-describing — no runtime lookup into chipExamples.ts. This keeps
// project saves/loads independent from the chip gallery.
import i8080ReplC      from '../components/customChips/examples/intel/i8080-repl.c?raw';
import i8080ReplJ      from '../components/customChips/examples/intel/i8080-repl.chip.json?raw';
import i8080CounterC   from '../components/customChips/examples/intel/i8080-counter.c?raw';
import i8080CounterJ   from '../components/customChips/examples/intel/i8080-counter.chip.json?raw';
import i8080CpuC       from '../components/customChips/examples/intel/i8080-cpu.c?raw';
import i8080CpuJ       from '../components/customChips/examples/intel/i8080-cpu.chip.json?raw';
import z80CpuC         from '../components/customChips/examples/intel/z80-cpu.c?raw';
import z80CpuJ         from '../components/customChips/examples/intel/z80-cpu.chip.json?raw';

const chaserZ80C = `/* LED chaser written in C, compiled to Z80 by SDCC.
 *
 * Demonstrates that you can program the Z80 chip in C (not just asm).
 * The backend runs:
 *     sdcc -mz80 --data-loc 0x8000 program.c
 * and feeds the resulting Intel HEX into the chip via vx_rom_read.
 *
 * The MMIO addresses (0xC000 LED, 0xC003 BTN, 0xC001 UART_DATA,
 * 0xC002 UART_STAT) match the z80-cpu chip's memory map.
 *
 * Behaviour: walks a single LED back and forth across the 8 outputs
 * (true Larson scanner, with direction reversal).
 */
#define LED_OUT   (*(volatile unsigned char *)0xC000)
#define BTN_IN    (*(volatile unsigned char *)0xC003)

static void delay(unsigned int loops) {
    while (loops--) {
        __asm
        nop
        nop
        nop
        nop
        __endasm;
    }
}

void main(void) {
    unsigned char bit = 0x01;
    /* MUST be signed: SDCC treats plain \`char\` as unsigned on Z80, so
       dir=-1 would read back as 255, the "walk right" branch would never
       run, and the bit would just shift left off the end and stay dark. */
    signed char dir = 1;   /* +1 = walking left, -1 = walking right */
    while (1) {
        LED_OUT = bit;
        delay(5000);

        if (dir > 0) {
            bit <<= 1;
            if (bit == 0x80) dir = -1;
        } else {
            bit >>= 1;
            if (bit == 0x01) dir = 1;
        }
    }
}
`;

const larsonZ80Asm = `; Larson Scanner / Knight Rider in Z80 assembly.
;
; A single LED walks left across 8 LEDs forever. Uses JR/DJNZ/RLCA --
; Z80 instructions the 8080 emulator can't run. The pattern wraps from
; bit 7 back to bit 0 thanks to RLCA's circular rotation.

        ORG 0x0000

        LD   SP, 0xBFFF        ; stack at top of RAM
        LD   A, 0x01           ; A = bit pattern (start at LED0)

loop:
        LD   (0xC000), A       ; write to LED port
        PUSH AF
        CALL delay
        POP  AF
        RLCA                   ; rotate left (bit 7 -> bit 0)
        JR   loop

; -- delay: ~80 ms outer loop -------------------------------------------
delay:
        LD   C, 80
outer:
        LD   B, 0              ; 0 = 256 inner iterations
inner:
        DJNZ inner
        DEC  C
        JR   NZ, outer
        RET
`;

const larsonScannerAsm = `; Z80 "comet" scanner — a TWO-LED pair sweeps across the 8 LEDs.
;
; Same z80-cpu chip as the single-bit Larson, but the start pattern is
; 0x03 (two adjacent LEDs) and the sweep is faster. RLCA rotates the pair
; left and wraps it around the ends — a brighter, quicker Knight Rider.
; To slow it down, raise the "LD C, 40" delay; to widen the comet, change
; the "LD A, 0x03" start pattern.

        ORG 0x0000

        LD   SP, 0xBFFF        ; stack at top of RAM
        LD   A, 0x03           ; A = two adjacent LEDs (LED0 + LED1)

loop:
        LD   (0xC000), A       ; write to LED port
        PUSH AF
        CALL delay
        POP  AF
        RLCA                   ; rotate the pair left (wraps at the ends)
        JR   loop

; -- delay: faster sweep than the single-bit Larson ---------------------
delay:
        LD   C, 40
outer:
        LD   B, 0              ; 0 = 256 inner iterations
inner:
        DJNZ inner
        DEC  C
        JR   NZ, outer
        RET
`;

const killbitsAsm = `; Kill the Bit -- Dean McDaniel, May 15, 1975. Public domain.
;
; The classic Altair 8800 front-panel reflex game adapted to Velxio.
; A single LED walks across the 8 LEDs; press the matching button at
; the right moment to "kill" the bit. Miss, and an extra bit lights up
; next pass. Get all bits out to win.
;
; This file is the ROM image for the programmable i8080-cpu chip. Click
; Compile to assemble it (calls /api/compile-rom on the backend), then
; click Run to start the 8080 emulator.

        ORG 0x0000

        LXI  SP, 0xBFFF      ; stack at top of RAM
        LXI  H, 0x0000       ; delay accumulator
        MVI  D, 0x80         ; D = bit pattern (start: LED7 lit)
        LXI  B, 0x0E00       ; delay step

beat:
        DAD  B               ; loop ~18 times per visible frame
        JNC  beat

        ; One tick: show pattern + sample buttons + advance bit.
        MOV  A, D
        STA  0xC000          ; LED port

        LDA  0xC003          ; button bitmap
        XRA  D               ; matching bits cancel
        RRC                  ; rotate right
        MOV  D, A

        JMP  beat
`;

const replSketch = `// i8080 banner streamer
//
// The bundled i8080 chip on the canvas runs its own embedded ROM. All
// this Arduino sketch does is set up Serial and forward bytes back and
// forth: the chip's UART output arrives at the AVR's RX path, the sketch
// echoes each byte so the Serial Monitor displays it.
//
// Steps:
//   1. Double-click the chip, switch to the Editor tab, click Compile.
//      (The backend compiles the embedded 8080 emulator + ROM to WASM.)
//   2. Hit Save, then Run.
//   3. Open the Serial Monitor — you should see the banner followed by
//      "uptime ticks: 0xNN" lines incrementing every ~50 ms, all driven
//      by real Intel 8080 instructions running in WASM.

void setup() {
  Serial.begin(9600);
}

void loop() {
  while (Serial.available()) {
    int c = Serial.read();
    Serial.write(c);
  }
}
`;

const counterNote = `// Intel 8080 Button Counter — self-contained, no board.
//
// This chip runs its own embedded ROM: BTN_INC counts up in binary on the
// 8 LEDs, BTN_RST clears. There is no separate program file to edit here —
// the program lives inside the chip (double-click it, Editor tab, to view
// its C). Powered by the regulated bench supply. Click Run, then press the
// buttons.
`;

export const retroIntelExamples: ExampleProject[] = [
  {
    id: 'i8080-banner-streamer',
    title: 'Intel 8080 Banner Streamer',
    description:
      'A clean-room Intel 8080 boots from a 328-byte embedded ROM, prints a banner, ' +
      'then prints "uptime ticks: 0xNN" every ~50 ms. Open the Serial Monitor to watch.',
    category: 'circuits',
    difficulty: 'advanced',
    boardType: 'arduino-uno',
    tags: ['retro', '8080', 'cpu', 'uart', 'wasm', 'custom-chip', 'serial'],
    code: replSketch,
    components: [
      {
        type: 'custom-chip',
        id: 'i8080',
        x: 480,
        y: 140,
        properties: {
          chipName: 'i8080 Mini-Computer (Banner)',
          sourceC: i8080ReplC,
          chipJson: i8080ReplJ,
          wasmBase64: '',
        },
      },
    ],
    wires: [
      // Chip TX → Arduino RX (D0) — visual only; the UART bridge routes
      // bytes through the simulator's USART regardless of wire topology.
      {
        id: 'i8080-tx',
        start: { componentId: 'i8080', pinName: 'TX' },
        end: { componentId: 'arduino-uno', pinName: '0' },
        color: '#7be38b',
      },
      {
        id: 'i8080-rx',
        start: { componentId: 'i8080', pinName: 'RX' },
        end: { componentId: 'arduino-uno', pinName: '1' },
        color: '#ffb648',
      },
      {
        id: 'i8080-vcc',
        start: { componentId: 'i8080', pinName: 'VCC' },
        end: { componentId: 'arduino-uno', pinName: '5V' },
        color: '#e74c3c',
      },
      {
        id: 'i8080-gnd',
        start: { componentId: 'i8080', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'i8080-button-counter',
    title: 'Intel 8080 Button Counter',
    description:
      'A self-contained Intel 8080 chip running a 34-byte ROM. Press the INC button to count up ' +
      'in binary on 8 LEDs, press the RST button to clear. The CPU, RAM, and program are all ' +
      'inside the single chip on the canvas.',
    category: 'circuits',
    difficulty: 'intermediate',
    boardFilter: 'digital',
    tags: ['retro', '8080', 'cpu', 'leds', 'buttons', 'no-board', 'power-supply', 'wasm', 'custom-chip', 'spice'],
    code: counterNote,
    components: [
      {
        type: 'power-supply',
        id: 'psu',
        x: 180,
        y: 240,
        properties: { mode: 'dc', voltage: 5, currentLimit: 2, frequency: 50 },
      },
      {
        type: 'custom-chip',
        id: 'i8080c',
        x: 440,
        y: 150,
        properties: {
          chipName: 'i8080 Button Counter',
          sourceC: i8080CounterC,
          chipJson: i8080CounterJ,
          wasmBase64: '',
        },
      },
      // 8 LEDs for the binary readout, each through a series resistor
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-resistor',
        id: `r-${i}`,
        x: 760,
        y: 110 + i * 50,
        properties: { value: '220' },
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-led',
        id: `led-${i}`,
        x: 900,
        y: 110 + i * 50,
        properties: { color: i < 4 ? 'red' : 'orange' },
      })),
      // 2 buttons, each with a pull-down so the chip pin reads a clean LOW
      // when the button is open (the button ties the pin to +5V when pressed).
      {
        type: 'wokwi-pushbutton',
        id: 'btn-inc',
        x: 300,
        y: 470,
        properties: { color: 'green' },
      },
      {
        type: 'wokwi-pushbutton',
        id: 'btn-rst',
        x: 480,
        y: 470,
        properties: { color: 'red' },
      },
      {
        type: 'wokwi-resistor',
        id: 'rpd-inc',
        x: 300,
        y: 580,
        properties: { value: '10000' },
      },
      {
        type: 'wokwi-resistor',
        id: 'rpd-rst',
        x: 480,
        y: 580,
        properties: { value: '10000' },
      },
    ],
    wires: [
      {
        id: 'psu-vcc',
        start: { componentId: 'psu', pinName: 'SIG' },
        end: { componentId: 'i8080c', pinName: 'VCC' },
        color: '#e74c3c',
      },
      {
        id: 'psu-gnd',
        start: { componentId: 'psu', pinName: 'GND' },
        end: { componentId: 'i8080c', pinName: 'GND' },
        color: '#000000',
      },
      // LED data wires: chip -> resistor -> LED anode -> supply GND
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-led-${i}`,
        start: { componentId: 'i8080c', pinName: `LED${i}` },
        end: { componentId: `r-${i}`, pinName: '1' },
        color: '#facc15',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-r-${i}`,
        start: { componentId: `r-${i}`, pinName: '2' },
        end: { componentId: `led-${i}`, pinName: 'A' },
        color: '#facc15',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-gnd-${i}`,
        start: { componentId: `led-${i}`, pinName: 'C' },
        end: { componentId: 'psu', pinName: 'GND' },
        color: '#000000',
      })),
      // Buttons: signal to the chip, other side to the supply rail
      {
        id: 'wire-btn-inc',
        start: { componentId: 'btn-inc', pinName: '1.l' },
        end: { componentId: 'i8080c', pinName: 'BTN_INC' },
        color: '#22c55e',
      },
      {
        id: 'wire-btn-rst',
        start: { componentId: 'btn-rst', pinName: '1.l' },
        end: { componentId: 'i8080c', pinName: 'BTN_RST' },
        color: '#ef4444',
      },
      {
        id: 'wire-btn-inc-pwr',
        start: { componentId: 'btn-inc', pinName: '2.l' },
        end: { componentId: 'psu', pinName: 'SIG' },
        color: '#e74c3c',
      },
      {
        id: 'wire-btn-rst-pwr',
        start: { componentId: 'btn-rst', pinName: '2.l' },
        end: { componentId: 'psu', pinName: 'SIG' },
        color: '#e74c3c',
      },
      // Pull-downs: chip BTN pin -> 10k -> GND (clean LOW when not pressed)
      {
        id: 'pd-inc-sig',
        start: { componentId: 'rpd-inc', pinName: '1' },
        end: { componentId: 'i8080c', pinName: 'BTN_INC' },
        color: '#000000',
      },
      {
        id: 'pd-inc-gnd',
        start: { componentId: 'rpd-inc', pinName: '2' },
        end: { componentId: 'psu', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'pd-rst-sig',
        start: { componentId: 'rpd-rst', pinName: '1' },
        end: { componentId: 'i8080c', pinName: 'BTN_RST' },
        color: '#000000',
      },
      {
        id: 'pd-rst-gnd',
        start: { componentId: 'rpd-rst', pinName: '2' },
        end: { componentId: 'psu', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  // ── Kill-the-Bit (1975) — first example using the PROGRAMMABLE i8080-cpu chip ──
  {
    id: 'i8080-killbits',
    title: 'Kill the Bit (1975)',
    description:
      "Dean McDaniel's iconic 1975 Altair 8800 reflex game, running on a programmable Intel 8080 chip " +
      'with NO Arduino — powered by a regulated bench supply. A single LED walks across 8 LEDs; press ' +
      'the matching button at the right moment to kill it. The ROM is killbits.s (the chip\'s editable ' +
      'program); click Run.',
    category: 'games',
    difficulty: 'advanced',
    boardFilter: 'digital',
    tags: ['retro', '8080', 'cpu', 'leds', 'buttons', 'game', 'altair', 'no-board', 'power-supply', 'wasm', 'custom-chip', 'asm', 'spice', 'programmable'],
    code: killbitsAsm,
    files: [{ name: 'killbits.s', content: killbitsAsm }],
    components: [
      {
        type: 'power-supply',
        id: 'psu',
        x: 180,
        y: 240,
        properties: { mode: 'dc', voltage: 5, currentLimit: 2, frequency: 50 },
      },
      {
        type: 'custom-chip',
        id: 'i8080cpu',
        x: 440,
        y: 150,
        properties: {
          chipName: 'i8080 CPU (programmable)',
          sourceC: i8080CpuC,
          chipJson: i8080CpuJ,
          wasmBase64: '',
          romBytes: '',
          programFile: 'killbits.s',
        },
      },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-resistor',
        id: `r-${i}`,
        x: 760,
        y: 110 + i * 50,
        properties: { value: '220' },
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-led',
        id: `led-${i}`,
        x: 900,
        y: 110 + i * 50,
        properties: { color: i < 4 ? 'yellow' : 'orange' },
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-pushbutton',
        id: `btn-${i}`,
        x: 1080,
        y: 110 + i * 50,
        properties: { color: 'green' },
      })),
      // Pull-downs so each chip BTN pin reads a clean LOW when not pressed.
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-resistor',
        id: `rpd-${i}`,
        x: 1240,
        y: 110 + i * 50,
        properties: { value: '10000' },
      })),
    ],
    wires: [
      {
        id: 'psu-vcc',
        start: { componentId: 'psu', pinName: 'SIG' },
        end: { componentId: 'i8080cpu', pinName: 'VCC' },
        color: '#e74c3c',
      },
      {
        id: 'psu-gnd',
        start: { componentId: 'psu', pinName: 'GND' },
        end: { componentId: 'i8080cpu', pinName: 'GND' },
        color: '#000000',
      },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-led-${i}`,
        start: { componentId: 'i8080cpu', pinName: `LED${i}` },
        end: { componentId: `r-${i}`, pinName: '1' },
        color: '#facc15',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-r-${i}`,
        start: { componentId: `r-${i}`, pinName: '2' },
        end: { componentId: `led-${i}`, pinName: 'A' },
        color: '#facc15',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-gnd-${i}`,
        start: { componentId: `led-${i}`, pinName: 'C' },
        end: { componentId: 'psu', pinName: 'GND' },
        color: '#000000',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-btn-${i}`,
        start: { componentId: `btn-${i}`, pinName: '1.l' },
        end: { componentId: 'i8080cpu', pinName: `BTN${i}` },
        color: '#22c55e',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `wire-btn-${i}-pwr`,
        start: { componentId: `btn-${i}`, pinName: '2.l' },
        end: { componentId: 'psu', pinName: 'SIG' },
        color: '#e74c3c',
      })),
      // Pull-downs: each chip BTN pin -> 10k -> GND
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `pd-${i}-sig`,
        start: { componentId: `rpd-${i}`, pinName: '1' },
        end: { componentId: 'i8080cpu', pinName: `BTN${i}` },
        color: '#000000',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `pd-${i}-gnd`,
        start: { componentId: `rpd-${i}`, pinName: '2' },
        end: { componentId: 'psu', pinName: 'GND' },
        color: '#000000',
      })),
    ],
  },

  // ── Z80 Larson Scanner — first example on the programmable z80-cpu ──
  {
    id: 'z80-larson-scanner',
    title: 'Z80 Comet Scanner',
    description:
      'A faster, TWO-LED "comet" sweeps across 8 LEDs on a programmable Z80 chip — a brighter twist on ' +
      'the single-bit Larson. Written in Z80 assembly (scanner.s), NO Arduino: the chip runs standalone ' +
      'on a regulated supply. Click Run.',
    category: 'circuits',
    difficulty: 'intermediate',
    boardFilter: 'digital',
    tags: ['retro', 'z80', 'zilog', 'cpu', 'leds', 'larson', 'knight-rider', 'comet', 'no-board', 'power-supply', 'wasm', 'custom-chip', 'asm', 'spice', 'programmable'],
    code: larsonScannerAsm,
    files: [{ name: 'scanner.s', content: larsonScannerAsm }],
    components: [
      {
        type: 'power-supply',
        id: 'psu',
        x: 180,
        y: 200,
        properties: { mode: 'dc', voltage: 5, currentLimit: 2, frequency: 50 },
      },
      {
        type: 'custom-chip',
        id: 'z80cpu',
        x: 440,
        y: 150,
        properties: {
          chipName: 'Z80 CPU (programmable)',
          sourceC: z80CpuC,
          chipJson: z80CpuJ,
          wasmBase64: '',
          romBytes: '',
          programFile: 'scanner.s',
          programTarget: 'z80',
        },
      },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-resistor',
        id: `r-${i}`,
        x: 760,
        y: 110 + i * 50,
        properties: { value: '220' },
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-led',
        id: `led-${i}`,
        x: 900,
        y: 110 + i * 50,
        properties: { color: i % 2 === 0 ? 'green' : 'blue' },
      })),
    ],
    wires: [
      {
        id: 'psu-vcc',
        start: { componentId: 'psu', pinName: 'SIG' },
        end: { componentId: 'z80cpu', pinName: 'VCC' },
        color: '#e74c3c',
      },
      {
        id: 'psu-gnd',
        start: { componentId: 'psu', pinName: 'GND' },
        end: { componentId: 'z80cpu', pinName: 'GND' },
        color: '#000000',
      },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-led-${i}`,
        start: { componentId: 'z80cpu', pinName: `LED${i}` },
        end: { componentId: `r-${i}`, pinName: '1' },
        color: '#22c55e',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-r-${i}`,
        start: { componentId: `r-${i}`, pinName: '2' },
        end: { componentId: `led-${i}`, pinName: 'A' },
        color: '#22c55e',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-gnd-${i}`,
        start: { componentId: `led-${i}`, pinName: 'C' },
        end: { componentId: 'psu', pinName: 'GND' },
        color: '#000000',
      })),
    ],
  },

  // ── Z80 LED chaser in C (SDCC) — NO board, regulated supply ─────────
  // The Z80 program is written in C (chaser.c) and compiled by SDCC. No
  // Arduino: the chip is powered by a regulated bench supply, same as
  // z80-larson-no-board. Board-less (boardFilter: 'digital'); chaser.c is
  // the chip's editable program (its own section in the file explorer).
  {
    id: 'z80-led-chaser-c',
    title: 'Z80 LED Chaser in C (no board)',
    description:
      'A programmable Z80 chip walks a single LED back and forth, Larson-style — but the ' +
      'program is written in C (chaser.c) and compiled to the Z80 by SDCC. No Arduino: the ' +
      'chip runs standalone, powered by a regulated supply. Click Run. Requires sdcc on the backend.',
    category: 'circuits',
    difficulty: 'advanced',
    boardFilter: 'digital',
    tags: ['retro', 'z80', 'zilog', 'cpu', 'leds', 'larson', 'c', 'sdcc', 'no-board', 'power-supply', 'wasm', 'custom-chip', 'spice', 'programmable'],
    code: chaserZ80C,
    files: [{ name: 'chaser.c', content: chaserZ80C }],
    components: [
      {
        type: 'power-supply',
        id: 'psu',
        x: 180,
        y: 200,
        properties: { mode: 'dc', voltage: 5, currentLimit: 2, frequency: 50 },
      },
      {
        type: 'custom-chip',
        id: 'z80cpu',
        x: 440,
        y: 150,
        properties: {
          chipName: 'Z80 CPU (programmable)',
          sourceC: z80CpuC,
          chipJson: z80CpuJ,
          wasmBase64: '',
          romBytes: '',
          programFile: 'chaser.c',
          programTarget: 'z80',
        },
      },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-resistor',
        id: `r-${i}`,
        x: 760,
        y: 110 + i * 50,
        properties: { value: '220' },
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-led',
        id: `led-${i}`,
        x: 900,
        y: 110 + i * 50,
        properties: { color: 'red' },
      })),
    ],
    wires: [
      {
        id: 'psu-vcc',
        start: { componentId: 'psu', pinName: 'SIG' },
        end: { componentId: 'z80cpu', pinName: 'VCC' },
        color: '#e74c3c',
      },
      {
        id: 'psu-gnd',
        start: { componentId: 'psu', pinName: 'GND' },
        end: { componentId: 'z80cpu', pinName: 'GND' },
        color: '#000000',
      },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-led-${i}`,
        start: { componentId: 'z80cpu', pinName: `LED${i}` },
        end: { componentId: `r-${i}`, pinName: '1' },
        color: '#facc15',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-r-${i}`,
        start: { componentId: `r-${i}`, pinName: '2' },
        end: { componentId: `led-${i}`, pinName: 'A' },
        color: '#facc15',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-gnd-${i}`,
        start: { componentId: `led-${i}`, pinName: 'C' },
        end: { componentId: 'psu', pinName: 'GND' },
        color: '#000000',
      })),
    ],
  },

  // ── Z80 Larson Scanner — NO board (general-purpose electronics) ──
  // A programmable Z80 chip + 8 LEDs + a regulated power supply, with NO
  // Arduino/ESP32 on the canvas. Demonstrates that Velxio runs custom chips
  // standalone. Board-less (boardFilter: 'digital'); larson.s is the chip's
  // editable program (its own section in the file explorer) — Run assembles
  // it to ROM and compiles the chip WASM.
  {
    id: 'z80-larson-no-board',
    title: 'Z80 Larson Scanner (no board)',
    description:
      'The programmable Z80 chip drives 8 LEDs with NO Arduino — powered by a ' +
      'regulated bench supply. Velxio runs custom chips as a general-purpose ' +
      'electronics simulator. Click Run: a single LED walks back and forth.',
    category: 'circuits',
    difficulty: 'intermediate',
    boardFilter: 'digital',
    tags: ['retro', 'z80', 'zilog', 'cpu', 'leds', 'larson', 'no-board', 'power-supply', 'custom-chip', 'spice', 'programmable'],
    code: larsonZ80Asm,
    files: [{ name: 'larson.s', content: larsonZ80Asm }],
    components: [
      {
        type: 'power-supply',
        id: 'psu',
        x: 180,
        y: 200,
        properties: { mode: 'dc', voltage: 5, currentLimit: 2, frequency: 50 },
      },
      {
        type: 'custom-chip',
        id: 'z80cpu',
        x: 440,
        y: 150,
        properties: {
          chipName: 'Z80 CPU (programmable)',
          sourceC: z80CpuC,
          chipJson: z80CpuJ,
          wasmBase64: '',
          romBytes: '',
          programFile: 'larson.s',
          programTarget: 'z80',
        },
      },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-resistor',
        id: `r-${i}`,
        x: 760,
        y: 110 + i * 50,
        properties: { value: '220' },
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        type: 'wokwi-led',
        id: `led-${i}`,
        x: 900,
        y: 110 + i * 50,
        properties: { color: i % 2 === 0 ? 'red' : 'orange' },
      })),
    ],
    wires: [
      {
        id: 'psu-vcc',
        start: { componentId: 'psu', pinName: 'SIG' },
        end: { componentId: 'z80cpu', pinName: 'VCC' },
        color: '#e74c3c',
      },
      {
        id: 'psu-gnd',
        start: { componentId: 'psu', pinName: 'GND' },
        end: { componentId: 'z80cpu', pinName: 'GND' },
        color: '#000000',
      },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-led-${i}`,
        start: { componentId: 'z80cpu', pinName: `LED${i}` },
        end: { componentId: `r-${i}`, pinName: '1' },
        color: '#facc15',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-r-${i}`,
        start: { componentId: `r-${i}`, pinName: '2' },
        end: { componentId: `led-${i}`, pinName: 'A' },
        color: '#facc15',
      })),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        id: `w-gnd-${i}`,
        start: { componentId: `led-${i}`, pinName: 'C' },
        end: { componentId: 'psu', pinName: 'GND' },
        color: '#000000',
      })),
    ],
  },
];
