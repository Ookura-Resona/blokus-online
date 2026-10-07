/**
 * 零依赖 Canvas 2D 指令光栅化器（纯 Node，只用内置模块）。
 *
 * 输入：test/domstub.js 的录制型 2D context 录下来的结构化指令
 *   [{ op, args, transform, fillStyle, strokeStyle, lineWidth, globalAlpha }]
 * 输出：RGBA8 像素缓冲（交给 tools/png.js 编码成 PNG）。
 *
 * ── 坐标链路（唯一权威约定，改这里之前先把 tools/_debug-matrix.js 跑一遍）──
 *   前端在 CSS 像素里写坐标，再调 setTransform(dpr,0,0,dpr,0,0) 映射到设备像素。
 *   于是录制下来的每条指令：
 *     op.transform      「指令本地坐标 → 设备像素」= 当前 CTM，含 dpr
 *     canvas.width/height  设备像素尺寸（dpr = width / cssWidth）
 *   本光栅化器内部：
 *     state.local        录制到的 CTM 参数
 *     this.frame         设备像素 → CSS 逻辑像素，默认 [1/dpr,0,0,1/dpr,0,0]
 *                        （帧切片里的第一条 setTransform 会把它再摆正一次）
 *     buffer 尺寸         固定为「设备像素 × supersample」，与输出缩放解耦
 *   三处各乘一次、绝不重复：local × frame = 本地→CSS，再 ×(bufW/cssW) = 本地→buffer。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 不支持的方法不会静默忽略：记进 stats.unsupported，调用方负责打印出来。
 */

/** 单位矩阵 [a, b, c, d, e, f]，含义同 Canvas 的 setTransform */
export const IDENTITY = [1, 0, 0, 1, 0, 0];

/** 本光栅化器能重放的指令（'SET' 是录制器补的初始状态） */
export const SUPPORTED_OPS = new Set([
  'SET', 'setTransform', 'resetTransform', 'save', 'restore', 'clearRect',
  'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'arc', 'arcTo', 'rect', 'fill', 'stroke',
]);

/* ------------------------------ 矩阵 ------------------------------ */

/** 矩阵相乘：返回 m2 × m1，语义是「先用 m1 变换、再用 m2 变换」 */
export function multiply(m2, m1) {
  return [
    m2[0] * m1[0] + m2[2] * m1[1],
    m2[1] * m1[0] + m2[3] * m1[1],
    m2[0] * m1[2] + m2[2] * m1[3],
    m2[1] * m1[2] + m2[3] * m1[3],
    m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
    m2[1] * m1[4] + m2[3] * m1[5] + m2[5],
  ];
}

export function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 2x3 仿射矩阵求逆；不可逆时返回 null */
export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/* ------------------------------ 颜色 ------------------------------ */

const NAMED = {
  transparent: [0, 0, 0, 0],
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
  red: [255, 0, 0, 1],
  green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1],
  gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1],
};

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 解析 CSS 颜色：#rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba() / hsl() / 关键字。
 * @returns {[number,number,number,number]|null} r,g,b 为 0-255，a 为 0-1
 */
export function parseColor(input) {
  if (input === null || input === undefined) return null;
  if (Array.isArray(input)) return [input[0], input[1], input[2], input[3] ?? 1];
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (Object.hasOwn(NAMED, s)) return NAMED[s].slice();

  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    const dup = (i) => parseInt(h[i] + h[i], 16);
    if (h.length === 3 || h.length === 4) {
      return [dup(0), dup(1), dup(2), h.length === 4 ? dup(3) / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      const pair = (i) => parseInt(h.slice(i, i + 2), 16);
      return [pair(0), pair(2), pair(4), h.length === 8 ? pair(6) / 255 : 1];
    }
    return null;
  }

  const fn = /^([a-z]+)\((.*)\)$/.exec(s);
  if (!fn) return null;
  const parts = fn[2]
    .split(/[\s,/]+/)
    .filter((p) => p.length > 0)
    .map((p) => (p.endsWith('%') ? Number(p.slice(0, -1)) / 100 : Number(p)));
  if (parts.some((n) => Number.isNaN(n))) return null;

  if (fn[1] === 'rgb' || fn[1] === 'rgba') {
    if (parts.length < 3) return null;
    return [parts[0], parts[1], parts[2], parts.length > 3 ? clamp01(parts[3]) : 1];
  }
  if (fn[1] === 'hsl' || fn[1] === 'hsla') {
    if (parts.length < 3) return null;
    const [h, sPct, lPct] = parts;
    const a = parts.length > 3 ? clamp01(parts[3]) : 1;
    const c = (1 - Math.abs(2 * lPct - 1)) * sPct;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = lPct - c / 2;
    const rgb =
      hp < 1 ? [c, x, 0]
      : hp < 2 ? [x, c, 0]
      : hp < 3 ? [0, c, x]
      : hp < 4 ? [0, x, c]
      : hp < 5 ? [x, 0, c]
      : [c, 0, x];
    return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255, a];
  }
  return null;
}

/* ------------------------------ 画布 ------------------------------ */

/** 一块可叠加绘制的 RGBA 画布 */
export class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  /** src-over 混合一个像素；rgb 为 0-255，a 为 0-1 */
  blendPixel(x, y, r, g, b, a) {
    if (a <= 0) return;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    if (a > 1) a = 1;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    const da = d[i + 3] / 255;
    const outA = a + da * (1 - a);
    if (outA <= 0) {
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
      d[i + 3] = 0;
      return;
    }
    d[i] = (r * a + d[i] * da * (1 - a)) / outA;
    d[i + 1] = (g * a + d[i + 1] * da * (1 - a)) / outA;
    d[i + 2] = (b * a + d[i + 2] * da * (1 - a)) / outA;
    d[i + 3] = outA * 255;
  }

  /** 把另一块画布按 1:1 混合贴上来（用于拼接棋子预览） */
  blit(src, dx, dy) {
    for (let y = 0; y < src.height; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.height) continue;
      for (let x = 0; x < src.width; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= this.width) continue;
        const si = (y * src.width + x) * 4;
        const a = src.data[si + 3] / 255;
        if (a <= 0) continue;
        this.blendPixel(tx, ty, src.data[si], src.data[si + 1], src.data[si + 2], a);
      }
    }
  }
}

/* ------------------------------ 路径 ------------------------------ */

/**
 * 把 Canvas 的路径指令累积成折线子路径。
 * 圆弧与 arcTo 都按固定密度采样成线段，够用且实现简单。
 */
class PathBuilder {
  constructor() {
    this.subpaths = [];
    this.cur = null;
  }

  begin() {
    this.subpaths = [];
    this.cur = null;
  }

  moveTo(x, y) {
    this.cur = { points: [[x, y]], closed: false };
    this.subpaths.push(this.cur);
  }

  lineTo(x, y) {
    if (!this.cur) this.moveTo(x, y);
    else this.cur.points.push([x, y]);
  }

  close() {
    if (!this.cur || this.cur.points.length === 0) return;
    this.cur.points.push([...this.cur.points[0]]);
    this.cur.closed = true;
  }

  rect(x, y, w, h) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.close();
  }

  arc(cx, cy, r, a0, a1, ccw) {
    if (!(r > 0)) return;
    let d = a1 - a0;
    if (ccw) {
      while (d > 1e-9) d -= Math.PI * 2;
      while (d < -Math.PI * 2) d += Math.PI * 2;
    } else {
      while (d < -1e-9) d += Math.PI * 2;
      while (d > Math.PI * 2) d -= Math.PI * 2;
    }
    const n = Math.min(512, Math.max(6, Math.ceil(Math.abs(d) * 12)));
    const startsNew = this.cur === null;
    for (let i = 0; i <= n; i++) {
      const t = a0 + (d * i) / n;
      const px = cx + r * Math.cos(t);
      const py = cy + r * Math.sin(t);
      if (i === 0 && startsNew) this.moveTo(px, py);
      else this.lineTo(px, py);
    }
  }

  /**
   * 圆角矩形的 arcTo：起点 P0 = 当前点，控制点 P1，接下来朝 P2 方向走，
   * 画与两边相切、半径 r 的圆弧。半径过大时按 tan(θ/2) 的约束自动缩小。
   */
  arcTo(x1, y1, x2, y2, r) {
    if (!this.cur || this.cur.points.length === 0) {
      this.moveTo(x1, y1);
      return;
    }
    const [x0, y0] = this.cur.points.at(-1);
    if (!(r > 0)) {
      this.lineTo(x1, y1);
      return;
    }
    const d1 = Math.hypot(x0 - x1, y0 - y1);
    const d2 = Math.hypot(x2 - x1, y2 - y1);
    if (d1 < 1e-9 || d2 < 1e-9) {
      this.lineTo(x1, y1);
      return;
    }
    const u1 = [(x0 - x1) / d1, (y0 - y1) / d1];
    const u2 = [(x2 - x1) / d2, (y2 - y1) / d2];
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const dot = u1[0] * u2[0] + u1[1] * u2[1];
    if (Math.abs(cross) < 1e-12) {
      this.lineTo(x1, y1); // 三点共线，退化成直线
      return;
    }
    const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
    const tanHalf = Math.tan(theta / 2) || 1e-9;
    const rr = Math.min(r, d1 * tanHalf, d2 * tanHalf);
    const tanLen = rr / tanHalf; // 切点到 P1 的距离
    const t1 = [x1 + u1[0] * tanLen, y1 + u1[1] * tanLen];
    const t2 = [x1 + u2[0] * tanLen, y1 + u2[1] * tanLen];
    const ccx = t2[0] + u2[0] * rr; // 圆心
    const ccy = t2[1] + u2[1] * rr;

    this.lineTo(t1[0], t1[1]);
    const a0 = Math.atan2(t1[1] - ccy, t1[0] - ccx);
    const a1 = Math.atan2(t2[1] - ccy, t2[0] - ccx);
    // 屏幕坐标（y 向下）里 cross > 0 表示弧逆时针扫过
    const ccw = cross > 0;
    let d = a1 - a0;
    if (ccw) while (d > 0) d -= Math.PI * 2;
    else while (d < 0) d += Math.PI * 2;
    const n = Math.min(256, Math.max(3, Math.ceil(Math.abs(d) * 12)));
    for (let i = 1; i <= n; i++) {
      const t = a0 + (d * i) / n;
      this.lineTo(ccx + rr * Math.cos(t), ccy + rr * Math.sin(t));
    }
  }
}

/* ------------------------------ 光栅化器 ------------------------------ */

export class Rasterizer {
  /**
   * @param {Array} ops 录制指令
   * @param {{
   *   width:number, height:number, dpr?:number, scale?:number,
   *   supersample?:number, frameTransform?:number[],
   * }} opts
   *   width/height —— 设备像素尺寸（录制时 canvas.width / canvas.height）
   *   dpr —— 设备像素比（canvas.width ÷ CSS 宽度），默认 1
   *   scale —— 输出缩放：1 = 设备像素（默认），0.5 = CSS 逻辑像素
   *   supersample —— 抗锯齿超采样倍率，默认 2
   *   frameTransform —— 帧起始 CTM（设备像素 → 本帧局部坐标），默认 [1/dpr,…]
   */
  constructor(ops, opts) {
    const {
      width,
      height,
      dpr = 1,
      scale = 1,
      supersample = 2,
      frameTransform = [1 / dpr, 0, 0, 1 / dpr, 0, 0],
    } = opts;
    this.ops = ops;
    this.devW = width;
    this.devH = height;
    this.dpr = dpr;
    this.scale = scale;
    this.ss = supersample;
    this.frame = frameTransform.slice();
    // buffer 固定按「设备像素 × 超采样」渲染，与输出缩放解耦，
    // 这样 scale 只影响最后一步降采样倍率，不会和画布几何互相干扰。
    this.bufW = Math.max(1, Math.round(width * supersample));
    this.bufH = Math.max(1, Math.round(height * supersample));
    this.outW = Math.max(1, Math.round(width * scale));
    this.outH = Math.max(1, Math.round(height * scale));
    this.dst = new Canvas(this.outW, this.outH);
    this.stats = { unsupported: new Map(), drawn: 0, ops: ops.length, badColors: 0 };
    this.state = null;
    this.stack = [];
    this.buf = null;
    this.bufDirty = true;
  }

  run() {
    // 帧切片可能不带录制器补的那条 'SET'（比如从 setTransform 开始切），
    // 所以先垫一个默认上下文状态，保证重放不会因为 state 为空而中断。
    if (!this.state) {
      this.state = this.#newState({ transform: IDENTITY });
      this.bufDirty = true;
    }
    for (const op of this.ops) {
      try {
        this.#step(op);
      } catch (err) {
        this.#note(op.op, `重放异常：${err.message}`);
      }
    }
    return this;
  }

  #note(opName, reason = '') {
    const prev = this.stats.unsupported.get(opName) ?? { count: 0, reason };
    prev.count += 1;
    if (reason) prev.reason = reason;
    this.stats.unsupported.set(opName, prev);
  }

  #newState(op) {
    return {
      local: (op.transform ?? IDENTITY).slice(),
      fillStyle: op.fillStyle ?? '#000000',
      strokeStyle: op.strokeStyle ?? '#000000',
      lineWidth: op.lineWidth ?? 1,
      globalAlpha: op.globalAlpha ?? 1,
      lineJoin: op.lineJoin ?? 'miter',
      lineCap: op.lineCap ?? 'butt',
      path: new PathBuilder(),
      inv: null,
    };
  }

  /** 取得（或新建）超采样 buffer，并维护「本地坐标 → buffer 像素」的逆矩阵 */
  #resolveBuffer() {
    if (!this.buf) {
      this.buf = new Canvas(this.bufW, this.bufH);
      this.bufDirty = true;
    }
    if (this.bufDirty) {
      // 本地坐标 → CSS 逻辑像素（frame 抵消 dpr）
      const toCss = multiply(this.state.local, this.frame);
      const cssInv = invert(toCss);
      if (!cssInv) throw new Error('变换矩阵不可逆，无法光栅化');
      // CSS 逻辑像素 → buffer 像素
      const sx = this.bufW / (this.devW / this.dpr);
      const sy = this.bufH / (this.devH / this.dpr);
      this.state.inv = multiply([sx, 0, 0, sy, 0, 0], cssInv);
      this.bufDirty = false;
    }
    return this.buf;
  }

  /** 指令本地坐标 → buffer 像素坐标 */
  #toBuf(x, y) {
    return applyMatrix(this.state.inv, x, y);
  }

  #step(op) {
    const { op: name, args } = op;

    if (name === 'SET') {
      this.state = this.#newState(op);
      this.bufDirty = true;
      return;
    }
    if (name === 'save') {
      this.stack.push({ ...this.state });
      return;
    }
    if (name === 'restore') {
      const prev = this.stack.pop();
      if (prev) {
        this.state = prev;
        this.bufDirty = true;
      }
      return;
    }
    if (name === 'setTransform') {
      this.state.local = [args[0], args[1], args[2], args[3], args[4], args[5]];
      this.bufDirty = true;
      return;
    }
    if (name === 'resetTransform') {
      this.state.local = IDENTITY.slice();
      this.bufDirty = true;
      return;
    }
    if (name === 'clearRect') {
      this.#clearRect(op);
      this.stats.drawn += 1;
      return;
    }
    if (!SUPPORTED_OPS.has(name)) {
      this.#note(name, '本光栅化器未实现，已跳过');
      return;
    }

    switch (name) {
      case 'beginPath':
        this.state.path.begin();
        break;
      case 'closePath':
        this.state.path.close();
        break;
      case 'moveTo':
        this.state.path.moveTo(args[0], args[1]);
        break;
      case 'lineTo':
        this.state.path.lineTo(args[0], args[1]);
        break;
      case 'arc':
        this.state.path.arc(args[0], args[1], args[2], args[3], args[4], !!args[5]);
        break;
      case 'arcTo':
        this.state.path.arcTo(args[0], args[1], args[2], args[3], args[4]);
        break;
      case 'rect':
        this.state.path.rect(args[0], args[1], args[2], args[3]);
        break;
      case 'fillRect':
        this.state.path.rect(args[0], args[1], args[2], args[3]);
        this.#fill(op);
        this.state.path.begin();
        break;
      case 'strokeRect':
        this.state.path.rect(args[0], args[1], args[2], args[3]);
        this.#stroke(op);
        this.state.path.begin();
        break;
      case 'fill':
        this.#fill(op);
        break;
      case 'stroke':
        this.#stroke(op);
        break;
      default:
        this.#note(name, '本光栅化器未实现，已跳过');
        return;
    }
    this.stats.drawn += 1;
  }

  #color(op, which) {
    const raw = op[which];
    const c = parseColor(raw);
    if (c) return c;
    this.stats.badColors += 1;
    if (raw) this.#note(`color:${raw}`, '颜色解析失败，已按黑色处理');
    return [0, 0, 0, 1];
  }

  #clearRect(op) {
    const buf = this.#resolveBuffer();
    const c0 = this.#toBuf(0, 0);
    const c1 = this.#toBuf(op.args[2], op.args[3]);
    const inv = this.state.inv;
    const axisAligned = Math.abs(inv[1]) < 1e-9 && Math.abs(inv[2]) < 1e-9;
    if (!axisAligned) {
      buf.data.fill(0); // 带旋转的 clearRect 直接整块清掉
      return;
    }
    const x0 = Math.max(0, Math.floor(Math.min(c0[0], c1[0])));
    const y0 = Math.max(0, Math.floor(Math.min(c0[1], c1[1])));
    const x1 = Math.min(buf.width, Math.ceil(Math.max(c0[0], c1[0])));
    const y1 = Math.min(buf.height, Math.ceil(Math.max(c0[1], c1[1])));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * buf.width + x) * 4;
        buf.data[i] = 0;
        buf.data[i + 1] = 0;
        buf.data[i + 2] = 0;
        buf.data[i + 3] = 0;
      }
    }
  }

  /**
   * 逐扫描线求覆盖并混合（奇偶规则，多子路径自然形成镂空）。
   * @param {Array<Array<[number,number]>>} polys 已换算到 buffer 坐标的多边形
   */
  #fillPolys(polys, r, g, b, alpha, buf) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pts of polys) {
      for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (!Number.isFinite(minY)) return;
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(buf.height - 1, Math.ceil(maxY));
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(buf.width - 1, Math.ceil(maxX));
    if (y0 > y1 || x0 > x1) return;

    const SUB = 4; // 每条扫描线 4 条子采样线
    const band = 1 / SUB;
    for (let y = y0; y <= y1; y++) {
      const cover = new Map();
      for (let s = 0; s < SUB; s++) {
        const sy = y + (s + 0.5) * band;
        const xs = [];
        for (const pts of polys) {
          for (let i = 0; i < pts.length; i++) {
            const [ax, ay] = pts[i];
            const [bx, by] = pts[(i + 1) % pts.length];
            if (ay === by) continue;
            if (sy >= Math.min(ay, by) && sy < Math.max(ay, by)) {
              xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
            }
          }
        }
        if (xs.length < 2) continue;
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const xa = xs[i];
          const xb = xs[i + 1];
          if (xb <= x0 || xa > x1) continue;
          const from = Math.max(x0, Math.floor(xa));
          const to = Math.min(x1, Math.ceil(xb));
          for (let x = from; x <= to; x++) {
            const ov = Math.min(x + 1, xb) - Math.max(x, xa);
            if (ov <= 0) continue;
            cover.set(x, (cover.get(x) ?? 0) + ov / SUB);
          }
        }
      }
      for (const [x, cov] of cover) {
        if (cov <= 0) continue;
        buf.blendPixel(x, y, r, g, b, Math.min(1, cov) * alpha);
      }
    }
  }

  #fill(op) {
    const alpha = op.globalAlpha ?? 1;
    if (alpha <= 0) return;
    const [r, g, b, ca] = this.#color(op, 'fillStyle');
    const a = ca * alpha;
    if (a <= 0) return;
    const buf = this.#resolveBuffer();
    const polys = [];
    for (const sp of this.state.path.subpaths) {
      if (sp.points.length < 3) continue;
      polys.push(sp.points.map(([x, y]) => this.#toBuf(x, y)));
    }
    if (polys.length === 0) return;
    this.#fillPolys(polys, r, g, b, a, buf);
  }

  /** 用正多边形近似填充圆 */
  #fillCircle(cx, cy, r, color, alpha, buf, segments = 32) {
    if (!(r > 0)) return;
    const pts = [];
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
    }
    this.#fillPolys([pts], color[0], color[1], color[2], alpha, buf);
  }

  /** 一条线段 → 线宽对应的矩形（+ 圆端帽） */
  #strokeSegment(p0, p1, color, alpha, buf, lineWidth, cap) {
    const p0m = this.#toBuf(p0[0], p0[1]);
    const p1m = this.#toBuf(p1[0], p1[1]);
    const dx = p1m[0] - p0m[0];
    const dy = p1m[1] - p0m[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return;
    const hw = lineWidth / 2;
    const nx = (-dy / len) * hw;
    const ny = (dx / len) * hw;
    this.#fillPolys(
      [
        [
          [p0m[0] + nx, p0m[1] + ny],
          [p1m[0] + nx, p1m[1] + ny],
          [p1m[0] - nx, p1m[1] - ny],
          [p0m[0] - nx, p0m[1] - ny],
        ],
      ],
      color[0],
      color[1],
      color[2],
      alpha,
      buf,
    );
    if (cap === 'round') {
      for (const [px, py] of [p0m, p1m]) this.#fillCircle(px, py, hw, color, alpha, buf);
    }
  }

  #stroke(op) {
    const alpha = op.globalAlpha ?? 1;
    if (alpha <= 0) return;
    const [r, g, b, ca] = this.#color(op, 'strokeStyle');
    const a = ca * alpha;
    if (a <= 0) return;
    const lw = op.lineWidth ?? 1;
    if (!(lw > 0)) return;
    const buf = this.#resolveBuffer();
    const color = [r, g, b];
    // 1px 的网格线用平端帽；粗线用圆角接头把转折处补齐
    const cap = lw <= 1.2 ? 'butt' : (op.lineCap ?? 'butt');
    for (const sp of this.state.path.subpaths) {
      const pts = sp.points;
      if (pts.length < 2) continue;
      for (let i = 0; i + 1 < pts.length; i++) {
        this.#strokeSegment(pts[i], pts[i + 1], color, a, buf, lw, cap);
      }
      if ((op.lineJoin ?? 'miter') === 'round') {
        for (let i = 1; i + 1 < pts.length; i++) {
          const p = this.#toBuf(pts[i][0], pts[i][1]);
          this.#fillCircle(p[0], p[1], lw / 2, color, a, buf);
        }
      }
    }
  }

  /** 把超采样 buffer 降采样到输出画布（box filter，按面积平均） */
  #flush() {
    if (!this.buf) return;
    const buf = this.buf;
    const fx = buf.width / this.outW;
    const fy = buf.height / this.outH;
    for (let y = 0; y < this.outH; y++) {
      const sy0 = Math.floor(y * fy);
      const sy1 = Math.max(sy0 + 1, Math.min(buf.height, Math.ceil((y + 1) * fy)));
      for (let x = 0; x < this.outW; x++) {
        const sx0 = Math.floor(x * fx);
        const sx1 = Math.max(sx0 + 1, Math.min(buf.width, Math.ceil((x + 1) * fx)));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let py = sy0; py < sy1; py++) {
          for (let px = sx0; px < sx1; px++) {
            const i = (py * buf.width + px) * 4;
            const pa = buf.data[i + 3] / 255;
            // 先按 alpha 加权再平均，避免透明像素把颜色拉黑
            r += buf.data[i] * pa;
            g += buf.data[i + 1] * pa;
            b += buf.data[i + 2] * pa;
            a += pa;
            n += 1;
          }
        }
        if (a <= 0 || n === 0) continue;
        const i = (y * this.outW + x) * 4;
        this.dst.data[i] = r / a;
        this.dst.data[i + 1] = g / a;
        this.dst.data[i + 2] = b / a;
        this.dst.data[i + 3] = (a / n) * 255;
      }
    }
    this.buf = null;
    this.bufDirty = true;
  }

  finish() {
    this.#flush();
    return this.dst;
  }
}

/**
 * 便利函数：重放指令并返回像素结果。
 * @returns {{width:number,height:number,data:Uint8ClampedArray,stats:object,canvas:Canvas}}
 */
export function rasterize(ops, opts) {
  const raster = new Rasterizer(ops, opts);
  raster.run();
  const canvas = raster.finish();
  return { width: canvas.width, height: canvas.height, data: canvas.data, stats: raster.stats, canvas };
}

/**
 * 统计非背景像素占比（用于自动验证「图不是全黑/全空」）。
 * @param {{data:Uint8ClampedArray|Uint8Array, width:number, height:number}} img
 * @param {[number,number,number,number]} bg
 */
export function backgroundRatio(img, bg) {
  const { data, width, height } = img;
  let bgCount = 0;
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) opaque += 1;
    if (
      Math.abs(data[i] - bg[0]) <= 2 &&
      Math.abs(data[i + 1] - bg[1]) <= 2 &&
      Math.abs(data[i + 2] - bg[2]) <= 2 &&
      Math.abs(data[i + 3] - bg[3]) <= 2
    ) {
      bgCount += 1;
    }
  }
  const total = width * height;
  return {
    total,
    background: bgCount,
    nonBackground: total - bgCount,
    opaque,
    ratio: (total - bgCount) / total,
  };
}
