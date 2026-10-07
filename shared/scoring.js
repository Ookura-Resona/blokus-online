/**
 * 记分与名次。
 *
 * 四人混战：
 *   1) 按占格数排名，最多者获胜。
 *   2) 占格数相同时，**后手**（座位号更大）排名更高。
 *   3) 名次增减分：+3 / +1 / 0 / -2（基础分 1 时）。
 *   4) 统治力奖励 / 全清奖励额外加分。
 *
 * 二对二：
 *   1) 对角两两一方，占格总数多的一方获胜。
 *   2) 总数相同时，**后手**的一方获胜（座位号更晚出场的那一方）。
 *   3) 胜方每人 +2，败方每人 -1（基础分 1 时）。
 *   4) 表现特别强的胜方玩家获得额外积分奖励。
 */

import {
  SEAT_COUNT,
  TEAM_OF_SEAT,
  MODE_TEAM,
  DEFAULT_SCORING,
  SEAT_LABELS,
} from './constants.js';
import { allSquares } from './rules.js';

/** 每个阵营包含的座位 */
export const TEAMS = (() => {
  const t = [[], []];
  for (let s = 0; s < SEAT_COUNT; s++) t[TEAM_OF_SEAT[s]].push(s);
  return t;
})();

/**
 * 阵营的「先手 / 后手」判定：以阵营中最早出场的座位号比较，
 * 座位号更大的阵营为后手（平局时后手胜出）。
 */
export const LATER_TEAM = (() => {
  const earliest = TEAMS.map((seats) => Math.min(...seats));
  return earliest[0] > earliest[1] ? 0 : 1;
})();

function mergeConfig(config) {
  const c = config ?? {};
  return {
    base: c.base ?? DEFAULT_SCORING.base,
    ffaRankDelta: c.ffaRankDelta ?? DEFAULT_SCORING.ffaRankDelta,
    teamWinDelta: c.teamWinDelta ?? DEFAULT_SCORING.teamWinDelta,
    teamLoseDelta: c.teamLoseDelta ?? DEFAULT_SCORING.teamLoseDelta,
    domination: { ...DEFAULT_SCORING.domination, ...(c.domination ?? {}) },
    fullClear: { ...DEFAULT_SCORING.fullClear, ...(c.fullClear ?? {}) },
  };
}

/**
 * 计算一局的结果。
 * @param {object} state rules.js 的对局状态
 * @param {object} [config] 覆盖 DEFAULT_SCORING 的部分字段
 */
export function computeScore(state, config) {
  const cfg = mergeConfig(config);
  const squares = allSquares(state);
  const remainingCount = state.remaining.map((r) => r.length);
  const bonuses = [];
  const deltas = new Array(SEAT_COUNT).fill(0);

  const addBonus = (seat, kind, points, label) => {
    bonuses.push({ seat, kind, points, label });
    deltas[seat] += points;
  };

  if (state.mode === MODE_TEAM) {
    const teamSquares = TEAMS.map((seats) => seats.reduce((sum, s) => sum + squares[s], 0));
    let winTeam;
    let tie = false;
    if (teamSquares[0] > teamSquares[1]) winTeam = 0;
    else if (teamSquares[1] > teamSquares[0]) winTeam = 1;
    else {
      winTeam = LATER_TEAM;
      tie = true;
    }
    const loseTeam = 1 - winTeam;

    for (const s of TEAMS[winTeam]) deltas[s] += cfg.teamWinDelta;
    for (const s of TEAMS[loseTeam]) deltas[s] += cfg.teamLoseDelta;

    const gap = Math.abs(teamSquares[0] - teamSquares[1]);
    const dom = cfg.domination;
    if (dom.enabled && gap >= dom.teamGap) {
      for (const s of TEAMS[winTeam]) {
        addBonus(s, 'domination', dom.points, `统治力奖励（领先 ${gap} 格 ≥ ${dom.teamGap}）`);
      }
    }
    const fc = cfg.fullClear;
    if (fc.enabled) {
      for (const s of TEAMS[winTeam]) {
        if (remainingCount[s] === 0) addBonus(s, 'fullClear', fc.points, '全清奖励（21 块全部下完）');
      }
    }

    const winnerSeats = TEAMS[winTeam].slice();
    const teams = [0, 1].map((t) => ({
      team: t,
      seats: TEAMS[t].slice(),
      squares: teamSquares[t],
      win: t === winTeam,
    }));

    return {
      mode: state.mode,
      squares,
      remainingCount,
      deltas,
      bonuses,
      base: cfg.base,
      teams,
      winnerSeats,
      ranking: null,
      tie,
      summary: buildTeamSummary(state, squares, teamSquares, winTeam, tie, deltas, bonuses),
    };
  }

  /* ---------------- 四人混战 ---------------- */
  // 排序：占格数降序；相同则座位号大的（后手）排前面
  const order = [0, 1, 2, 3].sort((a, b) => (squares[b] - squares[a]) || (b - a));
  const ranking = order.map((seat, i) => ({
    seat,
    squares: squares[seat],
    remaining: remainingCount[seat],
    rank: i + 1,
  }));

  for (const entry of ranking) deltas[entry.seat] += cfg.ffaRankDelta[entry.rank - 1] ?? 0;

  const first = ranking[0];
  const second = ranking[1];
  const dom = cfg.domination;
  if (dom.enabled && first.squares - second.squares >= dom.ffaGap) {
    addBonus(
      first.seat,
      'domination',
      dom.points,
      `统治力奖励（领先第二名 ${first.squares - second.squares} 格 ≥ ${dom.ffaGap}）`,
    );
  }
  const fc = cfg.fullClear;
  if (fc.enabled && remainingCount[first.seat] === 0) {
    addBonus(first.seat, 'fullClear', fc.points, '全清奖励（21 块全部下完）');
  }

  const tieAtTop = first.squares === second.squares;

  return {
    mode: state.mode,
    squares,
    remainingCount,
    deltas,
    bonuses,
    base: cfg.base,
    teams: null,
    winnerSeats: [first.seat],
    ranking,
    tie: tieAtTop,
    summary: buildFfaSummary(state, ranking, deltas, bonuses, tieAtTop),
  };
}

function bonusText(bonuses, seat) {
  const list = bonuses.filter((b) => b.seat === seat);
  if (list.length === 0) return '';
  return '（' + list.map((b) => `${b.label} +${b.points}`).join('，') + '）';
}

function sign(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

function buildFfaSummary(state, ranking, deltas, bonuses, tieAtTop) {
  const lines = ['【四人混战】'];
  for (const r of ranking) {
    lines.push(
      `第${r.rank}名 ${SEAT_LABELS[r.seat]}：${r.squares} 格，剩 ${r.remaining} 块，` +
        `本局 ${sign(deltas[r.seat])}${bonusText(bonuses, r.seat)}`,
    );
  }
  if (tieAtTop) lines.push('（头名与第二名占格数相同，按规则后手排名更高）');
  return lines.join('\n');
}

function buildTeamSummary(state, squares, teamSquares, winTeam, tie, deltas, bonuses) {
  const lines = ['【二对二】'];
  for (const t of [0, 1]) {
    const seats = TEAMS[t];
    const names = seats.map((s) => SEAT_LABELS[s]).join(' + ');
    lines.push(
      `${t === winTeam ? '胜方' : '败方'} ${names}：合计 ${teamSquares[t]} 格 ` +
        `(${seats.map((s) => squares[s]).join(' + ')})，` +
        seats.map((s) => `${SEAT_LABELS[s]} ${sign(deltas[s])}${bonusText(bonuses, s)}`).join('，'),
    );
  }
  if (tie) lines.push('（两方占格总数相同，按规则后手的一方获胜）');
  return lines.join('\n');
}

/** 把一局的结果累加进会话累计分（返回新对象，不修改入参） */
export function applyToTotals(totals, result) {
  const next = { ...totals };
  for (let s = 0; s < SEAT_COUNT; s++) {
    next[s] = (next[s] ?? 0) + result.deltas[s];
  }
  return next;
}
