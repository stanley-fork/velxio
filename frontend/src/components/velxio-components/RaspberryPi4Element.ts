/**
 * Raspberry Pi 4 Model B — Velxio schematic board.
 *
 * Authored from scratch (not traced from RPi Foundation art); the layout
 * is the publicly-known PCB topology (BCM2711 SoC centre-right, USB-C
 * power on the south edge, dual micro-HDMI mid-south, 4× USB-A and
 * gigabit Ethernet stacked on the east edge, 40-pin GPIO header on the
 * north edge, microSD on the underside).  Rendered at the same
 * 250×160 footprint and pin pitch as RaspberryPi3Element so wires from
 * existing canvases line up byte-for-byte.
 *
 * The 40-pin GPIO header is electrically identical to every Pi from
 * the 1B+ onwards — pin numbers 1-40 map to the same BCM GPIO lines
 * the firmware sees, so reusing the same pin-name scheme means Velxio
 * routes and example projects transfer between Pi models without
 * touching wires.
 */

import { buildPi40PinHeader } from './pi40PinHeader';

const PI_WIDTH = 250;
const PI_HEIGHT = 160;

class RaspberryPi4Element extends HTMLElement {
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
          fill: #006633; /* Pi 4 green PCB */
          stroke: #003d1f;
          stroke-width: 2;
          rx: 8;
        }
        .cpu { fill: #1a1a1a; stroke: #000; rx: 2; }
        .usb { fill: #ccc; stroke: #999; rx: 2; }
        .usbc { fill: #888; stroke: #555; rx: 1; }
        .eth { fill: #bbb; stroke: #888; rx: 2; }
        .hdmi { fill: #555; stroke: #333; rx: 1; }
        .gpio-header { fill: #222; }
        .rp1 { fill: #2a2a2a; stroke: #000; rx: 2; }
        .label { fill: #FFF; font-family: sans-serif; }
      </style>
      <svg viewBox="0 0 ${PI_WIDTH} ${PI_HEIGHT}">
        <!-- PCB -->
        <rect class="board" x="2" y="2" width="${PI_WIDTH - 4}" height="${PI_HEIGHT - 4}" />

        <!-- BCM2711 SoC (centre-right, larger than Pi 3) -->
        <rect class="cpu" x="100" y="55" width="48" height="48" />
        <text x="124" y="76" class="label" font-size="7" text-anchor="middle">BCM2711</text>
        <text x="124" y="86" class="label" font-size="6" text-anchor="middle" opacity="0.7">A72 ×4</text>

        <!-- 4× USB-A (east edge, two stacked banks) -->
        <rect class="usb" x="${PI_WIDTH - 38}" y="18" width="36" height="28" />
        <text x="${PI_WIDTH - 20}" y="34" class="label" font-size="5" text-anchor="middle" opacity="0.7">USB3</text>
        <rect class="usb" x="${PI_WIDTH - 38}" y="50" width="36" height="28" />
        <text x="${PI_WIDTH - 20}" y="66" class="label" font-size="5" text-anchor="middle" opacity="0.7">USB2</text>

        <!-- Gigabit Ethernet -->
        <rect class="eth" x="${PI_WIDTH - 38}" y="82" width="36" height="36" />
        <text x="${PI_WIDTH - 20}" y="102" class="label" font-size="5" text-anchor="middle" opacity="0.7">GbE</text>

        <!-- USB-C Power (south edge, west side) -->
        <rect class="usbc" x="6" y="${PI_HEIGHT - 18}" width="18" height="10" />
        <text x="15" y="${PI_HEIGHT - 22}" class="label" font-size="5" text-anchor="middle" opacity="0.7">USB-C 5V</text>

        <!-- 2× micro-HDMI (south edge, centre) -->
        <rect class="hdmi" x="40" y="${PI_HEIGHT - 16}" width="20" height="10" />
        <rect class="hdmi" x="66" y="${PI_HEIGHT - 16}" width="20" height="10" />
        <text x="63" y="${PI_HEIGHT - 20}" class="label" font-size="5" text-anchor="middle" opacity="0.7">µHDMI 0 / 1</text>

        <!-- Audio jack (south edge, east of HDMI) -->
        <circle cx="100" cy="${PI_HEIGHT - 11}" r="5" fill="#222" stroke="#000" />

        <!-- GPIO Header base -->
        <rect class="gpio-header" x="15" y="5" width="200" height="20" rx="1" />

        <!-- Pins -->
        ${pinsSvg}

        <!-- Board name + Velxio mark -->
        <text x="60" y="125" class="label" font-size="14" font-weight="bold">Raspberry Pi 4</text>
        <text x="60" y="140" class="label" font-size="9" opacity="0.85">Model B · Cortex-A72</text>
        <text x="${PI_WIDTH - 8}" y="${PI_HEIGHT - 6}" class="label" font-size="6" text-anchor="end" opacity="0.6">velxio</text>
      </svg>
    `;
  }
}

if (!customElements.get('velxio-raspberry-pi-4')) {
  customElements.define('velxio-raspberry-pi-4', RaspberryPi4Element);
}

export {};
