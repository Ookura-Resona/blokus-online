/**
 * 部署自检：验证一个**已经部署好的地址**是否完整可用。
 *
 *   node tools/check-deploy.js https://xxx.trycloudflare.com
 *   node tools/check-deploy.js http://192.168.1.23:3000
 *
 * 和 tools/smoke.js 的区别：smoke.js 假设你就在服务器本机（纯 TCP），
 * 这个是走真实 URL（支持 https/wss），用来验证公网隧道、反向代理、
 * 证书、WebSocket 升级这些「出了本机才有的问题」。
 *
 * 特别是反向代理：Nginx 少写 `Upgrade`/`Connection` 头的话，
 * 静态页面能打开、但一连 WebSocket 就挂 —— 这个脚本正好能抓到。
 */

const target = process.argv[2];
if (!target) {
  console.error('用法：node tools/check-deploy.js <http(s)://地址>');
  process.exit(2);
}

const base = target.replace(/\/+$/, '');
const wsBase = base.replace(/^http/, 'ws');
const wsUrl = `${wsBase}/ws`;

let failures = 0;
const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  \u2717 ${m}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── 1. HTTP 静态资源 ───────────────────────── */

console.log(`\n检查部署地址：${base}\n`);
console.log('[1] HTTPS / 静态资源');

for (const [path, needle] of [
  ['/', '角斗士棋'],
  ['/style.css', '--primary'],
  ['/app.js', 'BoardView'],
  ['/board.js', 'drawPiecePreview'],
  ['/shared/rules.js', 'legalMoves'],
  ['/shared/constants.js', 'BOARD_SIZE'],
  ['/healthz', '"ok":true'],
  ['/api/config', 'boardSize'],
]) {
  try {
    const res = await fetch(base + path, { redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) bad(`${path} -> HTTP ${res.status}`);
    else if (!text.includes(needle)) bad(`${path} 内容里找不到「${needle}」`);
    else ok(`${path}  ${res.status}  ${text.length} 字节`);
  } catch (err) {
    bad(`${path} 请求失败：${err.cause?.code ?? err.message}`);
  }
}

/* ───────────────────────── 2. WebSocket 升级 ───────────────────────── */

console.log('\n[2] WebSocket（反向代理最容易坏的就是这里）');
console.log(`    目标：${wsUrl}`);

/** 打开一条 WebSocket，返回带消息日志的小封装 */
function open(label) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      reject(new Error(`${label} 无法构造 WebSocket：${err.message}`));
      return;
    }
    const client = {
      label,
      ws,
      messages: [],
      errors: [],
      send(obj) {
        ws.send(JSON.stringify(obj));
      },
      latest(type) {
        for (let i = client.messages.length - 1; i >= 0; i--) {
          if (client.messages[i].t === type) return client.messages[i];
        }
        return null;
      },
      async wait(type, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const hit = client.latest(type);
          if (hit) return hit;
          if (client.errors.length) throw new Error(`${label} 出错：${client.errors.join('; ')}`);
          if (Date.now() > deadline) throw new Error(`${label} 等待 ${type} 超时`);
          await sleep(30);
        }
      },
    };
    const timer = setTimeout(() => reject(new Error(`${label} 连接超时（10 秒没完成升级）`)), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(client);
    });
    ws.addEventListener('message', (e) => {
      try {
        client.messages.push(JSON.parse(e.data));
      } catch {
        /* 忽略非 JSON */
      }
    });
    ws.addEventListener('error', () => client.errors.push('连接错误'));
    ws.addEventListener('close', (e) => {
      if (e.code !== 1000 && e.code !== 1005) {
        client.errors.push(`被关闭 code=${e.code}${e.reason ? ' ' + e.reason : ''}`);
      }
    });
  });
}

try {
  const a = await open('客户端A');
  ok('WebSocket 升级成功（wss 握手通过）');
  a.send({ t: 'hello', playerId: 'deploy-check-a', name: '部署自检A' });
  const welcome = await a.wait('welcome');
  ok(`收到 welcome：${welcome.you.name}`);

  const b = await open('客户端B');
  b.send({ t: 'hello', playerId: 'deploy-check-b', name: '部署自检B' });
  await b.wait('welcome');
  ok('第二条连接也升级成功');

  /* ───────────────────── 3. 完整走一遍联机流程 ───────────────────── */

  console.log('\n[3] 联机流程');

  a.send({ t: 'createRoom', mode: 'ffa' });
  const room = await a.wait('room');
  ok(`建房成功，房号 ${room.code}`);

  b.send({ t: 'joinRoom', code: room.code });
  const roomB = await b.wait('room');
  if (roomB.code !== room.code) bad('B 加入后拿到的房号不对');
  else ok(`B 加入成功，坐在 ${roomB.yourSeat} 号位`);

  a.send({ t: 'start' });
  await a.wait('state');
  ok('开局成功（空位自动补 AI）');

  // 等座位 0 的回合，落一手，确认状态能双向同步
  let moved = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const st = a.latest('state');
    if (st && !st.state.over && st.state.turn === 0 && !moved) {
      // 首子占角：找一个合法的落点
      const { deserializeState } = await import('../shared/rules.js');
      const { chooseMove } = await import('../shared/ai.js');
      const mv = chooseMove(deserializeState(st.state), 0, { difficulty: 'easy' });
      if (mv) {
        a.send({ t: 'move', pieceId: mv.pieceId, orient: mv.orient, x: mv.x, y: mv.y });
        moved = true;
      }
    }
    if (moved) {
      const before = a.latest('state').state.moveCount;
      await sleep(300);
      const after = a.latest('state').state.moveCount;
      if (after > before) {
        ok(`落子成功并被服务端确认（moveCount ${before} → ${after}）`);
        break;
      }
      const err = a.latest('error');
      if (err) {
        bad(`落子被拒：${err.message}`);
        break;
      }
    }
    await sleep(50);
  }
  if (!moved) bad('20 秒内没能落子，状态同步可能有问题');

  // B 也应该收到同一份状态（广播链路）
  await sleep(300);
  const aState = a.latest('state')?.state;
  const bState = b.latest('state')?.state;
  if (!aState || !bState) bad('有一方没收到对局状态');
  else if (aState.board !== bState.board) bad('两个客户端看到的棋盘不一致');
  else ok('两个客户端看到的棋盘完全一致（广播正常）');

  const errs = [...a.errors, ...b.errors];
  if (errs.length) bad(`连接期间出现错误：${errs.join('; ')}`);

  console.log(`\n邀请链接：${base}/?r=${room.code}`);
  try {
    a.ws.close();
    b.ws.close();
  } catch {
    /* 忽略 */
  }
} catch (err) {
  bad(err.message);
}

void 0;

console.log(failures === 0 ? '\n部署自检全部通过 \u2713\n' : `\n有 ${failures} 项失败 \u2717\n`);
process.exit(failures === 0 ? 0 : 1);
