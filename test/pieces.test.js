import test from 'node:test';
import assert from 'node:assert/strict';

import { PIECES, PIECE_BY_ID, TOTAL_SQUARES, TOTAL_ORIENTATIONS, orientationGrid } from '../shared/pieces.js';
import { BOARD_SIZE, SEAT_CORNERS, TEAM_OF_SEAT, PIECES_PER_PLAYER, SQUARES_PER_PLAYER } from '../shared/constants.js';

test('标准 Blokus 棋子集：21 块 / 89 格 / 91 种朝向', () => {
  assert.equal(PIECES.length, PIECES_PER_PLAYER);
  assert.equal(TOTAL_SQUARES, SQUARES_PER_PLAYER);
  // 旋转 + 翻转去重后的朝向总数：1+2+2+4+2+1+4+8+4 +8+2+8+8+8+4+4+4+4+1+8+4 = 91
  assert.equal(TOTAL_ORIENTATIONS, 91);
});

test('每种格数的棋子数量符合标准（1/1/2/5/12）', () => {
  const hist = {};
  for (const p of PIECES) hist[p.size] = (hist[p.size] ?? 0) + 1;
  assert.deepEqual(hist, { 1: 1, 2: 1, 3: 2, 4: 5, 5: 12 });
});

test('棋子 id 唯一', () => {
  assert.equal(new Set(PIECES.map((p) => p.id)).size, PIECES.length);
});

test('每种朝向的格子互不重复，且包围盒与宽高一致', () => {
  for (const p of PIECES) {
    for (let oi = 0; oi < p.orientations.length; oi++) {
      const cells = p.orientations[oi];
      assert.equal(cells.length, p.size, `${p.id} 朝向 ${oi} 格数不对`);
      const keys = new Set(cells.map(([x, y]) => `${x},${y}`));
      assert.equal(keys.size, cells.length, `${p.id} 朝向 ${oi} 有重叠格`);
      const maxX = Math.max(...cells.map(([x]) => x));
      const maxY = Math.max(...cells.map(([, y]) => y));
      const minX = Math.min(...cells.map(([x]) => x));
      const minY = Math.min(...cells.map(([, y]) => y));
      assert.equal(minX, 0, `${p.id} 朝向 ${oi} 未左对齐`);
      assert.equal(minY, 0, `${p.id} 朝向 ${oi} 未上对齐`);
      assert.equal(p.widths[oi], maxX + 1);
      assert.equal(p.heights[oi], maxY + 1);
    }
  }
});

test('朝向数量符合各棋子的对称性（手性块 8，直线/对称块更少）', () => {
  const expect = {
    '1': 1, '2': 2, // 单格只有一种，双格有横竖两种
    I3: 2, V3: 4,
    I4: 2, O4: 1, T4: 4, L4: 8, S4: 4,
    F5: 8, I5: 2, L5: 8, P5: 8, N5: 8, T5: 4,
    U5: 4, V5: 4, W5: 4, X5: 1, Y5: 8, Z5: 4,
  };
  for (const [id, n] of Object.entries(expect)) {
    assert.equal(PIECE_BY_ID.get(id).orientations.length, n, `${id} 朝向数不对`);
  }
});

test('朝向之间互不重复（同一形状不会重复计数）', () => {
  for (const p of PIECES) {
    const keys = new Set(p.orientations.map((o) => o.map(([x, y]) => `${x},${y}`).join(';')));
    assert.equal(keys.size, p.orientations.length, `${p.id} 存在重复朝向`);
  }
});

test('piece.offsets 与 orientations 一致', () => {
  for (const p of PIECES) {
    for (let oi = 0; oi < p.orientations.length; oi++) {
      const expected = p.orientations[oi].map(([x, y]) => y * BOARD_SIZE + x);
      assert.deepEqual(p.offsets[oi], expected);
    }
  }
});

test('orientationGrid 渲染尺寸与包围盒一致', () => {
  const p = PIECE_BY_ID.get('X5');
  const grid = orientationGrid(p, 0);
  assert.equal(grid.length, 3);
  assert.equal(grid[0].length, 3);
  assert.equal(grid[0][1], true);
  assert.equal(grid[0][0], false);
  assert.equal(grid[1][0], true);
});

test('flipIndex 是真正的镜像：翻转后形状等于水平镜像，再翻一次回到原样', () => {
  for (const p of PIECES) {
    for (let i = 0; i < p.orientations.length; i++) {
      const j = p.flipIndex[i];
      assert.equal(typeof j, 'number', `${p.id} 朝向 ${i} 缺少镜像下标`);
      assert.ok(j >= 0 && j < p.orientations.length);

      // 把朝向 i 水平镜像后归一化，应该与朝向 j 完全相同
      const src = p.orientations[i];
      const mirrored = src.map(([x, y]) => [-x, y]);
      const minX = Math.min(...mirrored.map(([x]) => x));
      const minY = Math.min(...mirrored.map(([, y]) => y));
      const want = mirrored
        .map(([x, y]) => [x - minX, y - minY])
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const got = p.orientations[j];
      assert.deepEqual(got, want, `${p.id} 朝向 ${i} 的镜像不对`);

      // 镜像是对合运算：翻两次必须回到自己
      assert.equal(p.flipIndex[j], i, `${p.id} 朝向 ${i} 的镜像下标不是对合`);
    }
  }
});

test('flipIndex 对镜像对称的棋子指向自身', () => {
  // X5 完全对称，翻转后应该还是自己
  const x = PIECE_BY_ID.get('X5');
  assert.equal(x.flipIndex[0], 0);
  // O4 也一样
  const o = PIECE_BY_ID.get('O4');
  assert.equal(o.flipIndex[0], 0);
});

test('座位角顺序是屏幕上的逆时针（y 轴向下坐标系）', () => {
  // 鞋带公式：y 轴向下时，屏幕逆时针的有向面积为负
  let area = 0;
  for (let i = 0; i < SEAT_CORNERS.length; i++) {
    const [x1, y1] = SEAT_CORNERS[i];
    const [x2, y2] = SEAT_CORNERS[(i + 1) % SEAT_CORNERS.length];
    area += x1 * y2 - x2 * y1;
  }
  assert.ok(area < 0, `座位顺序应为逆时针，实际有向面积 ${area}`);
  assert.deepEqual(SEAT_CORNERS, [
    [0, 0],
    [0, BOARD_SIZE - 1],
    [BOARD_SIZE - 1, BOARD_SIZE - 1],
    [BOARD_SIZE - 1, 0],
  ]);
});

test('二对二阵营是对角配对', () => {
  assert.deepEqual(TEAM_OF_SEAT, [0, 1, 0, 1]);
  // 座位 0(左上) 与 2(右下) 同队；1(左下) 与 3(右上) 同队
  assert.equal(TEAM_OF_SEAT[0], TEAM_OF_SEAT[2]);
  assert.equal(TEAM_OF_SEAT[1], TEAM_OF_SEAT[3]);
  assert.notEqual(TEAM_OF_SEAT[0], TEAM_OF_SEAT[1]);
  // 同队两座位确实位于对角
  assert.deepEqual(SEAT_CORNERS[0], [0, 0]);
  assert.deepEqual(SEAT_CORNERS[2], [BOARD_SIZE - 1, BOARD_SIZE - 1]);
  assert.deepEqual(SEAT_CORNERS[1], [0, BOARD_SIZE - 1]);
  assert.deepEqual(SEAT_CORNERS[3], [BOARD_SIZE - 1, 0]);
});
