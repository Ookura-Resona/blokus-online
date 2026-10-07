/**
 * 涓存椂宸ュ叿锛氶獙璇?Durable Object 鐨?*瀛樺偍鎸佷箙鍖?*銆? *
 *   node tools/_persist-phase.js before   # 寤烘埧銆佽蛋鍑犳墜銆佹妸灞€闈㈠瓨鍒版枃浠? *   锛堥噸鍚?wrangler dev锛屾妸 DO 瀹炰緥鏉€鎺夛級
 *   node tools/_persist-phase.js after    # 閲嶈繛鍚屼竴涓埧鍙凤紝姣斿灞€闈? *
 * 鍙湁 after 闃舵鑳芥仮澶嶅嚭 before 闃舵鐨勬鐩橈紝鎵嶈鏄庣姸鎬佺湡鐨勮惤鍒颁簡 DO 瀛樺偍閲岋紝
 * 鑰屼笉鏄彧娲诲湪鍐呭瓨涓€? */

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

async function until(fn, timeoutMs = 15000, label = '鏉′欢') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`绛夊緟銆?{label}銆嶈秴鏃禶);
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

if (phase === 'before') {
  const res = await fetch(`${TARGET}/api/new-room`, { cache: 'no-store' });
  const { code } = await res.json();

  const { ws } = await join(code, 'persist-probe', '鎸佷箙鍖栨帰娴?);
  for (const seat of [1, 2, 3]) ws.sendJSON({ t: C2S.SET_SEAT, seat, kind: 'ai' });
  await until(() => ws.latest(S2C.ROOM)?.seats.filter((s) => s.kind === 'ai').length === 3, 8000, '琛?AI');

  ws.sendJSON({ t: C2S.START });
  await until(() => ws.latest(S2C.STATE)?.state, 8000, '寮€灞€');

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
  if (!snap) throw new Error('娌℃嬁鍒板眬闈?);

  fs.writeFileSync(
    SAVE,
    JSON.stringify({ code, board: snap.board, moveCount: snap.moveCount, remaining0: snap.remaining[0].length }),
    'utf8',
  );

  console.log(`\n[befor] 鎴垮彿 ${code}`);
  console.log(`        鎵嬫暟 ${snap.moveCount}锛? 鍙蜂綅鍓?${snap.remaining[0].length} 鍧梎);
  console.log(`        宸插崰 ${snap.board.split('').filter((c) => c !== '.').length} 鏍糮);
  console.log(`        宸插瓨鍒?${path.relative(ROOT, SAVE)}\n`);
  ws.destroy();
  process.exit(0);
}

if (phase === 'after') {
  if (!fs.existsSync(SAVE)) {
    console.error('鍏堣窇 before');
    process.exit(2);
  }
  const saved = JSON.parse(fs.readFileSync(SAVE, 'utf8'));

  const { ws, room } = await join(saved.code, 'persist-probe', '鎸佷箙鍖栨帰娴?);
  console.log(`\n[after] 閲嶈繛鎴垮彿 ${saved.code}锛屽骇浣?${room.yourSeat}`);

  const state = ws.latest(S2C.STATE)?.state ?? (await ws.waitJson(S2C.STATE, 8000)).state;

  let same = 0;
  let changed = 0;
  for (let i = 0; i < saved.board.length; i++) {
    if (saved.board[i] === '.') continue;
    if (state.board[i] === saved.board[i]) same++;
    else changed++;
  }

  console.log(`        鎭㈠鍚庢墜鏁?${state.moveCount}锛堥噸鍚墠 ${saved.moveCount}锛塦);
  console.log(`        閲嶅惎鍓嶅凡鍗犵殑鏍煎瓙锛?{same} 鏍奸鑹蹭竴鑷达紝${changed} 鏍煎涓嶄笂`);
  console.log(`        0 鍙蜂綅鍓?${state.remaining[0].length} 鍧楋紙閲嶅惎鍓?${saved.remaining0} 鍧楋級`);

  // 鍒ゅ畾鏍囧噯锛?  //  路 changed === 0 鈥斺€?閲嶅惎鍓嶅崰鐨勬瘡涓€鏍奸鑹查兘娌″彉锛岃鏄庢灞€琚畬鏁翠繚瀛樺苟鎭㈠
  //  路 moveCount 鍙涓嶅噺 鈥斺€?璇存槑鎭㈠鐨勬槸鍚屼竴灞€锛屼笉鏄柊寤虹殑绌烘埧闂?  // 娉ㄦ剰**涓嶈兘**鏂█ remaining[0] 涓嶅彉锛氳剼鏈€€鍑哄悗娓告垙浠嶅湪鏈嶅姟绔户缁窇锛?  // 鎺夌嚎鐨?0 鍙蜂綅浼氳鑷姩鎵樼锛屾墍浠ュ畠浼氬悎娉曞湴澶氫笅鍑犳墜銆?  const ok = changed === 0 && state.moveCount >= saved.moveCount && same > 0;
  console.log(
    ok
      ? '\n鉁?DO 瀛樺偍鎸佷箙鍖栫敓鏁堬細DO 瀹炰緥琚潃鎺夐噸寤哄悗锛屾埧闂翠笌妫嬪眬瀹屾暣鎭㈠\n'
      : '\n鉂?鐘舵€佹病鑳藉畬鏁存仮澶峔n',
  );
  ws.destroy();
  process.exit(ok ? 0 : 1);
}

console.error('鐢ㄦ硶锛歯ode tools/_persist-phase.js before|after');
process.exit(2);
