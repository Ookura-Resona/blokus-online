/**
 * 标准 Blokus 的 21 枚棋子定义，以及全部「旋转 + 翻转」朝向的预计算。
 *
 * 棋子是双面的（可以翻过来用），所以朝向 = 4 种旋转 × 2 种翻转，去重后得到
 * 该棋子所有本质不同的摆放姿态。标准棋子集共 21 块、89 格：
 *   1 格 ×1、2 格 ×1、3 格 ×2、4 格 ×5、5 格 ×12。
 */

import { BOARD_SIZE } from './constants.js';

/**
 * 棋子的规范坐标（以左上角为原点）。
 * 命名遵循国际通用五格骨牌（pentomino）字母命名法。
 */
const DEFINITIONS = [
  // ---- 1 格 ----
  ['1', [[0, 0]]],
  // ---- 2 格 ----
  ['2', [[0, 0], [1, 0]]],
  // ---- 3 格 ----
  ['I3', [[0, 0], [1, 0], [2, 0]]],
  ['V3', [[0, 0], [0, 1], [1, 1]]],
  // ---- 4 格 ----
  ['I4', [[0, 0], [1, 0], [2, 0], [3, 0]]],
  ['O4', [[0, 0], [1, 0], [0, 1], [1, 1]]],
  ['T4', [[0, 0], [1, 0], [2, 0], [1, 1]]],
  ['L4', [[0, 0], [0, 1], [0, 2], [1, 2]]],
  ['S4', [[1, 0], [2, 0], [0, 1], [1, 1]]],
  // ---- 5 格 ----
  ['F5', [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]]],
  ['I5', [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]],
  ['L5', [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]]],
  ['P5', [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]]],
  ['N5', [[0, 0], [1, 0], [1, 1], [2, 1], [3, 1]]],
  ['T5', [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]]],
  ['U5', [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]]],
  ['V5', [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]]],
  ['W5', [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]]],
  ['X5', [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]]],
  ['Y5', [[0, 0], [0, 1], [0, 2], [0, 3], [1, 1]]],
  ['Z5', [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]]],
];

/** 把坐标平移到左上都贴边（min x = 0, min y = 0） */
function normalize(cells) {
  let minX = Infinity;
  let minY = Infinity;
  for (const [x, y] of cells) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }
  const out = cells.map(([x, y]) => [x - minX, y - minY]);
  // 稳定排序，保证同一形状得到同一个字符串 key
  out.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
  return out;
}

function keyOf(cells) {
  return cells.map(([x, y]) => `${x},${y}`).join(';');
}

/** 生成一个形状的全部 8 种变换（4 旋转 × 是否翻转） */
function allTransforms(base) {
  const found = new Map();
  for (let flipped = 0; flipped < 2; flipped++) {
    // 当前这组坐标经过若干次 90° 旋转
    let current = base.map(([x, y]) => (flipped ? [-x, y] : [x, y]));
    for (let rot = 0; rot < 4; rot++) {
      const norm = normalize(current);
      const k = keyOf(norm);
      if (!found.has(k)) found.set(k, norm);
      // 逆时针旋转 90°：(x, y) -> (-y, x)
      current = current.map(([x, y]) => [-y, x]);
    }
  }
  return [...found.values()];
}

/**
 * 全部棋子的完整数据。
 * 每项：{ id, size, cells, orientations, widths, heights, offsets, flipIndex, index }
 *   orientations[i] —— 第 i 种朝向的相对坐标数组 [[dx, dy], ...]
 *   widths[i] / heights[i] —— 该朝向的包围盒宽高
 *   offsets[i] —— 该朝向的扁平相对偏移 dy * BOARD_SIZE + dx（服务端热路径用）
 *   flipIndex[i] —— 第 i 种朝向「翻面」之后对应的朝向下标
 *                  （棋子是双面的，界面上必须有真正的镜像而不是再转 90°）
 */
export const PIECES = DEFINITIONS.map(([id, cells], index) => {
  const canonical = normalize(cells);
  const orientations = allTransforms(canonical);

  const indexByKey = new Map(orientations.map((o, i) => [keyOf(o), i]));
  const flipIndex = orientations.map((o) => {
    const mirrored = normalize(o.map(([x, y]) => [-x, y]));
    return indexByKey.get(keyOf(mirrored));
  });

  return {
    id,
    index,
    size: canonical.length,
    cells: canonical,
    orientations,
    widths: orientations.map((o) => Math.max(...o.map(([x]) => x)) + 1),
    heights: orientations.map((o) => Math.max(...o.map(([, y]) => y)) + 1),
    offsets: orientations.map((o) => o.map(([x, y]) => y * BOARD_SIZE + x)),
    flipIndex,
  };
});

/** id -> 棋子 */
export const PIECE_BY_ID = new Map(PIECES.map((p) => [p.id, p]));

/** 全部棋子 id，按从大到小排序（界面棋子栏用它做稳定顺序） */
export const ALL_PIECE_IDS = PIECES.map((p) => p.id);

/** 每个玩家的初始剩余棋子（21 块） */
export function freshPieceIds() {
  return ALL_PIECE_IDS.slice();
}

/** 统计用：棋子集总格数 */
export const TOTAL_SQUARES = PIECES.reduce((sum, p) => sum + p.size, 0);

/** 朝向总数（标准集合为 90） */
export const TOTAL_ORIENTATIONS = PIECES.reduce((sum, p) => sum + p.orientations.length, 0);

/** 把某朝向的坐标转成棋盘扁平索引（给定左上角位置） */
export function orientationToIndices(piece, orientIndex, ox, oy) {
  const out = [];
  for (const [dx, dy] of piece.orientations[orientIndex]) {
    out.push((oy + dy) * BOARD_SIZE + (ox + dx));
  }
  return out;
}

/** 渲染辅助：返回某个朝向包围盒的二维布尔网格 */
export function orientationGrid(piece, orientIndex) {
  const w = piece.widths[orientIndex];
  const h = piece.heights[orientIndex];
  const grid = Array.from({ length: h }, () => new Array(w).fill(false));
  for (const [dx, dy] of piece.orientations[orientIndex]) grid[dy][dx] = true;
  return grid;
}
