/**
 * 邀请链接的「连接预热」测试。
 *
 * 背景：WebSocket 握手要 2~3 个来回（TCP + TLS + 协议升级），网络差的时候
 * 能占掉一两秒。所以群里点开邀请链接（URL 带 ?r=房号）时，页面一加载就
 * 开始建连接，用户输昵称的那几秒正好用掉；点「加入」时直接打招呼。
 *
 * 要保证两件事，缺一不可：
 *   1) 连接确实提前建好了（否则优化没生效）
 *   2) 提前建的连接**不能占座位**（否则用户还没点就被算进房间了）
 *
 * 单独一个文件是因为 app.js 是模块单例，得用带查询串的 URL 载入第二份实例。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server/app.js';
import { installDom } from './domstub.js';

register('./web-loader.js', import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs = 8000, label = '条件') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await sleep(20);
  }
}

test('邀请链接：页面一加载就开始建连接，且不占座位；点「加入」后立刻进房', async () => {
  const serverApp = createApp({ aiDelayMs: 5 });
  await new Promise((r) => serverApp.server.listen(0, '127.0.0.1', r));
  const port = serverApp.server.address().port;
  const host = `127.0.0.1:${port}`;

  // 先真的建一个房间，这样后面「加入」能成功
  const { code } = await (
    await fetch(`http://${host}/api/new-room`, { cache: 'no-store' })
  ).json();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/);

  // 模拟「群里点开邀请链接」：URL 上带 ?r=房号
  installDom({ host, search: `?r=${code}`, html: INDEX_HTML });
  await import('../public/app.js?preconnect-test');

  const hook = globalThis.window.__blokus;
  assert.ok(hook, 'app.js 应当挂出 window.__blokus');
  const { app: client, el } = hook;

  try {
    /* ---- 1. 一加载就认下了房号 ---- */
    assert.equal(client.roomCode, code, '页面加载时就该把 URL 里的房号记下来');

    /* ---- 2. 不用用户做任何事，连接自己就建起来了 ---- */
    await until(() => client.connected, 8000, '页面加载后自动建立连接');
    assert.equal(
      client.ws?.readyState,
      1,
      'WebSocket 应当已经处于 OPEN（说明握手在用户输昵称期间就做完了）',
    );

    /* ---- 3. 但**不能**占座位 ---- */
    assert.equal(client.helloDone, false, '用户还没点「加入」，不该已经打过招呼');
    assert.equal(client.room, null, '用户还没点「加入」，不该已经在房间里（否则会白占一个座位）');

    // 再等一会儿，确认不是「还没来得及打招呼」而是真的不打
    await sleep(400);
    assert.equal(client.helloDone, false, '等待之后仍然不该自动打招呼');
    assert.equal(client.room, null, '等待之后仍然不该自动进房');

    /* ---- 4. 点「加入」之后要立刻进房（复用已经建好的连接） ---- */
    const wsBefore = client.ws; // 记下当前连接，等下要确认没换一条
    el.inputName.value = '预热测试员';
    el.btnJoin.click();

    const room = await until(() => client.room, 8000, '点加入后进房');
    assert.equal(room.code, code, '应当进的是链接里那个房间');
    assert.equal(client.ws, wsBefore, '应当复用预热好的那条连接，而不是重新建一条');
    assert.equal(client.connected, true);
    assert.equal(el.screenRoom.classList.contains('is-active'), true, '应当切到房间界面');
  } finally {
    hook.disconnect();
    await serverApp.close();
  }
});
