import React, { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import type { Point, DrawingState, DrawingTool, DrawingAction } from './types';
import { Edit3, Eraser, Minus, ArrowUpRight, Square, Circle as CircleIcon, Star as StarIcon, Wand2, Tag, Play, Ruler } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
//  Bulletproofed drawing canvas
//
//  Key guarantees:
//    • High-DPI correct — strokes render at native pixel density on retina
//      displays without blur. Drawing math still uses CSS pixels so shape
//      geometry is unchanged; the backing store is transparently upscaled
//      via ctx.scale(dpr, dpr).
//    • Pointer-events unified — mouse, touch, stylus and pen go through the
//      same handlers. No more parallel mouse/touch branches drifting out of
//      sync. `setPointerCapture` means a drag that exits the canvas still
//      gets its `pointerup`, so we never lose the final point of a shape.
//    • Tool locked per drag — the tool, color and line width at pointerdown
//      are cloned into the active action. Switching tools mid-drag no longer
//      corrupts the shape preview or produces weird hybrid artefacts.
//    • Transform-aware coords — rect-to-canvas conversion uses the ratio of
//      bounding-client rect to canvas bitmap, so CSS transforms (scale,
//      zoom, modal animations) on any ancestor don't throw off the cursor.
//    • Resize-safe — a ResizeObserver on the canvas re-applies the DPI
//      scaling and re-renders every prior action, so the drawing survives
//      window/container resizes without stretching.
//    • Crash-safe imperative ref — `captureDrawing / replay / undo / clear`
//      are always available and no-op safely if called before mount or
//      after unmount.
//    • Proper undo/clear — not just replay. Removes the last action and
//      re-renders from the remaining action list + initial background.
//    • Full cleanup — every ref that could hold an ImageData (~8MB on a
//      1080p canvas) is nulled on unmount.
// ─────────────────────────────────────────────────────────────────────────────

export interface DrawingCanvasRef extends HTMLCanvasElement {
  replay: () => void;
  captureDrawing: () => string | null;
  undo: () => void;
  redo: () => void;
  canRedo: () => boolean;
  clear: () => void;
}

interface DrawingCanvasProps {
  width: number;
  height: number;
  drawingState: DrawingState;
  onDrawEnd?: (dataUrl: string) => void;
  initialDrawingDataUrl?: string;
  className?: string;
  style?: React.CSSProperties;
  isReadOnly?: boolean;
  onAddTag?: (point: Point) => void;
  /** Remove the white bg + border — use when overlaying on an image */
  noBg?: boolean;
}

// Per-drag snapshot — the tool/color/width the user started with. Using this
// instead of reading drawingState live prevents tool-switch-mid-drag bugs.
interface ActiveStroke {
  tool: DrawingTool;
  color: string;
  lineWidth: number;
  start: Point;
  last: Point;
  path: Point[];                  // only populated for pencil / smart_shape / eraser
  snapshot: ImageData | null;     // only populated for shape tools
}

const SHAPE_TOOLS: readonly DrawingTool[] = ['line', 'arrow', 'rectangle', 'circle', 'star', 'ruler'];

const DrawingCanvas = forwardRef<HTMLCanvasElement | DrawingCanvasRef, DrawingCanvasProps>(({
  width,
  height,
  drawingState,
  onDrawEnd,
  initialDrawingDataUrl,
  className = '',
  style = {},
  isReadOnly = false,
  onAddTag,
  noBg = false,
}, forwardedRef) => {
  const internalRef = useRef<HTMLCanvasElement>(null);
  const [, setForceRender] = useState(0);

  // Per-drag state — refs because pointermove fires fast and we don't want
  // React re-renders on every sample.
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const actionsRef = useRef<DrawingAction[]>([]);
  // Stack of actions popped via undo. New strokes clear the stack so redo only
  // ever replays the most recent undo chain.
  const redoStackRef = useRef<DrawingAction[]>([]);

  // Drawing state read-once on mousedown lives here too so handlers are stable
  const drawingStateRef = useRef(drawingState);
  drawingStateRef.current = drawingState;

  // onDrawEnd can change on every parent render — keep a stable ref so the
  // pointer handlers (which we want to register without effect churn) always
  // see the latest callback.
  const onDrawEndRef = useRef(onDrawEnd);
  onDrawEndRef.current = onDrawEnd;

  const onAddTagRef = useRef(onAddTag);
  onAddTagRef.current = onAddTag;

  // ── Canvas context helper ──────────────────────────────────────────────────
  const getCtx = useCallback((): CanvasRenderingContext2D | null => {
    return internalRef.current?.getContext('2d', { willReadFrequently: true }) ?? null;
  }, []);

  // ── DPI-aware (re)size ─────────────────────────────────────────────────────
  // Sets the canvas backing store to (cssW × dpr) × (cssH × dpr), then scales
  // the context so all draw calls use CSS pixel coords. Call this on mount,
  // whenever width/height change, and on ResizeObserver fires.
  const applyDpiScaling = useCallback(() => {
    const canvas = internalRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

    const cssW = width;
    const cssH = height;

    // Only re-size if the backing store isn't already at the right density —
    // resizing clears the canvas, so we avoid it when not needed.
    const needsResize =
      canvas.width !== Math.round(cssW * dpr) ||
      canvas.height !== Math.round(cssH * dpr);

    if (needsResize) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      const ctx = getCtx();
      if (ctx) ctx.scale(dpr, dpr);
    }
  }, [width, height, getCtx]);

  // ── Replay the full action history ─────────────────────────────────────────
  // Used by both replay (animated) and undo / resize (instant).
  const renderAllActions = useCallback(async (animated: boolean) => {
    const ctx = getCtx();
    const canvas = internalRef.current;
    if (!ctx || !canvas) return;

    // Clear the entire bitmap, accounting for DPI (canvas.width is dpr-scaled)
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Restore DPI scale after setTransform wipe
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (initialDrawingDataUrl) {
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0, width, height);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = initialDrawingDataUrl;
      });
    }

    for (const action of actionsRef.current) {
      ctx.strokeStyle = action.color;
      ctx.fillStyle = action.color;
      ctx.lineWidth = action.lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (action.path.length === 0) continue;

      if (action.tool === 'pencil' || action.tool === 'smart_shape') {
        drawSmoothPath(ctx, action.path);
        if (animated) await wait(10 * action.path.length);
      } else if (action.tool === 'eraser') {
        for (const p of action.path) {
          const size = action.lineWidth * 2 + 8;
          ctx.clearRect(p.x - size / 2, p.y - size / 2, size, size);
          if (animated) await wait(10);
        }
      } else {
        const start = action.path[0];
        const end = action.path[action.path.length - 1];
        if (!start || !end) continue;
        if (animated) await wait(200);
        drawShape(ctx, action.tool, start, end, action.color, action.lineWidth);
      }
    }
  }, [initialDrawingDataUrl, width, height, getCtx]);

  // ── Imperative ref — always a valid object, safe no-ops pre-mount ─────────
  useImperativeHandle<HTMLCanvasElement | DrawingCanvasRef, DrawingCanvasRef>(
    forwardedRef as React.Ref<DrawingCanvasRef>,
    () => {
      const canvas = internalRef.current;
      const api: DrawingCanvasRef = {
        replay: () => { void renderAllActions(true); },
        captureDrawing: () => internalRef.current?.toDataURL('image/png') ?? null,
        undo: () => {
          if (actionsRef.current.length === 0) return;
          const popped = actionsRef.current[actionsRef.current.length - 1];
          if (!popped) return;
          actionsRef.current = actionsRef.current.slice(0, -1);
          redoStackRef.current = [...redoStackRef.current, popped];
          void renderAllActions(false);
          const dataUrl = internalRef.current?.toDataURL('image/png');
          if (dataUrl && onDrawEndRef.current) onDrawEndRef.current(dataUrl);
          // Force a render so parents watching the ref update (e.g. to
          // enable/disable an undo button) see the change.
          setForceRender(n => n + 1);
        },
        redo: () => {
          if (redoStackRef.current.length === 0) return;
          const next = redoStackRef.current[redoStackRef.current.length - 1];
          if (!next) return;
          redoStackRef.current = redoStackRef.current.slice(0, -1);
          actionsRef.current = [...actionsRef.current, next];
          void renderAllActions(false);
          const dataUrl = internalRef.current?.toDataURL('image/png');
          if (dataUrl && onDrawEndRef.current) onDrawEndRef.current(dataUrl);
          setForceRender(n => n + 1);
        },
        canRedo: () => redoStackRef.current.length > 0,
        clear: () => {
          actionsRef.current = [];
          redoStackRef.current = [];
          const ctx = getCtx();
          const c = internalRef.current;
          if (!ctx || !c) return;
          const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, c.width, c.height);
          ctx.restore();
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const dataUrl = internalRef.current?.toDataURL('image/png');
          if (dataUrl && onDrawEndRef.current) onDrawEndRef.current(dataUrl);
          setForceRender(n => n + 1);
        },
        // HTMLCanvasElement passthrough — use the underlying element when
        // available. These props just shadow it so callers typed against
        // HTMLCanvasElement still work.
        ...(canvas ?? {} as HTMLCanvasElement),
      } as DrawingCanvasRef;
      return api;
    },
    [renderAllActions, getCtx]
  );

  // ── Apply DPI on mount + when dimensions change ────────────────────────────
  useEffect(() => {
    applyDpiScaling();
    // Re-render any existing actions so the DPI change preserves the drawing.
    void renderAllActions(false);
  }, [applyDpiScaling, renderAllActions]);

  // ── ResizeObserver — survive container / window resizes ────────────────────
  useEffect(() => {
    const canvas = internalRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      applyDpiScaling();
      void renderAllActions(false);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [applyDpiScaling, renderAllActions]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      activeStrokeRef.current = null;
      actionsRef.current = [];
    };
  }, []);

  // ── Coordinate conversion that survives CSS transforms ─────────────────────
  // Uses the ratio between the canvas's DOMRect and its CSS dimensions so any
  // ancestor transform (scale, zoom) is handled. We also divide by the DPR
  // scale because the context is already scaled — drawing math uses CSS px.
  const getPointFromClient = (clientX: number, clientY: number): Point | null => {
    const canvas = internalRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
      timestamp: Date.now(),
    };
  };

  // ── Pointer handlers — unified mouse / touch / pen ────────────────────────
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isReadOnly) return;
    // Ignore secondary buttons — only primary (left-click / finger / pen tip)
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const ctx = getCtx();
    const canvas = internalRef.current;
    if (!ctx || !canvas) return;

    const point = getPointFromClient(e.clientX, e.clientY);
    if (!point) return;

    // Capture the pointer so a drag that exits the canvas still receives its
    // pointerup. Without this, shape previews leak and the final action is
    // never committed.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* nothing */ }

    const ds = drawingStateRef.current;

    // Snapshot everything for this drag — tool switches mid-drag are ignored.
    const snapshot = SHAPE_TOOLS.includes(ds.tool)
      ? ctx.getImageData(0, 0, canvas.width, canvas.height)
      : null;

    activeStrokeRef.current = {
      tool: ds.tool,
      color: ds.color,
      lineWidth: ds.lineWidth,
      start: point,
      last: point,
      path: [point],
      snapshot,
    };

    ctx.strokeStyle = ds.color;
    ctx.fillStyle = ds.color;
    ctx.lineWidth = ds.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (ds.tool === 'pencil' || ds.tool === 'smart_shape') {
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = activeStrokeRef.current;
    if (!stroke || isReadOnly) return;
    const ctx = getCtx();
    const canvas = internalRef.current;
    if (!ctx || !canvas) return;

    const point = getPointFromClient(e.clientX, e.clientY);
    if (!point) return;

    const { tool, color, lineWidth, last, start } = stroke;
    stroke.path.push(point);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;

    // For shape tools, restore the snapshot so each mousemove draws over a
    // clean slate — avoids stacking preview artefacts.
    if (SHAPE_TOOLS.includes(tool) && stroke.snapshot) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(stroke.snapshot, 0, 0);
      ctx.restore();
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lineWidth;
    }

    switch (tool) {
      case 'pencil':
      case 'smart_shape': {
        // Quadratic midpoint smoothing — avoids the darkening stacked-stroke
        // effect you get from lineTo+stroke per sample.
        const midX = (last.x + point.x) / 2;
        const midY = (last.y + point.y) / 2;
        ctx.quadraticCurveTo(last.x, last.y, midX, midY);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(midX, midY);
        break;
      }
      case 'eraser': {
        const size = lineWidth * 2 + 8;
        ctx.clearRect(point.x - size / 2, point.y - size / 2, size, size);
        break;
      }
      case 'line':
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
        break;
      case 'arrow':
        drawArrow(ctx, start, point, color, lineWidth);
        break;
      case 'rectangle':
        ctx.beginPath();
        ctx.rect(start.x, start.y, point.x - start.x, point.y - start.y);
        ctx.stroke();
        break;
      case 'circle': {
        const radius = Math.hypot(point.x - start.x, point.y - start.y);
        ctx.beginPath();
        ctx.arc(start.x, start.y, radius, 0, 2 * Math.PI);
        ctx.stroke();
        break;
      }
      case 'star': {
        const radius = Math.hypot(point.x - start.x, point.y - start.y) / 2;
        drawStar(ctx, (start.x + point.x) / 2, (start.y + point.y) / 2, 5, radius, color, lineWidth, true);
        break;
      }
      case 'job_tag':
        // Tag is placed on pointerup; nothing to render during drag.
        break;
    }

    stroke.last = point;
  };

  const commitStroke = (finalPoint: Point) => {
    const stroke = activeStrokeRef.current;
    if (!stroke) return;

    const { tool, color, lineWidth, start, path } = stroke;
    stroke.path.push(finalPoint);

    const ctx = getCtx();
    if (!ctx) {
      activeStrokeRef.current = null;
      return;
    }

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Smart shape resolution on release
    if (tool === 'smart_shape' && path.length > 5 && stroke.snapshot) {
      const end = finalPoint;
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      const minX = Math.min(...path.map(p => p.x));
      const maxX = Math.max(...path.map(p => p.x));
      const minY = Math.min(...path.map(p => p.y));
      const maxY = Math.max(...path.map(p => p.y));
      const w = maxX - minX;
      const h = maxY - minY;

      // Restore the pre-drag snapshot so the resolved shape doesn't sit on
      // top of the raw sketch.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(stroke.snapshot, 0, 0);
      ctx.restore();
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lineWidth;

      if (distance < 50) {
        const ratio = h === 0 ? 1 : w / h;
        if (ratio > 0.8 && ratio < 1.2) {
          ctx.beginPath();
          ctx.arc(minX + w / 2, minY + h / 2, w / 2, 0, 2 * Math.PI);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.rect(minX, minY, w, h);
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(finalPoint.x, finalPoint.y);
        ctx.stroke();
      }
    } else if (tool === 'job_tag') {
      onAddTagRef.current?.(finalPoint);
    }

    // Record the committed action and invalidate any pending redo —
    // a new stroke after undo means the redone branch is gone.
    actionsRef.current.push({
      tool,
      path: [...path],
      color,
      lineWidth,
      timestamp: Date.now(),
    });
    if (redoStackRef.current.length > 0) {
      redoStackRef.current = [];
      setForceRender(n => n + 1);
    }

    // Clear per-drag state — prevents tempImageData from persisting in memory
    activeStrokeRef.current = null;

    // Notify parent with the final dataUrl
    if (onDrawEndRef.current && internalRef.current) {
      onDrawEndRef.current(internalRef.current.toDataURL('image/png'));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!activeStrokeRef.current || isReadOnly) return;
    const canvas = internalRef.current;
    try { canvas?.releasePointerCapture(e.pointerId); } catch { /* nothing */ }
    const point = getPointFromClient(e.clientX, e.clientY) || activeStrokeRef.current.last;
    commitStroke(point);
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Treat a cancelled pointer (e.g. OS gesture hijacking the touch) as a
    // commit at the last known point so the user's work isn't lost.
    if (!activeStrokeRef.current || isReadOnly) return;
    const canvas = internalRef.current;
    try { canvas?.releasePointerCapture(e.pointerId); } catch { /* nothing */ }
    commitStroke(activeStrokeRef.current.last);
  };

  return (
    <canvas
      ref={(el) => {
        (internalRef as React.MutableRefObject<HTMLCanvasElement | null>).current = el;
      }}
      // NOTE: width / height are set imperatively by applyDpiScaling so they
      // reflect DPR. The attributes below are placeholders for the initial
      // render — the effect runs immediately after and fixes them up.
      width={width}
      height={height}
      className={`${className} ${isReadOnly ? 'cursor-not-allowed' : 'cursor-crosshair'}${noBg ? '' : ' bg-white border border-gray-300 rounded-md'}`}
      style={{ touchAction: 'none', display: 'block', ...style }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerUp}
    />
  );
});

DrawingCanvas.displayName = 'DrawingCanvas';

// ── Drawing primitives ─────────────────────────────────────────────────────

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function drawSmoothPath(ctx: CanvasRenderingContext2D, path: Point[]) {
  const first = path[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < path.length - 1; i++) {
    const curr = path[i];
    const next = path[i + 1];
    if (!curr || !next) continue;
    const midX = (curr.x + next.x) / 2;
    const midY = (curr.y + next.y) / 2;
    ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
  }
  if (path.length > 1) {
    const last = path[path.length - 1];
    if (last) ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  tool: DrawingTool,
  start: Point,
  end: Point,
  color: string,
  lineWidth: number,
) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  switch (tool) {
    case 'line':
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      break;
    case 'arrow':
      drawArrow(ctx, start, end, color, lineWidth);
      break;
    case 'rectangle':
      ctx.beginPath();
      ctx.rect(start.x, start.y, end.x - start.x, end.y - start.y);
      ctx.stroke();
      break;
    case 'circle': {
      const radius = Math.hypot(end.x - start.x, end.y - start.y);
      ctx.beginPath();
      ctx.arc(start.x, start.y, radius, 0, 2 * Math.PI);
      ctx.stroke();
      break;
    }
    case 'star': {
      const radius = Math.hypot(end.x - start.x, end.y - start.y) / 2;
      drawStar(ctx, (start.x + end.x) / 2, (start.y + end.y) / 2, 5, radius, color, lineWidth, true);
      break;
    }
    case 'ruler':
      drawRuler(ctx, start, end, color, lineWidth);
      break;
  }
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  lineWidth: number,
) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const tickHalf = Math.max(6, lineWidth * 2);

  // Main line
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  // End-cap ticks perpendicular to the line
  const perp = angle + Math.PI / 2;
  const cos = Math.cos(perp) * tickHalf;
  const sin = Math.sin(perp) * tickHalf;
  ctx.beginPath();
  ctx.moveTo(from.x - cos, from.y - sin);
  ctx.lineTo(from.x + cos, from.y + sin);
  ctx.moveTo(to.x - cos, to.y - sin);
  ctx.lineTo(to.x + cos, to.y + sin);
  ctx.stroke();

  // Distance label — pixel count, centred above the line
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const labelText = `${Math.round(distance)} px`;
  ctx.save();
  ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const textWidth = ctx.measureText(labelText).width;
  const padX = 6;
  const padY = 3;
  const boxW = textWidth + padX * 2;
  const boxH = 18;
  // Translate to midpoint, rotate so label sits along the line, but
  // flip if upside down so text is always readable.
  ctx.translate(midX, midY);
  let rot = angle;
  if (rot > Math.PI / 2 || rot < -Math.PI / 2) rot += Math.PI;
  ctx.rotate(rot);
  // Background pill above the line
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const boxX = -boxW / 2;
  const boxY = -boxH - 4;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(boxX, boxY, boxW, boxH, 4);
  else ctx.rect(boxX, boxY, boxW, boxH);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(labelText, 0, boxY + boxH / 2 + padY - padY);
  ctx.restore();
}

function drawArrow(
  context: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  lineWidth: number
) {
  const headLength = Math.max(10, lineWidth * 2.5);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);

  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.stroke();

  context.beginPath();
  context.moveTo(to.x, to.y);
  context.lineTo(to.x - headLength * Math.cos(angle - Math.PI / 6), to.y - headLength * Math.sin(angle - Math.PI / 6));
  context.lineTo(to.x - headLength * Math.cos(angle + Math.PI / 6), to.y - headLength * Math.sin(angle + Math.PI / 6));
  context.closePath();
  context.fillStyle = color;
  context.fill();
}

function drawStar(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  points: number,
  outerRadius: number,
  color: string,
  lineWidth: number,
  filled = false
) {
  const innerRadius = outerRadius / 2;
  context.beginPath();
  for (let i = 0; i < 2 * points; i++) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = (Math.PI / points) * i - Math.PI / 2;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.stroke();
  if (filled) {
    context.fillStyle = color;
    context.fill();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Toolbar (unchanged — toolbar UX / controls stay the same, only the
//  underlying engine got bulletproofed)
// ─────────────────────────────────────────────────────────────────────────────

interface DrawingToolbarProps {
  drawingState: DrawingState;
  onStateChange: <K extends keyof DrawingState>(key: K, value: DrawingState[K]) => void;
  colorOptions?: string[];
  lineWidthOptions?: number[];
  className?: string;
  onReplay?: () => void;
}

export const DrawingToolbar: React.FC<DrawingToolbarProps> = ({
  drawingState,
  onStateChange,
  colorOptions = ['#FF0000', '#0000FF', '#00FF00', '#FFFF00', '#000000', '#FFFFFF'],
  lineWidthOptions = [1, 3, 5, 8, 12],
  className = "",
  onReplay,
}) => {
  const basicTools: { name: DrawingTool; icon: React.ReactNode; label: string }[] = [
    { name: 'pencil', icon: <Edit3 className="h-4 w-4" />, label: 'Pencil' },
    { name: 'eraser', icon: <Eraser className="h-4 w-4" />, label: 'Eraser' },
    { name: 'smart_shape', icon: <Wand2 className="h-4 w-4" />, label: 'Smart Shape' },
    { name: 'job_tag', icon: <Tag className="h-4 w-4" />, label: 'Job Detail' },
  ];
  const shapeTools: { name: DrawingTool; icon: React.ReactNode; label: string }[] = [
    { name: 'line', icon: <Minus className="h-4 w-4 transform rotate-45" />, label: 'Line' },
    { name: 'arrow', icon: <ArrowUpRight className="h-4 w-4" />, label: 'Arrow' },
    { name: 'rectangle', icon: <Square className="h-4 w-4" />, label: 'Rectangle' },
    { name: 'circle', icon: <CircleIcon className="h-4 w-4" />, label: 'Circle' },
    { name: 'star', icon: <StarIcon className="h-4 w-4" />, label: 'Star' },
    { name: 'ruler', icon: <Ruler className="h-4 w-4" />, label: 'Ruler — measure pixel distance' },
  ];

  const renderToolButton = (tool: { name: DrawingTool; icon: React.ReactNode; label: string }) => (
    <button
      key={tool.name}
      title={tool.label}
      onClick={() => onStateChange('tool', tool.name)}
      className={`p-1.5 rounded-md hover:bg-gray-200 transition-colors ${drawingState.tool === tool.name ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-white text-gray-700 border border-gray-300'
        }`}
    >
      {tool.icon}
    </button>
  );

  return (
    <div className={`flex flex-col gap-3 p-3 border border-gray-200 rounded-lg bg-gray-50 ${className}`}>
      {/* Basic Tools */}
      <div className="flex items-center gap-2 justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-600 mr-1 min-w-[70px]">AI Tools:</span>
          <div className="flex flex-wrap gap-1.5">
            {basicTools.map(renderToolButton)}
          </div>
        </div>
        {onReplay && (
          <button
            onClick={onReplay}
            className="p-1.5 rounded-md bg-green-100 hover:bg-green-200 text-green-700 transition-colors"
            title="Replay Drawing"
          >
            <Play className="h-4 w-4 fill-current" />
          </button>
        )}
      </div>

      {/* Shape Tools */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-600 mr-1 min-w-[70px]">Shapes:</span>
        <div className="flex flex-wrap gap-1.5">
          {shapeTools.map(renderToolButton)}
        </div>
      </div>

      {/* Line Width and Colors */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
        {/* Line Width */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-600 mr-1 min-w-[70px] sm:min-w-0">Size:</span>
          <div className="flex flex-wrap gap-1.5">
            {lineWidthOptions.map(w => (
              <button
                key={`width-${w}`}
                title={`${w}px`}
                onClick={() => onStateChange('lineWidth', w)}
                className={`p-1.5 rounded-md hover:bg-gray-200 transition-colors h-8 min-w-[2rem] flex items-center justify-center ${drawingState.lineWidth === w ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-white text-gray-700 border border-gray-300'
                  }`}
              >
                <span className="block bg-black rounded-full" style={{ width: `${w}px`, height: `${w}px`, minWidth: '2px', minHeight: '2px', maxWidth: '16px', maxHeight: '16px' }}></span>
              </button>
            ))}
          </div>
        </div>

        {/* Colors */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-600 mr-1 min-w-[70px] sm:min-w-0">Color:</span>
          <div className="flex flex-wrap gap-1.5 items-center">
            {colorOptions.map(color => (
              <button
                key={color}
                title={color}
                onClick={() => onStateChange('color', color)}
                className={`h-6 w-6 rounded-full border-2 transition-all duration-150 ease-in-out
                ${drawingState.color === color ? 'ring-2 ring-offset-1 ring-blue-500 scale-110' : 'hover:scale-110'}
                ${color === '#FFFFFF' ? 'border-gray-400' : 'border-transparent'}`}
                style={{ backgroundColor: color }}
              />
            ))}
            <input
              type="color"
              value={drawingState.color}
              onChange={(e) => onStateChange('color', e.target.value)}
              className="h-7 w-9 rounded-md border border-gray-300 cursor-pointer p-0.5"
              title="Custom Color"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

// Memoized so parents that re-render frequently (e.g. the annotation viewer
// while typing a text note) don't force a full canvas reconcile each time.
// Props are referentially stable in those callers, so shallow-equal holds.
const MemoizedDrawingCanvas = React.memo(DrawingCanvas);
MemoizedDrawingCanvas.displayName = 'DrawingCanvas';

export default MemoizedDrawingCanvas;
