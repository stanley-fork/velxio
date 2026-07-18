/**
 * Wire path generation: orthogonal expansion, degenerate-geometry cleanup
 * and rounded bends (Wokwi-style).
 */

import { describe, it, expect } from 'vitest';
import {
  expandOrthogonalPoints,
  simplifyOrthogonalPath,
  roundedPathFromPoints,
  generateOrthogonalPath,
  generatePreviewPath,
  previewElbow,
  normalizeWireWaypoints,
} from '../utils/wireUtils';

describe('expandOrthogonalPoints', () => {
  it('inserts a horizontal-first corner between non-aligned points', () => {
    expect(
      expandOrthogonalPoints([
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
    ]);
  });

  it('keeps axis-aligned hops as-is', () => {
    expect(
      expandOrthogonalPoints([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
    ]);
  });
});

describe('simplifyOrthogonalPath', () => {
  it('collapses a U-turn (wire doubling back over itself)', () => {
    // Down 300, back up 230 along the same vertical — the wire_test red
    // wire scenario. The middle point is the tip of the phantom stub.
    const simplified = simplifyOrthogonalPath([
      { x: 74, y: 278 },
      { x: 74, y: 577 },
      { x: 74, y: 348 },
      { x: 384, y: 348 },
    ]);
    expect(simplified).toEqual([
      { x: 74, y: 278 },
      { x: 74, y: 348 },
      { x: 384, y: 348 },
    ]);
  });

  it('collapses collinear runs and duplicate points', () => {
    expect(
      simplifyOrthogonalPath([
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 80 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ]);
  });

  it('never removes the first or last point', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 0, y: 50 },
    ];
    const simplified = simplifyOrthogonalPath(pts);
    expect(simplified[0]).toEqual({ x: 0, y: 0 });
    expect(simplified[simplified.length - 1]).toEqual({ x: 0, y: 50 });
  });
});

describe('roundedPathFromPoints', () => {
  it('emits a quadratic curve at each interior corner', () => {
    const d = roundedPathFromPoints(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      7,
    );
    expect(d).toBe('M 0 0 L 93 0 Q 100 0 100 7 L 100 100');
  });

  it('clamps the radius to half the shorter adjacent segment', () => {
    const d = roundedPathFromPoints(
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 100 },
      ],
      7,
    );
    // Incoming segment is 4 long → radius clamps to 2
    expect(d).toBe('M 0 0 L 2 0 Q 4 0 4 2 L 4 100');
  });

  it('falls back to a hard corner when segments are too short to round', () => {
    const d = roundedPathFromPoints(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 100 },
      ],
      7,
    );
    expect(d).toBe('M 0 0 L 1 0 L 1 100');
  });
});

describe('generateOrthogonalPath', () => {
  it('cleans degenerate stored waypoints at render time', () => {
    // The saved wire_test red wire: VIN → down past the target → back up →
    // across. The rendered path must not contain the phantom y=577 tip.
    const d = generateOrthogonalPath(
      { x: 74, y: 278 },
      [
        { x: 74, y: 577 },
        { x: 74, y: 348 },
      ],
      { x: 384, y: 321 },
    );
    expect(d).not.toContain('577');
    expect(d).toContain('Q');
  });

  it('renders a straight wire with no corners', () => {
    expect(generateOrthogonalPath({ x: 0, y: 10 }, [], { x: 200, y: 10 })).toBe(
      'M 0 10 L 200 10',
    );
  });
});

describe('previewElbow', () => {
  it('goes horizontal-first when dx dominates', () => {
    expect(previewElbow({ x: 0, y: 0 }, 100, 40)).toEqual({ x: 100, y: 0 });
  });

  it('goes vertical-first when dy dominates', () => {
    expect(previewElbow({ x: 0, y: 0 }, 40, 100)).toEqual({ x: 0, y: 100 });
  });

  it('returns null for axis-aligned legs', () => {
    expect(previewElbow({ x: 0, y: 0 }, 100, 0)).toBeNull();
    expect(previewElbow({ x: 0, y: 0 }, 0, 100)).toBeNull();
  });
});

describe('generatePreviewPath', () => {
  it('matches the committed shape for the vertical-first case', () => {
    // Preview with dy > dx bends vertical-first; committing through
    // finishWireCreation materialises the same elbow, so the two paths
    // must be identical (WYSIWYG).
    const preview = generatePreviewPath({ x: 0, y: 0 }, [], 40, 100);
    const committed = generateOrthogonalPath(
      { x: 0, y: 0 },
      normalizeWireWaypoints({ x: 0, y: 0 }, [{ x: 0, y: 100 }], { x: 40, y: 100 }),
      { x: 40, y: 100 },
    );
    expect(preview).toBe(committed);
  });
});

describe('normalizeWireWaypoints', () => {
  it('returns no waypoints for a straight wire', () => {
    expect(normalizeWireWaypoints({ x: 0, y: 0 }, [], { x: 100, y: 0 })).toEqual([]);
  });

  it('materialises implicit corners and drops U-turn junk', () => {
    expect(
      normalizeWireWaypoints(
        { x: 74, y: 278 },
        [
          { x: 74, y: 577 },
          { x: 74, y: 348 },
        ],
        { x: 384, y: 348 },
      ),
    ).toEqual([{ x: 74, y: 348 }]);
  });
});
