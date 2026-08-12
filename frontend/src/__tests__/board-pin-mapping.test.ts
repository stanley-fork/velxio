/**
 * boardPinToNumber — the bridge between a board element's PAD NAMES and the
 * GPIO numbers the simulators speak.
 *
 * A board whose kind has no branch here falls through to `return null`, and a
 * null pin means every wire to that header silently connects to nothing: the
 * part sits on the canvas, the sketch reads a dead pin, and nothing reports an
 * error. That is what happened to the M5 Cardputer, whose EXT header and Grove
 * Port A were unreachable even though the element drew them.
 */
import { describe, expect, it } from 'vitest';
import { boardPinToNumber } from '../utils/boardPinMapping';

describe('boardPinToNumber — M5 Cardputer ADV header', () => {
  // The pad names CardputerElement.ts renders on its wireable bottom row.
  const GPIO_NAMES = ['3', '4', '5', '6', '8', '9', '13', '14', '15', '39', '40', '2', '1'];

  it('maps every GPIO pad to its own number', () => {
    for (const name of GPIO_NAMES) {
      expect(boardPinToNumber('cardputer-adv', name)).toBe(Number(name));
    }
  });

  it('leaves no pad unmapped', () => {
    const unmapped = GPIO_NAMES.filter((n) => boardPinToNumber('cardputer-adv', n) === null);
    expect(unmapped).toEqual([]);
  });

  it('maps the power pads to -1, not to a GPIO', () => {
    expect(boardPinToNumber('cardputer-adv', '5V')).toBe(-1);
    expect(boardPinToNumber('cardputer-adv', 'GND')).toBe(-1);
  });

  it('accepts G40, which the classic ESP32 range would have rejected', () => {
    // The shared esp32 branch clamps at 39; the S3 has 48 GPIOs and this board
    // exposes 40 on its header.
    expect(boardPinToNumber('cardputer-adv', '40')).toBe(40);
  });

  it('rejects a pad that is not a pin', () => {
    expect(boardPinToNumber('cardputer-adv', 'NOPE')).toBeNull();
    expect(boardPinToNumber('cardputer-adv', '99')).toBeNull();
  });
});

describe('m5stack-core header pins', () => {
  // The Core's pads sat unmapped for months: the kind does not start with
  // 'esp32', so it fell through every branch and each wire from the M-Bus
  // header resolved to null — a part wired to the header never saw a signal,
  // silently. These pin the dedicated branch.
  const CORE_GPIO = ['21', '22', '23', '19', '18', '3', '1', '16', '17', '2', '5', '25', '26', '35', '36', '12', '13', '15', '0', '34'];

  it('maps every M-Bus GPIO pad to its number', () => {
    for (const name of CORE_GPIO) {
      expect(boardPinToNumber('m5stack-core', name)).toBe(Number(name));
    }
  });

  it('maps the power pads (including BAT) to -1', () => {
    for (const name of ['5V', 'GND', '3V3', 'BAT']) {
      expect(boardPinToNumber('m5stack-core', name)).toBe(-1);
    }
  });

  it('rejects out-of-range and non-pins', () => {
    expect(boardPinToNumber('m5stack-core', '40')).toBeNull(); // classic tops out at 39
    expect(boardPinToNumber('m5stack-core', 'NOPE')).toBeNull();
  });
});
