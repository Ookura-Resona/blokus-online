/**
 * Cloudflare Workers / Durable Objects 专属测试。
 *
 * 需要先有一个跑着的 wrangler dev（或已部署的 Worker）：
 *
 *   npx wrangler dev --port 8787 --var AI_DELAY_MS:5 --var TURN_LIMIT_MS:1000
 *   BLOKUS_TARGET=http://127.0.0.1:8787 node --test test/worker.test.js
 *
 * 没有可用目标时会**跳过**（而不是失败），这样 `npm test` 在没起 Worker 时也能全绿。
 *
 * 这里测的都是 Workers 版本特有的东西：房号分配（DO claim）、
 * Durable Object 的状态持久化、断线后用同一个 playerId 坐回原座位。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { connectWs } from './wsclient.js';
import { C2S, S2C } from '../shared/protocol.js';
import { deserializeState, allSquares } from '../shared/rules.js';
import { chooseMove, mulberry32 } from '../shared/ai.js';

const TARGET = (process.env.BLOKUS_TARGET ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const u = new URL(TARGET);
const HOST = u.hostname;
const PORT = Number(u.port || 80);

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

/** 探测目标是不是一个跑着的 Workers 版本 */
const probe = await (async () => {
  try {
    const res = await fetch(`${TARGET}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.runtime !== 'cloudflare-workers') {
      return { ok: false, why: `目标不是 Workers 运行时（runtime=${data.runtime}）` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err.cause?.code ?? err.message };
  }
})();

if (!probe.ok) {
  console.log(`\n  跳过 Workers 测试：${TARGET} 不可用（${probe.why}）`);
  console.log('  想跑的话先执行：npx wrangler dev --port 8787 --var AI_DELAY_MS:5\n');
}

/** 连上某个房号 */
async function join(code, playerId, name) {
  const ws = await connectWs(PORT, { host: HOST, path: `/ws?room=${code}` });
  ws.sendJSON({ t: C2S.HELLO, playerId, name });
  await ws.waitJson(S2C.WELCOME);
  ws.sendJSON({ t: C2S.JOIN_ROOM, code });
  const room = await ws.waitJson(S2C.ROOM);
  return { ws, room };
}

/* ─────────────────────────────────────────────────────────────── */

test('Worker：/api/new-room 分配的房号是唯一的（DO claim 真的落了标记）', { skip: !probe.ok }, async () => {
  const codes = new Set();
  const rounds = 12;
  for (let i = 0; i < rounds; i++) {
    const res = await fetch(`${TARGET}/api/new-room`, { cache: 'no-store' });
    assert.equal(res.ok, true, `/api/new-room 返回 ${res.status}`);
    const { code } = await res.json();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/, `房号格式不对：${code}`);
    assert.equal(codes.has(code), false, `房号 ${code} 被重复分配了`);
    codes.add(code);
  }
  assert.equal(codes.size, rounds);
});

test('Worker：缺房号连 /ws 会被明确拒绝，而不是静默不响应', { skip: !probe.ok }, async () => {
  await assert.rejects(
    () => connectWs(PORT, { host: HOST, path: '/ws' }),
    /101/,
    '不带 room 参数时应当返回非 101，并且客户端要抛出明确错误',
  );
});

test('Worker：一整局能打完（AI 由 Durable Object 的定时器驱动）', { skip: !probe.ok }, async () => {
  const res = await fetch(`${TARGET}/api/new-room`, { cache: 'no-store' });
  const { code } = await res.json();

  const { ws } = await join(code, 'worker-solo', 'Worker测试');
  const seen = { state: null, result: null, errors: [] };

  // 把 1/2/3 号位设成 AI
  for (const seat of [1, 2, 3]) ws.sendJSON({ t: C2S.SET_SEAT, seat, kind: 'ai' });
  await until(() => ws.latest(S2C.ROOM)?.seats.filter((s) => s.kind === 'ai').length === 3, 8000, '补 AI');

  ws.sendJSON({ t: C2S.START });
  await until(() => ws.latest(S2C.STATE), 8000, '开局');

  const rng = mulberry32(20261007);
  const lastActed = { at: -1 };
  const deadline = Date.now() + 90_000;
  let sawOver = false;

  while (Date.now() < deadline) {
    const raw = ws.latest(S2C.STATE)?.state;
    if (raw) {
      seen.state = raw;
      if (raw.over) {
        // 注意：STATE(over) 和 RESULT 是两条独立广播，RESULT 在后。
        // 看到 over 就立刻 break 会抢在 RESULT 前面，这里要多等一会儿。
        sawOver = true;
        break;
      }
      if (raw.turn === 0 && lastActed.at !== raw.moveCount) {
        lastActed.at = raw.moveCount;
        const mv = chooseMove(deserializeState(raw), 0, { difficulty: 'easy', rng });
        if (mv) ws.sendJSON({ t: C2S.MOVE, ...mv });
      }
    }
    const r = ws.latest(S2C.RESULT)?.result;
    if (r) {
      seen.result = r;
      break;
    }
    await sleep(15);
  }

  if (sawOver && !seen.result) {
    seen.result = (await ws.waitJson(S2C.RESULT, 8000)).result;
  }

  assert.ok(seen.result, '局面应当能打到结束并出结算');
  assert.equal(seen.result.ranking.length, 4);
  assert.deepEqual(seen.result.ranking.map((r) => r.rank).sort(), [1, 2, 3, 4]);
  assert.equal(ws.errors().length, 0, `过程中出错：${ws.errors().join('; ')}`);

  const squares = allSquares(deserializeState(seen.state));
  console.log(
    `    打完 ${seen.state.moveCount} 手，终局占格 ${squares.join('/')}，` +
      `增减分 ${seen.result.deltas.join('/')}`,
  );

  ws.destroy();
});

test('Worker：断线重连能坐回原座位并恢复棋局（DO 状态持久化）', { skip: !probe.ok }, async () => {
  const res = await fetch(`${TARGET}/api/new-room`, { cache: 'no-store' });
  const { code } = await res.json();

  const playerId = 'worker-reconnect-1';
  const first = await join(code, playerId, '会重连的人');
  assert.equal(first.room.yourSeat, 0, '第一个人应当坐 0 号位');

  first.ws.sendJSON({ t: C2S.SET_SEAT, seat: 1, kind: 'ai' });
  first.ws.sendJSON({ t: C2S.SET_SEAT, seat: 2, kind: 'ai' });
  first.ws.sendJSON({ t: C2S.SET_SEAT, seat: 3, kind: 'ai' });
  await until(
    () => first.ws.latest(S2C.ROOM)?.seats.filter((s) => s.kind === 'ai').length === 3,
    8000,
    '补 AI',
  );

  first.ws.sendJSON({ t: C2S.START });
  await until(() => first.ws.latest(S2C.STATE)?.state, 8000, '开局');

  // 走 3 手，让局面有内容可恢复
  const rng = mulberry32(777);
  let acted = -1;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const raw = first.ws.latest(S2C.STATE)?.state;
    if (raw && !raw.over && raw.turn === 0 && acted !== raw.moveCount) {
      acted = raw.moveCount;
      const mv = chooseMove(deserializeState(raw), 0, { difficulty: 'easy', rng });
      if (mv) first.ws.sendJSON({ t: C2S.MOVE, ...mv });
      if (acted >= 3) break;
    }
    await sleep(15);
  }

  const before = first.ws.latest(S2C.STATE)?.state;
  assert.ok(before, '应当拿到过对局状态');
  assert.ok(before.moveCount >= 1, `应当至少落了 1 手，实际 ${before.moveCount}`);
  const beforeBoard = before.board;
  const beforeMoves = before.moveCount;
  const beforeRemaining = before.remaining[0].length;

  // 断开：模拟关掉页面 / 断网
  first.ws.destroy();
  await sleep(400);

  // 用同一个 playerId 重连 —— 服务端应当按 playerId 把人放回 0 号位
  const again = await join(code, playerId, '会重连的人');
  assert.equal(again.room.yourSeat, 0, '重连后必须坐回原来的 0 号位，而不是随便找个空位');

  const restoredState = again.ws.latest(S2C.STATE)?.state;
  const restored = restoredState ?? (await again.ws.waitJson(S2C.STATE, 5000)).state;

  // 注意：人断开期间，另外三个 AI 座位还在继续走，所以恢复后的局面只会更靠后，
  // 不会和断开那一刻完全相同。正确的断言是「断开前已占的格子，颜色没变」。
  assert.ok(
    restored.moveCount >= beforeMoves,
    `恢复后的手数不应当倒退（断开时 ${beforeMoves}，恢复后 ${restored.moveCount}）`,
  );
  let changed = 0;
  for (let i = 0; i < beforeBoard.length; i++) {
    if (beforeBoard[i] !== '.' && restored.board[i] !== beforeBoard[i]) changed++;
  }
  assert.equal(changed, 0, `有 ${changed} 格在恢复后变了颜色，说明棋局没被正确保存`);
  assert.equal(restored.over, false, '这局还没结束，应当能继续打');

  console.log(
    `    断开于第 ${beforeMoves} 手，重连后座位仍是 0、已占格子颜色全部一致` +
      `（期间 AI 推进到第 ${restored.moveCount} 手）`,
  );

  // 重连之后还能继续落子
  if (!restored.over && restored.turn === 0) {
    const mv = chooseMove(deserializeState(restored), 0, { difficulty: 'easy', rng });
    if (mv) {
      again.ws.sendJSON({ t: C2S.MOVE, ...mv });
      await until(
        () => (again.ws.latest(S2C.STATE)?.state.moveCount ?? 0) > beforeMoves,
        8000,
        '重连后能继续落子',
      );
      console.log('    重连后继续落子成功');
    }
  }

  again.ws.destroy();
});
