/**
 * 棋盘视图：Canvas 绘制 + 触屏交互。
 *
 * 交互设计（手机优先）：
 *   - 未选棋子：单指拖动 = 平移棋盘，双指 = 缩放。
 *   - 选中棋子：单指拖动 = 移动半透明的「影子棋子」；
 *     松手时如果开了「自动吸附」，会吸附到最近的合法位置。
 *   - 轻点棋盘 = 影子直接跳到那一格。
 *   - 点「落子」才真正提交，所以不会误操作。
 */

import {
  BOARD_SIZE,
  SEAT_HEX,
  SEAT_HEX_DARK,
  SEAT_CORNERS,
  EDGE_OFFSETS,
  DIAG_OFFSETS,
} from '/shared/constants.js';
import { PIECE_BY_ID } from '/shared/pieces.js';
import { deserializeState, legalMoves } from '/shared/rules.js';

const SNAP_RADIUS = 4; // 自动吸附的最大距离（格）
const TAP_MOVE_PX = 9; // 小于这个位移算「轻点」
const DPR_MAX = 3;

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 把一枚棋子画到小 canvas 上（棋子栏用） */
export function drawPiecePreview(canvas, piece, orientIndex, colorHex, cell = 7, dpr = 1) {
  const w = piece.widths[orientIndex];
  const h = piece.heights[orientIndex];
  const cssW = w * cell;
  const cssH = h * cell;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const r = Math.max(1.5, cell * 0.24);
  for (const [dx, dy] of piece.orientations[orientIndex]) {
    roundRect(ctx, dx * cell + 0.5, dy * cell + 0.5, cell - 1, cell - 1, r);
    ctx.fillStyle = colorHex;
    ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class BoardView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{
   *   onConfirm?: (move:{pieceId:string,orient:number,x:number,y:number})=>void,
   *   onTip?: (text:string)=>void,
   *   onSelectChange?: (pieceId:string|null)=>void,
   * }} [opts]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;

    this.raw = null; // 序列化快照
    this.state = null; // 反序列化后的状态（用于本地算合法着法）
    this.mySeat = null;
    this.legal = []; // 我的全部合法着法
    this.legalWarned = false;

    this.sel = null; // { pieceId, orient, gx, gy }
    this.snapEnabled = true;

    this.view = { zoom: 1, tx: 0, ty: 0 };
    this.layout = { cssW: 0, cssH: 0, baseCell: 0, boardPx: 0, dpr: 1 };

    this.pointers = new Map();
    this.gesture = null; // { mode:'pan'|'ghost'|'pinch', ... }
    this.lastMovePulse = 0;

    this.#bindEvents();
  }

  /* ------------------------------ 对外接口 ------------------------------ */

  setState(raw) {
    this.raw = raw;
    this.state = deserializeState(raw);
    this.#recomputeLegal();

    // 选中的棋子在别处已下掉 / 已经落下，就清掉选择
    if (this.sel) {
      const stillMine =
        this.mySeat !== null && raw.remaining[this.mySeat].includes(this.sel.pieceId);
      if (!stillMine || raw.turn !== this.mySeat || raw.over) this.#clearSelection(true);
    }

    // 每次状态更新后让「最近一手」闪一下
    this.lastMovePulse = performance.now();
    this.render();
    this.#emitTip();
  }

  setMySeat(seat) {
    if (this.mySeat === seat) return;
    this.mySeat = seat;
    this.#clearSelection(true);
    this.#recomputeLegal();
    this.render();
    this.#emitTip();
  }

  setSnapEnabled(on) {
    this.snapEnabled = !!on;
  }

  /** 选中一枚棋子；会自动挑一个放得下的朝向和位置 */
  selectPiece(pieceId) {
    if (!this.state || this.mySeat === null) return;
    if (this.raw?.over) return;
    if (this.raw?.turn !== this.mySeat) {
      this.opts.onTip?.('还没轮到你');
      return;
    }
    const piece = PIECE_BY_ID.get(pieceId);
    if (!piece) return;

    // 优先用当前朝向；放不下就换一个放得下的朝向
    let orient = 0;
    let origins = this.#originsFor(pieceId, orient);
    if (origins.length === 0) {
      for (let oi = 0; oi < piece.orientations.length; oi++) {
        const list = this.#originsFor(pieceId, oi);
        if (list.length > 0) {
          orient = oi;
          origins = list;
          break;
        }
      }
    }

    let gx = 0;
    let gy = 0;
    if (origins.length > 0) {
      // 挑一个离当前视野中心最近的合法位置
      const c = this.#viewCenterCell();
      let best = origins[0];
      let bestD = Infinity;
      for (const o of origins) {
        const d = (o.x + 0.5 - c.x) ** 2 + (o.y + 0.5 - c.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = o;
        }
      }
      gx = best.x;
      gy = best.y;
    }

    this.sel = { pieceId, orient, gx, gy };
    this.opts.onSelectChange?.(pieceId);
    this.render();
    this.#emitTip();
  }

  clearSelection() {
    this.#clearSelection();
  }

  get selection() {
    return this.sel ? { ...this.sel } : null;
  }

  rotate(dir = 1) {
    if (!this.sel) return;
    const piece = PIECE_BY_ID.get(this.sel.pieceId);
    const n = piece.orientations.length;
    this.sel.orient = (((this.sel.orient + dir) % n) + n) % n;
    this.#snapGhost();
    this.render();
    this.#emitTip();
  }

  /** 翻面（镜像）。用预计算好的镜像下标，保证是真正的翻转而不是再转 90° */
  flip() {
    if (!this.sel) return;
    const piece = PIECE_BY_ID.get(this.sel.pieceId);
    const next = piece.flipIndex?.[this.sel.orient];
    if (next === undefined || next === null) return;
    this.sel.orient = next;
    this.#snapGhost();
    this.render();
    this.#emitTip();
  }

  /** 提交当前影子位置；非法时返回原因 */
  confirm() {
    if (!this.sel || !this.state) return { ok: false, reason: '还没有选棋子' };
    const { pieceId, orient } = this.sel;
    const { x, y } = this.#roundedGhost();
    if (!this.#isLegalOrigin(pieceId, orient, x, y)) {
      return { ok: false, reason: '这个位置放不下' };
    }
    this.opts.onConfirm?.({ pieceId, orient, x, y });
    return { ok: true };
  }

  resetView() {
    this.view.zoom = 1;
    this.view.tx = 0;
    this.view.ty = 0;
    this.#clampView();
    this.render();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const cssW = Math.max(80, Math.floor(rect.width));
    const cssH = Math.max(80, Math.floor(rect.height));
    const dpr = Math.min(DPR_MAX, window.devicePixelRatio || 1);

    const prevW = this.layout.cssW;
    const prevH = this.layout.cssH;
    const prev = { zoom: this.view.zoom, tx: this.view.tx, ty: this.view.ty };

    this.layout.cssW = cssW;
    this.layout.cssH = cssH;
    this.layout.dpr = dpr;
    this.layout.boardPx = Math.min(cssW, cssH);
    this.layout.baseCell = this.layout.boardPx / BOARD_SIZE;

    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);

    // 手机上滚动时地址栏收起会触发 resize。如果只是小幅变化就保留缩放/平移，
    // 否则玩家刚放大的棋盘会被莫名其妙重置。
    const minor =
      prevW > 0 && Math.abs(cssW - prevW) < 80 && Math.abs(cssH - prevH) < 160;
    if (minor) {
      this.view.zoom = prev.zoom;
      this.view.tx = prev.tx;
      this.view.ty = prev.ty;
    } else {
      this.view.zoom = 1;
      this.view.tx = 0;
      this.view.ty = 0;
    }
    this.#clampView();
    this.render();
  }

  /* ------------------------------ 坐标换算 ------------------------------ */

  get cell() {
    return this.layout.baseCell * this.view.zoom;
  }

  /** 棋盘格 (x,y) → canvas CSS 像素 */
  #toScreen(x, y) {
    const side = this.cell * BOARD_SIZE;
    const ox = (this.layout.cssW - side) / 2 + this.view.tx;
    const oy = (this.layout.cssH - side) / 2 + this.view.ty;
    return [ox + x * this.cell, oy + y * this.cell];
  }

  /** canvas CSS 像素 → 棋盘格（可以为小数、越界） */
  #toCell(px, py) {
    const side = this.cell * BOARD_SIZE;
    const ox = (this.layout.cssW - side) / 2 + this.view.tx;
    const oy = (this.layout.cssH - side) / 2 + this.view.ty;
    return [(px - ox) / this.cell, (py - oy) / this.cell];
  }

  #viewCenterCell() {
    const [cx, cy] = this.#toCell(this.layout.cssW / 2, this.layout.cssH / 2);
    return { x: cx, y: cy };
  }

  #clampView() {
    const side = this.cell * BOARD_SIZE;
    const maxX = Math.max(0, (side - this.layout.cssW) / 2 + this.cell * 2);
    const maxY = Math.max(0, (side - this.layout.cssH) / 2 + this.cell * 2);
    this.view.tx = Math.max(-maxX, Math.min(maxX, this.view.tx));
    this.view.ty = Math.max(-maxY, Math.min(maxY, this.view.ty));
  }

  /* ------------------------------ 合法着法 ------------------------------ */

  #recomputeLegal() {
    if (!this.state || this.mySeat === null || this.raw?.over) {
      this.legal = [];
      return;
    }
    if (this.raw.turn !== this.mySeat) {
      this.legal = [];
      return;
    }
    try {
      this.legal = legalMoves(this.state, this.mySeat);
    } catch {
      this.legal = [];
    }
  }

  /** 某个棋子某个朝向的全部合法左上角位置 */
  #originsFor(pieceId, orient) {
    const out = [];
    for (const m of this.legal) {
      if (m.pieceId === pieceId && m.orient === orient) out.push({ x: m.x, y: m.y });
    }
    return out;
  }

  #isLegalOrigin(pieceId, orient, x, y) {
    return this.legal.some(
      (m) => m.pieceId === pieceId && m.orient === orient && m.x === x && m.y === y,
    );
  }

  /** 我的「角接点」：与同色棋子角相邻、且不与同色棋子边相邻的空格 */
  #anchorCells() {
    const out = new Set();
    if (!this.state || this.mySeat === null) return out;
    const b = this.state.board;
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        if (b[y * BOARD_SIZE + x] !== this.mySeat) continue;
        for (const [dx, dy] of DIAG_OFFSETS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
          const j = ny * BOARD_SIZE + nx;
          if (b[j] !== -1) continue;
          let blocked = false;
          for (const [ex, ey] of EDGE_OFFSETS) {
            const kx = nx + ex;
            const ky = ny + ey;
            if (kx < 0 || ky < 0 || kx >= BOARD_SIZE || ky >= BOARD_SIZE) continue;
            if (b[ky * BOARD_SIZE + kx] === this.mySeat) {
              blocked = true;
              break;
            }
          }
          if (!blocked) out.add(j);
        }
      }
    }
    return out;
  }

  /* ------------------------------ 影子 ------------------------------ */

  #roundedGhost() {
    return { x: Math.round(this.sel.gx), y: Math.round(this.sel.gy) };
  }

  /** 把影子吸附到最近的合法位置 */
  #snapGhost() {
    if (!this.sel) return;
    const { pieceId, orient } = this.sel;
    const origins = this.#originsFor(pieceId, orient);
    if (origins.length === 0) {
      this.sel.gx = Math.round(this.sel.gx);
      this.sel.gy = Math.round(this.sel.gy);
      return;
    }
    let best = null;
    let bestD = Infinity;
    for (const o of origins) {
      const d = (o.x - this.sel.gx) ** 2 + (o.y - this.sel.gy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (this.snapEnabled && best && bestD <= SNAP_RADIUS ** 2) {
      this.sel.gx = best.x;
      this.sel.gy = best.y;
    } else {
      this.sel.gx = Math.round(this.sel.gx);
      this.sel.gy = Math.round(this.sel.gy);
    }
  }

  #clearSelection(silent = false) {
    if (!this.sel) return;
    this.sel = null;
    if (!silent) {
      this.opts.onSelectChange?.(null);
      this.render();
      this.#emitTip();
    }
  }

  #emitTip() {
    let text = '';
    if (!this.raw?.over && this.mySeat !== null && this.raw?.turn === this.mySeat) {
      if (this.legal.length === 0) {
        text = '你无处可下了，稍后会自动弃权';
      } else if (this.sel) {
        const g = this.#roundedGhost();
        const ok = this.#isLegalOrigin(this.sel.pieceId, this.sel.orient, g.x, g.y);
        text = ok ? '点「落子」确认' : '这个位置放不下，拖动或旋转试试';
      } else {
        text = '选一枚棋子，拖到棋盘上';
      }
    }
    this.opts.onTip?.(text);
  }

  /* ------------------------------ 渲染 ------------------------------ */

  render() {
    const ctx = this.ctx;
    const { cssW, cssH, dpr } = this.layout;
    if (!cssW) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // 棋盘底
    const [bx, by] = this.#toScreen(0, 0);
    const side = this.cell * BOARD_SIZE;
    ctx.fillStyle = '#0d1526';
    roundRect(ctx, bx, by, side, side, Math.max(4, this.cell * 0.5));
    ctx.fill();

    this.#drawGrid();
    this.#drawAnchors();
    this.#drawPlaced();
    this.#drawCorners();
    this.#drawLegalHints();
    this.#drawGhost();
    this.#drawLastMove();
  }

  #drawGrid() {
    const ctx = this.ctx;
    const c = this.cell;
    const [bx, by] = this.#toScreen(0, 0);
    ctx.strokeStyle = '#1b2a45';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= BOARD_SIZE; i++) {
      const p = Math.round(bx + i * c) + 0.5;
      ctx.moveTo(p, by);
      ctx.lineTo(p, by + BOARD_SIZE * c);
      const q = Math.round(by + i * c) + 0.5;
      ctx.moveTo(bx, q);
      ctx.lineTo(bx + BOARD_SIZE * c, q);
    }
    ctx.stroke();

    // 每 5 格加粗，便于数格子
    ctx.strokeStyle = '#2b4066';
    ctx.beginPath();
    for (let i = 0; i <= BOARD_SIZE; i += 5) {
      const p = Math.round(bx + i * c) + 0.5;
      ctx.moveTo(p, by);
      ctx.lineTo(p, by + BOARD_SIZE * c);
      const q = Math.round(by + i * c) + 0.5;
      ctx.moveTo(bx, q);
      ctx.lineTo(bx + BOARD_SIZE * c, q);
    }
    ctx.stroke();
  }

  #drawPlaced() {
    if (!this.state) return;
    const ctx = this.ctx;
    const c = this.cell;
    const b = this.state.board;
    const inset = Math.max(0.5, c * 0.06);
    const r = Math.max(1, c * 0.22);

    for (let i = 0; i < b.length; i++) {
      const seat = b[i];
      if (seat < 0) continue;
      const x = i % BOARD_SIZE;
      const y = (i - x) / BOARD_SIZE;
      const [px, py] = this.#toScreen(x, y);
      roundRect(ctx, px + inset, py + inset, c - inset * 2, c - inset * 2, r);
      ctx.fillStyle = SEAT_HEX[seat];
      ctx.fill();
      if (c > 9) {
        ctx.strokeStyle = hexToRgba(SEAT_HEX_DARK[seat], 0.85);
        ctx.lineWidth = Math.max(0.6, c * 0.06);
        ctx.stroke();
      }
    }
  }

  #drawCorners() {
    const ctx = this.ctx;
    const c = this.cell;
    for (let seat = 0; seat < 4; seat++) {
      const [cx, cy] = SEAT_CORNERS[seat];
      const [px, py] = this.#toScreen(cx, cy);
      const used = this.raw?.placed?.[seat]?.some((p) => {
        const piece = PIECE_BY_ID.get(p.pieceId);
        return piece.orientations[p.orient].some(([dx, dy]) => p.x + dx === cx && p.y + dy === cy);
      });
      ctx.beginPath();
      ctx.arc(px + c / 2, py + c / 2, Math.max(2, c * 0.3), 0, Math.PI * 2);
      ctx.strokeStyle = SEAT_HEX[seat];
      ctx.lineWidth = Math.max(1.2, c * 0.12);
      if (used) {
        ctx.globalAlpha = 0.25;
        ctx.stroke();
      } else {
        ctx.globalAlpha = 0.95;
        ctx.stroke();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = SEAT_HEX[seat];
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  #drawAnchors() {
    if (!this.state || this.mySeat === null) return;
    if (this.raw?.turn !== this.mySeat || this.raw?.over) return;
    const ctx = this.ctx;
    const c = this.cell;
    if (c < 7) return;
    const anchors = this.#anchorCells();
    ctx.fillStyle = hexToRgba(SEAT_HEX[this.mySeat], 0.5);
    for (const i of anchors) {
      const x = i % BOARD_SIZE;
      const y = (i - x) / BOARD_SIZE;
      const [px, py] = this.#toScreen(x, y);
      ctx.beginPath();
      ctx.arc(px + c / 2, py + c / 2, Math.max(1.2, c * 0.11), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  #drawLegalHints() {
    if (!this.sel || this.legal.length === 0) return;
    const ctx = this.ctx;
    const c = this.cell;
    const { pieceId, orient } = this.sel;
    ctx.fillStyle = hexToRgba(SEAT_HEX[this.mySeat] ?? '#ffffff', 0.16);
    const seen = new Set();
    for (const m of this.legal) {
      if (m.pieceId !== pieceId || m.orient !== orient) continue;
      const key = `${m.x},${m.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [px, py] = this.#toScreen(m.x, m.y);
      ctx.fillRect(px, py, c, c);
    }
  }

  #drawGhost() {
    if (!this.sel || !this.state) return;
    const ctx = this.ctx;
    const c = this.cell;
    const piece = PIECE_BY_ID.get(this.sel.pieceId);
    const { x, y } = this.#roundedGhost();
    const ok = this.#isLegalOrigin(this.sel.pieceId, this.sel.orient, x, y);
    const color = ok ? SEAT_HEX[this.mySeat] ?? '#4f8cff' : '#f0554f';
    const inset = Math.max(0.5, c * 0.06);
    const r = Math.max(1, c * 0.22);

    for (const [dx, dy] of piece.orientations[this.sel.orient]) {
      const gx = x + dx;
      const gy = y + dy;
      if (gx < 0 || gy < 0 || gx >= BOARD_SIZE || gy >= BOARD_SIZE) continue;
      const [px, py] = this.#toScreen(gx, gy);
      roundRect(ctx, px + inset, py + inset, c - inset * 2, c - inset * 2, r);
      ctx.fillStyle = hexToRgba(color, ok ? 0.62 : 0.42);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(color, 0.95);
      ctx.lineWidth = Math.max(1, c * 0.09);
      ctx.stroke();
    }
  }

  #drawLastMove() {
    const lm = this.raw?.lastMove;
    if (!lm || !this.state) return;
    const age = performance.now() - this.lastMovePulse;
    if (age > 1400) return;
    const ctx = this.ctx;
    const c = this.cell;
    const piece = PIECE_BY_ID.get(lm.pieceId);
    ctx.strokeStyle = hexToRgba('#ffffff', 0.85 * (1 - age / 1400));
    ctx.lineWidth = Math.max(1.2, c * 0.13);
    for (const [dx, dy] of piece.orientations[lm.orient]) {
      const [px, py] = this.#toScreen(lm.x + dx, lm.y + dy);
      ctx.strokeRect(px + 1, py + 1, c - 2, c - 2);
    }
  }

  /* ------------------------------ 事件 ------------------------------ */

  #bindEvents() {
    const canvas = this.canvas;

    this.onPointerDown = (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this.pointers.set(e.pointerId, p);

      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.gesture = {
          mode: 'pinch',
          startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          startZoom: this.view.zoom,
          startTx: this.view.tx,
          startTy: this.view.ty,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
        return;
      }
      if (this.pointers.size > 2) return;

      this.gesture = {
        mode: this.sel ? 'ghost' : 'pan',
        startX: p.x,
        startY: p.y,
        startTx: this.view.tx,
        startTy: this.view.ty,
        startGx: this.sel?.gx ?? 0,
        startGy: this.sel?.gy ?? 0,
        moved: 0,
        at: performance.now(),
      };
    };

    this.onPointerMove = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const rect = canvas.getBoundingClientRect();
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this.pointers.set(e.pointerId, p);
      const g = this.gesture;
      if (!g) return;

      if (g.mode === 'pinch') {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const scale = dist / g.startDist;
        const newZoom = Math.max(1, Math.min(4, g.startZoom * scale));
        // 以双指中点为锚点缩放
        const [cx, cy] = this.#toCell(g.mid.x, g.mid.y);
        this.view.zoom = newZoom;
        const side = this.cell * BOARD_SIZE;
        const ox = (this.layout.cssW - side) / 2 + this.view.tx;
        const oy = (this.layout.cssH - side) / 2 + this.view.ty;
        this.view.tx += g.mid.x - (ox + cx * this.cell);
        this.view.ty += g.mid.y - (oy + cy * this.cell);
        this.#clampView();
        this.render();
        return;
      }

      const dx = p.x - g.startX;
      const dy = p.y - g.startY;
      g.moved = Math.max(g.moved, Math.hypot(dx, dy));

      if (g.mode === 'pan') {
        this.view.tx = g.startTx + dx;
        this.view.ty = g.startTy + dy;
        this.#clampView();
        this.render();
        return;
      }

      // ghost：拖动影子棋子（手指上方偏移一点，免得被手指挡住）
      const lift = this.cell * 0.9;
      this.sel.gx = g.startGx + dx / this.cell;
      this.sel.gy = g.startGy + (dy - lift) / this.cell;
      this.render();
    };

    this.onPointerUp = (e) => {
      const had = this.pointers.delete(e.pointerId);
      const g = this.gesture;
      canvas.releasePointerCapture?.(e.pointerId);

      if (this.pointers.size === 0) this.gesture = null;
      if (!had || !g) return;
      if (g.mode === 'pinch') return;

      const rect = canvas.getBoundingClientRect();
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const isTap = g.moved < TAP_MOVE_PX && performance.now() - g.at < 500;

      if (g.mode === 'ghost' && this.sel) {
        if (isTap) {
          // 轻点：影子直接跳到点中的那一格（以棋子左上角对齐手指附近）
          const [cx, cy] = this.#toCell(p.x, p.y);
          const piece = PIECE_BY_ID.get(this.sel.pieceId);
          const w = piece.widths[this.sel.orient];
          const h = piece.heights[this.sel.orient];
          this.sel.gx = Math.floor(cx - (w - 1) / 2);
          this.sel.gy = Math.floor(cy - (h - 1) / 2);
        }
        this.#snapGhost();
        this.render();
        this.#emitTip();
      }
    };

    this.onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const [cx, cy] = this.#toCell(mx, my);
      const newZoom = Math.max(1, Math.min(4, this.view.zoom * (e.deltaY < 0 ? 1.12 : 0.89)));
      this.view.zoom = newZoom;
      const side = this.cell * BOARD_SIZE;
      const ox = (this.layout.cssW - side) / 2 + this.view.tx;
      const oy = (this.layout.cssH - side) / 2 + this.view.ty;
      this.view.tx += mx - (ox + cx * this.cell);
      this.view.ty += my - (oy + cy * this.cell);
      this.#clampView();
      this.render();
    };

    this.onContextMenu = (e) => e.preventDefault();

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  destroy() {
    const canvas = this.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
  }
}
