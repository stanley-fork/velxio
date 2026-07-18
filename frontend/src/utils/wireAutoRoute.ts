/**
 * First-time wire auto-routing: find an orthogonal route from pin to pin
 * that avoids crossing other components on the canvas.
 *
 * This runs ONLY when a wire is first created with no user-placed
 * waypoints (a direct pin-to-pin click). Manual edits are never re-routed:
 * the routed corners are stored as ordinary waypoints, so from that moment
 * on the wire behaves exactly like a hand-drawn one and goes wherever the
 * user drags it.
 *
 * Algorithm: A* over the compressed orthogonal grid spanned by the pin
 * coordinates and the inflated obstacle edges, with a per-bend cost so
 * straighter routes win. Canvases hold at most a few dozen components, so
 * the grid stays tiny (2N+2 coordinates per axis).
 */

import { previewElbow, simplifyOrthogonalPath } from './wireUtils';

export interface ObstacleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

/** Clearance kept between a routed wire and component bounding boxes. */
export const ROUTE_MARGIN = 8;

/** Extra path cost per 90-degree bend, in world px. */
const BEND_PENALTY = 40;

/** Hard cap on grid size, beyond which routing silently degrades to the
 * direct elbow. Far above any realistic canvas. */
const MAX_COORDS_PER_AXIS = 256;

function inflate(r: ObstacleRect, m: number): ObstacleRect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

function rectContains(r: ObstacleRect, p: Point): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}

/**
 * Axis-aligned segment vs rect overlap. Touching an edge exactly does not
 * count as a hit, so routes may run along the inflated boundary.
 */
function segmentHitsRect(a: Point, b: Point, r: ObstacleRect): boolean {
  if (a.y === b.y) {
    // Horizontal
    if (!(a.y > r.y && a.y < r.y + r.h)) return false;
    return Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w;
  }
  if (a.x === b.x) {
    // Vertical
    if (!(a.x > r.x && a.x < r.x + r.w)) return false;
    return Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h;
  }
  // Non-orthogonal segments never occur in routed paths
  return false;
}

function pathClear(pts: Point[], rects: ObstacleRect[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    for (const r of rects) {
      if (segmentHitsRect(pts[i - 1], pts[i], r)) return false;
    }
  }
  return true;
}

/** Minimal binary min-heap keyed on `f`. */
class Heap {
  private a: { f: number; s: number }[] = [];
  get size() {
    return this.a.length;
  }
  push(f: number, s: number) {
    const a = this.a;
    a.push({ f, s });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { f: number; s: number } {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Route from `start` to `end` avoiding `rawRects` (component bounding
 * boxes in world coordinates, uninflated).
 *
 * Returns the interior corner points of the route (ready to store as
 * waypoints), or null when the default direct elbow is already clear —
 * or when no clean route exists — so the caller falls back to the
 * existing preview-matching behavior.
 */
export function routeAroundObstacles(
  start: Point,
  end: Point,
  rawRects: ObstacleRect[],
): Point[] | null {
  if (rawRects.length === 0) return null;

  // Rects that contain an endpoint can never be avoided (the wire must
  // leave the pin); drop them rather than making routing impossible.
  const rects = rawRects
    .map((r) => inflate(r, ROUTE_MARGIN))
    .filter((r) => !rectContains(r, start) && !rectContains(r, end));
  if (rects.length === 0) return null;

  // Preferred direct route: the same elbow the live preview drew.
  const elbow = previewElbow(start, end.x, end.y);
  const direct = elbow ? [start, elbow, end] : [start, end];
  if (pathClear(direct, rects)) return null;

  // The other elbow orientation costs nothing extra — try it before A*.
  if (elbow) {
    const alt = elbow.x === end.x ? { x: start.x, y: end.y } : { x: end.x, y: start.y };
    if (pathClear([start, alt, end], rects)) return [alt];
  }

  // ── A* over the compressed grid ─────────────────────────────────────
  const xsSet = new Set<number>([start.x, end.x]);
  const ysSet = new Set<number>([start.y, end.y]);
  for (const r of rects) {
    xsSet.add(r.x);
    xsSet.add(r.x + r.w);
    ysSet.add(r.y);
    ysSet.add(r.y + r.h);
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  if (xs.length > MAX_COORDS_PER_AXIS || ys.length > MAX_COORDS_PER_AXIS) return null;

  const cols = xs.length;
  const rows = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));

  // State = (grid node, incoming direction). Directions: 0 none, 1 horizontal, 2 vertical.
  const nodeId = (cx: number, cy: number, dir: number) => (cy * cols + cx) * 3 + dir;
  const startCx = xi.get(start.x)!;
  const startCy = yi.get(start.y)!;
  const endCx = xi.get(end.x)!;
  const endCy = yi.get(end.y)!;

  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const h = (cx: number, cy: number) =>
    Math.abs(xs[cx] - end.x) + Math.abs(ys[cy] - end.y);

  const heap = new Heap();
  const s0 = nodeId(startCx, startCy, 0);
  dist.set(s0, 0);
  heap.push(h(startCx, startCy), s0);

  const stepClear = (a: Point, b: Point) => rects.every((r) => !segmentHitsRect(a, b, r));

  let goal = -1;
  while (heap.size) {
    const { s } = heap.pop();
    const dir = s % 3;
    const node = (s - dir) / 3;
    const cx = node % cols;
    const cy = (node - cx) / cols;
    const d = dist.get(s)!;
    if (cx === endCx && cy === endCy) {
      goal = s;
      break;
    }
    const neighbors: Array<[number, number, number]> = [
      [cx - 1, cy, 1],
      [cx + 1, cy, 1],
      [cx, cy - 1, 2],
      [cx, cy + 1, 2],
    ];
    for (const [nx, ny, ndir] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const a = { x: xs[cx], y: ys[cy] };
      const b = { x: xs[nx], y: ys[ny] };
      if (!stepClear(a, b)) continue;
      const bend = dir !== 0 && dir !== ndir ? BEND_PENALTY : 0;
      const nd = d + Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + bend;
      const ns = nodeId(nx, ny, ndir);
      if (nd < (dist.get(ns) ?? Infinity)) {
        dist.set(ns, nd);
        prev.set(ns, s);
        heap.push(nd + h(nx, ny), ns);
      }
    }
  }
  if (goal < 0) return null;

  // Reconstruct, simplify, return interior corners only.
  const pts: Point[] = [];
  for (let s: number | undefined = goal; s !== undefined; s = prev.get(s)) {
    const dir = s % 3;
    const node = (s - dir) / 3;
    const cx = node % cols;
    pts.push({ x: xs[cx], y: ys[(node - cx) / cols] });
  }
  pts.reverse();
  const simplified = simplifyOrthogonalPath(pts);
  return simplified.slice(1, -1);
}

/**
 * Bounding boxes of every component except the wire's own endpoints,
 * measured from the rendered DOM (store coordinates + element size).
 * Boards are deliberately NOT obstacles: pins live on both board edges
 * and detouring around a board produces absurd routes. Returns [] in
 * non-DOM environments (tests) and for unmounted components.
 */
export function collectComponentObstacles(
  components: Array<{ id: string; x: number; y: number }>,
  excludeIds: Array<string | undefined>,
): ObstacleRect[] {
  if (typeof document === 'undefined') return [];
  const skip = new Set(excludeIds.filter(Boolean));
  const rects: ObstacleRect[] = [];
  for (const c of components) {
    if (skip.has(c.id)) continue;
    const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(c.id) : c.id;
    const el = document.querySelector(
      `.dynamic-component-wrapper[data-component-id="${esc}"]`,
    ) as HTMLElement | null;
    if (!el) continue;
    const w = el.offsetWidth;
    const hh = el.offsetHeight;
    if (!w || !hh) continue;
    rects.push({ x: c.x, y: c.y, w, h: hh });
  }
  return rects;
}
