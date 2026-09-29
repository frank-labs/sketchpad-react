// canvas.js —— 渲染逻辑（对应 Python 的 draw / redraw_all / 高亮 / 虚线预览）
import { regularBounds, flatten, moveShape } from './shapes.js';

// 规则形状的规范化结束点（square/circle 取 min 约束）
function boundsEnd(s) {
  const b = regularBounds(s);
  return { sx: b.sx, sy: b.sy, ex: b.ex, ey: b.ey };
}

// 画一个形状（普通渲染）
export function drawShape(ctx, s) {
  if (s.type === 'group') {
    s.shapes.forEach((c) => drawShape(ctx, c));
    return;
  }
  if (s.type === 'polygon') {
    // 与 Python 一致：多边形已提交的线段用黑色绘制
    if (s.points.length > 1) {
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const flat = flatten(s.points);
      ctx.moveTo(flat[0], flat[1]);
      for (let i = 2; i < flat.length; i += 2) ctx.lineTo(flat[i], flat[i + 1]);
      ctx.stroke();
    }
    return;
  }
  if (s.type === 'freehand') {
    if (s.points.length > 1) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      const flat = flatten(s.points);
      ctx.moveTo(flat[0], flat[1]);
      for (let i = 2; i < flat.length; i += 2) ctx.lineTo(flat[i], flat[i + 1]);
      ctx.stroke();
    }
    return;
  }

  // 规则形状
  ctx.strokeStyle = s.color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (s.type === 'line') {
    const [x1, y1] = s.start, [x2, y2] = s.end;
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  } else if (s.type === 'ellipse' || s.type === 'circle') {
    const { sx, sy, ex, ey } = boundsEnd(s);
    const rx = Math.abs(ex - sx) / 2, ry = Math.abs(ey - sy) / 2;
    ctx.ellipse(sx + rx, sy + ry, Math.max(rx, 0.1), Math.max(ry, 0.1), 0, 0, Math.PI * 2);
  } else {
    // rect / square
    const { sx, sy, ex, ey } = boundsEnd(s);
    ctx.rect(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy));
  }
  ctx.stroke();
}

// 高亮选中的形状：红色虚线（对应 redraw_all 里的 draw_highlighted_shape）
export function drawHighlight(ctx, s) {
  if (s.type === 'group') {
    s.shapes.forEach((c) => drawHighlight(ctx, c));
    return;
  }
  ctx.save();
  ctx.strokeStyle = 'red';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 2]);
  ctx.beginPath();
  if (Array.isArray(s.points)) {
    // 不规则形状：沿点列画虚线多边形
    if (s.points.length > 1) {
      const flat = flatten(s.points);
      ctx.moveTo(flat[0], flat[1]);
      for (let i = 2; i < flat.length; i += 2) ctx.lineTo(flat[i], flat[i + 1]);
      if (s.type === 'polygon' && s.points.length > 2) {
        ctx.closePath();
      }
      ctx.stroke();
    }
  } else {
    // 规则形状：虚线包围矩形
    const { sx, sy, ex, ey } = boundsEnd(s);
    ctx.rect(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy));
    ctx.stroke();
  }
  ctx.restore();
}

// 绘制进行中的草稿
// - 多边形：已提交点黑色实线 + 到鼠标位置的灰色虚线预览
// - 自由画笔 / 规则形状：正常颜色绘制（与 Python 一致）
export function drawDraft(ctx, draft) {
  if (!draft) return;
  if (draft.type === 'polygon') {
    if (draft.points.length > 1) {
      drawShape(ctx, draft);
    }
    if (draft.hover) {
      const pts = [...draft.points, draft.hover];
      if (pts.length > 1) {
        ctx.save();
        ctx.strokeStyle = 'gray';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        const flat = flatten(pts);
        ctx.moveTo(flat[0], flat[1]);
        for (let i = 2; i < flat.length; i += 2) ctx.lineTo(flat[i], flat[i + 1]);
        ctx.stroke();
        ctx.restore();
      }
    }
    return;
  }
  drawShape(ctx, draft);
}

// 粘贴预览：整体随鼠标平移 + 灰色虚线轮廓
export function drawPastePreview(ctx, pastePreview) {
  if (!pastePreview) return;
  const ox = pastePreview.at[0] - pastePreview.minX;
  const oy = pastePreview.at[1] - pastePreview.minY;
  ctx.save();
  ctx.strokeStyle = 'gray';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 2]);
  for (const s of pastePreview.base) {
    const moved = moveShape(s, ox, oy);
    if (moved.type === 'group') {
      for (const c of moved.shapes) strokePreview(ctx, c);
    } else {
      strokePreview(ctx, moved);
    }
  }
  ctx.restore();
}

function strokePreview(ctx, s) {
  ctx.beginPath();
  if (Array.isArray(s.points)) {
    if (s.points.length > 1) {
      const flat = flatten(s.points);
      ctx.moveTo(flat[0], flat[1]);
      for (let i = 2; i < flat.length; i += 2) ctx.lineTo(flat[i], flat[i + 1]);
      ctx.stroke();
    }
  } else {
    const { sx, sy, ex, ey } = boundsEnd(s);
    if (s.type === 'line') {
      ctx.moveTo(s.start[0], s.start[1]);
      ctx.lineTo(s.end[0], s.end[1]);
      ctx.stroke();
    } else {
      ctx.rect(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy));
      ctx.stroke();
    }
  }
}
