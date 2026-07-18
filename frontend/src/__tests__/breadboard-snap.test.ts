/**
 * Parts-on-breadboard geometry: hole grids, nearest-hole lookup and the
 * wire flag plumbing that keeps seating wires invisible.
 */

import { describe, it, expect } from 'vitest';
import { breadboardHoles, nearestHole, SEAT_TOLERANCE } from '../utils/breadboardSnap';
import { BREADBOARD_PINS } from '../velxio-elements/breadboard-element';
import { BREADBOARD_MINI_PINS } from '../velxio-elements/breadboard-mini-element';

const WRAPPER_INSET = 6;

describe('breadboardHoles', () => {
  it('exposes the full-size grid (830 holes) and the mini grid (170)', () => {
    expect(breadboardHoles('breadboard')).toHaveLength(830);
    expect(breadboardHoles('breadboard-mini')).toHaveLength(170);
    expect(breadboardHoles('led')).toBeNull();
  });

  it('uses the wokwi 9.6 px pitch on both axes', () => {
    const holes = BREADBOARD_PINS;
    const c1a = holes.find((h) => h.name === '1t.a')!;
    const c2a = holes.find((h) => h.name === '2t.a')!;
    const c1b = holes.find((h) => h.name === '1t.b')!;
    expect(c2a.x - c1a.x).toBeCloseTo(9.6, 5);
    expect(c1b.y - c1a.y).toBeCloseTo(9.6, 5);
  });

  it('spans exactly 6 pitches from row b to row f (resistor trench bridge)', () => {
    const b = BREADBOARD_PINS.find((h) => h.name === '10t.b')!;
    const f = BREADBOARD_PINS.find((h) => h.name === '10b.f')!;
    expect(f.y - b.y).toBeCloseTo(6 * 9.6, 5);
    expect(f.x).toBeCloseTo(b.x, 5);
  });

  it('mini board has no rails', () => {
    expect(BREADBOARD_MINI_PINS.some((h) => h.name.includes('p.'))).toBe(false);
  });
});

describe('nearestHole', () => {
  const bb = { id: 'bb1', metadataId: 'breadboard', x: 100, y: 200 };
  const hole = BREADBOARD_PINS.find((h) => h.name === '5t.c')!;
  const world = { x: 100 + WRAPPER_INSET + hole.x, y: 200 + WRAPPER_INSET + hole.y };

  it('finds the exact hole under a world point (wrapper inset accounted)', () => {
    const found = nearestHole(bb, world, SEAT_TOLERANCE);
    expect(found?.name).toBe('5t.c');
    expect(found?.dist).toBeCloseTo(0, 5);
  });

  it('absorbs the resistor 1.2 px pitch residual but rejects beyond tolerance', () => {
    expect(nearestHole(bb, { x: world.x + 1.2, y: world.y }, SEAT_TOLERANCE)?.name).toBe('5t.c');
    // Center of the e-f trench: 14.4 px from the nearest rows — no hole.
    const rowE = BREADBOARD_PINS.find((h) => h.name === '5t.e')!;
    const trench = { x: 100 + WRAPPER_INSET + rowE.x, y: 200 + WRAPPER_INSET + rowE.y + 14.4 };
    expect(nearestHole(bb, trench, SEAT_TOLERANCE)).toBeNull();
  });

  it('tolerance stays below half the hole pitch (no ambiguous seating)', () => {
    expect(SEAT_TOLERANCE).toBeLessThan(9.6 / 2);
  });

  it('refuses rotated breadboards', () => {
    const rotated = { ...bb, properties: { rotation: 90 } };
    expect(nearestHole(rotated, world, SEAT_TOLERANCE)).toBeNull();
  });
});
