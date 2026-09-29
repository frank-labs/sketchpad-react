// shapes.js —— 形状模型与几何算法
// 对应 Python 里的 Shape 继承体系，但改用"纯数据 + 纯函数"表达：
// 每个形状是一个可序列化的普通对象（discriminated union 按 type 区分），
// 命中检测 / 平移 / 包围盒 / 深拷贝都是纯函数，便于 React 渲染和 JSON 持久化。

// 形状数据结构：
//   规则形状  : { id, type:'line'|'rect'|'ellipse'|'square'|'circle', color, start:[x,y], end:[x,y] }
//   不规则形状: { id, type:'polygon'|'freehand',                       color, points:[[x,y],...] }
//   分组      : { id, type:'group', color:null, shapes:[...子形状] }

let idCounter = 0;
export function makeId() {
  idCounter += 1;
  return `s${Date.now().toString(36)}_${idCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- 深拷贝 ----------
export function cloneShape(s) {
  if (!s) return s;
  if (s.type === 'group') return { ...s, shapes: s.shapes.map(cloneShape) };
  if (Array.isArray(s.points)) return { ...s, points: s.points.map((p) => [...p]) };
  return { ...s, start: [...s.start], end: [...s.end] };
}

// ---------- 平移（返回新对象，immutable） ----------
export function moveShape(s, dx, dy) {
  if (s.type === 'group') return { ...s, shapes: s.shapes.map((c) => moveShape(c, dx, dy)) };
  if (Array.isArray(s.points)) return { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy]) };
  return { ...s, start: [s.start[0] + dx, s.start[1] + dy], end: [s.end[0] + dx, s.end[1] + dy] };
}

// ---------- 递归求所有点坐标的最小值（用于 Paste 对齐到鼠标位置） ----------
export function collectMinCoords(s, acc) {
  if (s.type === 'group') {
    for (const c of s.shapes) collectMinCoords(c, acc);
    return;
  }
  if (Array.isArray(s.points)) {
    for (const [x, y] of s.points) {
      if (x < acc.minX) acc.minX = x;
      if (y < acc.minY) acc.minY = y;
    }
    return;
  }
  if (s.start[0] < acc.minX) acc.minX = s.start[0];
  if (s.start[1] < acc.minY) acc.minY = s.start[1];
  if (s.end[0] < acc.minX) acc.minX = s.end[0];
  if (s.end[1] < acc.minY) acc.minY = s.end[1];
}

// ---------- 规则形状的规范化边界 ----------
// 对应 Python Square / Circle：边长 / 半径取 |dx|、|dy| 的较小值，且恒从起点向右下延伸。
export function regularBounds(s) {
  let [sx, sy] = s.start;
  let [ex, ey] = s.end;
  if (s.type === 'square') {
    const side = Math.min(Math.abs(ex - sx), Math.abs(ey - sy));
    ex = sx + side;
    ey = sy + side;
  } else if (s.type === 'circle') {
    const r = Math.min(Math.abs(ex - sx), Math.abs(ey - sy)) / 2;
    ex = sx + 2 * r;
    ey = sy + 2 * r;
  }
  return { sx, sy, ex, ey };
}

// ---------- 包围盒 ----------
export function shapeBounds(s) {
  if (s.type === 'group') {
    let b = null;
    for (const c of s.shapes) {
      const cb = shapeBounds(c);
      if (!cb) continue;
      b = b
        ? { minX: Math.min(b.minX, cb.minX), minY: Math.min(b.minY, cb.minY), maxX: Math.max(b.maxX, cb.maxX), maxY: Math.max(b.maxY, cb.maxY) }
        : cb;
    }
    return b;
  }
  if (Array.isArray(s.points)) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of s.points) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }
  const { sx, sy, ex, ey } = regularBounds(s);
  return {
    minX: Math.min(sx, ex), minY: Math.min(sy, ey),
    maxX: Math.max(sx, ex), maxY: Math.max(sy, ey),
  };
}

// ---------- 几何工具 ----------
// 点到线段的最短距离（对应 Python Line.contains_point 的 dist 公式）
export function distPointToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ---------- 命中检测（对应 contains_point） ----------
// 与 Python 相同的容差：Freehand 10px，Line/Polygon 边 5px。
export function containsPoint(s, x, y) {
  if (s.type === 'group') return s.shapes.some((c) => containsPoint(c, x, y));

  if (s.type === 'freehand') {
    return s.points.some(([px, py]) => Math.abs(x - px) < 10 && Math.abs(y - py) < 10);
  }

  if (s.type === 'polygon') {
    const pts = s.points;
    // 边界命中：点在某条边上
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      if (distPointToSeg(x, y, x1, y1, x2, y2) < 5) return true;
    }
    // 内部命中：射线法（ray casting）
    let inside = false;
    const n = pts.length;
    let [x1, y1] = pts[0];
    for (let i = 0; i <= n; i++) {
      const [x2, y2] = pts[i % n];
      if (y > Math.min(y1, y2)) {
        if (y <= Math.max(y1, y2)) {
          if (x <= Math.max(x1, x2)) {
            if (y1 !== y2) {
              const xint = ((y - y1) * (x2 - x1)) / (y2 - y1) + x1;
              if (x1 === x2 || x <= xint) inside = !inside;
            }
          }
        }
      }
      x1 = x2; y1 = y2;
    }
    return inside;
  }

  if (s.type === 'line') {
    const [x1, y1] = s.start, [x2, y2] = s.end;
    if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) &&
        y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) {
      return distPointToSeg(x, y, x1, y1, x2, y2) < 5;
    }
    return false;
  }

  if (s.type === 'ellipse' || s.type === 'circle') {
    const { sx, sy, ex, ey } = regularBounds(s);
    const rx = Math.abs(ex - sx) / 2, ry = Math.abs(ey - sy) / 2;
    const cx = sx + rx, cy = sy + ry;
    if (rx > 0 && ry > 0) return ((x - cx) ** 2) / (rx ** 2) + ((y - cy) ** 2) / (ry ** 2) <= 1;
    return false;
  }

  // rect / square
  const { sx, sy, ex, ey } = regularBounds(s);
  return x >= Math.min(sx, ex) && x <= Math.max(sx, ex) &&
         y >= Math.min(sy, ey) && y <= Math.max(sy, ey);
}

// ---------- 序列化（对应 to_dict / from_dict） ----------
// 存储格式与 Python 的 JSON 输出结构保持一致，便于手工查看。
export function toDict(s) {
  if (s.type === 'group') return { type: 'group', shapes: s.shapes.map(toDict) };
  if (Array.isArray(s.points)) return { type: s.type, color: s.color, points: s.points.map(([x, y]) => [x, y]) };
  return { type: s.type, color: s.color, start: [...s.start], end: [...s.end] };
}

export function fromDict(data) {
  const base = { id: makeId(), type: data.type, color: data.color };
  if (data.type === 'group') return { ...base, shapes: (data.shapes || []).map(fromDict) };
  if (Array.isArray(data.points)) return { ...base, points: data.points.map(([x, y]) => [x, y]) };
  return { ...base, start: [...data.start], end: [...data.end] };
}

// 展平点列，供 Canvas 画折线 / 多边形用
export function flatten(points) {
  const out = [];
  for (const [x, y] of points) out.push(x, y);
  return out;
}
