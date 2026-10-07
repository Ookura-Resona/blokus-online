/**
 * 验证 Durable Object 的**存储持久化**。
 *
 * 这是两阶段的手动检查 —— 因为要真的把 DO 实例杀掉，自动化测试做不到：
 *
 *   1) node tools/check-persistence.js before
 *      → 建房、走几手、把局面快照存到 persist-check.json
 *
 *   2) 停掉 wrangler dev（DO 实例随之销毁），再重新起一个
 *      npx wrangler dev --port 8787 --var AI_DELAY_MS:5 --var OFFLINE_TAKEOVER_MS:1000
 *
 *   3) node tools/check-persistence.js after
 *      → 重连同一个房号，比对局面
 *
 * 只有 after 阶段能恢复出 before 阶段的棋盘，才说明状态真的落到了 DO 存储里，
 * 而不是只活在内存中（内存里的状态一杀就没了）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectWs } from '../test/wsclient.js';
import { C2S, S2C } from '../shared/protocol.js';
import { deserializeState } from '../shared/rules.js';
import { chooseMove, mulberry32 } from '../shared/ai.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAVE = path.join(ROOT, 'persist-check.json');

const TARGET = (process.env.BLOKUS_TARGET ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const u = new URL(TARGET);
const HOST = u.hostname;
const PORT = Number(u.port || 80);

const phase = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs = 15000, label = '条件') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await sleep(20);
  }
}

async function join(code, playerId, name) {
  const ws = await connectWs(PORT, { host: HOST, path: `/ws?room=${code}` });
  ws.sendJSON({ t: C2S.HELLO, playerId, name });
  await ws.waitJson(S2C.WELCOME);
  ws.sendJSON({ t: C2S.JOIN_ROOM, code });
  const room = await ws.waitJson(S2C.ROOM);
  return { ws, room };
}

/* ───────────────────────── 阶段 1：存快照 ───────────────────────── */

if (phase === 'before') {
  const res = await fetch(`${TARGET}/api/new-room`, { cache: 'no-store' });
  const { code } = await res.json();

  const { ws } = await join(code, 'persist-probe', '持久化探测');
  for (const seat of [1, 2, 3]) ws.sendJSON({ t: C2S.SET_SEAT, seat, kind: 'ai' });
  await until(
    () => ws.latest(S2C.ROOM)?.seats.filter((s) => s.kind === 'ai').length === 3,
    8000,
    '三个座位变成 AI',
  );

  ws.sendJSON({ t: C2S.START });
  await until(() => ws.latest(S2C.STATE)?.state, 8000, '开局');

  // 让 0 号位走 4 手，让棋盘上有内容可验证
  const rng = mulberry32(4242);
  let acted = -1;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const raw = ws.latest(S2C.STATE)?.state;
    if (raw && !raw.over && raw.turn === 0 && acted !== raw.moveCount) {
      acted = raw.moveCount;
      const mv = chooseMove(deserializeState(raw), 0, { difficulty: 'easy', rng });
      if (mv) ws.sendJSON({ t: C2S.MOVE, ...mv });
      if (acted >= 4) break;
    }
    await sleep(15);
  }

  const snap = ws.latest(S2C.STATE)?.state;
  if (!snap) throw new Error('没拿到局面快照');

  fs.writeFileSync(
    SAVE,
    JSON.stringify(
      {
        code,
        board: snap.board,
        moveCount: snap.moveCount,
        remaining0: snap.remaining[0].length,
      },
      null,
      2,
    ),
    'utf8',
  );

  const occupied = snap.board.split('').filter((c) => c !== '.').length;
  console.log(`\n[before] 房号 ${code}`);
  console.log(`         手数 ${snap.moveCount}，0 号位剩 ${snap.remaining[0].length} 块`);
  console.log(`         已占 ${occupied} 格`);
  console.log(`         快照已存到 ${path.relative(ROOT, SAVE)}`);
  console.log('\n  下一步：停掉 wrangler dev，重新起一个，然后跑 after\n');

  ws.destroy();
  process.exit(0);
}

/* ───────────────────────── 阶段 2：比对 ───────────────────────── */

if (phase === 'after') {
  if (!fs.existsSync(SAVE)) {
    console.error('先跑 before：node tools/check-persistence.js before');
    process.exit(2);
  }
  const saved = JSON.parse(fs.readFileSync(SAVE, 'utf8'));

  const { ws, room } = await join(saved.code, 'persist-probe', '持久化探测');
  const state =
    ws.latest(S2C.STATE)?.state ?? (await ws.waitJson(S2C.STATE, 8000)).state;

  let same = 0;
  let changed = 0;
  for (let i = 0; i < saved.board.length; i++) {
    if (saved.board[i] === '.') continue;
    if (state.board[i] === saved.board[i]) same++;
    else changed++;
  }

  console.log(`\n[after] 重连房号 ${saved.code}，座位 ${room.yourSeat}`);
  console.log(`        恢复后手数 ${state.moveCount}（重启前 ${saved.moveCount}）`);
  console.log(`        重启前已占的格子：${same} 格颜色一致，${changed} 格对不上`);
  console.log(`        0 号位剩 ${state.remaining[0].length} 块（重启前 ${saved.remaining0} 块）`);

  // 判定标准：
  //  · changed === 0 —— 重启前占的每一格颜色都没变，说明棋局被完整保存并恢复
  //  · moveCount 只增不减 —— 说明恢复的是同一局，而不是新建的空房间
  // 注意**不能**断言 remaining[0] 不变：脚本退出后游戏仍在服务端继续跑，
  // 掉线的 0 号位会被自动托管，所以它会合法地多下几手。
  const ok = changed === 0 && state.moveCount >= saved.moveCount && same > 0;
  console.log(
    ok
      ? '\n✅ DO 存储持久化生效：DO 实例被杀掉重建后，房间与棋局完整恢复\n'
      : '\n❌ 状态没能完整恢复\n',
  );
  ws.destroy();
  process.exit(ok ? 0 : 1);
}

console.error('用法：node tools/check-persistence.js before|after');
process.exit(2);
