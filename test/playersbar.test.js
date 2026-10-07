/**
 * 对局中的玩家状态条（在线 / 离线 / 重连中）。
 *
 * 用一个真实场景来测，不做假：
 *   · 玩家 A = 真实前端（加载 index.html + app.js，用按钮操作）
 *   · 玩家 B = 裸 WebSocket 客户端，中途拔线
 * 然后检查 A 的界面上的状态有没有正确变化。
 *
 * 单独一个文件是因为 app.js 是模块单例，得用带查询串的 URL 载入独立实例。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server/app.js';
import { installDom } from './domstub.js';
import { connectWs } from './wsclient.js';
import { C2S, S2C } from '../shared/protocol.js';

register('./web-loader.js', import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs = 10000, label = '条件') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await sleep(20);
  }
}

/** 把玩家条读成 [{name, state}]，方便断言 */
function readChips(el) {
  return el.playersBar.querySelectorAll('.player-chip').map((chip) => ({
    name: chip.querySelector('.pc-name')?.textContent ?? '',
    state: chip.querySelector('.pc-state')?.textContent ?? '',
    me: chip.classList.contains('is-me'),
    turn: chip.classList.contains('is-turn'),
  }));
}

test('对局中显示玩家状态：在线 / 离线 / 重连中', async () => {
  // turnLimitMs 给大一点：这条测的是状态显示，不想让「超时托管」来搅局
  const serverApp = createApp({ aiDelayMs: 5, turnLimitMs: 30_000 });
  await new Promise((r) => serverApp.server.listen(0, '127.0.0.1', r));
  const port = serverApp.server.address().port;
  const host = `127.0.0.1:${port}`;

  installDom({ host, html: INDEX_HTML });
  await import('../public/app.js?playersbar-test');

  const hook = globalThis.window.__blokus;
  assert.ok(hook, 'app.js 应当挂出 window.__blokus');
  const { app: client, el } = hook;

  let b = null;
  try {
    /* ---------- 1. A 建房 ---------- */
    assert.equal(el.playersBar.hidden, true, '还没开局时玩家条应当藏着');
    el.inputName.value = '玩家A';
    el.btnCreate.click();
    const room = await until(() => client.room, 10000, 'A 建房');
    assert.equal(room.yourSeat, 0);
    assert.equal(el.playersBar.hidden, true, '大厅阶段仍然不该显示玩家条（那里有完整座位卡片）');

    /* ---------- 2. B 用裸客户端加入 1 号位 ---------- */
    b = await connectWs(port, { host: '127.0.0.1', path: `/ws?room=${room.code}` });
    b.sendJSON({ t: C2S.HELLO, playerId: 'player-b', name: '玩家B' });
    await b.waitJson(S2C.WELCOME);
    b.sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
    const bRoom = await b.waitJson(S2C.ROOM);
    assert.equal(bRoom.yourSeat, 1, 'B 应当坐在 1 号位');

    // A 这边也要收到「B 进来了」的广播
    await until(() => client.room?.seats[1].name === '玩家B', 8000, 'A 看到 B 入座');

    /* ---------- 3. 开局（空位自动补 AI） ---------- */
    el.btnStart.click();
    await until(() => client.room?.phase === 'playing', 10000, '开局');
    await until(() => client.lastState, 10000, '拿到对局状态');

    /* ---------- 4. 四个人都该显示出来，状态正确 ---------- */
    await until(() => el.playersBar.hidden === false, 5000, '玩家条出现');

    // 回合横幅上要显示思考时间倒计时（轮到真人时才有）
    const bannerText = el.turnBanner.querySelector('.turn-text').textContent;
    assert.match(
      bannerText,
      /\d+s/,
      `轮到真人时回合横幅应当显示倒计时，实际是「${bannerText}」`,
    );

    let chips = readChips(el);
    assert.equal(chips.length, 4, '应当有 4 个玩家');
    assert.deepEqual(
      chips.map((c) => c.state),
      ['在线', '在线', 'AI', 'AI'],
      'A、B 在线，2/3 号位是 AI',
    );
    assert.deepEqual(
      chips.slice(0, 2).map((c) => c.name),
      ['玩家A', '玩家B'],
    );
    assert.ok(
      chips[2].name.includes('AI') && chips[3].name.includes('AI'),
      `AI 座位应当有名字，实际是 ${chips[2].name} / ${chips[3].name}`,
    );
    assert.equal(chips[0].me, true, '0 号位应当标成「我」');

    /* ---------- 5. B 拔线 → 状态变成「离线」 ---------- */
    b.destroy();
    b = null;
    await until(() => readChips(el)[1]?.state === '离线', 10000, 'A 看到 B 离线');

    chips = readChips(el);
    assert.equal(chips[1].state, '离线', 'B 拔线后应当显示离线');
    assert.equal(chips[0].state, '在线', 'A 自己不受影响，仍是在线');
    assert.equal(chips[1].name, '玩家B', '离线了也要保留名字，不能变成空位');

    /* ---------- 6. A 自己断线 → 显示「重连中」，而不是「离线」 ---------- */
    // 直接关掉底层 socket，模拟网络断了（不走 disconnect()，否则会标记为主动退出）
    client.ws.close();
    await until(() => readChips(el)[0]?.state === '重连中', 5000, 'A 自己显示重连中');

    const after = readChips(el);
    assert.equal(after[0].state, '重连中', '自己掉线应当是「重连中」而不是「离线」');
    assert.equal(after[0].me, true);

    /* ---------- 7. 重连成功后又回到在线 ---------- */
    await until(() => readChips(el)[0]?.state === '在线', 15000, 'A 自动重连回在线');
    assert.equal(readChips(el)[0].state, '在线', '重连成功后应当恢复在线');
  } finally {
    if (b) b.destroy();
    hook.disconnect();
    await serverApp.close();
  }
});
