/**
 * First-time wire auto-routing around component bounding boxes.
 */

import { describe, it, expect } from 'vitest';
import {
  routeAroundObstacles,
  ROUTE_MARGIN,
  type ObstacleRect,
} from '../utils/wireAutoRoute';
import { expandOrthogonalPoints } from '../utils/wireUtils';

/** True when no segment of [start, ...corners, end] crosses an inflated rect. */
function routeAvoids(
  start: { x: number; y: number },
  corners: { x: number; y: number }[],
  end: { x: number; y: number },
  rects: ObstacleRect[],
): boolean {
  const pts = expandOrthogonalPoints([start, ...corners, end]);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    for (const r of rects) {
      const rx = r.x - ROUTE_MARGIN;
      const ry = r.y - ROUTE_MARGIN;
      const rw = r.w + 2 * ROUTE_MARGIN;
      const rh = r.h + 2 * ROUTE_MARGIN;
      if (a.y === b.y) {
        if (a.y > ry && a.y < ry + rh && Math.max(a.x, b.x) > rx && Math.min(a.x, b.x) < rx + rw)
          return false;
      } else if (a.x > rx && a.x < rx + rw && Math.max(a.y, b.y) > ry && Math.min(a.y, b.y) < ry + rh) {
        return false;
      }
    }
  }
  return true;
}

describe('routeAroundObstacles', () => {
  const start = { x: 0, y: 0 };
  const end = { x: 300, y: 200 };

  it('returns null with no obstacles (default elbow keeps working)', () => {
    expect(routeAroundObstacles(start, end, [])).toBeNull();
  });

  it('returns null when the preview elbow is already clear', () => {
    // Obstacle far away from both L-routes
    expect(
      routeAroundObstacles(start, end, [{ x: 1000, y: 1000, w: 50, h: 50 }]),
    ).toBeNull();
  });

  it('uses the other elbow orientation when only the preview one is blocked', () => {
    // dy (200) > dx... no: dx=300 >= dy=200 → preview goes horizontal-first
    // through (300, 0). Block that with a rect on the top edge.
    const rects: ObstacleRect[] = [{ x: 120, y: -30, w: 60, h: 60 }];
    const corners = routeAroundObstacles(start, end, rects);
    expect(corners).toEqual([{ x: 0, y: 200 }]);
    expect(routeAvoids(start, corners!, end, rects)).toBe(true);
  });

  it('routes around an obstacle blocking both L orientations', () => {
    // A tall block straddling the middle blocks horizontal-first and
    // vertical-first alike; A* must detour around it.
    const rects: ObstacleRect[] = [{ x: 100, y: -100, w: 60, h: 400 }];
    const corners = routeAroundObstacles(start, end, rects);
    expect(corners).not.toBeNull();
    expect(corners!.length).toBeGreaterThan(0);
    expect(routeAvoids(start, corners!, end, rects)).toBe(true);
  });

  it('ignores rects that contain an endpoint (wire must leave the pin)', () => {
    // The obstacle sits right on the start pin — routing around it is
    // impossible, so it must be dropped and the direct elbow kept.
    expect(
      routeAroundObstacles(start, end, [{ x: -20, y: -20, w: 40, h: 40 }]),
    ).toBeNull();
  });

  it('falls back to null when the target is fully walled off', () => {
    // Four rects boxing the end point with no gap
    const rects: ObstacleRect[] = [
      { x: 200, y: 100, w: 200, h: 20 },
      { x: 200, y: 280, w: 200, h: 20 },
      { x: 200, y: 100, w: 20, h: 200 },
      { x: 380, y: 100, w: 20, h: 200 },
    ];
    expect(routeAroundObstacles(start, { x: 300, y: 200 }, rects)).toBeNull();
  });

  it('keeps the route orthogonal', () => {
    const rects: ObstacleRect[] = [{ x: 100, y: -100, w: 60, h: 400 }];
    const corners = routeAroundObstacles(start, end, rects)!;
    const pts = [start, ...corners, end];
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i - 1].x === pts[i].x || pts[i - 1].y === pts[i].y).toBe(true);
    }
  });
});
