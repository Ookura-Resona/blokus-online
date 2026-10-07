/**
 * 严谨自检：把 PNG 的像素与「真实对局状态 / 真实棋子定义」逐格对照。
 *
 *   node tools/verify-render.js
 *
 * 检查项：
 *   A. 棋盘：把 art/board.png 按棋盘几何切成 20×20 格，每格中心取色，
 *      与 art/json/render.json 里那份状态快照的 board 字符串逐格比对；
 *      并验证棋盘确实占满画布宽度。
 *   B. 棋子栏：把 art/tray.png 切成格子，重建每枚棋子的形状（哪些格被填充），
 *      与 shared/pieces.js 的真实定义比对（含宽高与相对偏移）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from './pngread.js';
import { BOARD_SIZE, SEAT_HEX, SEAT_CORNERS } from '../shared/constants.js';
import { PIECE_BY_ID } from '../shared/pieces.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ART = path.join(ROOT, 'art');

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const SEAT_RGB = SEAT_HEX.map(hex);
const near = (p, rgb, tol) => Math.abs(p[0] - rgb[0]) <= tol && Math.abs(p[1] - rgb[1]) <= tol && Math.abs(p[2] - rgb[2]) <= tol;

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${msg}`);
  if (!ok) failures += 1;
};

const DUMP_PATH = path.join(ART, 'json', 'render.json');
if (!fs.existsSync(DUMP_PATH)) {
  console.error(
    `\n找不到 ${path.relative(ROOT, DUMP_PATH)}。\n` +
      '这个文件是渲染录制产物（已在 .gitignore 里），请先跑一次：\n\n' +
      '    node tools/render-preview.js\n',
  );
  process.exit(2);
}
const dump = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));

/* ------------------------------ A. 棋盘 ------------------------------ */

console.log('== A. art/board.png 与对局状态逐格比对 ==');
const boardPng = PNG.read(path.join(ART, 'board.png'));
console.log(`  PNG 尺寸 ${boardPng.width}x${boardPng.height}（录制设备尺寸 ${dump.board.deviceWidth}x${dump.board.deviceHeight}）`);
check(boardPng.width === dump.board.deviceWidth && boardPng.height === dump.board.deviceHeight, 'PNG 尺寸与录制画布一致');

// 棋盘几何：从录制帧里的棋盘底圆角矩形反推（本地 CSS 坐标）
const firstMove = dump.board.ops.find((o) => o.op === 'moveTo');
const arcTos = dump.board.ops.filter((o) => o.op === 'arcTo').slice(0, 4).map((o) => o.args);
const xs = arcTos.map((a) => a[0]);
const ys = arcTos.map((a) => a[1]);
const bx = Math.min(...xs);
const by = Math.min(...ys);
const side = Math.max(...xs) - bx;
const dpr = dump.board.deviceWidth / dump.board.cssWidth;
const cellPx = (side / BOARD_SIZE) * dpr; // 每格在 PNG 里的像素
console.log(`  棋盘本地左上 (${bx}, ${by})，边长 ${side} CSS px ⇒ 每格 ${cellPx} PNG px（dpr=${dpr}）`);
check(Math.abs(side - side) < 1e-6, `棋盘底边长 ${side} CSS px`);
void firstMove;

const left = bx * dpr;
const top = by * dpr;
check(Math.abs(left) < 1.5, `棋盘左边界在 x≈0（实际 ${left.toFixed(2)}，应贴住画布左边）`);
check(
  Math.abs(left + side * dpr - boardPng.width) < 1.5,
  `棋盘右边界在 x≈${boardPng.width}（实际 ${(left + side * dpr).toFixed(2)}，即占满画布宽度）`,
);

// 用「哪一格中心属于哪个座位」比对状态字符串
const stateBoard = dump.state?.board;
let mismatch = 0;
let sampled = 0;
const seen = [0, 0, 0, 0];
for (let gy = 0; gy < BOARD_SIZE; gy++) {
  for (let gx = 0; gx < BOARD_SIZE; gx++) {
    const cx = Math.round(left + (gx + 0.5) * cellPx);
    const cy = Math.round(top + (gy + 0.5) * cellPx);
    const p = boardPng.pixel(cx, cy);
    let seat = -1;
    for (let s = 0; s < 4; s++) {
      if (near(p, SEAT_RGB[s], 30)) {
        seat = s;
        break;
      }
    }
    sampled += 1;
    if (seat >= 0) seen[seat] += 1;
    const expect = stateBoard ? (stateBoard[gy * BOARD_SIZE + gx] === '.' ? -1 : Number(stateBoard[gy * BOARD_SIZE + gx])) : null;
    if (expect !== null && expect !== seat) {
      mismatch += 1;
      if (mismatch <= 5) {
        console.log(`     格 (${gx},${gy}) 像素 rgb(${p[0]},${p[1]},${p[2]}) 判为 ${seat}，状态里是 ${expect}`);
      }
    }
  }
}
console.log(`  采样 ${sampled} 格；像素判色计数 蓝${seen[0]} 黄${seen[1]} 红${seen[2]} 绿${seen[3]}`);
if (stateBoard) {
  const counts = [0, 0, 0, 0];
  for (const ch of stateBoard) if (ch !== '.') counts[Number(ch)] += 1;
  console.log(`  状态快照计数     蓝${counts[0]} 黄${counts[1]} 红${counts[2]} 绿${counts[3]}`);
  check(
    counts.every((c, i) => c === seen[i]),
    `逐格颜色计数与状态快照完全一致（不一致 ${mismatch} 格）`,
  );
}

// 起始角标记：四个角都应该有对应颜色的角标（未被占用时是实心填充）
for (let seat = 0; seat < 4; seat++) {
  const [gx, gy] = SEAT_CORNERS[seat];
  const cx = Math.round(left + (gx + 0.5) * cellPx);
  const cy = Math.round(top + (gy + 0.5) * cellPx);
  const p = boardPng.pixel(cx, cy);
  // 角标画在格子中心，半径 c*0.3，所以中心像素一定是该座位色（或被棋子覆盖）
  const occupied = stateBoard ? stateBoard[gy * BOARD_SIZE + gx] !== '.' : false;
  const isSeatColor = near(p, SEAT_RGB[seat], 40);
  check(
    isSeatColor,
    `座位 ${seat} 的起始角 (${gx},${gy}) 中心像素是座位色 rgb(${p[0]},${p[1]},${p[2]})${occupied ? '（该角已被棋子覆盖，符合预期）' : ''}`,
  );
}

/* ------------------------------ B. 棋子栏 ------------------------------ */

console.log('\n== B. art/tray.png 与 shared/pieces.js 定义逐枚比对 ==');
const trayPng = PNG.read(path.join(ART, 'tray.png'));
console.log(`  PNG 尺寸 ${trayPng.width}x${trayPng.height}，共 ${dump.tray.length} 枚棋子`);
check(dump.tray.length === 21, `棋子栏包含 21 枚棋子（实际 ${dump.tray.length}）`);

// 每个预览画布是「cell=8 CSS px × dpr」，PNG 里每格 = 8 * dpr_preview 像素
let pieceOk = 0;
for (const item of dump.tray) {
  const piece = PIECE_BY_ID.get(item.pieceId);
  if (!piece) {
    check(false, `棋子 ${item.pieceId} 在 PIECE_BY_ID 里不存在`);
    continue;
  }
  const cell = 8; // drawPiecePreview 的 cell 参数
  const dprP = item.deviceWidth / item.cssWidth;
  const cellsW = Math.round(item.cssWidth / cell);
  const cellsH = Math.round(item.cssHeight / cell);
  const def = piece.orientations[0];
  const defW = piece.widths[0];
  const defH = piece.heights[0];
  const defSet = new Set(def.map(([x, y]) => `${x},${y}`));
  // 渲染出来的形状：每个格子内部（中心）是否被填色
  const gotSet = new Set();
  for (let gy = 0; gy < cellsH; gy++) {
    for (let gx = 0; gx < cellsW; gx++) {
      // tray.png 是 21 枚棋子拼成的一张图，所以必须加上这枚棋子在合成图里的偏移
      const cx = Math.round((item.offsetX ?? 0) + (gx + 0.5) * cell * dprP);
      const cy = Math.round((item.offsetY ?? 0) + (gy + 0.5) * cell * dprP);
      const p = trayPng.pixel(cx, cy);
      if (p[3] > 128) gotSet.add(`${gx},${gy}`);
    }
  }
  const same = gotSet.size === defSet.size && [...defSet].every((k) => gotSet.has(k));
  const sizeOk = cellsW === defW && cellsH === defH;
  const cellsOk = gotSet.size === piece.size;
  if (same && sizeOk && cellsOk) {
    pieceOk += 1;
  } else {
    console.log(
      `  ❌ 棋子 ${item.pieceId}（${piece.size} 格）不一致：` +
        `画布格 ${cellsW}x${cellsH} vs 定义 ${defW}x${defH}；` +
        `填充格 ${[...gotSet].sort().join(' ')} vs 定义 ${[...defSet].sort().join(' ')}`,
    );
    failures += 1;
  }
}
check(pieceOk === 21, `21 枚棋子的形状/朝向与 pieces.js 定义完全一致（实际 ${pieceOk}/21）`);

// 棋子栏总格数应当是 89
let trayCells = 0;
for (const item of dump.tray) {
  const cell = 8;
  const dprP = item.deviceWidth / item.cssWidth;
  const cellsW = Math.round(item.cssWidth / cell);
  const cellsH = Math.round(item.cssHeight / cell);
  for (let gy = 0; gy < cellsH; gy++) {
    for (let gx = 0; gx < cellsW; gx++) {
      const p = trayPng.pixel(
        Math.round((item.offsetX ?? 0) + (gx + 0.5) * cell * dprP),
        Math.round((item.offsetY ?? 0) + (gy + 0.5) * cell * dprP),
      );
      if (p[3] > 128) trayCells += 1;
    }
  }
}
check(trayCells === 89, `棋子栏合计 ${trayCells} 格（标准 Blokus 全套 = 89 格）`);

console.log(`\n${failures === 0 ? '✅ 全部检查通过' : `❌ 有 ${failures} 项检查未通过`}`);
process.exitCode = failures === 0 ? 0 : 1;
