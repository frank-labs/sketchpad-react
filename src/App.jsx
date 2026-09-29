import { useCallback, useEffect, useRef, useState } from 'react';
import {
  makeId, cloneShape, moveShape, collectMinCoords,
  containsPoint, toDict, fromDict,
} from './shapes.js';
import { drawShape, drawHighlight, drawDraft, drawPastePreview } from './canvas.js';

// 工具列表：顺序、文案与 Python 工具栏一一对应
const TOOLS = [
  { id: 'select', label: 'Select/Move', msg: 'Select/Move Mode' },
  { id: 'line', label: 'Line', msg: 'Draw a Line' },
  { id: 'rect', label: 'Rectangle', msg: 'Draw a Rectangle' },
  { id: 'ellipse', label: 'Ellipse', msg: 'Draw an Ellipse' },
  { id: 'square', label: 'Square', msg: 'Draw a Square' },
  { id: 'circle', label: 'Circle', msg: 'Draw a Circle' },
  { id: 'polygon', label: 'Polygon', msg: 'Draw a Polygon' },
  { id: 'freehand', label: 'Freehand', msg: 'Draw Freehand' },
];
const REGULAR = new Set(['line', 'rect', 'ellipse', 'square', 'circle']);
const TOLERANCE = 10; // 多边形自动闭合的容差
const THRESHOLD = 5;  // 区分"点击"与"拖拽"的阈值

export default function App() {
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);

  // ---------- 文档状态 ----------
  const [tool, setTool] = useState('select');
  const [color, setColor] = useState('#000000');
  const [shapes, setShapes] = useState([]);        // 顶层形状（Group 为嵌套对象）
  const [activeIds, setActiveIds] = useState([]);  // 选中的顶层形状 id
  const [clipboard, setClipboard] = useState([]);  // 内部剪贴板（对应 copied_shapes）
  const [undoStack, setUndoStack] = useState([]);  // 快照栈
  const [redoStack, setRedoStack] = useState([]);
  const [draft, setDraft] = useState(null);        // 正在绘制的草稿
  const [pastePreview, setPastePreview] = useState(null);
  const [status, setStatus] = useState('Welcome! Choose a tool to start.');
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 });

  // 瞬态指针状态（不需要触发渲染的用 ref）
  const pointerDownRef = useRef(false);
  const dragRef = useRef(null); // { startX,startY,lastX,lastY,clickedId,moving,moveIds }

  // ---------- 撤销快照（对应 save_state） ----------
  const pushUndo = useCallback(() => {
    setUndoStack((u) => [...u, shapes.map(cloneShape)]);
    setRedoStack([]);
  }, [shapes]);

  // ---------- Canvas 自适应尺寸 ----------
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setBoxSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setBoxSize({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);

  // ---------- 渲染 ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !boxSize.w) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(boxSize.w * dpr);
    const h = Math.round(boxSize.h * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boxSize.w, boxSize.h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, boxSize.w, boxSize.h);

    shapes.forEach((s) => drawShape(ctx, s));                 // 普通形状
    drawPastePreview(ctx, pastePreview);                      // 粘贴虚线预览
    drawDraft(ctx, draft);                                    // 进行中的草稿
    shapes.filter((s) => activeIds.includes(s.id)).forEach((s) => drawHighlight(ctx, s)); // 高亮
  }, [shapes, activeIds, draft, pastePreview, boxSize]);

  // ---------- 工具函数 ----------
  const canvasPos = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const topShapeAt = useCallback((x, y) => {
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (containsPoint(shapes[i], x, y)) return shapes[i];
    }
    return null;
  }, [shapes]);

  // ---------- 指针事件：按下 ----------
  const handlePointerDown = useCallback((e) => {
    if (e.button === 2) return; // 右键交给 contextmenu
    const { x, y } = canvasPos(e);
    const ctrl = e.ctrlKey || e.metaKey;
    pointerDownRef.current = true;

    if (pastePreview) return; // 粘贴模式下由 up 决定落点

    if (tool === 'select') {
      const clicked = topShapeAt(x, y);
      pushUndo(); // 任何可能改变画布的操作前先存快照
      if (ctrl) {
        dragRef.current = { startX: x, startY: y, lastX: x, lastY: y, clickedId: clicked ? clicked.id : null, moving: false, moveIds: null };
      } else if (clicked) {
        if (!activeIds.includes(clicked.id)) setActiveIds([clicked.id]);
        dragRef.current = { startX: x, startY: y, lastX: x, lastY: y, clickedId: clicked.id, moving: false, moveIds: null };
      } else {
        setActiveIds([]);
        dragRef.current = null;
      }
      return;
    }

    // 绘图模式
    if (tool === 'polygon') {
      pushUndo();
      if (!draft) {
        setDraft({ id: makeId(), type: 'polygon', color, points: [[x, y]] });
      } else {
        const [ix, iy] = draft.points[0];
        if (Math.hypot(x - ix, y - iy) <= TOLERANCE) {
          // 靠近起点 → 闭合多边形
          setShapes((s) => [...s, { ...draft, points: [...draft.points, [ix, iy]] }]);
          setDraft(null);
        } else {
          setDraft((d) => ({ ...d, points: [...d.points, [x, y]] }));
        }
      }
      return;
    }

    // freehand 与规则形状
    pushUndo();
    if (tool === 'freehand') {
      setDraft({ id: makeId(), type: 'freehand', color, points: [[x, y]] });
    } else if (REGULAR.has(tool)) {
      setDraft({ id: makeId(), type: tool, color, start: [x, y], end: [x, y] });
    }
  }, [tool, color, shapes, activeIds, draft, pastePreview, canvasPos, topShapeAt, pushUndo]);

  // ---------- 指针事件：移动 ----------
  const handlePointerMove = useCallback((e) => {
    const { x, y } = canvasPos(e);

    if (pastePreview) {
      setPastePreview((p) => ({ ...p, at: [x, y] }));
      return;
    }

    // 选择模式拖拽移动
    if (tool === 'select' && pointerDownRef.current) {
      const d = dragRef.current;
      if (!d) return;
      const dx = x - d.lastX;
      const dy = y - d.lastY;
      if (!d.moving) {
        if (Math.hypot(x - d.startX, y - d.startY) > THRESHOLD) {
          d.moving = true;
          if (d.clickedId && !activeIds.includes(d.clickedId)) {
            setActiveIds((prev) => [...prev, d.clickedId]);
            d.moveIds = [...activeIds, d.clickedId];
          } else {
            d.moveIds = [...activeIds];
          }
        } else {
          return;
        }
      }
      setShapes((s) => s.map((sh) => (d.moveIds.includes(sh.id) ? moveShape(sh, dx, dy) : sh)));
      d.lastX = x;
      d.lastY = y;
      return;
    }

    // 绘图模式预览
    if (tool === 'polygon') {
      if (draft) setDraft((d) => ({ ...d, hover: [x, y] }));
      return;
    }
    if (pointerDownRef.current && draft) {
      if (tool === 'freehand') {
        setDraft((d) => ({ ...d, points: [...d.points, [x, y]] }));
      } else if (REGULAR.has(tool)) {
        setDraft((d) => ({ ...d, end: [x, y] }));
      }
    }
  }, [tool, activeIds, pastePreview, draft, canvasPos]);

  // ---------- 指针事件：松开 ----------
  const handlePointerUp = useCallback((e) => {
    const { x, y } = canvasPos(e);
    const ctrl = e.ctrlKey || e.metaKey;
    pointerDownRef.current = false;

    // 粘贴落点
    if (pastePreview) {
      pushUndo();
      const ox = x - pastePreview.minX;
      const oy = y - pastePreview.minY;
      setShapes((s) => [...s, ...pastePreview.base.map((b) => moveShape(b, ox, oy))]);
      setPastePreview(null);
      setStatus('Pasted copied shapes');
      return;
    }

    if (tool === 'select') {
      const d = dragRef.current;
      dragRef.current = null;
      if (d && !d.moving) {
        // 是一次"点击"，决定单选 / Ctrl 切换选中
        if (ctrl) {
          if (d.clickedId) {
            setActiveIds((prev) =>
              prev.includes(d.clickedId) ? prev.filter((id) => id !== d.clickedId) : [...prev, d.clickedId]
            );
          }
        } else if (d.clickedId) {
          setActiveIds([d.clickedId]);
        } else {
          setActiveIds([]);
        }
      }
      return;
    }

    // 结束绘制：提交草稿到 shapes
    if (draft) {
      if (tool === 'freehand' || REGULAR.has(tool)) {
        setShapes((s) => [...s, draft]);
        setDraft(null);
      }
    }
  }, [tool, pastePreview, draft, canvasPos, pushUndo]);

  // ---------- 右键：结束开口多边形 ----------
  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    if (tool === 'polygon' && draft && draft.points.length > 1) {
      const { x, y } = canvasPos(e);
      pushUndo();
      setShapes((s) => [...s, { ...draft, points: [...draft.points, [x, y]] }]);
      setDraft(null);
    }
  }, [tool, draft, canvasPos, pushUndo]);

  // ---------- 编辑操作 ----------
  const selectTool = useCallback((t) => {
    setTool(t);
    setDraft(null);
    setActiveIds([]);
    setStatus(t === 'select' ? 'Select/Move Mode' : TOOLS.find((x) => x.id === t)?.msg || '');
  }, []);

  const groupShapes = useCallback(() => {
    if (activeIds.length < 2) return;
    pushUndo();
    const selected = shapes.filter((s) => activeIds.includes(s.id));
    const group = { id: makeId(), type: 'group', color: null, shapes: selected.map(cloneShape) };
    setShapes((s) => [...s.filter((sh) => !activeIds.includes(sh.id)), group]);
    setActiveIds([group.id]);
    setStatus('Group selected shapes');
  }, [activeIds, shapes, pushUndo]);

  const ungroupShapes = useCallback(() => {
    if (activeIds.length !== 1) return;
    const g = shapes.find((s) => s.id === activeIds[0]);
    if (!g || g.type !== 'group') return;
    pushUndo();
    setShapes((s) => [...s.filter((sh) => sh.id !== g.id), ...g.shapes.map(cloneShape)]);
    setActiveIds(g.shapes.map((c) => c.id));
    setStatus('Ungroup selected shapes');
  }, [activeIds, shapes, pushUndo]);

  const copyShapes = useCallback(() => {
    if (activeIds.length) {
      setClipboard(shapes.filter((s) => activeIds.includes(s.id)).map(cloneShape));
      setStatus('Copied selected shapes');
    }
  }, [activeIds, shapes]);

  const cutShapes = useCallback(() => {
    if (!activeIds.length) return;
    pushUndo();
    setClipboard(shapes.filter((s) => activeIds.includes(s.id)).map(cloneShape));
    setShapes((s) => s.filter((sh) => !activeIds.includes(sh.id)));
    setActiveIds([]);
    setStatus('Cut selected shapes');
  }, [activeIds, shapes, pushUndo]);

  const startPasteMode = useCallback(() => {
    if (!clipboard.length) return;
    const base = clipboard.map(cloneShape);
    const acc = { minX: Infinity, minY: Infinity };
    base.forEach((b) => collectMinCoords(b, acc));
    // 默认放到画布中心附近
    const cx = boxSize.w / 2, cy = boxSize.h / 2;
    setPastePreview({ base, minX: acc.minX, minY: acc.minY, at: [cx, cy] });
    setStatus('Click on canvas to place pasted shapes');
  }, [clipboard, boxSize]);

  const deleteShapes = useCallback(() => {
    if (!activeIds.length) return;
    pushUndo();
    setShapes((s) => s.filter((sh) => !activeIds.includes(sh.id)));
    setActiveIds([]);
    setStatus('Deleted selected shapes');
  }, [activeIds, pushUndo]);

  const undo = useCallback(() => {
    if (!undoStack.length) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack((r) => [...r, shapes.map(cloneShape)]);
    setUndoStack((u) => u.slice(0, -1));
    setShapes(prev);
    setActiveIds([]);
    setStatus('Undo last action');
  }, [undoStack, shapes]);

  const redo = useCallback(() => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((u) => [...u, shapes.map(cloneShape)]);
    setRedoStack((r) => r.slice(0, -1));
    setShapes(next);
    setActiveIds([]);
    setStatus('Redo last action');
  }, [redoStack, shapes]);

  // ---------- 保存 / 加载 ----------
  const save = useCallback(() => {
    const data = shapes.map(toDict);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sketchpad.json';
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Saved to sketchpad.json');
  }, [shapes]);

  const handleLoadFile = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data)) throw new Error('not an array of shapes');
        pushUndo();
        setShapes(data.map(fromDict));
        setActiveIds([]);
        setStatus(`Loaded ${data.length} shape(s)`);
      } catch (err) {
        setStatus(`Load failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [pushUndo]);

  // ---------- 键盘快捷键 ----------
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteShapes(); }
      else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && k === 'y') { e.preventDefault(); redo(); }
      else if (mod && k === 'c') { e.preventDefault(); copyShapes(); }
      else if (mod && k === 'x') { e.preventDefault(); cutShapes(); }
      else if (mod && k === 'v') { e.preventDefault(); startPasteMode(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteShapes, undo, redo, copyShapes, cutShapes, startPasteMode]);

  const activeCount = activeIds.length;

  return (
    <div className="app">
      <div className="menubar">
        <button className="menu-btn" onClick={save}>Save</button>
        <button className="menu-btn" onClick={() => fileInputRef.current && fileInputRef.current.click()}>Load</button>
        <input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={handleLoadFile} />
      </div>

      <div className="toolbar">
        <label className="color-wrap" title="Choose a color">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={tool === t.id ? 'active' : ''}
            onClick={() => selectTool(t.id)}
            title={t.msg}
          >
            {t.label}
          </button>
        ))}
        <span className="sep" />
        <button onClick={groupShapes} title="Group selected shapes">Group</button>
        <button onClick={ungroupShapes} title="Ungroup selected shapes">Ungroup</button>
        <span className="sep" />
        <button onClick={copyShapes} title="Copy selected shapes">Copy</button>
        <button onClick={cutShapes} title="Cut selected shapes">Cut</button>
        <button onClick={startPasteMode} title="Paste copied shapes">Paste</button>
        <button onClick={deleteShapes} title="Delete selected shapes">Delete</button>
        <span className="sep" />
        <button onClick={undo} title="Undo (Ctrl+Z)">Undo</button>
        <button onClick={redo} title="Redo (Ctrl+Y)">Redo</button>
      </div>

      <div className="canvas-wrap">
        <canvas
          ref={canvasRef}
          className="pad"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => { pointerDownRef.current = false; }}
          onContextMenu={handleContextMenu}
        />
        <div className="hint">
          {tool === 'polygon' && 'Left-click to add vertices · click near start to close · right-click to finish open'}
          {tool === 'select' && 'Click to select · Ctrl+Click multi-select · drag to move'}
          {pastePreview && 'Move mouse, then left-click to place'}
        </div>
      </div>

      <div className="statusbar">{status} {activeCount > 0 && `· ${activeCount} selected`}</div>
    </div>
  );
}
