export interface Point {
  x: number;
  y: number;
}

export function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - a.y * b.x;
  }
  return Math.abs(sum) * 0.5;
}

export function polygonCentroid(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % points.length];
    const cross = p0.x * p1.y - p1.x * p0.y;
    area2 += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }

  if (Math.abs(area2) < 1e-6) {
    const avgX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const avgY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    return { x: avgX, y: avgY };
  }

  return {
    x: cx / (3 * area2),
    y: cy / (3 * area2),
  };
}

export function convexHull(points: Point[]): Point[] {
  if (points.length <= 1) return points.map((p) => ({ x: p.x, y: p.y }));

  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const deduped: Point[] = [];
  for (const p of sorted) {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev.x !== p.x || prev.y !== p.y) deduped.push(p);
  }
  if (deduped.length <= 2) return deduped;

  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point[] = [];
  for (const p of deduped) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point[] = [];
  for (let i = deduped.length - 1; i >= 0; i--) {
    const p = deduped[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function expandPolygon(points: Point[], padding: number): Point[] {
  if (points.length === 0) return [];
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  return points.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const mag = Math.hypot(dx, dy) || 1;
    return {
      x: p.x + (dx / mag) * padding,
      y: p.y + (dy / mag) * padding,
    };
  });
}

export function resamplePolygon(points: Point[], count: number): Point[] {
  if (points.length === 0) return [];
  if (points.length === 1) {
    return Array.from({ length: count }, () => ({ x: points[0].x, y: points[0].y }));
  }

  const segmentLengths: number[] = [];
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segmentLengths.push(len);
    perimeter += len;
  }

  if (perimeter === 0) {
    return Array.from({ length: count }, () => ({ x: points[0].x, y: points[0].y }));
  }

  const out: Point[] = [];
  const step = perimeter / count;
  let segmentIndex = 0;
  let distPastSegments = 0;
  for (let i = 0; i < count; i++) {
    const target = i * step;
    while (distPastSegments + segmentLengths[segmentIndex] < target && segmentLengths[segmentIndex] > 0) {
      distPastSegments += segmentLengths[segmentIndex];
      segmentIndex = (segmentIndex + 1) % points.length;
    }

    const segLen = segmentLengths[segmentIndex];
    const t = segLen === 0 ? 0 : (target - distPastSegments) / segLen;
    const a = points[segmentIndex];
    const b = points[(segmentIndex + 1) % points.length];
    out.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    });
  }

  return out;
}

export function alignPolygon(next: Point[], previous: Point[]): Point[] {
  if (next.length !== previous.length || next.length === 0) {
    return next.map((p) => ({ x: p.x, y: p.y }));
  }

  const scoreOffset = (input: Point[]): { score: number; offset: number } => {
    let bestScore = Number.POSITIVE_INFINITY;
    let bestOffset = 0;
    for (let offset = 0; offset < input.length; offset++) {
      let score = 0;
      for (let i = 0; i < input.length; i++) {
        const a = input[(i + offset) % input.length];
        const b = previous[i];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        score += dx * dx + dy * dy;
      }
      if (score < bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    return { score: bestScore, offset: bestOffset };
  };

  const rotate = (input: Point[], offset: number) => {
    const out: Point[] = [];
    for (let i = 0; i < input.length; i++) out.push(input[(i + offset) % input.length]);
    return out;
  };

  const forward = scoreOffset(next);
  const reversedInput = [...next].reverse();
  const reversed = scoreOffset(reversedInput);
  const best = forward.score <= reversed.score ? rotate(next, forward.offset) : rotate(reversedInput, reversed.offset);
  return best.map((p) => ({ x: p.x, y: p.y }));
}

export function lerpPolygon(from: Point[], to: Point[], amount: number): Point[] {
  if (from.length !== to.length) {
    return to.map((p) => ({ x: p.x, y: p.y }));
  }
  const t = Math.max(0, Math.min(1, amount));
  return from.map((p, i) => ({
    x: p.x + (to[i].x - p.x) * t,
    y: p.y + (to[i].y - p.y) * t,
  }));
}
