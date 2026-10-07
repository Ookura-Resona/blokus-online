/**
 * 角斗士棋（Blokus）规则引擎 —— 服务端权威，也供浏览器本地预演合法着法。
 *
 * 规则实现要点（严格对应题目第 2、3、4 条）：
 *  R1 四位玩家按**逆时针**顺序轮流下棋（座位 0→1→2→3 见 constants.js）。
 *  R2 每位玩家的**第一枚**棋子必须覆盖自己那一角的起始点。
 *  R3 之后每一步新棋子，至少有一个角与**同色**已有棋子角对角相接；
 *     并且新棋子的任何一格都不能与**同色**棋子边边相邻。
 *     与**其他颜色**的棋子没有任何接触限制（可以边贴边）。
 *  R4 无法合法落子即当轮弃权；当所有还能下棋的玩家都连续弃权时，本局结束。
 */

import {
  BOARD_SIZE,
  CELLS,
  SEAT_COUNT,
  SEAT_CORNERS,
  EDGE_OFFSETS,
  DIAG_OFFSETS,
  MODE_FFA,
} from './constants.js';
import { PIECE_BY_ID, freshPieceIds } from './pieces.js';

/** 创建一局全新的对局状态 */
export function createState(mode = MODE_FFA, options = {}) {
  return {
    mode,
    board: new Int8Array(CELLS).fill(-1),
    remaining: Array.from({ length: SEAT_COUNT }, () => freshPieceIds()),
    placed: Array.from({ length: SEAT_COUNT }, () => []),
    finished: new Array(SEAT_COUNT).fill(false),
    turn: 0,
    passStreak: 0,
    passes: [],
    log: [],
    over: false,
    moveCount: 0,
    lastMove: null,
    startedAt: options.startedAt ?? Date.now(),
    endedAt: null,
  };
}

/** 该座位是否已经下过第一枚棋子（首子已占角） */
export function hasPlayed(state, seat) {
  return state.placed[seat].length > 0;
}

/** 座位当前占格数 */
export function squaresOf(state, seat) {
  let n = 0;
  for (let i = 0; i < CELLS; i++) if (state.board[i] === seat) n++;
  return n;
}

/** 全部座位的占格数 */
export function allSquares(state) {
  const out = new Array(SEAT_COUNT).fill(0);
  for (let i = 0; i < CELLS; i++) {
    const v = state.board[i];
    if (v >= 0) out[v]++;
  }
  return out;
}

/**
 * 为一个座位构建两张掩码表（每次轮到某座位时算一次，之后所有候选着法复用）：
 *   blocked[i] —— 该格与同色棋子边相邻 ⇒ 任何棋子都不能落在这里
 *   anchor[i]  —— 该格为空且与同色棋子角相邻 ⇒ 新棋子的「接点」
 */
function buildMasks(board, seat) {
  const blocked = new Uint8Array(CELLS);
  const anchor = new Uint8Array(CELLS);
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (board[y * BOARD_SIZE + x] !== seat) continue;
      for (const [dx, dy] of EDGE_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
        blocked[ny * BOARD_SIZE + nx] = 1;
      }
      for (const [dx, dy] of DIAG_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
        const j = ny * BOARD_SIZE + nx;
        if (board[j] === -1) anchor[j] = 1;
      }
    }
  }
  return { blocked, anchor };
}

/** 座位对应的起始角扁平索引 */
function cornerIndex(seat) {
  const [cx, cy] = SEAT_CORNERS[seat];
  return cy * BOARD_SIZE + cx;
}

/**
 * 用给定掩码判断一次落子是否合法（不做边界外的额外分配，热路径）。
 * @returns {boolean}
 */
function isValidWithMasks(state, seat, piece, orientIndex, ox, oy, masks, cornerIdx) {
  const board = state.board;
  const cells = piece.orientations[orientIndex];
  const isFirst = state.placed[seat].length === 0;
  let touchesAnchor = false;
  let coversCorner = false;

  for (let k = 0; k < cells.length; k++) {
    const x = ox + cells[k][0];
    const y = oy + cells[k][1];
    if (x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) return false;
    const i = y * BOARD_SIZE + x;
    if (board[i] !== -1) return false;
    if (masks.blocked[i]) return false;
    if (isFirst) {
      if (i === cornerIdx) coversCorner = true;
    } else if (masks.anchor[i]) {
      touchesAnchor = true;
    }
  }

  // R2：首子必须覆盖起始角；R3：后续必须角对角接上同色棋子
  return isFirst ? coversCorner : touchesAnchor;
}

/**
 * 枚举某个座位的全部合法着法。
 * @param {object} state
 * @param {number} seat
 * @param {{limit?: number}} [opts] limit 用于「只想知道有没有得下」的快路径
 * @returns {Array<{pieceId:string, orient:number, x:number, y:number, size:number}>}
 */
export function legalMoves(state, seat, opts = {}) {
  const limit = opts.limit ?? Infinity;
  const out = [];
  if (state.over) return out;
  if (state.remaining[seat].length === 0) return out;

  const masks = buildMasks(state.board, seat);
  const cornerIdx = cornerIndex(seat);
  const isFirst = state.placed[seat].length === 0;

  for (const pieceId of state.remaining[seat]) {
    const piece = PIECE_BY_ID.get(pieceId);
    for (let oi = 0; oi < piece.orientations.length; oi++) {
      const w = piece.widths[oi];
      const h = piece.heights[oi];
      // 首子必须盖住角：可以直接把搜索范围收进对应象限
      let minX = 0;
      let maxX = BOARD_SIZE - w;
      let minY = 0;
      let maxY = BOARD_SIZE - h;
      if (isFirst) {
        const [cx, cy] = SEAT_CORNERS[seat];
        minX = Math.max(minX, cx - (w - 1));
        maxX = Math.min(maxX, cx);
        minY = Math.max(minY, cy - (h - 1));
        maxY = Math.min(maxY, cy);
      }
      if (minX > maxX || minY > maxY) continue;

      for (let oy = minY; oy <= maxY; oy++) {
        for (let ox = minX; ox <= maxX; ox++) {
          if (!isValidWithMasks(state, seat, piece, oi, ox, oy, masks, cornerIdx)) continue;
          out.push({ pieceId, orient: oi, x: ox, y: oy, size: piece.size });
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

/** 该座位是否还有任何合法着法（短路，比 legalMoves().length 快得多） */
export function hasAnyMove(state, seat) {
  return legalMoves(state, seat, { limit: 1 }).length > 0;
}

/** 单次落子合法性校验（对外接口，含全部错误信息） */
export function validateMove(state, seat, pieceId, orientIndex, ox, oy) {
  if (state.over) return { ok: false, reason: '本局已结束' };
  if (state.turn !== seat) return { ok: false, reason: '还没轮到你' };
  if (state.finished[seat]) return { ok: false, reason: '你已经没有棋子了' };
  const piece = PIECE_BY_ID.get(pieceId);
  if (!piece) return { ok: false, reason: `未知棋子 ${pieceId}` };
  if (!state.remaining[seat].includes(pieceId)) return { ok: false, reason: '这块棋子你已经用过了' };
  if (!Number.isInteger(orientIndex) || orientIndex < 0 || orientIndex >= piece.orientations.length) {
    return { ok: false, reason: '朝向不合法' };
  }
  if (!Number.isInteger(ox) || !Number.isInteger(oy)) return { ok: false, reason: '坐标不合法' };

  const masks = buildMasks(state.board, seat);
  const cornerIdx = cornerIndex(seat);
  const isFirst = state.placed[seat].length === 0;

  // 逐格给出精确原因，方便前端提示玩家
  let touchesAnchor = false;
  let coversCorner = false;
  for (const [dx, dy] of piece.orientations[orientIndex]) {
    const x = ox + dx;
    const y = oy + dy;
    if (x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) return { ok: false, reason: '超出棋盘' };
    const i = y * BOARD_SIZE + x;
    const occupant = state.board[i];
    if (occupant !== -1) {
      return { ok: false, reason: occupant === seat ? '和你的棋子重叠了' : '和别人的棋子重叠了' };
    }
    if (masks.blocked[i]) return { ok: false, reason: '同色棋子不能边边相邻' };
    if (isFirst) {
      if (i === cornerIdx) coversCorner = true;
    } else if (masks.anchor[i]) {
      touchesAnchor = true;
    }
  }
  if (isFirst && !coversCorner) return { ok: false, reason: '第一枚棋子必须盖住你的起始角' };
  if (!isFirst && !touchesAnchor) return { ok: false, reason: '必须与同色棋子角对角相接' };

  return { ok: true, piece };
}

/** 落子（调用前必须先 validateMove 或 applyMove 内部校验） */
export function applyMove(state, seat, pieceId, orientIndex, ox, oy) {
  const check = validateMove(state, seat, pieceId, orientIndex, ox, oy);
  if (!check.ok) throw new Error(check.reason);

  const piece = check.piece;
  const cells = [];
  for (const [dx, dy] of piece.orientations[orientIndex]) {
    const i = (oy + dy) * BOARD_SIZE + (ox + dx);
    state.board[i] = seat;
    cells.push(i);
  }

  const idx = state.remaining[seat].indexOf(pieceId);
  state.remaining[seat].splice(idx, 1);

  const record = {
    pieceId,
    orient: orientIndex,
    x: ox,
    y: oy,
    size: piece.size,
    cells,
    moveIndex: state.moveCount,
    at: Date.now(),
  };
  state.placed[seat].push(record);
  state.lastMove = { seat, ...record };
  state.log.push({ type: 'move', seat, pieceId, size: piece.size, at: record.at });
  state.moveCount++;
  state.passStreak = 0;
  state.turn = (seat + 1) % SEAT_COUNT;

  settle(state);
  return record;
}

/** 手动弃权（仅当确实无法落子时允许，由调用方保证） */
export function passSeat(state, seat) {
  state.passes.push({ seat, moveIndex: state.moveCount, at: Date.now() });
  state.log.push({ type: 'pass', seat, at: Date.now() });
  state.passStreak++;
  state.turn = (seat + 1) % SEAT_COUNT;
}

/** 还能继续下棋（还有棋子）的座位 */
function activeSeats(state) {
  const active = [];
  for (let s = 0; s < SEAT_COUNT; s++) {
    if (state.remaining[s].length === 0) state.finished[s] = true;
    else if (!state.finished[s]) active.push(s);
  }
  return active;
}

/** 把状态推进到一个「等待某座位落子」的稳定点；必要时自动弃权并判定终局。 */
export function settle(state) {
  if (state.over) return;

  let guard = 0;
  for (;;) {
    if (guard++ > 64) {
      state.over = true;
      break;
    }

    const active = activeSeats(state);
    if (active.length === 0) {
      state.over = true;
      break;
    }
    // R4：所有还能下棋的人都连续弃权 ⇒ 本局结束
    if (state.passStreak >= active.length) {
      state.over = true;
      break;
    }

    let seat = null;
    for (let k = 0; k < SEAT_COUNT; k++) {
      const s = (state.turn + k) % SEAT_COUNT;
      if (active.includes(s)) {
        seat = s;
        break;
      }
    }
    state.turn = seat;

    if (hasAnyMove(state, seat)) break;

    // 该玩家无处可下 ⇒ 自动弃权，轮到下一位
    passSeat(state, seat);
  }

  if (state.over && !state.endedAt) {
    state.endedAt = Date.now();
    state.log.push({ type: 'end', at: state.endedAt });
  }
}

/* ------------------------------------------------------------------ */
/* 序列化：board 用长度 400 的字符串表示（'.' = 空，'0'..'3' = 座位号） */
/* ------------------------------------------------------------------ */

export function boardToString(board) {
  const chars = new Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    const v = board[i];
    chars[i] = v < 0 ? '.' : String(v);
  }
  return chars.join('');
}

export function stringToBoard(str) {
  const board = new Int8Array(CELLS).fill(-1);
  for (let i = 0; i < CELLS; i++) {
    const c = str.charCodeAt(i);
    board[i] = c === 46 /* '.' */ ? -1 : c - 48;
  }
  return board;
}

/** 生成可经 JSON 传输的紧凑快照 */
export function serializeState(state) {
  return {
    mode: state.mode,
    board: boardToString(state.board),
    turn: state.turn,
    remaining: state.remaining.map((a) => a.slice()),
    placed: state.placed.map((list) =>
      list.map((p) => ({ pieceId: p.pieceId, orient: p.orient, x: p.x, y: p.y, size: p.size })),
    ),
    finished: state.finished.slice(),
    passStreak: state.passStreak,
    passes: state.passes.slice(-24),
    log: state.log.slice(-40),
    over: state.over,
    moveCount: state.moveCount,
    lastMove: state.lastMove
      ? {
          seat: state.lastMove.seat,
          pieceId: state.lastMove.pieceId,
          orient: state.lastMove.orient,
          x: state.lastMove.x,
          y: state.lastMove.y,
          size: state.lastMove.size,
          moveIndex: state.lastMove.moveIndex,
        }
      : null,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
  };
}

/** 客户端把快照还原成可调用 legalMoves 的状态对象 */
export function deserializeState(raw) {
  return {
    mode: raw.mode,
    board: stringToBoard(raw.board),
    remaining: raw.remaining.map((a) => a.slice()),
    placed: raw.placed.map((list) => list.map((p) => ({ ...p }))),
    finished: raw.finished.slice(),
    turn: raw.turn,
    passStreak: raw.passStreak,
    passes: (raw.passes ?? []).slice(),
    log: (raw.log ?? []).slice(),
    over: raw.over,
    moveCount: raw.moveCount,
    lastMove: raw.lastMove ?? null,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
  };
}
