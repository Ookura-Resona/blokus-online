import test from 'node:test';
import assert from 'node:assert/strict';

import { MODE_FFA, MODE_TEAM, DEFAULT_SCORING } from '../shared/constants.js';
import { createState } from '../shared/rules.js';
import { computeScore, TEAMS, LATER_TEAM, applyToTotals } from '../shared/scoring.js';
import { setSquares, setRemainingCount } from './helpers.js';

/** 搭一个指定占格数的局面 */
function build(mode, squares, remaining) {
  const st = createState(mode);
  squares.forEach((n, seat) => setSquares(st, seat, n));
  if (remaining) remaining.forEach((n, seat) => setRemainingCount(st, seat, n));
  return st;
}

/* ------------------------------ 四人混战 ------------------------------ */

test('混战：按占格数排名并给出 +3 / +1 / 0 / -2', () => {
  const st = build(MODE_FFA, [30, 20, 10, 5]);
  // 关闭奖励项，单独验证名次增减分
  const r = computeScore(st, { domination: { enabled: false }, fullClear: { enabled: false } });
  assert.deepEqual(r.ranking.map((x) => x.seat), [0, 1, 2, 3]);
  assert.deepEqual(r.ranking.map((x) => x.rank), [1, 2, 3, 4]);
  assert.deepEqual(r.deltas, [3, 1, 0, -2]);
  assert.equal(r.bonuses.length, 0);
  assert.deepEqual(r.winnerSeats, [0]);
});

const NO_BONUS = { domination: { enabled: false }, fullClear: { enabled: false } };

test('混战：占格数相同时后手（座位号更大）排名更高', () => {
  const st = build(MODE_FFA, [10, 10, 10, 10]);
  const r = computeScore(st, NO_BONUS);
  assert.deepEqual(r.ranking.map((x) => x.seat), [3, 2, 1, 0]);
  assert.deepEqual(r.deltas, [-2, 0, 1, 3]);
  assert.equal(r.tie, true);
});

test('混战：部分并列时同样按后手优先', () => {
  // 座位 1 与座位 2 都是 20 格 —— 座位 2 排前面
  const st = build(MODE_FFA, [25, 20, 20, 5]);
  const r = computeScore(st, NO_BONUS);
  assert.deepEqual(r.ranking.map((x) => x.seat), [0, 2, 1, 3]);
  assert.deepEqual(r.deltas, [3, 0, 1, -2]);
});

test('混战：头名大幅领先触发统治力奖励 +1', () => {
  const st = build(MODE_FFA, [40, 15, 10, 5]); // 领先 25 格
  const r = computeScore(st);
  assert.equal(r.deltas[0], 4); // 3 + 1
  assert.equal(r.bonuses.length, 1);
  assert.equal(r.bonuses[0].kind, 'domination');
  assert.equal(r.bonuses[0].seat, 0);
});

test('混战：领先不足阈值不触发统治力奖励', () => {
  const st = build(MODE_FFA, [25, 20, 10, 5]); // 领先 5 格 < 10
  const r = computeScore(st);
  assert.equal(r.deltas[0], 3);
  assert.equal(r.bonuses.length, 0);
});

test('混战：刚好等于阈值即触发（含等于）', () => {
  const st = build(MODE_FFA, [30, 20, 10, 5]); // 领先正好 10 格
  const r = computeScore(st, { domination: { ffaGap: 10, enabled: true } });
  assert.equal(r.bonuses.filter((b) => b.kind === 'domination').length, 1);
  assert.equal(r.deltas[0], 4);
});

test('混战：头名把 21 块下完触发全清奖励 +1', () => {
  const st = build(MODE_FFA, [30, 20, 10, 5], [0, 3, 8, 12]);
  // 关掉统治力奖励，单独验证全清
  const r = computeScore(st, { domination: { enabled: false } });
  assert.equal(r.bonuses.filter((b) => b.kind === 'fullClear').length, 1);
  assert.equal(r.deltas[0], 4);
});

test('混战：只有头名的全清才算，别人的全清不加分', () => {
  const st = build(MODE_FFA, [25, 30, 10, 5], [5, 0, 8, 12]);
  const r = computeScore(st);
  // 头名是座位 1：3 分，无全清（它剩 0 块 → 触发！）
  assert.equal(r.ranking[0].seat, 1);
  const fc = r.bonuses.filter((b) => b.kind === 'fullClear');
  assert.equal(fc.length, 1);
  assert.equal(fc[0].seat, 1);
});

test('混战：统治力与全清可以叠加', () => {
  const st = build(MODE_FFA, [45, 15, 10, 5], [0, 3, 8, 12]);
  const r = computeScore(st);
  assert.equal(r.deltas[0], 5); // 3 + 1 + 1
  assert.equal(r.bonuses.length, 2);
});

test('混战：奖励可关闭', () => {
  const st = build(MODE_FFA, [45, 15, 10, 5], [0, 3, 8, 12]);
  const r = computeScore(st, {
    domination: { enabled: false },
    fullClear: { enabled: false },
  });
  assert.equal(r.deltas[0], 3);
  assert.equal(r.bonuses.length, 0);
});

test('混战：阈值与奖励分值可配置', () => {
  const st = build(MODE_FFA, [30, 20, 10, 5]);
  const r = computeScore(st, { domination: { ffaGap: 5, points: 3 } });
  assert.equal(r.deltas[0], 6); // 3 + 3
});

/* ------------------------------ 二对二 ------------------------------ */

test('二对二：对角配对，阵营划分正确', () => {
  assert.deepEqual(TEAMS, [[0, 2], [1, 3]]);
  assert.equal(LATER_TEAM, 1, '阵营 1（座位 1、3）是后手');
});

test('二对二：占格总数多的一方获胜，胜方每人 +2、败方每人 -1', () => {
  // 阵营 0 = 座位 0(20) + 2(15) = 35；阵营 1 = 座位 1(10) + 3(5) = 15
  const st = build(MODE_TEAM, [20, 10, 15, 5]);
  const r = computeScore(st);
  assert.equal(r.teams[0].squares, 35);
  assert.equal(r.teams[1].squares, 15);
  assert.equal(r.teams[0].win, true);
  // 领先 20 格 → 触发统治力奖励，胜方每人再 +1
  assert.deepEqual(r.deltas, [3, -1, 3, -1]);
  assert.deepEqual(r.winnerSeats, [0, 2]);
});

test('二对二：领先不足阈值时只有基础增减分', () => {
  const st = build(MODE_TEAM, [20, 15, 15, 10]); // 35 : 25，差 10
  const r = computeScore(st);
  assert.deepEqual(r.deltas, [2, -1, 2, -1]);
  assert.equal(r.bonuses.length, 0);
});

test('二对二：总数相同时后手一方获胜', () => {
  const st = build(MODE_TEAM, [10, 10, 10, 10]); // 20 : 20
  const r = computeScore(st);
  assert.equal(r.tie, true);
  assert.equal(r.teams[1].win, true, '平局时阵营 1（后手）应获胜');
  assert.deepEqual(r.deltas, [-1, 2, -1, 2]);
});

test('二对二：总数相同但一边强一边弱时仍按后手判定', () => {
  // 阵营 0 = 30 + 0，阵营 1 = 5 + 25，总数都是 30
  const st = build(MODE_TEAM, [30, 5, 0, 25]);
  const r = computeScore(st);
  assert.equal(r.tie, true);
  assert.deepEqual(r.deltas, [-1, 2, -1, 2]);
});

test('二对二：胜方把 21 块下完触发全清奖励', () => {
  const st = build(MODE_TEAM, [30, 10, 20, 5], [0, 21, 0, 21]);
  const r = computeScore(st);
  // 阵营 0 胜（50 : 15），座位 0 与座位 2 都全清 → 各 +1
  const fc = r.bonuses.filter((b) => b.kind === 'fullClear').map((b) => b.seat).sort();
  assert.deepEqual(fc, [0, 2]);
  // 50-15=35 ≥ 20 也触发统治力
  assert.deepEqual(r.deltas, [4, -1, 4, -1]);
});

test('二对二：败方即使全清也没有奖励', () => {
  const st = build(MODE_TEAM, [40, 24, 10, 0], [0, 0, 5, 5]);
  const r = computeScore(st);
  // 阵营 0 = 50，阵营 1 = 24 → 阵营 0 胜
  assert.equal(r.teams[0].win, true);
  assert.equal(r.bonuses.some((b) => [1, 3].includes(b.seat)), false);
  assert.equal(r.deltas[3], -1);
});

test('二对二：全清奖励按人头算，同队两人可能差 1 分', () => {
  // 座位 0 把 21 块下完（剩 0），队友座位 2 还剩几块 → 只有座位 0 拿全清奖励。
  // 这条是补的回归：曾经我以为「同队两人分数必然相等」，结果测试偶发失败。
  const st = build(MODE_TEAM, [40, 10, 20, 5], [0, 21, 4, 21]);
  const r = computeScore(st);
  assert.equal(r.teams[0].win, true, '阵营 0 应当获胜');

  const fc = r.bonuses.filter((b) => b.kind === 'fullClear').map((b) => b.seat);
  assert.deepEqual(fc, [0], '只有把 21 块下完的那个队友拿全清奖励');

  // 基础分部分（胜方每人 +2）依然一致，差的那 1 分完全来自全清奖励
  const bonusOf = (seat) =>
    r.bonuses.filter((b) => b.seat === seat).reduce((a, b) => a + b.points, 0);
  assert.equal(r.deltas[0] - bonusOf(0), r.deltas[2] - bonusOf(2), '同队基础增减分必须一致');
  assert.equal(r.deltas[0] - r.deltas[2], 1, '座位 0 比队友多 1 分');
});

/* ------------------------------ 其它 ------------------------------ */

test('战报文本包含关键信息', () => {
  const ffa = computeScore(build(MODE_FFA, [30, 20, 10, 5]), NO_BONUS);
  assert.match(ffa.summary, /四人混战/);
  assert.match(ffa.summary, /第1名/);
  assert.match(ffa.summary, /\+3/);

  const team = computeScore(build(MODE_TEAM, [20, 10, 15, 5]), NO_BONUS);
  assert.match(team.summary, /二对二/);
  assert.match(team.summary, /胜方/);
});

test('applyToTotals 正确累加会话积分', () => {
  const st = build(MODE_FFA, [30, 20, 10, 5]);
  const r = computeScore(st, NO_BONUS);
  const t1 = applyToTotals({ 0: 0, 1: 0, 2: 0, 3: 0 }, r);
  assert.deepEqual(t1, { 0: 3, 1: 1, 2: 0, 3: -2 });
  const t2 = applyToTotals(t1, r);
  assert.deepEqual(t2, { 0: 6, 1: 2, 2: 0, 3: -4 });
});

test('默认规则与题目一致', () => {
  assert.deepEqual(DEFAULT_SCORING.ffaRankDelta, [3, 1, 0, -2]);
  assert.equal(DEFAULT_SCORING.teamWinDelta, 2);
  assert.equal(DEFAULT_SCORING.teamLoseDelta, -1);
  assert.equal(DEFAULT_SCORING.base, 1);
  // 混战阈值按实测数据下调到 10（20 格在混战里 100 局触发 0 次）
  assert.equal(DEFAULT_SCORING.domination.ffaGap, 10);
  assert.equal(DEFAULT_SCORING.domination.teamGap, 20);
  assert.equal(DEFAULT_SCORING.fullClear.points, 1);
});

test('每局混战四个名次的增减分总和为 +2（题目数值的推论）', () => {
  const total = DEFAULT_SCORING.ffaRankDelta.reduce((a, b) => a + b, 0);
  assert.equal(total, 2);
});
