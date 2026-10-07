/**
 * 自对局模拟器：跑 N 局 AI 对局，输出对局长度、终局占格分布、积分分布与耗时。
 * 用途：验证规则引擎不会提前终局，并为积分阈值提供参考数据。
 *
 *   node tools/sim.js [局数] [难度] [模式]
 */

import { createState } from '../shared/rules.js';
import { chooseMove, mulberry32 } from '../shared/ai.js';
import { applyMove, allSquares, hasAnyMove, serializeState } from '../shared/rules.js';
import { computeScore } from '../shared/scoring.js';
import { MODE_FFA, MODE_TEAM, SEAT_LABELS } from '../shared/constants.js';

const games = Number(process.argv[2] ?? 20);
const difficulty = process.argv[3] ?? 'normal';
const mode = process.argv[4] ?? MODE_FFA;

const moveCounts = [];
const squareSets = [];
const durations = [];
const totalPoints = [0, 0, 0, 0];
const bonusTally = { domination: 0, fullClear: 0 };
const passTally = [];
const margins = []; // FFA: 头名 - 第二名；TEAM: 胜方总数 - 败方总数

for (let g = 0; g < games; g++) {
  const rng = mulberry32(1000 + g * 7919);
  const st = createState(mode);
  const t0 = Date.now();
  let guard = 0;
  while (!st.over && guard++ < 600) {
    const seat = st.turn;
    const mv = chooseMove(st, seat, { difficulty, rng });
    if (!mv) break;
    applyMove(st, seat, mv.pieceId, mv.orient, mv.x, mv.y);
  }
  durations.push(Date.now() - t0);

  if (!st.over) {
    console.error(`第 ${g + 1} 局未结束！moveCount=${st.moveCount}`);
    process.exitCode = 1;
    break;
  }

  moveCounts.push(st.moveCount);
  passTally.push(st.passes.length);
  const sq = allSquares(st);
  squareSets.push(sq);
  const result = computeScore(st);
  margins.push(Math.abs(result.teams ? result.teams[0].squares - result.teams[1].squares : result.ranking[0].squares - result.ranking[1].squares));
  for (let s = 0; s < 4; s++) totalPoints[s] += result.deltas[s];
  for (const b of result.bonuses) bonusTally[b.kind] = (bonusTally[b.kind] ?? 0) + 1;
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const num = (n) => Number(n).toFixed(1);

console.log(`局数 ${moveCounts.length} / 难度 ${difficulty} / 模式 ${mode}`);
console.log(`每局手数  平均 ${num(avg(moveCounts))}  最少 ${Math.min(...moveCounts)}  最多 ${Math.max(...moveCounts)}`);
console.log(`弃权次数  平均 ${num(avg(passTally))}`);
console.log(`单局耗时  平均 ${num(avg(durations))}ms  最慢 ${Math.max(...durations)}ms`);
for (let s = 0; s < 4; s++) {
  const col = squareSets.map((r) => r[s]);
  console.log(
    `${SEAT_LABELS[s]}(${s}) 占格 平均 ${num(avg(col))}  最少 ${Math.min(...col)}  最多 ${Math.max(...col)}` +
      `  累计积分 ${totalPoints[s]}`,
  );
}
console.log(`奖励统计`, bonusTally);

const sorted = [...margins].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
console.log(
  `领先幅度  平均 ${num(avg(margins))}  p50 ${pct(0.5)}  p75 ${pct(0.75)}  p90 ${pct(0.9)}  ` +
    `p95 ${pct(0.95)}  最大 ${sorted[sorted.length - 1]}`,
);
const thresholds = [10, 12, 15, 18, 20, 25];
console.log(
  '不同统治力阈值下的触发率：' +
    thresholds.map((t) => `${t}格→${((margins.filter((m) => m >= t).length / margins.length) * 100).toFixed(0)}%`).join('  '),
);
