export interface Point { readonly x: number; readonly y: number }
export type NormalizedRegion = { readonly shape: "rectangle"; readonly x: number; readonly y: number; readonly width: number; readonly height: number } | { readonly shape: "polygon"; readonly points: readonly Point[] };
const epsilon = 1e-10;
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const onEdge = (p: Point, a: Point, b: Point) => Math.abs(cross(a, b, p)) <= epsilon && p.x >= Math.min(a.x, b.x) - epsilon && p.x <= Math.max(a.x, b.x) + epsilon && p.y >= Math.min(a.y, b.y) - epsilon && p.y <= Math.max(a.y, b.y) + epsilon;
export function normalizedRegionError(region: NormalizedRegion): string | undefined {
  const bounded = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  if (region.shape === "rectangle") return bounded(region) && region.width > 0 && region.height > 0 && bounded({ x: region.x + region.width, y: region.y + region.height }) ? undefined : "矩形越界或退化";
  if (region.shape !== "polygon" || !Array.isArray(region.points) || region.points.length < 3 || !region.points.every(bounded)) return "多边形越界或退化";
  const points = region.points, n = points.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= epsilon) return "多边形边退化";
    area += a.x * b.y - b.x * a.y;
    // Adjacent backtracking edges also overlap and are invalid.
    const prev = points[(i + n - 1) % n];
    if (Math.abs(cross(prev, a, b)) <= epsilon && onEdge(b, prev, a)) return "多边形自交";
    for (let j = i + 2; j < n; j++) {
      if ((j + 1) % n === i) continue;
      const c = points[j], d = points[(j + 1) % n];
      const intersect = cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0 || onEdge(a, c, d) || onEdge(b, c, d) || onEdge(c, a, b) || onEdge(d, a, b);
      if (intersect) return "多边形自交";
    }
  }
  return Math.abs(area) <= epsilon ? "多边形退化" : undefined;
}
export function regionContains(region: NormalizedRegion, point: Point): boolean {
  if (region.shape === "rectangle") return point.x >= region.x && point.x <= region.x + region.width && point.y >= region.y && point.y <= region.y + region.height;
  let inside = false;
  const pts = region.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i]; if (onEdge(point, a, b)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
