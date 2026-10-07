/**
 * 真实前端渲染快照工具。
 *
 *   node tools/render-preview.js [选项]
 *
 * 做的事：
 *   1. 起一个真实的 createApp() 服务器（监听 0 端口）；
 *   2. 装 DOM 桩（带录制型 2D context），加载真正的 public/app.js + board.js；
 *   3. 建房 → 补 3 个 AI → 开局；
 *   4. 用真实 AI（shared/ai.js，经前端的 board.confirm() 提交）走若干手，
 *      直到棋盘上有 target 格（默认 45 格，落在题目要求的 30~60 区间）；
 *   5. 调 board.render() 把最后一帧画出来，把录制的绘制指令 dump 成 JSON，
 *      并用纯 Node 光栅化器重放成 art/board.png；
 *   6. 把棋子栏里 21 个 drawPiecePreview() 的画布拼成 art/tray.png；
 *   7. 附带把棋盘那一帧导出成 art/svg/board.svg。
 *
 * 输出目录：art/（图片）、art/json/（录制指令）、art/svg/（矢量图）
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server/app.js';
import { installDom, create2DRecorder } from '../test/domstub.js';
import { C2S } from '../shared/protocol.js';
import { PIECE_BY_ID } from '../shared/pieces.js';
import { legalMoves, deserializeState } from '../shared/rules.js';
import { BOARD_SIZE } from '../shared/constants.js';
import { rasterize, Canvas, backgroundRatio, parseColor } from './raster.js';
import { encodePNG } from './png.js';

register('../test/web-loader.js', import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ART = path.join(ROOT, 'art');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/* ------------------------------ CLI ------------------------------ */

function parseArgs(argv) {
  const out = {
    target: 45,
    difficulty: 'normal',
    cols: 7,
    boardScale: 1,
    maxMoves: 600,
    seed: 20240607,
    quiet: false,
  };
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = m[2] ?? 'true';
    out[key] = /^\d+$/.test(value) ? Number(value) : value === 'true' ? true : value;
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const log = (...a) => {
  if (!ARGS.quiet) console.log(...a);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs = 15000, label = '条件') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await sleep(10);
  }
}

/* ------------------------------ 录制帧提取 ------------------------------ */

/** 棋子编号排序：1、2、3…12 这种数字优先，其余按字母序 */
function comparePieceId(a, b) {
  const na = /^(\d+)([a-z]*)$/i.exec(a);
  const nb = /^(\d+)([a-z]*)$/i.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]) || na[2].localeCompare(nb[2]);
  if (na) return -1;
  if (nb) return 1;
  return a.localeCompare(b);
}

/** 把一帧的指令切出来：优先用帧首的 setTransform，退而求其次用 last clearRect */
function frameSlice(record) {
  const cmds = record.commands ?? [];
  if (cmds.length === 0) return { ops: [], start: 0, mode: 'empty' };
  for (let i = 0; i < cmds.length; i++) {
    if (cmds[i].op !== 'setTransform') continue;
    if (i > 0 && cmds[i - 1].op === 'setTransform') continue;
    // 最后一帧的 render() 一定从「setTransform + clearRect」开始，
    // 用它来定位能保证切出来的帧是完整的一帧。
    if (cmds[i + 1]?.op === 'clearRect') {
      return { ops: cmds.slice(i), start: i, mode: 'setTransform+clearRect' };
    }
  }
  const fs0 = record.frameStart ?? 0;
  return { ops: cmds.slice(fs0), start: fs0, mode: 'lastClearRect' };
}

/* ------------------------------ SVG 导出 ------------------------------ */

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function matrixAttr(m) {
  if (Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) {
    return `translate(${+m[4].toFixed(3)} ${+m[5].toFixed(3)}) scale(${+m[0].toFixed(4)} ${+m[3].toFixed(4)})`;
  }
  return `matrix(${m.map((v) => +v.toFixed(4)).join(' ')})`;
}

function rgbaCss(style, alpha) {
  const c = parseColor(style) ?? [0, 0, 0, 1];
  const a = +(c[3] * alpha).toFixed(3);
  const rgb = [c[0], c[1], c[2]].map((v) => Math.round(v));
  return a >= 1 ? `rgb(${rgb.join(',')})` : `rgba(${rgb.join(',')},${a})`;
}

function sameColor(a, b) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return false;
  return ca.every((v, i) => Math.abs(v - cb[i]) < 1e-6);
}

/**
 * 把一帧的绘制指令导出成 SVG。
 * 用 SVG 原生的 arcTo 语法（A 命令）表达圆角矩形与圆弧，放大看也不错。
 */
export function opsToSvg(ops, opts) {
  const { width, height, deviceWidth, deviceHeight, background = '#ffffff' } = opts;
  const body = [];
  let m = [1, 0, 0, 1, 0, 0];
  let fill = '#000000';
  let stroke = '#000000';
  let lineWidth = 1;
  let alpha = 1;
  let path = [];
  let cur = null;
  let start = null;
  const unsupported = new Map();

  const scale = width / deviceWidth;
  const root = [scale, 0, 0, scale, 0, 0];

  const note = (name) => unsupported.set(name, (unsupported.get(name) ?? 0) + 1);

  const pathData = () => path.map((c) => `${c[0]} ${c.slice(1).map((v) => (+v.toFixed(3))).join(' ')}`).join(' ');
  const flush = (mode) => {
    if (path.length === 0) return;
    const d = pathData();
    if (mode === 'fill') {
      body.push(`  <path d="${d}" fill="${escapeAttr(rgbaCss(fill, alpha))}"/>`);
    } else {
      body.push(
        `  <path d="${d}" fill="none" stroke="${escapeAttr(rgbaCss(stroke, alpha))}" ` +
          `stroke-width="${+lineWidth.toFixed(3)}" stroke-linejoin="round"/>`,
      );
    }
    path = [];
    cur = null;
    start = null;
  };

  for (const op of ops) {
    const name = op.op;
    const a = op.args;
    switch (name) {
      case 'SET':
        break;
      case 'save':
      case 'restore':
        break;
      case 'setTransform':
        m = a.slice(0, 6);
        break;
      case 'resetTransform':
        m = [1, 0, 0, 1, 0, 0];
        break;
      case 'clearRect':
        body.length = 0;
        body.push(`  <rect x="0" y="0" width="${width}" height="${height}" fill="none"/>`);
        break;
      case 'beginPath':
        path = [];
        cur = null;
        start = null;
        break;
      case 'moveTo':
        path.push(['M', a[0], a[1]]);
        cur = [a[0], a[1]];
        start = cur.slice();
        break;
      case 'lineTo':
        path.push(['L', a[0], a[1]]);
        cur = [a[0], a[1]];
        break;
      case 'rect':
        path.push(['M', a[0], a[1]], ['L', a[0] + a[2], a[1]], ['L', a[0] + a[2], a[1] + a[3]], ['L', a[0], a[1] + a[3]], ['Z']);
        cur = [a[0], a[1]];
        start = cur.slice();
        break;
      case 'closePath':
        path.push(['Z']);
        cur = start ? start.slice() : null;
        break;
      case 'arc':
        if (cur) {
          path.push(['L', a[0] + a[2] * Math.cos(a[3]), a[1] + a[2] * Math.sin(a[3])]);
        } else {
          path.push(['M', a[0] + a[2] * Math.cos(a[3]), a[1] + a[2] * Math.sin(a[3])]);
        }
        {
          let d = a[4] - a[3];
          if (a[5]) {
            while (d > 0) d -= Math.PI * 2;
          } else {
            while (d < 0) d += Math.PI * 2;
          }
          const largeArc = Math.abs(d) > Math.PI ? 1 : 0;
          const sweep = d > 0 ? 1 : 0;
          path.push([
            'A', a[2], a[2], 0, largeArc, sweep,
            +(a[0] + a[2] * Math.cos(a[4])).toFixed(3),
            +(a[1] + a[2] * Math.sin(a[4])).toFixed(3),
          ]);
          cur = [a[0] + a[2] * Math.cos(a[4]), a[1] + a[2] * Math.sin(a[4])];
        }
        break;
      case 'arcTo': {
        const [x1, y1, x2, y2, r] = a;
        if (!cur) {
          cur = [x1, y1];
          path.push(['M', x1, y1]);
        }
        const d1 = Math.hypot(cur[0] - x1, cur[1] - y1) || 1;
        const d2 = Math.hypot(x2 - x1, y2 - y1) || 1;
        const u1 = [(cur[0] - x1) / d1, (cur[1] - y1) / d1];
        const u2 = [(x2 - x1) / d2, (y2 - y1) / d2];
        const cross = u1[0] * u2[1] - u1[1] * u2[0];
        const dot = u1[0] * u2[0] + u1[1] * u2[1];
        const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
        const tanHalf = Math.tan(theta / 2) || 1e-9;
        const rr = Math.min(r, d1 * tanHalf, d2 * tanHalf);
        const tanLen = rr / tanHalf;
        const sweep = cross > 0 ? 0 : 1;
        path.push(['L', +(x1 + u1[0] * tanLen).toFixed(3), +(y1 + u1[1] * tanLen).toFixed(3)]);
        path.push([
          'A', +rr.toFixed(3), +rr.toFixed(3), 0, 0, sweep,
          +(x1 + u2[0] * tanLen).toFixed(3), +(y1 + u2[1] * tanLen).toFixed(3),
        ]);
        cur = [x1 + u2[0] * tanLen, y1 + u2[1] * tanLen];
        break;
      }
      case 'fillRect':
        path.push(['M', a[0], a[1]], ['L', a[0] + a[2], a[1]], ['L', a[0] + a[2], a[1] + a[3]], ['L', a[0], a[1] + a[3]], ['Z']);
        cur = [a[0], a[1]];
        fill = op.fillStyle;
        alpha = op.globalAlpha;
        flush('fill');
        break;
      case 'strokeRect':
        path.push(['M', a[0], a[1]], ['L', a[0] + a[2], a[1]], ['L', a[0] + a[2], a[1] + a[3]], ['L', a[0], a[1] + a[3]], ['Z']);
        cur = [a[0], a[1]];
        stroke = op.strokeStyle;
        lineWidth = op.lineWidth;
        alpha = op.globalAlpha;
        flush('stroke');
        break;
      case 'fill':
        fill = op.fillStyle;
        alpha = op.globalAlpha;
        flush('fill');
        break;
      case 'stroke':
        stroke = op.strokeStyle;
        lineWidth = op.lineWidth;
        alpha = op.globalAlpha;
        flush('stroke');
        break;
      default:
        note(name);
        break;
    }
  }

  const inner = body.join('\n');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <!-- 由 tools/render-preview.js 从真实 public/board.js 的录制指令生成；设备像素 ${deviceWidth}x${deviceHeight} -->
  <rect x="0" y="0" width="${width}" height="${height}" fill="${background}"/>
  <g transform="${matrixAttr(root)}">
${inner}
  </g>
</svg>
`;
  return { svg, unsupported };
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  await fsp.mkdir(path.join(ART, 'json'), { recursive: true });
  await fsp.mkdir(path.join(ART, 'svg'), { recursive: true });

  /* --- 1. 服务器 --- */
  const serverApp = createApp({ aiDelayMs: 5 });
  await new Promise((r) => serverApp.server.listen(0, '127.0.0.1', r));
  const port = serverApp.server.address().port;
  log(`服务器已启动：127.0.0.1:${port}`);

  /* --- 2. DOM 桩（带录制）+ 真实前端 --- */
  const recorder = create2DRecorder();
  installDom({ host: `127.0.0.1:${port}`, html: INDEX_HTML, recorder });
  await import('../public/app.js');

  const hook = globalThis.window.__blokus;
  if (!hook) throw new Error('app.js 没有挂出 window.__blokus 钩子');
  const { app: client, board, el, send } = hook;

  let captured = null;
  try {
    await until(() => client.connected, 10000, '前端连上 WebSocket');

    /* --- 3. 建房 + 补 AI + 开局 --- */
    el.inputName.value = '渲染快照';
    el.btnCreate.click();
    const room = await until(() => client.room, 10000, '收到房间信息');
    log(`房间 ${room.code} 已创建，我在座位 ${room.yourSeat}`);

    for (const seat of [1, 2, 3]) send({ t: C2S.SET_SEAT, seat, kind: 'ai' });
    await until(
      () => client.room?.seats.filter((s) => s.kind === 'ai').length === 3,
      8000,
      '三个座位变成 AI',
    );
    el.btnStart.click();
    await until(() => client.lastState, 10000, '收到对局快照');
    await until(() => el.tray.querySelectorAll('.tray-item').length === 21, 8000, '棋子栏渲染出 21 枚棋子');
    log(`棋子栏 ${el.tray.querySelectorAll('.tray-item').length} 枚棋子，录制中的画布 ${recorder.list().length} 块`);

    /* --- 3.5 开局时棋子栏里是完整 21 枚，先把它们的预览画布记录抓下来 --- */
    const previewRecords = new Map(); // pieceId → 录制记录
    for (const btn of el.tray.querySelectorAll('.tray-item')) {
      const canvas = btn.children.find((n) => n.tagName === 'CANVAS') ?? btn.querySelector('canvas');
      if (!canvas) continue;
      const rec = recorder.capture(canvas);
      if (rec && rec.commands.length > 0) previewRecords.set(btn.dataset.pieceId, rec);
    }
    log(`已抓到 ${previewRecords.size}/21 枚棋子的预览录制（此时棋盘还是空的）`);

    /* --- 4. 用真实 AI 走若干手 --- */
    const state0 = deserializeState(client.lastState);
    const local = JSON.parse(JSON.stringify(state0)); // 本地镜像，只用规则引擎挑着法
    local.board = state0.board; // Int8Array 不能 JSON 化，手动接回来

    let moveNo = 0;
    let squares = 0;
    let lastSeat = null;

    while (squares < ARGS.target && moveNo < ARGS.maxMoves) {
      const st = client.lastState;
      if (!st || st.over) break;
      const seat = st.turn;
      const moves = legalMoves(local, seat);
      if (moves.length === 0) {
        // 规则引擎不可能给出空列表（settle 已跳过无处可下的座位），保险起见等一下
        await sleep(10);
        continue;
      }
      const pick = moves[Math.floor((moveNo * 2654435761) % moves.length)];
      if (seat === 0) {
        // 座位 0 走完整的 UI 路径：点棋子栏 → board.confirm() → 服务端确认
        const btn = el.tray.querySelectorAll('.tray-item').find((n) => n.dataset.pieceId === pick.pieceId);
        if (!btn) throw new Error(`棋子栏里找不到 ${pick.pieceId}`);
        btn.click();
        const sel = board.selection;
        board.sel = { pieceId: sel.pieceId, orient: pick.orient, gx: pick.x, gy: pick.y };
        const r = board.confirm();
        if (!r.ok) throw new Error(`board.confirm() 拒绝了合法着法 ${JSON.stringify(pick)}：${r.reason}`);
      } else {
        send({ t: C2S.MOVE, pieceId: pick.pieceId, orient: pick.orient, x: pick.x, y: pick.y });
      }

      const prev = st.moveCount;
      await until(() => client.lastState?.moveCount > prev, 10000, `第 ${moveNo + 1} 手被服务端接受`);
      // 把这一手同步进本地镜像
      const piece = PIECE_BY_ID.get(pick.pieceId);
      for (const [dx, dy] of piece.orientations[pick.orient]) {
        local.board[(pick.y + dy) * BOARD_SIZE + (pick.x + dx)] = seat;
      }
      local.remaining[seat] = local.remaining[seat].filter((id) => id !== pick.pieceId);
      local.placed[seat].push({ ...pick });
      local.turn = client.lastState.turn;
      local.over = client.lastState.over;
      local.passStreak = client.lastState.passStreak;

      moveNo += 1;
      lastSeat = seat;
      squares = 0;
      for (let i = 0; i < local.board.length; i++) if (local.board[i] >= 0) squares += 1;
      if (moveNo % 5 === 0 || squares >= ARGS.target) {
        log(`  第 ${String(moveNo).padStart(3)} 手：座位 ${seat} 落子，棋盘已有 ${squares} 格`);
      }
    }
    log(`共走 ${moveNo} 手，棋盘 ${squares} 格（最后落子：座位 ${lastSeat}）`);

    /* --- 5. 画最后一帧棋盘 ---
     *
     * 这里必须先「等局面稳定」再渲染：
     * 服务端的 AI 座位是自动推进的，只要让出一次事件循环，就可能又收到一条
     * STATE 广播，于是 board 上画的是第 N 手、而 client.lastState 已经是第 N+1 手。
     * 之前就是踩了这个坑，导致 verify-render 报「有 5 格状态里有、渲染里没有」。
     */
    await until(() => board.raw && board.raw.moveCount > 0, 8000, '客户端拿到对局状态');
    for (let i = 0; i < 40; i++) {
      const before = board.raw?.moveCount;
      await sleep(60);
      if (board.raw?.moveCount === before && client.lastState?.moveCount === before) break;
    }
    board.render(); // ← 真实 public/board.js 的渲染入口
    const renderedSnapshot = board.raw; // 棋盘刚刚画的就是这一份，dump 必须用它
    const boardCanvas = el.boardCanvas;
    const boardRecord = recorder.capture(boardCanvas);
    if (!boardRecord || boardRecord.commands.length === 0) throw new Error('没有录到棋盘画布的绘制指令');
    const boardFrame = frameSlice(boardRecord);
    log(
      `棋盘画布：css ${boardRecord.cssWidth}x${boardRecord.cssHeight}，设备 ${boardRecord.width}x${boardRecord.height}，` +
        `共录 ${boardRecord.commands.length} 条指令，最后一帧 ${boardFrame.ops.length} 条（切法：${boardFrame.mode}）`,
    );

    /* --- 6. 棋子栏：开局抓到的完整 21 枚预览 --- */
    const previews = [];
    for (const id of [...previewRecords.keys()].sort(comparePieceId)) {
      previews.push({ pieceId: id, rec: previewRecords.get(id) });
    }
    if (previews.length !== 21) throw new Error(`棋子预览只抓到 ${previews.length} 枚，应当是 21 枚`);
    log(`棋子栏预览：${previews.length} 块画布，尺寸样例 ${previews[0].rec.width}x${previews[0].rec.height}`);

    /* --- 7. 光栅化 --- */
    const boardDpr = boardRecord.cssWidth > 0 ? boardRecord.width / boardRecord.cssWidth : window.devicePixelRatio || 1;
    log(`棋盘 dpr = ${boardDpr}（设备 ${boardRecord.width} ÷ CSS ${boardRecord.cssWidth}）`);
    const boardPng = rasterize(boardFrame.ops, {
      width: boardRecord.width,
      height: boardRecord.height,
      dpr: boardDpr,
      scale: ARGS.boardScale,
    });

    const rendered = previews.map(({ pieceId, rec }) => {
      const dpr = rec.cssWidth > 0 ? rec.width / rec.cssWidth : 1;
      const r = rasterize(rec.commands, { width: rec.width, height: rec.height, dpr, scale: 1 });
      return { pieceId, ...r, cssWidth: rec.cssWidth, cssHeight: rec.cssHeight, rec, dpr };
    });

    const cols = ARGS.cols;
    const rows = Math.ceil(rendered.length / cols);
    const cellW = Math.max(...rendered.map((r) => r.width)) + 8;
    const cellH = Math.max(...rendered.map((r) => r.height)) + 8;
    const tray = new Canvas(cols * cellW, rows * cellH);
    rendered.forEach((r, i) => {
      const cx = (i % cols) * cellW + Math.floor((cellW - r.width) / 2);
      const cy = Math.floor(i / cols) * cellH + Math.floor((cellH - r.height) / 2);
      // 记下每枚棋子在这张合成图里的偏移 —— verify-render.js 要按它
      // 才能把「棋子画布内的局部坐标」换算成合成图上的绝对坐标
      r.offsetX = cx;
      r.offsetY = cy;
      tray.blit(r.canvas, cx, cy);
    });

    /* --- 8. 落盘 --- */
    const boardPngBuf = encodePNG(boardPng);
    const trayPngBuf = encodePNG({ width: tray.width, height: tray.height, data: tray.data });
    await fsp.writeFile(path.join(ART, 'board.png'), boardPngBuf);
    await fsp.writeFile(path.join(ART, 'tray.png'), trayPngBuf);

    const svgOut = opsToSvg(boardFrame.ops, {
      width: boardRecord.width,
      height: boardRecord.height,
      deviceWidth: boardRecord.width,
      deviceHeight: boardRecord.height,
      background: '#0b1120',
    });
    await fsp.writeFile(path.join(ART, 'svg', 'board.svg'), svgOut.svg, 'utf8');

    const dump = {
      generatedAt: new Date().toISOString(),
      server: { port, roomCode: room.code },
      difficulty: ARGS.difficulty,
      moves: moveNo,
      squaresOnBoard: renderedSnapshot.board.split('').filter((c) => c !== '.').length,
      // 供 tools/verify-render.js 逐格比对用的真实对局快照。
      // 必须用 renderedSnapshot（棋盘实际画的那一份），不能用 client.lastState
      // —— 后者可能已经被后续广播推进到下一手了。
      state: {
        board: renderedSnapshot.board,
        turn: renderedSnapshot.turn,
        remaining: renderedSnapshot.remaining,
        placed: renderedSnapshot.placed,
        over: renderedSnapshot.over,
        moveCount: renderedSnapshot.moveCount,
      },
      board: {
        cssWidth: boardRecord.cssWidth,
        cssHeight: boardRecord.cssHeight,
        deviceWidth: boardRecord.width,
        deviceHeight: boardRecord.height,
        frameMode: boardFrame.mode,
        totalCommandsRecorded: boardRecord.commands.length,
        frameCommands: boardFrame.ops.length,
        ops: boardFrame.ops,
      },
      tray: rendered.map((r) => ({
        pieceId: r.pieceId,
        deviceWidth: r.width,
        deviceHeight: r.height,
        cssWidth: r.cssWidth,
        cssHeight: r.cssHeight,
        offsetX: r.offsetX,
        offsetY: r.offsetY,
        ops: r.rec.commands,
      })),
    };
    await fsp.writeFile(
      path.join(ART, 'json', 'render.json'),
      JSON.stringify(dump, null, 1),
      'utf8',
    );

    /* --- 9. 自检统计 --- */
    const boardStats = backgroundRatio(boardPng, [0, 0, 0, 0]);
    const trayStats = backgroundRatio({ width: tray.width, height: tray.height, data: tray.data }, [0, 0, 0, 0]);

    // 真实棋盘状态：每种颜色的格子数
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < local.board.length; i++) {
      const v = local.board[i];
      if (v >= 0) counts[v] += 1;
    }

    const report = {
      files: {
        boardPng: path.relative(ROOT, path.join(ART, 'board.png')),
        trayPng: path.relative(ROOT, path.join(ART, 'tray.png')),
        boardSvg: path.relative(ROOT, path.join(ART, 'svg', 'board.svg')),
        json: path.relative(ROOT, path.join(ART, 'json', 'render.json')),
      },
      sizes: {
        board: { width: boardPng.width, height: boardPng.height, bytes: boardPngBuf.length },
        tray: { width: tray.width, height: tray.height, bytes: trayPngBuf.length },
      },
      pixels: {
        board: { ...boardStats, ratio: +(boardStats.ratio * 100).toFixed(2) },
        tray: { ...trayStats, ratio: +(trayStats.ratio * 100).toFixed(2) },
      },
      squares: counts,
      moves: moveNo,
      unsupported: [...boardPng.stats.unsupported.entries()].map(([k, v]) => ({ op: k, ...v })),
      unsupportedTray: [
        ...rendered
          .flatMap((r) => [...r.stats.unsupported.entries()])
          .reduce((map, [k, v]) => {
            const prev = map.get(k) ?? { count: 0, reason: v.reason };
            prev.count += v.count;
            map.set(k, prev);
            return map;
          }, new Map())
          .entries(),
      ].map(([k, v]) => ({ op: k, ...v })),
      svgUnsupported: [...svgOut.unsupported.entries()].map(([k, v]) => ({ op: k, count: v })),
    };

    /* --- 10. 控制台报告 --- */
    console.log('');
    console.log('═══════════════ 渲染快照报告 ═══════════════');
    console.log(`文件：`);
    for (const [k, v] of Object.entries(report.files)) console.log(`  ${k.padEnd(9)} ${v}`);
    console.log(`尺寸：board ${report.sizes.board.width}x${report.sizes.board.height} (${report.sizes.board.bytes} B)`);
    console.log(`      tray  ${report.sizes.tray.width}x${report.sizes.tray.height} (${report.sizes.tray.bytes} B)`);
    console.log(`非背景像素占比：board ${report.pixels.board.ratio}%   tray ${report.pixels.tray.ratio}%`);
    // 从「棋盘实际画的那一份快照」统计，而不是本地镜像 —— 本地镜像可能
    // 和服务端已经推进到的局面差一手，那样这里报的数就和 PNG 对不上了。
    const seatCounts = [0, 0, 0, 0];
    for (const ch of renderedSnapshot.board) if (ch !== '.') seatCounts[+ch] += 1;
    const drawnTotal = seatCounts.reduce((a, c) => a + c, 0);
    console.log(`棋盘各色格子数（蓝/黄/红/绿）：${seatCounts.join(' / ')}（合计 ${drawnTotal}）`);
    console.log(`不支持的绘制方法（board）：${report.unsupported.length ? JSON.stringify(report.unsupported) : '无'}`);
    console.log(`不支持的绘制方法（tray）：${report.unsupportedTray.length ? JSON.stringify(report.unsupportedTray) : '无'}`);
    console.log(`不支持的绘制方法（svg） ：${report.svgUnsupported.length ? JSON.stringify(report.svgUnsupported) : '无'}`);

    // 额外自检：有没有「画了但一片空白」的情况
    if (boardStats.ratio < 0.05) throw new Error(`board.png 非背景像素只有 ${(boardStats.ratio * 100).toFixed(2)}%，疑似空白`);
    if (trayStats.ratio < 0.02) throw new Error(`tray.png 非背景像素只有 ${(trayStats.ratio * 100).toFixed(2)}%，疑似空白`);

    captured = report;
  } finally {
    hook.disconnect();
    await serverApp.close();
  }

  // 让 Node 进程干净退出（前端可能还留着定时器）
  setTimeout(() => process.exit(0), 50).unref?.();
  return captured;
}

main().catch((err) => {
  console.error('渲染快照失败：', err);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 50).unref?.();
});
