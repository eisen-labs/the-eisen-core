import { type Point, polygonArea, polygonCentroid } from "./region-geometry";

export interface RegionLabelOptions {
  points: Point[];
  label: string;
  alpha: number;
  scale: number;
  lineHeight: number;
  labelBg: string;
  labelFg: string;
  minArea?: number;
  minAlpha?: number;
  screenFontPx?: number;
  screenPadPx?: number;
}

export function drawLabelBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
): void {
  const radius = Math.min(h * 0.2, w * 0.2, 4);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function drawRegionLabel(ctx: CanvasRenderingContext2D, options: RegionLabelOptions): void {
  const {
    points,
    label,
    alpha,
    scale,
    lineHeight,
    labelBg,
    labelFg,
    minArea = 90,
    minAlpha = 0.06,
    screenFontPx = 13,
    screenPadPx = 2,
  } = options;

  if (alpha <= minAlpha || !label || polygonArea(points) < minArea) return;

  const center = polygonCentroid(points);
  const invScale = 1 / Math.max(scale, 1e-3);
  const fontSize = screenFontPx * invScale;
  const pad = screenPadPx * invScale;
  const lineH = fontSize * lineHeight;

  ctx.font = `500 ${fontSize}px sans-serif`;
  const textWidth = ctx.measureText(label).width;
  const boxW = textWidth + pad * 2;
  const boxH = lineH + pad * 2;
  const boxX = center.x - boxW / 2;
  const boxY = center.y - boxH / 2;

  const titleAlpha = 0.7;
  ctx.save();
  ctx.globalAlpha = alpha * titleAlpha;
  drawLabelBubble(ctx, boxX, boxY, boxW, boxH, labelBg);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = labelFg;
  ctx.fillText(label, center.x, center.y);
  ctx.restore();
}
