import test from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_SIZE, CELLS, SEAT_CORNERS, MODE_FFA, MODE_TEAM } from '../shared/constants.js';
import { PIECE_BY_ID } from '../shared/pieces.js';
import {
  createState,
  legalMoves,
  hasAnyMove,
  validateMove,
  applyMove,
  settle,
  allSquares,
  boardToString,
  stringToBoard,
  serializeState,
  deserializeState,
} from '../shared/rules.js';
import { chooseMove, playAiTurn, mulberry32 } from '../shared/ai.js';
import { force } from './helpers.js';

const idx = (x, y) => y * BOARD_SIZE + x;

/* ------------------------------------------------------------------ */
/* R2 首子必须覆盖起始角                                                */
/* ------------------------------------------------------------------ */

test('R2：第一枚棋子必须盖住自己的起始角', () => {
  for (let seat = 0; seat < 4; seat++) {
    const st = createState(MODE_FFA);
    const [cx, cy] = SEAT_CORNERS[seat];
    st.turn = seat;
    // 盖住角 —— 合法
    assert.equal(validateMove(st, seat, '1', 0, cx, cy).ok, true, `座位 ${seat} 占角应合法`);
    // 不盖角 —— 非法
    const other = validateMove(st, seat, '1', 0, 5, 6);
    assert.equal(other.ok, false, `座位 ${seat} 不占角应非法`);
    assert.match(other.reason, /起始角/);
  }
});

test('R2：首子只要盖住角即可，不要求整块都在角上', () => {
  const st = createState(MODE_FFA);
  st.turn = 0;
  // I5 水平放在左上角，(0,0) 是它的一端
  assert.equal(validateMove(st, 0, 'I5', 0, 0, 0).ok, true);
  // 竖直朝下放在左上角
  const v = PIECE_BY_ID.get('I5').orientations.findIndex(
    (o) => o.length === 5 && o.every(([x]) => x === 0),
  );
  assert.ok(v >= 0);
  assert.equal(validateMove(st, 0, 'I5', v, 0, 0).ok, true);
});

/* ------------------------------------------------------------------ */
/* R3 同色：只能角对角，禁止边边相邻                                     */
/* ------------------------------------------------------------------ */

test('R3：同色必须角对角相接（只有一个角碰上才合法）', () => {
  const st = createState(MODE_FFA);
  force(st, 0, '1', 0, 0, 0); // 座位 0 在左上角放一格
  st.turn = 0;
  // (1,1) 与 (0,0) 角对角 —— 合法
  assert.equal(validateMove(st, 0, '1', 0, 1, 1).ok, true);
  // 完全不相邻 —— 非法
  const far = validateMove(st, 0, '1', 0, 5, 5);
  assert.equal(far.ok, false);
  assert.match(far.reason, /角对角/);
});

test('R3：同色边边相邻被禁止 —— 即使同时满足角对角也不行', () => {
  // 局面：座位 0 在 (0,0) 和 (2,1)。(1,0) 与 (2,1) 角对角，但与 (0,0) 边相邻。
  const st = createState(MODE_FFA);
  force(st, 0, '1', 0, 0, 0);
  force(st, 0, '1', 0, 2, 1);
  st.turn = 0;
  const res = validateMove(st, 0, '1', 0, 1, 0);
  assert.equal(res.ok, false);
  assert.match(res.reason, /边边相邻/);
});

test('R3：异色边边相邻完全允许 —— 与上一条同几何，只把颜色换掉', () => {
  // 完全镜像上一条测试的几何：同样是 (1,0)（与 (0,0) 边相邻、与 (2,1) 角相邻），
  // 但这次 (0,0) 是座位 0、(2,1) 是座位 1，落子方为座位 1。
  const st = createState(MODE_FFA);
  force(st, 0, '1', 0, 0, 0); // 异色，边贴边无所谓
  force(st, 1, '1', 0, 2, 1); // 同色，提供角接点
  st.turn = 1;
  const res = validateMove(st, 1, '1', 0, 1, 0);
  assert.equal(res.ok, true, `异色边贴边应放行，实际被拒：${res.reason}`);
});

test('R3：异色棋子可以紧贴成一排（边贴边、任意相邻）', () => {
  const st = createState(MODE_FFA);
  st.turn = 0;
  // 座位 0 的首子占角，沿第 0 行铺满 x = 0..4
  applyMove(st, 0, 'I5', 0, 0, 0);
  // 座位 2 首子占角，并人为制造一个角接点 (3,2)
  force(st, 2, '1', 0, 19, 19);
  force(st, 2, '2', 0, 3, 2); // (3,2) 与 (4,2)
  st.turn = 2;

  // I3 横放在第 1 行 x = 0..2：整排与座位 0 的棋子边贴边，
  // 同时 (2,1) 与座位 2 的 (3,2) 角对角 ⇒ 完全合法。
  const res = validateMove(st, 2, 'I3', 0, 0, 1);
  assert.equal(res.ok, true, `异色边贴边应放行，实际被拒：${res.reason}`);
  applyMove(st, 2, 'I3', 0, 0, 1);

  // 逐格确认两色紧贴：第 0 行是座位 0，第 1 行是座位 2
  for (let x = 0; x < 3; x++) {
    assert.equal(st.board[idx(x, 0)], 0, `(${x},0) 应为座位 0`);
    assert.equal(st.board[idx(x, 1)], 2, `(${x},1) 应为座位 2`);
  }
  assert.equal(allSquares(st)[0], 5);
  assert.equal(allSquares(st)[2], 1 + 2 + 3);
});

test('R3：不能与任何颜色的棋子重叠', () => {
  const st = createState(MODE_FFA);
  force(st, 0, '1', 0, 3, 3);
  force(st, 1, '1', 0, 3, 5);
  st.turn = 1;
  const res = validateMove(st, 1, '1', 0, 3, 3);
  assert.equal(res.ok, false);
  assert.match(res.reason, /重叠/);
});

test('R3：所有枚举出来的合法着法都能通过逐格校验', () => {
  const st = createState(MODE_FFA);
  applyMove(st, 0, 'I5', 0, 0, 0);
  st.turn = 0;
  const moves = legalMoves(st, 0);
  assert.ok(moves.length > 0);
  for (const m of moves) {
    assert.equal(validateMove(st, 0, m.pieceId, m.orient, m.x, m.y).ok, true);
  }
});

/* ------------------------------------------------------------------ */
/* R1 逆时针轮转                                                       */
/* ------------------------------------------------------------------ */

test('R1：出牌顺序按座位 0→1→2→3 循环（屏幕逆时针）', () => {
  const st = createState(MODE_FFA);
  assert.equal(st.turn, 0);
  applyMove(st, 0, '1', 0, 0, 0);
  assert.equal(st.turn, 1);
  applyMove(st, 1, '1', 0, 0, 19);
  assert.equal(st.turn, 2);
  applyMove(st, 2, '1', 0, 19, 19);
  assert.equal(st.turn, 3);
  applyMove(st, 3, '1', 0, 19, 0);
  assert.equal(st.turn, 0);
});

test('落子会消耗棋子并把 passStreak 归零', () => {
  const st = createState(MODE_FFA);
  applyMove(st, 0, 'I5', 0, 0, 0);
  assert.equal(st.remaining[0].includes('I5'), false);
  assert.equal(st.remaining[0].length, 20);
  assert.equal(st.passStreak, 0);
  assert.equal(allSquares(st)[0], 5);
});

/* ------------------------------------------------------------------ */
/* R4 弃权与终局                                                       */
/* ------------------------------------------------------------------ */

test('R4：没有棋子可下的座位被标记为已完成并被跳过', () => {
  const st = createState(MODE_FFA);
  force(st, 0, '1', 0, 0, 0);
  st.remaining[0] = [];
  st.turn = 0;
  settle(st);
  assert.equal(st.finished[0], true);
  assert.equal(st.over, false);
  assert.equal(st.turn, 1);
});

test('R4：无法落子的玩家自动弃权，轮到下一位', () => {
  const st = createState(MODE_FFA);
  force(st, 1, '1', 0, 0, 19); // 座位 1 首子占角，唯一角接点是 (1,18)
  st.board[idx(1, 18)] = 0; // 把这个接点堵死
  st.remaining[1] = ['I5']; // 只留一块，且它无处可接
  st.turn = 1;
  settle(st);
  assert.equal(st.passes.length, 1);
  assert.equal(st.passes[0].seat, 1);
  assert.equal(st.passStreak, 1);
  assert.equal(st.turn, 2, '弃权后应轮到下一位');
  assert.equal(st.over, false);
});

test('R4：所有玩家都无法下棋时本局结束（全员下完）', () => {
  const st = createState(MODE_FFA);
  for (let seat = 0; seat < 4; seat++) {
    const [cx, cy] = SEAT_CORNERS[seat];
    force(st, seat, '1', 0, cx, cy);
    st.remaining[seat] = [];
  }
  st.turn = 0;
  settle(st);
  assert.equal(st.over, true);
  assert.equal(st.endedAt !== null, true);
});

test('R4：剩余玩家连续弃权达到人数时结束', () => {
  const st = createState(MODE_FFA);
  // 只剩座位 0、1 还能下，且两个人都被堵死
  force(st, 0, '1', 0, 0, 0);
  st.board[idx(1, 1)] = 2; // 堵死座位 0 的唯一角接点
  st.remaining[0] = ['I5'];
  force(st, 1, '1', 0, 0, 19);
  st.board[idx(1, 18)] = 2; // 堵死座位 1 的唯一角接点
  st.remaining[1] = ['I5'];
  st.remaining[2] = [];
  st.remaining[3] = [];
  st.turn = 0;
  settle(st);
  assert.equal(st.over, true);
  assert.equal(st.passes.length, 2);
});

test('R4：先下完的玩家退场，剩下的玩家可以继续单独下完', () => {
  const st = createState(MODE_FFA);
  force(st, 0, '1', 0, 0, 0);
  st.remaining[0] = [];
  force(st, 1, '1', 0, 0, 19);
  st.remaining[1] = [];
  force(st, 2, '1', 0, 19, 19);
  st.remaining[2] = [];
  force(st, 3, '1', 0, 19, 0);
  // 座位 3 还剩两块，应当可以继续下
  st.turn = 0;
  settle(st);
  assert.equal(st.over, false);
  assert.equal(st.turn, 3);
  assert.equal(hasAnyMove(st, 3), true);
});

/* ------------------------------------------------------------------ */
/* 序列化往返                                                          */
/* ------------------------------------------------------------------ */

test('棋盘序列化可无损往返', () => {
  const st = createState(MODE_TEAM);
  applyMove(st, 0, 'I5', 0, 0, 0);
  const str = boardToString(st.board);
  assert.equal(str.length, CELLS);
  const back = stringToBoard(str);
  for (let i = 0; i < CELLS; i++) assert.equal(back[i], st.board[i], `第 ${i} 格不一致`);
});

test('serializeState / deserializeState 往返后仍能正确枚举合法着法', () => {
  const st = createState(MODE_FFA);
  applyMove(st, 0, 'I5', 0, 0, 0);
  const raw = JSON.parse(JSON.stringify(serializeState(st)));
  const back = deserializeState(raw);
  const a = legalMoves(st, 0).map((m) => `${m.pieceId}/${m.orient}/${m.x}/${m.y}`).sort();
  const b = legalMoves(back, 0).map((m) => `${m.pieceId}/${m.orient}/${m.x}/${m.y}`).sort();
  assert.deepEqual(b, a);
});

/* ------------------------------------------------------------------ */
/* 整局自对局：终局、一致性、性能                                        */
/* ------------------------------------------------------------------ */

test('AI 完整自对局能正常结束，且棋盘与记录完全一致', () => {
  const rng = mulberry32(20240607);
  const st = createState(MODE_FFA);
  const started = Date.now();
  let guard = 0;
  let aiMoves = 0;

  while (!st.over && guard++ < 400) {
    const seat = st.turn;
    const move = chooseMove(st, seat, { difficulty: 'normal', rng });
    if (move) {
      applyMove(st, seat, move.pieceId, move.orient, move.x, move.y);
      aiMoves++;
    } else {
      break; // settle 已保证这种情况不会发生
    }
  }
  const elapsed = Date.now() - started;

  assert.equal(st.over, true, '自对局应当自然结束');
  assert.ok(aiMoves > 20, `对局着法太少：${aiMoves}`);

  // 每个座位都不能再下
  for (let s = 0; s < 4; s++) {
    assert.equal(hasAnyMove(st, s), false, `座位 ${s} 在终局仍能落子`);
  }

  // 棋盘与 placed 记录一致
  const recomputed = new Int8Array(CELLS).fill(-1);
  let total = 0;
  for (let s = 0; s < 4; s++) {
    for (const p of st.placed[s]) {
      const piece = PIECE_BY_ID.get(p.pieceId);
      for (const [dx, dy] of piece.orientations[p.orient]) {
        const i = idx(p.x + dx, p.y + dy);
        assert.equal(recomputed[i], -1, '不同棋子重叠');
        recomputed[i] = s;
        total++;
      }
    }
  }
  for (let i = 0; i < CELLS; i++) {
    assert.equal(recomputed[i], st.board[i], `第 ${i} 格与记录不一致`);
  }
  const squares = allSquares(st);
  assert.equal(
    squares.reduce((a, b) => a + b, 0),
    total,
  );
  // 每格棋子的颜色必须与座位匹配（用 placed 重建已保证 s 一致）

  // 性能：整局 AI 对局应当在 60 秒内完成
  assert.ok(elapsed < 60000, `自对局耗时过长：${elapsed}ms`);
});

test('AI 首子必定占角', () => {
  for (let seat = 0; seat < 4; seat++) {
    const st = createState(MODE_FFA);
    st.turn = seat;
    const mv = chooseMove(st, seat, { difficulty: 'normal', rng: mulberry32(seat + 1) });
    assert.ok(mv, `座位 ${seat} 应当能落子`);
    const piece = PIECE_BY_ID.get(mv.pieceId);
    const [cx, cy] = SEAT_CORNERS[seat];
    const covers = piece.orientations[mv.orient].some(
      ([dx, dy]) => mv.x + dx === cx && mv.y + dy === cy,
    );
    assert.equal(covers, true, `座位 ${seat} 的首子没有盖住起始角`);
  }
});

test('playAiTurn 走出来的每一步都是合法着法', () => {
  const rng = mulberry32(7);
  const st = createState(MODE_FFA);
  let guard = 0;
  while (!st.over && guard++ < 400) {
    const seat = st.turn;
    if (!hasAnyMove(st, seat)) break;
    const before = st.moveCount;
    const rec = playAiTurn(st, seat, { difficulty: 'easy', rng });
    assert.ok(rec, 'playAiTurn 应当返回落子记录');
    assert.equal(st.moveCount, before + 1);
  }
  assert.equal(st.over, true);
});

test('三种 AI 难度都能正常出招', () => {
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const st = createState(MODE_FFA);
    applyMove(st, 0, 'I5', 0, 0, 0);
    st.turn = 0;
    const mv = chooseMove(st, 0, { difficulty, rng: mulberry32(99) });
    assert.ok(mv, `${difficulty} 应当能出招`);
    assert.equal(validateMove(st, 0, mv.pieceId, mv.orient, mv.x, mv.y).ok, true);
  }
});

test('legalMoves 在终局与无子可下时返回空数组', () => {
  const st = createState(MODE_FFA);
  st.over = true;
  assert.deepEqual(legalMoves(st, 0), []);
  const st2 = createState(MODE_FFA);
  st2.remaining[2] = [];
  assert.deepEqual(legalMoves(st2, 2), []);
});

test('落子后不能重复使用同一块棋子', () => {
  const st = createState(MODE_FFA);
  applyMove(st, 0, '1', 0, 0, 0);
  st.turn = 0;
  const res = validateMove(st, 0, '1', 0, 1, 1);
  assert.equal(res.ok, false);
  assert.match(res.reason, /用过了/);
});

test('非法落子会抛错而不是污染状态', () => {
  const st = createState(MODE_FFA);
  assert.throws(() => applyMove(st, 0, '1', 0, 5, 5), /起始角/);
  assert.equal(st.moveCount, 0);
  assert.equal(allSquares(st).reduce((a, b) => a + b, 0), 0);
});
