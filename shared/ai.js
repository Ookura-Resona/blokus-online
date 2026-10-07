/**
 * AI 补位 / 练习对手。
 *
 * 思路：先用规则引擎枚举全部合法着法，再用一个「静态启发式」给每个候选打分，
 * 高难度再对前若干候选做一层前瞻（落子后自己还剩多少合法着法）。
 *
 * 启发式注意一个容易搞错的地方：**边相邻封锁只对自己颜色生效**。
 * 所以对手的落子空间只会被我们「占掉的格子」影响，不会被「边贴边」影响。
 * 这里只把「我们占用了对手的角接点」计入收益，不去算不存在的封锁。
 */

import { CELLS, BOARD_SIZE, EDGE_OFFSETS, DIAG_OFFSETS, DIFFICULTY_HARD, DIFFICULTY_EASY } from './constants.js';
import { PIECE_BY_ID } from './pieces.js';
import { legalMoves, settle } from './rules.js';

/** 确定性伪随机数（便于测试复现） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 与同色棋子边相邻（不可落子）的格子掩码 */
function blockedMask(board, seat) {
  const mask = new Uint8Array(CELLS);
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (board[y * BOARD_SIZE + x] !== seat) continue;
      for (const [dx, dy] of EDGE_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
        mask[ny * BOARD_SIZE + nx] = 1;
      }
    }
  }
  return mask;
}

/** 与同色棋子角相邻的空格（自己的接点）掩码 */
function anchorMask(board, seat) {
  const mask = new Uint8Array(CELLS);
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (board[y * BOARD_SIZE + x] !== seat) continue;
      for (const [dx, dy] of DIAG_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
        const j = ny * BOARD_SIZE + nx;
        if (board[j] === -1) mask[j] = 1;
      }
    }
  }
  return mask;
}

/** 与「任意对手颜色」角相邻的空格掩码（我们占掉它就等于压缩对手空间） */
function opponentAnchorMask(board, seat) {
  const mask = new Uint8Array(CELLS);
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      const v = board[y * BOARD_SIZE + x];
      if (v < 0 || v === seat) continue;
      for (const [dx, dy] of DIAG_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
        const j = ny * BOARD_SIZE + nx;
        if (board[j] === -1) mask[j] = 1;
      }
    }
  }
  return mask;
}

/** 静态启发式打分所需的公共上下文（每回合只算一次） */
function buildContext(state, seat) {
  const board = state.board;
  return {
    blocked: blockedMask(board, seat),
    anchor: anchorMask(board, seat),
    oppAnchor: opponentAnchorMask(board, seat),
  };
}

/**
 * 评估一次落子（不做实际修改）。
 * @returns {{score:number, detail:object}}
 */
function evaluate(state, seat, move, ctx) {
  const board = state.board;
  const piece = PIECE_BY_ID.get(move.pieceId);
  const cells = piece.orientations[move.orient];
  const ox = move.x;
  const oy = move.y;

  // 落子后占据的格子集合（用 Set 做 O(1) 邻接判定）
  const occupied = new Set();
  const indices = [];
  for (const [dx, dy] of cells) {
    const i = (oy + dy) * BOARD_SIZE + (ox + dx);
    occupied.add(i);
    indices.push(i);
  }

  let newAnchors = 0; // 落子后新产生的、属于我们自己的角接点
  let anchorsKilled = 0; // 被这步棋废掉的、原有的自己的角接点
  let oppTaken = 0; // 被我们占掉的对手角接点
  let blockedSelf = 0; // 这步棋自己给自己新增加的封锁格（越少越灵活）

  for (const i of indices) {
    const x = i % BOARD_SIZE;
    const y = (i - x) / BOARD_SIZE;

    for (const [dx, dy] of EDGE_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
      const j = ny * BOARD_SIZE + nx;
      if (occupied.has(j)) continue;
      if (ctx.anchor[j]) anchorsKilled++;
      if (board[j] === -1 && !ctx.blocked[j]) blockedSelf++;
    }

    for (const [dx, dy] of DIAG_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
      const j = ny * BOARD_SIZE + nx;
      if (board[j] !== -1) continue;
      if (occupied.has(j)) continue;
      // 该空格必须与我们落子后没有任何边相邻，才算是可用的角接点
      const jx = j % BOARD_SIZE;
      const jy = (j - jx) / BOARD_SIZE;
      let edgeTouching = false;
      for (const [ex, ey] of EDGE_OFFSETS) {
        const kx = jx + ex;
        const ky = jy + ey;
        if (kx < 0 || ky < 0 || kx >= BOARD_SIZE || ky >= BOARD_SIZE) continue;
        if (occupied.has(ky * BOARD_SIZE + kx)) {
          edgeTouching = true;
          break;
        }
      }
      if (!edgeTouching) newAnchors++;
    }

    if (ctx.oppAnchor[i]) oppTaken++;
  }

  const score =
    12 * piece.size +
    4 * newAnchors -
    3 * anchorsKilled +
    2 * oppTaken +
    0.5 * blockedSelf;

  return { score, detail: { size: piece.size, newAnchors, anchorsKilled, oppTaken, blockedSelf } };
}

/** 复制一份可安全试算的状态（不触发 settle / 日志） */
function cloneState(state) {
  return {
    ...state,
    board: state.board.slice(),
    remaining: state.remaining.map((a) => a.slice()),
    placed: state.placed.map((a) => a.slice()),
    finished: state.finished.slice(),
  };
}

/** 在副本上静默落子，用于前瞻 */
function placeRaw(clone, seat, move) {
  const piece = PIECE_BY_ID.get(move.pieceId);
  const record = {
    pieceId: move.pieceId,
    orient: move.orient,
    x: move.x,
    y: move.y,
    size: piece.size,
    cells: [],
    moveIndex: clone.moveCount,
    at: 0,
  };
  for (const [dx, dy] of piece.orientations[move.orient]) {
    const i = (move.y + dy) * BOARD_SIZE + (move.x + dx);
    clone.board[i] = seat;
    record.cells.push(i);
  }
  clone.remaining[seat] = clone.remaining[seat].filter((id) => id !== move.pieceId);
  clone.placed[seat] = clone.placed[seat].concat([record]);
  return clone;
}

/**
 * 为某个座位选择一步棋。
 * @param {object} state
 * @param {number} seat
 * @param {{difficulty?:string, rng?:()=>number, lookahead?:number, timeBudgetMs?:number}} [opts]
 * @returns {{pieceId:string, orient:number, x:number, y:number, size:number}|null}
 */
export function chooseMove(state, seat, opts = {}) {
  const difficulty = opts.difficulty ?? 'normal';
  const rng = opts.rng ?? mulberry32((Date.now() ^ (seat * 2654435761)) >>> 0);
  const start = Date.now();
  const timeBudgetMs = opts.timeBudgetMs ?? 2500;

  const moves = legalMoves(state, seat);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  const ctx = buildContext(state, seat);
  const scored = moves.map((m) => ({ move: m, ...evaluate(state, seat, m, ctx) }));

  // 无噪声时先按分数降序，便于截断前瞻范围
  scored.sort((a, b) => b.score - a.score);

  const wantsLookahead = difficulty === DIFFICULTY_HARD;
  const isEasy = difficulty === DIFFICULTY_EASY;

  // 静态分加噪：低难度噪声大，让 AI 不那么「完美」
  const noiseScale = isEasy ? 14 : difficulty === DIFFICULTY_HARD ? 0.5 : 3;
  for (const s of scored) s.score += (rng() - 0.5) * noiseScale;

  if (wantsLookahead) {
    const lookahead = Math.min(opts.lookahead ?? 36, scored.length);
    for (let i = 0; i < lookahead; i++) {
      if (Date.now() - start > timeBudgetMs) break;
      const candidate = scored[i];
      const clone = placeRaw(cloneState(state), seat, candidate.move);
      // 自己下完这步之后还剩多少合法着法 —— 机动性越高越好
      const mobility = legalMoves(clone, seat, { limit: 220 }).length;
      candidate.score += 0.8 * mobility;
      candidate.detail.mobility = mobility;
    }
  }

  scored.sort((a, b) => b.score - a.score);

  if (isEasy) {
    // 从前 40% 里随机挑一个，避免总是走同一步
    const poolSize = Math.max(1, Math.ceil(scored.length * 0.4));
    const pick = scored[Math.floor(rng() * poolSize)];
    return pick.move;
  }

  return scored[0].move;
}

/** 便捷入口：AI 直接在给定状态上落子（含 settle） */
export function playAiTurn(state, seat, opts) {
  const move = chooseMove(state, seat, opts);
  if (!move) return null;
  const piece = PIECE_BY_ID.get(move.pieceId);
  const record = {
    pieceId: move.pieceId,
    orient: move.orient,
    x: move.x,
    y: move.y,
    size: piece.size,
    cells: [],
    moveIndex: state.moveCount,
    at: Date.now(),
  };
  for (const [dx, dy] of piece.orientations[move.orient]) {
    const i = (move.y + dy) * BOARD_SIZE + (move.x + dx);
    state.board[i] = seat;
    record.cells.push(i);
  }
  state.remaining[seat] = state.remaining[seat].filter((id) => id !== move.pieceId);
  state.placed[seat].push(record);
  state.lastMove = { seat, ...record };
  state.log.push({ type: 'move', seat, pieceId: move.pieceId, size: piece.size, at: record.at, ai: true });
  state.moveCount++;
  state.passStreak = 0;
  state.turn = (seat + 1) % 4;
  settle(state);
  return record;
}
