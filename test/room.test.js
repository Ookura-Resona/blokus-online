/**
 * 房间 / 联机流程集成测试。
 * 起一个真实的 HTTP + WebSocket 服务器（随机端口、AI 停顿极短），
 * 用两个真实 WebSocket 客户端把一整局打完。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../server/app.js';
import { connectWs } from './wsclient.js';
import { C2S, S2C } from '../shared/protocol.js';
import { deserializeState, allSquares } from '../shared/rules.js';
import { chooseMove, mulberry32 } from '../shared/ai.js';
import { MODE_FFA, MODE_TEAM, SEAT_COUNT } from '../shared/constants.js';

/** 起服务器 + 两个已握手的客户端 */
async function setup() {
  const app = createApp({ aiDelayMs: 1, offlineTakeoverMs: 500 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;

  const clients = [];
  for (let i = 0; i < 2; i++) {
    const ws = await connectWs(port);
    ws.sendJSON({ t: C2S.HELLO, playerId: `player-${i}`, name: `玩家${i}` });
    // waitJson 会自动开启消息日志
    await ws.waitJson(S2C.WELCOME);
    clients.push(ws);
  }

  return {
    app,
    port,
    a: clients[0],
    b: clients[1],
    async cleanup() {
      for (const c of clients) c.close();
      await app.close();
    },
  };
}

/**
 * 用 AI 代打所有真人座位，把一局推完。
 * 直接读各客户端消息日志里的最新状态，不需要后台协程，也就没有抢消息的竞态。
 */
async function autoplay(clients, seats, timeoutMs = 30_000) {
  const rng = mulberry32(4242);
  const lastActedAt = new Map();
  const deadline = Date.now() + timeoutMs;
  let guard = 0;

  while (Date.now() < deadline && guard++ < 8000) {
    const done = clients.map((c) => c.latest(S2C.RESULT)?.result).find(Boolean);
    if (done) return done;

    let didAct = false;
    for (const [i, client] of clients.entries()) {
      // 注意：latest 返回的是消息本身，快照在 .state 里
      const raw = client.latest(S2C.STATE)?.state;
      if (!raw || raw.over) continue;
      const seat = seats[i];
      if (raw.turn !== seat) continue;
      // 同一个 moveCount 只出一次手，避免服务端还没广播新状态就重复发送
      if (lastActedAt.get(client) === raw.moveCount) continue;
      lastActedAt.set(client, raw.moveCount);

      const move = chooseMove(deserializeState(raw), seat, { difficulty: 'normal', rng });
      if (move) {
        client.sendJSON({ t: C2S.MOVE, ...move });
        didAct = true;
      }
    }
    await new Promise((r) => setTimeout(r, didAct ? 2 : 4));
  }
  throw new Error('autoplay 超时，对局没有结束');
}

/* ------------------------------------------------------------------ */

test('建房 → 分享房号 → 加入：座位与房主信息正确', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM });
    const roomA = await s.a.waitJson(S2C.ROOM);
    assert.match(roomA.code, /^[A-HJ-NP-Z2-9]{4}$/, '房号格式不对');
    assert.equal(roomA.isHost, true);
    assert.equal(roomA.yourSeat, 0);
    assert.equal(roomA.phase, 'lobby');
    assert.equal(roomA.seats.filter((x) => x.kind === 'human').length, 1);

    s.b.sendJSON({ t: C2S.JOIN_ROOM, code: roomA.code });
    const roomB = await s.b.waitJson(S2C.ROOM);
    assert.equal(roomB.code, roomA.code);
    assert.equal(roomB.isHost, false);
    assert.equal(roomB.yourSeat, 1, '第二个进来的人应该坐 1 号位');
    assert.equal(roomB.seats[0].isYou, false);
    assert.equal(roomB.seats[1].isYou, true);

    // 房主也要收到「有人进来了」的更新
    const updated = await s.a.waitJson(S2C.ROOM);
    assert.equal(updated.seats.filter((x) => x.kind === 'human').length, 2);
  } finally {
    await s.cleanup();
  }
});

test('加入不存在的房号会得到错误提示', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.JOIN_ROOM, code: 'ZZZZ' });
    const err = await s.a.waitJson(S2C.ERROR);
    assert.match(err.message, /不存在/);
  } finally {
    await s.cleanup();
  }
});

test('非房主不能开局 / 改模式，房主可以', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM });
    const room = await s.a.waitJson(S2C.ROOM);
    s.b.sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
    await s.b.waitJson(S2C.ROOM);
    await s.a.waitJson(S2C.ROOM);

    s.b.sendJSON({ t: C2S.START });
    const err = await s.b.waitJson(S2C.ERROR);
    assert.match(err.message, /房主/);

    s.b.sendJSON({ t: C2S.SET_MODE, mode: MODE_TEAM });
    assert.match((await s.b.waitJson(S2C.ERROR)).message, /房主/);

    s.a.sendJSON({ t: C2S.SET_MODE, mode: MODE_TEAM });
    const after = await s.a.waitJson(S2C.ROOM);
    assert.equal(after.mode, MODE_TEAM);
  } finally {
    await s.cleanup();
  }
});

test('房主可以把空位设为 AI，空位在开局时自动补 AI', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM });
    const room = await s.a.waitJson(S2C.ROOM);
    s.a.sendJSON({ t: C2S.SET_SEAT, seat: 2, kind: 'ai' });
    const r1 = await s.a.waitJson(S2C.ROOM);
    assert.equal(r1.seats[2].kind, 'ai');

    s.a.sendJSON({ t: C2S.SET_SEAT, seat: 2, kind: 'open' });
    const r2 = await s.a.waitJson(S2C.ROOM);
    assert.equal(r2.seats[2].kind, 'open');

    // 座位 1/2/3 都留空，开局应当自动补成 AI
    s.a.sendJSON({ t: C2S.START });
    const r3 = await s.a.waitJson(S2C.ROOM);
    assert.equal(r3.phase, 'playing');
    assert.deepEqual(r3.seats.map((x) => x.kind), ['human', 'ai', 'ai', 'ai']);
    assert.ok(room.code);
  } finally {
    await s.cleanup();
  }
});

test('真人 + AI 混战：一整局能打完并产生结算', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM, mode: MODE_FFA });
    const room = await s.a.waitJson(S2C.ROOM);
    s.b.sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
    await s.b.waitJson(S2C.ROOM);
    await s.a.waitJson(S2C.ROOM);

    // 座位 2、3 补 AI
    s.a.sendJSON({ t: C2S.SET_SEAT, seat: 2, kind: 'ai' });
    await s.a.waitJson(S2C.ROOM);
    s.a.sendJSON({ t: C2S.SET_SEAT, seat: 3, kind: 'ai' });
    await s.a.waitJson(S2C.ROOM);

    s.a.sendJSON({ t: C2S.START });
    await s.a.waitJson(S2C.ROOM);

    const result = await autoplay([s.a, s.b], [0, 1]);

    assert.equal(result.mode, MODE_FFA);
    assert.equal(result.ranking.length, 4);
    assert.deepEqual(
      result.ranking.map((r) => r.rank).sort(),
      [1, 2, 3, 4],
      '名次必须是 1..4 且不重复',
    );
    // 名次增减分总和恒为 +2（3+1+0-2）
    const sum = result.deltas.reduce((a, b) => a + b, 0);
    assert.ok(sum >= 2, `增减分总和至少为 +2，实际 ${sum}`);
    // 累计积分已经写进 result.seats
    assert.equal(typeof result.seats[0].sessionScore, 'number');
    assert.equal(result.seats[0].sessionScore, result.deltas[0]);

    // 双方都收到了同一份结算
    assert.deepEqual(s.b.latest(S2C.RESULT).result.deltas, result.deltas);
  } finally {
    await s.cleanup();
  }
});

test('二对二：对角为一队，胜负与结算按队伍给分', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM, mode: MODE_TEAM });
    const room = await s.a.waitJson(S2C.ROOM);
    assert.equal(room.mode, MODE_TEAM);
    s.b.sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
    await s.b.waitJson(S2C.ROOM);
    await s.a.waitJson(S2C.ROOM);
    s.a.sendJSON({ t: C2S.START });
    await s.a.waitJson(S2C.ROOM);

    const result = await autoplay([s.a, s.b], [0, 1]);

    assert.equal(result.mode, MODE_TEAM);
    assert.equal(result.teams.length, 2);
    assert.deepEqual(result.teams[0].seats, [0, 2]);
    assert.deepEqual(result.teams[1].seats, [1, 3]);

    // 同队两人的**基础**增减分必须一致。
    // 注意不能直接比 deltas：全清奖励是按人头给的，队友里只有一个把
    // 21 块下完时，两人会差 1 分。所以要把奖励扣掉再比。
    const bonusOf = (seat) =>
      (result.bonuses ?? []).filter((b) => b.seat === seat).reduce((a, b) => a + b.points, 0);
    assert.equal(
      result.deltas[0] - bonusOf(0),
      result.deltas[2] - bonusOf(2),
      '同队的两人基础增减分应当一致',
    );
    assert.equal(
      result.deltas[1] - bonusOf(1),
      result.deltas[3] - bonusOf(3),
      '另一队同理',
    );

    const team0Won = result.teams[0].win;
    assert.ok(team0Won ? result.deltas[0] > 0 : result.deltas[0] < 0, '胜方应当加分');
    assert.ok(team0Won ? result.deltas[1] < 0 : result.deltas[1] > 0, '败方应当扣分');
    assert.match(result.summary, /二对二/);
  } finally {
    await s.cleanup();
  }
});

test('服务端会拒绝非法落子，并且不污染对局', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM });
    await s.a.waitJson(S2C.ROOM);
    s.a.sendJSON({ t: C2S.START });
    await s.a.waitJson(S2C.ROOM);
    await s.a.waitJson(S2C.STATE);

    // 不占角的首子
    s.a.sendJSON({ t: C2S.MOVE, pieceId: '1', orient: 0, x: 7, y: 7 });
    const err = await s.a.waitJson(S2C.ERROR);
    assert.match(err.message, /起始角/);

    await new Promise((r) => setTimeout(r, 80));
    const raw = s.a.latest(S2C.STATE)?.state;
    assert.equal(
      allSquares(deserializeState(raw)).reduce((x, y) => x + y, 0),
      0,
      '非法落子不应该改变棋盘',
    );
  } finally {
    await s.cleanup();
  }
});

test('没轮到的人不能落子', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM });
    const room = await s.a.waitJson(S2C.ROOM);
    s.b.sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
    await s.b.waitJson(S2C.ROOM);
    await s.a.waitJson(S2C.ROOM);
    s.a.sendJSON({ t: C2S.START });
    await s.a.waitJson(S2C.ROOM);
    await s.b.waitJson(S2C.STATE);

    // 现在是座位 0（a）的回合，b 抢先落子
    s.b.sendJSON({ t: C2S.MOVE, pieceId: '1', orient: 0, x: 0, y: 19 });
    const err = await s.b.waitJson(S2C.ERROR);
    assert.match(err.message, /还没轮到/);
  } finally {
    await s.cleanup();
  }
});

test('旁观者能看到棋盘但看不到自己的座位', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM });
    const room = await s.a.waitJson(S2C.ROOM);

    // b 先坐满 1 号位，再来一个 c 旁观
    s.b.sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
    await s.b.waitJson(S2C.ROOM);

    const c = await connectWs(s.port);
    c.sendJSON({ t: C2S.HELLO, playerId: 'player-2', name: '旁观者' });
    await c.waitJson(S2C.WELCOME);
    c.sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
    const roomC = await c.waitJson(S2C.ROOM);
    // 还有空位，所以会坐下 —— 把 1/2/3 都填满再看旁观
    assert.ok([1, 2, 3].includes(roomC.yourSeat));
    c.close();
  } finally {
    await s.cleanup();
  }
});

test('对局中房主离开会转移房主给下一位玩家', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM });
    const room = await s.a.waitJson(S2C.ROOM);
    s.b.sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
    await s.b.waitJson(S2C.ROOM);
    await s.a.waitJson(S2C.ROOM);

    s.a.sendJSON({ t: C2S.LEAVE_ROOM });
    const after = await s.b.waitJson(S2C.ROOM);
    assert.equal(after.isHost, true, '房主应当转移给还在房间里的人');
  } finally {
    await s.cleanup();
  }
});

test('大厅阶段离开会释放座位，别人可以坐进来', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM });
    const roomA = await s.a.waitJson(S2C.ROOM);
    s.b.sendJSON({ t: C2S.JOIN_ROOM, code: roomA.code });
    const roomB = await s.b.waitJson(S2C.ROOM);
    assert.equal(roomB.yourSeat, 1);

    s.b.sendJSON({ t: C2S.LEAVE_SEAT });
    const afterLeave = await s.b.waitJson(S2C.ROOM);
    assert.equal(afterLeave.yourSeat, null);
    assert.equal(afterLeave.seats[1].kind, 'open');

    s.b.sendJSON({ t: C2S.TAKE_SEAT, seat: 3 });
    const afterTake = await s.b.waitJson(S2C.ROOM);
    assert.equal(afterTake.yourSeat, 3);
    assert.equal(afterTake.seats[3].kind, 'human');
  } finally {
    await s.cleanup();
  }
});

test('聊天消息会广播给房间里的所有人', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM });
    const room = await s.a.waitJson(S2C.ROOM);
    s.b.sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
    await s.b.waitJson(S2C.ROOM);
    await s.a.waitJson(S2C.ROOM);

    s.a.sendJSON({ t: C2S.CHAT, text: '来一局！' });
    assert.equal((await s.b.waitJson(S2C.CHAT)).text, '来一局！');
    assert.equal((await s.a.waitJson(S2C.CHAT)).text, '来一局！');
  } finally {
    await s.cleanup();
  }
});

test('再来一局会回到大厅并保留累计积分', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM });
    const room = await s.a.waitJson(S2C.ROOM);
    s.b.sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
    await s.b.waitJson(S2C.ROOM);
    await s.a.waitJson(S2C.ROOM);
    s.a.sendJSON({ t: C2S.START });
    await s.a.waitJson(S2C.ROOM);
    const result = await autoplay([s.a, s.b], [0, 1]);
    const score0 = result.seats[0].sessionScore;

    s.a.sendJSON({ t: C2S.REMATCH });
    // 结算时也广播过 ROOM（phase='over'），这里要的是重开之后的那一份
    const lobby = await s.a.waitLatest(S2C.ROOM);
    assert.equal(lobby.phase, 'lobby');
    assert.equal(lobby.seats[0].sessionScore, score0, '累计积分应当保留');
    assert.equal(lobby.seats[0].ready, false);
  } finally {
    await s.cleanup();
  }
});

test('轮到离线的玩家时，超时后会自动托管继续对局', async () => {
  const s = await setup();
  try {
    s.a.sendJSON({ t: C2S.CREATE_ROOM });
    await s.a.waitJson(S2C.ROOM);
    s.a.sendJSON({ t: C2S.SET_SEAT, seat: 1, kind: 'ai' });
    await s.a.waitJson(S2C.ROOM);
    s.a.sendJSON({ t: C2S.SET_SEAT, seat: 2, kind: 'ai' });
    await s.a.waitJson(S2C.ROOM);
    // 座位 3 留空 → 开局自动补 AI
    s.a.sendJSON({ t: C2S.START });
    await s.a.waitJson(S2C.ROOM);
    await s.a.waitJson(S2C.STATE);

    // a 立刻断开；轮到他时应当在 offlineTakeoverMs(500ms) 后被托管
    s.a.close();

    const room = [...s.app.manager.rooms.values()][0];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (room.state && room.state.moveCount >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(room.state.moveCount >= 2, `离线托管没有生效，moveCount=${room.state?.moveCount}`);
  } finally {
    await s.cleanup();
  }
});

test('四人混战：四个真人座位都能各司其职', async () => {
  const app = createApp({ aiDelayMs: 1 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const clients = [];
  try {
    for (let i = 0; i < SEAT_COUNT; i++) {
      const ws = await connectWs(port);
      ws.sendJSON({ t: C2S.HELLO, playerId: `p${i}`, name: `真人${i}` });
      await ws.waitJson(S2C.WELCOME);
      clients.push(ws);
    }

    clients[0].sendJSON({ t: C2S.CREATE_ROOM });
    const room = await clients[0].waitJson(S2C.ROOM);
    for (let i = 1; i < SEAT_COUNT; i++) {
      clients[i].sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
      await clients[i].waitJson(S2C.ROOM);
    }
    clients[0].sendJSON({ t: C2S.START });
    // 用 waitLatest：clients[0] 手上还压着三次「有人加入」的旧房间消息
    const started = await clients[0].waitLatest(S2C.ROOM);
    assert.equal(started.phase, 'playing');
    assert.equal(started.seats.every((x) => x.kind === 'human'), true);

    const result = await autoplay(clients, [0, 1, 2, 3], 60_000);
    assert.equal(result.ranking.length, 4);
    for (const c of clients) {
      assert.deepEqual(c.errors(), [], `出现了错误：${c.errors()}`);
    }
  } finally {
    for (const c of clients) c.close();
    await app.close();
  }
});
