/**
 * 冒烟检查：对「真实运行中的服务器」做一次端到端验证。
 *
 *   node tools/smoke.js                # 默认 127.0.0.1:3000
 *   node tools/smoke.js 10.0.0.5:8080
 *
 * 会检查：静态资源、路径穿越防护、/api/config、以及用两条真实 WebSocket
 * 连接把一整局打完并核对结算。
 */

import { connectWs } from '../test/wsclient.js';
import { C2S, S2C } from '../shared/protocol.js';
import { deserializeState, allSquares } from '../shared/rules.js';
import { chooseMove, mulberry32 } from '../shared/ai.js';

const target = process.argv[2] ?? '127.0.0.1:3000';
const [host, portStr] = target.split(':');
const port = Number(portStr ?? 80);
const base = `http://${target}`;

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  ✗ ${m}`);
};

/* ---------------------------- 1. 静态资源 ---------------------------- */

console.log(`\n检查 ${base}\n`);

for (const [path, needle] of [
  ['/', '角斗士棋'],
  ['/app.js', 'BoardView'],
  ['/board.js', 'drawPiecePreview'],
  ['/shared/rules.js', 'legalMoves'],
  ['/shared/pieces.js', 'orientations'],
  ['/style.css', '--primary'],
  ['/healthz', '"ok":true'],
  ['/api/config', 'boardSize'],
]) {
  try {
    const res = await fetch(base + path);
    const text = await res.text();
    if (!res.ok) bad(`${path} 返回 HTTP ${res.status}`);
    else if (!text.includes(needle)) bad(`${path} 内容里找不到「${needle}」`);
    else ok(`${path}  ${res.status}  ${text.length} 字节`);
  } catch (err) {
    bad(`${path} 请求失败：${err.message}`);
  }
}

// 路径穿越必须被挡住
for (const evil of ['/shared/../../package.json', '/../server/index.js', '/%2e%2e/package.json']) {
  try {
    const res = await fetch(base + evil);
    if (res.status === 404) ok(`路径穿越被拦截：${evil}`);
    else bad(`路径穿越没被挡住：${evil} → HTTP ${res.status}`);
  } catch (err) {
    bad(`路径穿越测试异常 ${evil}：${err.message}`);
  }
}

/* ---------------------------- 2. 联机对局 ---------------------------- */

const clients = [];
const seen = { state: null, result: null, errors: [] };

async function makeClient(name, id) {
  const ws = await connectWs(port, { host });
  ws.sendJSON({ t: C2S.HELLO, playerId: id, name });
  await ws.waitJson(S2C.WELCOME);
  clients.push(ws);
  return ws;
}

/** 从两条连接的日志里合并出最新状态（注意 latest 返回的是消息，快照在 .state） */
function refreshSeen() {
  for (const c of clients) {
    const raw = c.latest(S2C.STATE)?.state;
    if (raw && (!seen.state || raw.moveCount >= seen.state.moveCount)) seen.state = raw;
    const r = c.latest(S2C.RESULT)?.result;
    if (r) seen.result = r;
    seen.errors.push(...c.errors());
  }
}

console.log('');

try {
  const a = await makeClient('冒烟A', 'smoke-a');
  const b = await makeClient('冒烟B', 'smoke-b');
  ok('两条 WebSocket 连接建立并完成 hello');

  a.sendJSON({ t: C2S.CREATE_ROOM });
  const room = await a.waitJson(S2C.ROOM);
  ok(`建房成功：房号 ${room.code}，我是 ${room.yourSeat} 号位`);

  b.sendJSON({ t: C2S.JOIN_ROOM, code: room.code });
  const roomB = await b.waitJson(S2C.ROOM);
  if (roomB.yourSeat !== 1) bad(`第二个玩家应当坐 1 号位，实际 ${roomB.yourSeat}`);
  else ok('第二个玩家入座 1 号位');

  // 后台把 a 收到的状态持续记录下来
  a.sendJSON({ t: C2S.START });
  await a.waitJson(S2C.ROOM);
  ok('开局（座位 2/3 自动补 AI）');

  // 用 AI 代打两个真人座位，把整局推完
  const rng = mulberry32(20240607);
  const lastAt = new Map();
  const deadline = Date.now() + 120_000;

  while (!seen.result && Date.now() < deadline) {
    refreshSeen();
    const raw = seen.state;
    if (raw && !raw.over) {
      for (const [client, seat] of [
        [a, 0],
        [b, 1],
      ]) {
        if (raw.turn !== seat) continue;
        if (lastAt.get(seat) === raw.moveCount) continue;
        lastAt.set(seat, raw.moveCount);
        const mv = chooseMove(deserializeState(raw), seat, { difficulty: 'normal', rng });
        if (mv) client.sendJSON({ t: C2S.MOVE, ...mv });
      }
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  refreshSeen();
  seen.errors = [...new Set(seen.errors)];

  if (!seen.result) {
    bad('对局没能在 120 秒内结束');
  } else {
    const r = seen.result;
    ok(`整局打完：共 ${seen.state.moveCount} 手`);
    ok(`名次 ${r.ranking.map((x) => x.rank).join(' / ')}，增减分 ${r.deltas.join(' / ')}`);
    ok(`终局占格 ${allSquares(deserializeState(seen.state)).join(' / ')}`);
    if (r.ranking.map((x) => x.rank).join() !== '1,2,3,4') bad('名次不是 1..4');
    if (seen.errors.length) bad(`对局过程中出现错误：${seen.errors.join('; ')}`);
  }
} catch (err) {
  bad(`联机流程异常：${err.message}`);
} finally {
  for (const c of clients) c.destroy();
}

console.log(failures === 0 ? '\n全部正常 ✓\n' : `\n有 ${failures} 项失败 ✗\n`);
process.exit(failures === 0 ? 0 : 1);
