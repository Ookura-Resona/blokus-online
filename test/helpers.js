/** 测试公共工具 */

import { BOARD_SIZE, CELLS } from '../shared/constants.js';
import { PIECE_BY_ID } from '../shared/pieces.js';
import { createState } from '../shared/rules.js';

/**
 * 直接往棋盘上放一枚棋子，**完全绕过回合与合法性校验**。
 * 只用于精确搭建测试局面（例如「同色边接触」这种需要在特定几何下才能触发的规则）。
 *
 * 注意：默认**不会**把棋子从 remaining 里扣掉 —— 这样搭好局面后仍然可以用同一个
 * pieceId 去调 validateMove 验证规则。需要同步剩余棋子时显式传 { consume: true }，
 * 或者在测试里直接给 st.remaining[seat] 赋值。
 */
export function force(st, seat, pieceId, orient, x, y, opts = {}) {
  const piece = PIECE_BY_ID.get(pieceId);
  const cells = [];
  for (const [dx, dy] of piece.orientations[orient]) {
    const i = (y + dy) * BOARD_SIZE + (x + dx);
    if (i < 0 || i >= CELLS) throw new Error('force(): 越界');
    st.board[i] = seat;
    cells.push(i);
  }
  if (opts.consume) {
    st.remaining[seat] = st.remaining[seat].filter((id) => id !== pieceId);
  }
  st.placed[seat].push({ pieceId, orient, x, y, size: piece.size, cells, moveIndex: 0, at: 0 });
  st.turn = seat;
  return st;
}

/** 用最粗暴的方式给某个座位铺 n 格（仅用于计分测试，不保证几何合法） */
export function setSquares(st, seat, n) {
  let placed = 0;
  for (let i = 0; i < CELLS && placed < n; i++) {
    if (st.board[i] === -1) {
      st.board[i] = seat;
      placed++;
    }
  }
  return st;
}

/** 覆盖某个座位的剩余棋子数量（仅用于计分测试） */
export function setRemainingCount(st, seat, n) {
  const all = st.remaining[seat];
  st.remaining[seat] = all.slice(0, n);
  return st;
}

export function newState(mode = 'ffa') {
  return createState(mode);
}

export { BOARD_SIZE, CELLS };
