/**
 * Raspberry Pi 5 — Velxio schematic board.
 *
 * Authored from scratch (not traced from RPi Foundation art); the layout
 * is the publicly-known PCB topology: BCM2712 SoC centre, RP1 southbridge
 * to its right driving the I/O, 4× USB-A + 2.5 GbE on the east edge,
 * USB-C power + dual micro-HDMI on the south, 40-pin GPIO header on the
 * north, dedicated power button on the west, PCIe FFC connector on the
 * underside, fan header to the north-east of the SoC.
 *
 * The 40-pin GPIO header is electrically identical to every Pi from
 * the 1B+ onwards, so the pin coords mirror RaspberryPi3Element /
 * RaspberryPi4Element byte-for-byte — wires snap to the same physical
 * positions when a user swaps boards.
 */

import { buildPi40PinHeader } from './pi40PinHeader';

const PI_WIDTH = 250;
const PI_HEIGHT = 160;

class RaspberryPi5Element extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  get pinInfo() {
    return buildPi40PinHeader();
  }

  render() {
    let pinsSvg = '';
    const pins = this.pinInfo;
    pins.forEach((pin) => {
      pinsSvg += `<rect x="${pin.x - 3}" y="${pin.y - 3}" width="6" height="6" fill="#D4AF37" />`;
      pinsSvg += `<circle cx="${pin.x}" cy="${pin.y}" r="2" fill="#000" />`;
    });

    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: block;
          width: ${PI_WIDTH}px;
          height: ${PI_HEIGHT}px;
          position: relative;
        }
        svg { width: 100%; height: 100%; }
        .board {
          fill: #004d27; /* Pi 5 darker green PCB */
          stroke: #002b15;
          stroke-width: 2;
          rx: 8;
        }
        .cpu { fill: #1a1a1a; stroke: #000; rx: 2; }
        .rp1 { fill: #2a2a2a; stroke: #000; rx: 2; }
        .usb { fill: #ccc; stroke: #999; rx: 2; }
        .usbc { fill: #888; stroke: #555; rx: 1; }
        .eth { fill: #bbb; stroke: #888; rx: 2; }
        .hdmi { fill: #555; stroke: #333; rx: 1; }
        .gpio-header { fill: #222; }
        .pcie { fill: #4a4a4a; stroke: #222; rx: 1; }
        .pwrbtn { fill: #c00; stroke: #800; rx: 1.5; }
        .label { fill: #FFF; font-family: sans-serif; }
      </style>
      <svg viewBox="0 0 ${PI_WIDTH} ${PI_HEIGHT}">
        <!-- PCB -->
        <rect class="board" x="2" y="2" width="${PI_WIDTH - 4}" height="${PI_HEIGHT - 4}" />

        <!-- BCM2712 SoC (centre) -->
        <rect class="cpu" x="90" y="55" width="44" height="44" />
        <text x="112" y="76" class="label" font-size="7" text-anchor="middle">BCM2712</text>
        <text x="112" y="86" class="label" font-size="6" text-anchor="middle" opacity="0.7">A76 ×4</text>

        <!-- RP1 southbridge I/O chip (Raspberry Pi's own silicon, east of SoC) -->
        <rect class="rp1" x="146" y="65" width="26" height="26" />
        <text x="159" y="80" class="label" font-size="6" text-anchor="middle">RP1</text>

        <!-- 4× USB-A (east edge, two stacked banks of 2) -->
        <rect class="usb" x="${PI_WIDTH - 38}" y="18" width="36" height="28" />
        <text x="${PI_WIDTH - 20}" y="34" class="label" font-size="5" text-anchor="middle" opacity="0.7">USB3</text>
        <rect class="usb" x="${PI_WIDTH - 38}" y="50" width="36" height="28" />
        <text x="${PI_WIDTH - 20}" y="66" class="label" font-size="5" text-anchor="middle" opacity="0.7">USB3</text>

        <!-- 2.5 Gigabit Ethernet -->
        <rect class="eth" x="${PI_WIDTH - 38}" y="82" width="36" height="36" />
        <text x="${PI_WIDTH - 20}" y="102" class="label" font-size="5" text-anchor="middle" opacity="0.7">2.5GbE</text>

        <!-- USB-C power (south edge) -->
        <rect class="usbc" x="6" y="${PI_HEIGHT - 18}" width="18" height="10" />
        <text x="15" y="${PI_HEIGHT - 22}" class="label" font-size="5" text-anchor="middle" opacity="0.7">USB-C 5V/5A</text>

        <!-- Power button (west edge) — Pi 5 has a real on/off button -->
        <rect class="pwrbtn" x="3" y="80" width="6" height="6" />
        <text x="14" y="86" class="label" font-size="5" opacity="0.7">PWR</text>

        <!-- 2× micro-HDMI (south, centre) -->
        <rect class="hdmi" x="40" y="${PI_HEIGHT - 16}" width="20" height="10" />
        <rect class="hdmi" x="66" y="${PI_HEIGHT - 16}" width="20" height="10" />
        <text x="63" y="${PI_HEIGHT - 20}" class="label" font-size="5" text-anchor="middle" opacity="0.7">µHDMI 0 / 1</text>

        <!-- PCIe FFC connector (south, east of HDMI) -->
        <rect class="pcie" x="100" y="${PI_HEIGHT - 14}" width="36" height="6" />
        <text x="118" y="${PI_HEIGHT - 18}" class="label" font-size="5" text-anchor="middle" opacity="0.7">PCIe FFC</text>

        <!-- GPIO Header base -->
        <rect class="gpio-header" x="15" y="5" width="200" height="20" rx="1" />

        <!-- Pins -->
        ${pinsSvg}

        <!-- Board name + Velxio mark -->
        <text x="60" y="125" class="label" font-size="14" font-weight="bold">Raspberry Pi 5</text>
        <text x="60" y="140" class="label" font-size="9" opacity="0.85">Cortex-A76 · BCM2712 · RP1</text>
        <text x="${PI_WIDTH - 8}" y="${PI_HEIGHT - 6}" class="label" font-size="6" text-anchor="end" opacity="0.6">velxio</text>
      </svg>
    `;
  }
}

if (!customElements.get('velxio-raspberry-pi-5')) {
  customElements.define('velxio-raspberry-pi-5', RaspberryPi5Element);
}

export {};
