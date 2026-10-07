/**
 * 角斗士棋主应用：连接、大厅、对局 UI。
 *
 * 服务端权威：本地只用规则引擎做「预演」（高亮合法位置、棋子栏灰显），
 * 真正的落子必须等服务端确认。
 */

import {
  SEAT_HEX,
  SEAT_LABELS,
  SEAT_COUNT,
  MODE_TEAM,
  TEAM_OF_SEAT,
} from '/shared/constants.js';
import { PIECE_BY_ID } from '/shared/pieces.js';
import { C2S, S2C } from '/shared/protocol.js';
import { BoardView, drawPiecePreview } from '/board.js';

/* ══════════════════════════ 基础工具 ══════════════════════════ */

const $ = (id) => document.getElementById(id);

const el = {
  connBar: $('conn-bar'),
  connText: $('conn-text'),

  screenHome: $('screen-home'),
  screenRoom: $('screen-room'),
  screenGame: $('screen-game'),

  inputName: $('input-name'),
  inputCode: $('input-code'),
  btnCreate: $('btn-create'),
  btnJoin: $('btn-join'),
  homeHint: $('home-hint'),

  roomCode: $('room-code'),
  btnShare: $('btn-share'),
  btnCopy: $('btn-copy'),
  seatList: $('seat-list'),
  playersBar: $('players-bar'),
  seatHint: $('seat-hint'),
  roomModeLabel: $('room-mode-label'),
  segMode: $('seg-mode'),
  segDifficulty: $('seg-difficulty'),
  btnStart: $('btn-start'),
  roomHint: $('room-hint'),
  leaderboard: $('leaderboard'),
  chatLog: $('chat-log'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
  btnLeave: $('btn-leave'),

  turnBanner: $('turn-banner'),
  boardWrap: $('board-wrap'),
  boardCanvas: $('board'),
  boardTip: $('board-tip'),
  btnRotate: $('btn-rotate'),
  btnFlip: $('btn-flip'),
  btnConfirm: $('btn-confirm'),
  btnCancel: $('btn-cancel'),
  trayInfo: $('tray-info'),
  tray: $('tray'),
  chkSnap: $('chk-snap'),
  btnRules: $('btn-rules'),
  btnResult: $('btn-result'),
  btnScoreboard: $('btn-scoreboard'),

  sheet: $('sheet'),
  sheetBackdrop: $('sheet-backdrop'),
  sheetTitle: $('sheet-title'),
  sheetBody: $('sheet-body'),
  btnSheetClose: $('btn-sheet-close'),

  resultModal: $('result-modal'),
  resultTitle: $('result-title'),
  resultSub: $('result-sub'),
  resultRows: $('result-rows'),
  resultSummary: $('result-summary'),
  resultBonus: $('result-bonus'),
  btnAgain: $('btn-again'),
  btnViewBoard: $('btn-view-board'),
  btnBackRoom: $('btn-back-room'),

  toastWrap: $('toast-wrap'),
};

function toast(message, kind = '') {
  if (!message) return;
  const div = document.createElement('div');
  div.className = `toast ${kind}`;
  div.textContent = message;
  el.toastWrap.appendChild(div);
  setTimeout(() => {
    div.style.transition = 'opacity .25s';
    div.style.opacity = '0';
    setTimeout(() => div.remove(), 260);
  }, 2200);
}

function showScreen(name) {
  for (const [key, node] of [
    ['home', el.screenHome],
    ['room', el.screenRoom],
    ['game', el.screenGame],
  ]) {
    node.classList.toggle('is-active', key === name);
  }
  window.scrollTo(0, 0);
  if (name === 'game') {
    requestAnimationFrame(() => board.resize());
  }
}

/* ══════════════════════════ 本地身份 ══════════════════════════ */

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

let playerId = localStorage.getItem('blokus.pid');
if (!playerId) {
  playerId = uuid();
  localStorage.setItem('blokus.pid', playerId);
}

const savedName = localStorage.getItem('blokus.name') ?? '';
el.inputName.value = savedName;

/** URL 里的 ?r=CODE（群里点开的邀请链接） */
const urlRoom = (new URLSearchParams(location.search).get('r') ?? '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '')
  .slice(0, 4);
if (urlRoom) el.inputCode.value = urlRoom;

/* ══════════════════════════ 会话状态 ══════════════════════════ */

const app = {
  ws: null,
  connected: false,
  helloDone: false,
  // 连上之后要不要立刻向服务端打招呼换身份。
  // 页面加载时可能只是先把连接**预热**好（用户还在输昵称），那时不该打招呼，
  // 否则会白白占住一个座位。点了「加入」才置为 true。
  pendingHello: false,
  reconnectDelay: 800,
  reconnectTimer: null,
  shuttingDown: false,
  roomCode: null,
  room: null,
  lastState: null,
  result: null,
  seenLogLength: 0,
  selectedPiece: null,
  seatNames: {},
};

/* ══════════════════════════ WebSocket ══════════════════════════ */

/**
 * 连接地址带上房号。
 *
 * 这是为了 Cloudflare Workers 那一版：那边的房间是 Durable Object，
 * 「一个房号一个实例」，所以必须先知道房号才能连到正确的房间上。
 * Node 自托管版本无所谓（一个进程管所有房间），多带个查询参数也不影响。
 */
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = app.roomCode ? `?room=${encodeURIComponent(app.roomCode)}` : '';
  return `${proto}//${location.host}/ws${q}`;
}

function send(obj) {
  if (app.ws?.readyState === WebSocket.OPEN) {
    app.ws.send(JSON.stringify(obj));
  }
}

/**
 * 向服务端打招呼换身份。服务端回 welcome 之后才会 joinRoom。
 * 单独抽出来是因为它可能发生在两个时机：连接刚打开（正常流程），
 * 或者连接早就预热好了、用户这时才点「加入」。
 */
function sendHello() {
  app.pendingHello = false;
  send({ t: C2S.HELLO, playerId, name: currentName() });
}

function setConn(state, text) {
  el.connBar.hidden = state === 'ok';
  el.connBar.classList.toggle('is-ok', state === 'ok');
  el.connText.textContent = text;
  // 自己的连接状态变了，玩家条上「重连中」要立刻反映出来
  renderPlayers();
}

/**
 * 对局中的玩家状态条。
 *
 * 状态有两个来源：
 *   · 别人的 —— 服务端在 ROOM 广播里给的 `connected`。玩家掉线时服务端会重新
 *     广播一次，所以这边能收到。
 *   · 我自己的 —— 只能前端自己判断。我掉线的时候服务端就算把我标成离线，
 *     那条广播我也收不到，所以「重连中」必须由本地状态推导。
 */
function renderPlayers() {
  const room = app.room;
  // 大厅里有完整的座位卡片，这条只在开局后显示
  if (!room || room.phase === 'lobby') {
    el.playersBar.hidden = true;
    el.playersBar.innerHTML = '';
    return;
  }

  el.playersBar.hidden = false;
  el.playersBar.innerHTML = '';
  const turn = app.lastState && !app.lastState.over ? app.lastState.turn : null;

  for (const s of room.seats) {
    const node = document.createElement('div');
    node.className = 'player-chip';
    node.style.setProperty('--c', SEAT_HEX[s.seat]);
    if (s.isYou) node.classList.add('is-me');
    if (turn === s.seat) node.classList.add('is-turn');

    let state;
    let cls;
    if (s.kind === 'ai') {
      state = 'AI';
      cls = 'is-online';
    } else if (s.kind === 'open') {
      state = '空位';
      cls = 'is-offline';
    } else if (s.isYou && !app.connected) {
      // 我自己的座位：连接断了就是在重连，而不是「离线」
      state = '重连中';
      cls = 'is-reconnecting';
    } else if (!s.connected) {
      state = '离线';
      cls = 'is-offline';
    } else {
      state = '在线';
      cls = 'is-online';
    }
    node.classList.add(cls);

    const dot = document.createElement('i');
    dot.className = 'pc-dot';

    const name = document.createElement('span');
    name.className = 'pc-name';
    name.textContent = s.name ?? `座位 ${s.seat + 1}`;

    const st = document.createElement('span');
    st.className = 'pc-state';
    st.textContent = state;

    node.append(dot, name, st);
    el.playersBar.append(node);
  }
}

/** 进入房间：先定下房号，再按房号连到对应的房间实例 */
function enterRoom(code) {
  const clean = String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
  if (clean.length !== 4) {
    el.homeHint.textContent = '房号是 4 位字符，例如 A7KQ。';
    return false;
  }

  app.roomCode = clean;
  app.room = null;
  app.lastState = null;
  app.result = null;
  app.seenLogLength = 0;
  app.reconnectDelay = 800;
  app.shuttingDown = false; // 之前离开过房间的话，这里重新放行重连
  el.homeHint.textContent = '';
  el.inputCode.value = clean;
  closeResult();
  showScreen('room');
  app.pendingHello = true;
  connect();
  // 连接可能是页面加载时就预热好的（群里点开的邀请链接会走这条路），
  // 那样握手早就做完了，直接打招呼即可，不用让用户再等两三个来回。
  if (app.ws?.readyState === WebSocket.OPEN) sendHello();
  return true;
}

/** 离开房间：关掉连接（服务端会在断开时回收座位） */
function leaveRoom() {
  app.roomCode = null;
  app.room = null;
  app.lastState = null;
  app.result = null;
  app.seenLogLength = 0;
  disconnect();
  app.shuttingDown = false; // 之后还要能再进别的房间
  closeResult();
  showScreen('home');
  history.replaceState(null, '', location.pathname);
}

function connect() {
  if (!app.roomCode) return; // 还没进房间，不需要连着
  // 已经在连 / 已经连上了就别重复开
  if (app.ws && (app.ws.readyState === WebSocket.CONNECTING || app.ws.readyState === WebSocket.OPEN)) {
    return;
  }

  setConn('connecting', '正在连接房间…');
  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch (err) {
    setConn('bad', '无法连接服务器');
    scheduleReconnect();
    return;
  }
  app.ws = ws;

  ws.addEventListener('open', () => {
    app.connected = true;
    app.reconnectDelay = 800;
    setConn('ok', '已连接');
    el.connBar.hidden = true;
    // 只在这条连接确实要用来进房间时才打招呼。
    // 页面加载时预热的那种连接不打招呼，免得占住座位。
    if (app.pendingHello) sendHello();
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    app.connected = false;
    app.helloDone = false;
    if (app.shuttingDown || !app.roomCode) return;
    // 重连之后要重新打招呼才能坐回原来的座位
    app.pendingHello = true;
    setConn('bad', '连接断开，正在重连…');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    /* close 事件里统一处理 */
  });
}

function scheduleReconnect() {
  if (app.shuttingDown) return;
  const delay = app.reconnectDelay;
  app.reconnectDelay = Math.min(8000, app.reconnectDelay * 1.7);
  app.reconnectTimer = setTimeout(() => {
    if (!app.connected && !app.shuttingDown) connect();
  }, delay);
}

/** 主动断开并停止自动重连 */
function disconnect() {
  app.shuttingDown = true;
  clearTimeout(app.reconnectTimer);
  app.reconnectTimer = null;
  try {
    app.ws?.close();
  } catch {
    /* 忽略 */
  }
  app.connected = false;
}

function currentName() {
  const n = el.inputName.value.trim().slice(0, 16);
  return n || savedName || `玩家${Math.floor(Math.random() * 9000) + 1000}`;
}

/* ══════════════════════════ 消息分发 ══════════════════════════ */

function handleMessage(msg) {
  switch (msg.t) {
    case S2C.WELCOME:
      playerId = msg.you.playerId;
      localStorage.setItem('blokus.pid', playerId);
      app.helloDone = true;
      // 拿到身份之后再进房间。重连时服务端会按 playerId 把人放回原来的座位。
      if (app.roomCode) send({ t: C2S.JOIN_ROOM, code: app.roomCode });
      break;

    case S2C.ROOM:
      if (msg.left || !msg.code) {
        app.roomCode = null;
        app.room = null;
        app.lastState = null;
        app.result = null;
        closeResult();
        showScreen('home');
        history.replaceState(null, '', location.pathname);
        return;
      }
      app.roomCode = msg.code;
      app.room = msg;
      renderRoom(msg);
      if (msg.phase === 'lobby') {
        // 回到大厅意味着新的一局要开始了：清掉上一局的残留，
        // 否则下一局终局广播 STATE(over) 时会先闪出上一局的结算浮层。
        app.result = null;
        app.lastState = null;
        app.seenLogLength = 0;
        closeResult();
        showScreen('room');
      }
      break;

    case S2C.STATE:
      app.lastState = msg.state;
      if (!el.screenGame.classList.contains('is-active')) showScreen('game');
      board.setMySeat(app.room?.yourSeat ?? null);
      board.setState(msg.state);
      updateForState(msg.state);
      noteNewLogs(msg.state);
      renderPlayers(); // 轮次变了，玩家条上的高亮跟着走
      if (msg.state.over && app.result) showResult(app.result);
      break;

    case S2C.RESULT:
      app.result = msg.result;
      showResult(msg.result);
      break;

    case S2C.ERROR:
      toast(msg.message, 'err');
      // 断线重连时房间可能已经没了 —— 别把玩家卡在一个死界面上
      if (app.roomCode && /不存在/.test(msg.message)) {
        app.roomCode = null;
        app.room = null;
        app.lastState = null;
        app.result = null;
        closeResult();
        showScreen('home');
        history.replaceState(null, '', location.pathname);
        el.homeHint.textContent = '那个房间已经关闭了，重新建一个吧。';
      }
      break;

    case S2C.CHAT:
      appendChat(msg, true);
      break;

    case S2C.MOVE_MADE:
      if (msg.auto) {
        const who = SEAT_LABELS[msg.seat] ?? `座位${msg.seat}`;
        toast(`${who} 由系统托管落子`, '');
      }
      break;

    default:
      break;
  }
}

/* ══════════════════════════ 大厅渲染 ══════════════════════════ */

function renderRoom(room) {
  el.roomCode.textContent = room.code;
  el.roomModeLabel.textContent = room.mode === MODE_TEAM ? '二对二' : '四人混战';
  renderPlayers();

  // 座位
  el.seatList.innerHTML = '';
  for (const s of room.seats) {
    const node = document.createElement('div');
    node.className = 'seat-card';
    if (s.kind === 'open') node.classList.add('is-open');
    if (s.isYou) node.classList.add('is-me');
    if (app.lastState && !app.lastState.over && app.lastState.turn === s.seat) {
      node.classList.add('is-turn');
    }
    node.style.setProperty('--c', SEAT_HEX[s.seat]);

    const color = document.createElement('div');
    color.className = 'seat-color';

    const main = document.createElement('div');
    main.className = 'seat-main';
    const name = document.createElement('div');
    name.className = 'seat-name';
    name.textContent = s.name ?? '空位（点我坐下）';
    const meta = document.createElement('div');
    meta.className = 'seat-meta';
    meta.textContent = `${SEAT_LABELS[s.seat]} · ${
      room.mode === MODE_TEAM ? `第 ${TEAM_OF_SEAT[s.seat] + 1} 队` : `座位 ${s.seat + 1}`
    }`;
    main.append(name, meta);

    const tags = document.createElement('div');
    tags.className = 'seat-tags';
    if (s.isHost) tags.append(tag('房主'));
    if (s.isYou) tags.append(tag('你', 'you'));
    if (s.kind === 'ai') tags.append(tag('AI', 'ok'));
    if (s.kind === 'human' && !s.connected) tags.append(tag('离线', 'off'));
    if (s.sessionScore !== null && s.sessionScore !== undefined && s.sessionScore !== 0) {
      tags.append(tag(`${s.sessionScore > 0 ? '+' : ''}${s.sessionScore}`, s.sessionScore > 0 ? 'ok' : 'off'));
    }

    node.append(color, main, tags);
    node.addEventListener('click', () => onSeatClick(s));
    el.seatList.append(node);
  }

  // 模式 / 难度 分段控件
  for (const b of el.segMode.querySelectorAll('.seg-btn')) {
    b.classList.toggle('is-active', b.dataset.mode === room.mode);
  }
  for (const b of el.segDifficulty.querySelectorAll('.seg-btn')) {
    b.classList.toggle('is-active', b.dataset.difficulty === room.difficulty);
  }
  const locked = !room.isHost || room.phase !== 'lobby';
  el.segMode.classList.toggle('is-locked', locked);
  el.segDifficulty.classList.toggle('is-locked', locked);

  // 开局按钮：对局结束后变成「再来一局」，否则房主会被卡在房间里出不去
  const over = room.phase === 'over';
  el.btnStart.disabled = !room.isHost || room.phase === 'playing';
  el.btnStart.textContent = over
    ? room.isHost
      ? '再来一局'
      : '等房主再开一局'
    : room.isHost
      ? '开始游戏'
      : '等房主开始';
  const humans = room.seats.filter((s) => s.kind === 'human').length;
  const empties = room.seats.filter((s) => s.kind === 'open').length;
  if (room.phase === 'playing') {
    el.roomHint.textContent = '对局进行中…';
  } else if (over) {
    el.roomHint.textContent = room.isHost
      ? '本局已结束，点「再来一局」重开（累计积分会保留）。'
      : '本局已结束，等房主重开。';
  } else if (!room.isHost) {
    el.roomHint.textContent = `当前 ${humans} 位真人，空位会由房主补 AI。`;
  } else if (empties > 0) {
    el.roomHint.textContent = `还有 ${empties} 个空位，开局时会自动补成 AI（难度：${
      { easy: '简单', normal: '普通', hard: '困难' }[room.difficulty] ?? room.difficulty
    }）。`;
  } else {
    el.roomHint.textContent = '人齐了，点上面开始。';
  }

  // 排行榜
  renderLeaderboard(room.leaderboard);

  // 聊天
  if (el.chatLog.childElementCount === 0) {
    for (const c of room.chat ?? []) appendChat(c, false);
  } else {
    for (const c of room.chat ?? []) {
      if (!el.chatLog.querySelector(`[data-at="${c.at}"][data-name="${cssEscape(c.name)}"]`)) {
        appendChat(c, false);
      }
    }
  }

  el.seatHint.textContent = room.isHost
    ? '点空位可以自己坐下；长按（或点右侧）把空位设成 AI —— 也可以直接开局，空位会自动补 AI。'
    : '点空位坐下。人数不够时房主开局的空位会自动补 AI。';
}

function tag(text, kind = '') {
  const s = document.createElement('span');
  s.className = `tag ${kind}`;
  s.textContent = text;
  return s;
}

function cssEscape(s) {
  return String(s ?? '').replace(/["\\]/g, '\\$&');
}

function onSeatClick(seat) {
  const room = app.room;
  if (!room || room.phase !== 'lobby') return;
  if (seat.isYou) {
    send({ t: C2S.LEAVE_SEAT });
    return;
  }
  if (seat.kind === 'open') {
    send({ t: C2S.TAKE_SEAT, seat: seat.seat });
    return;
  }
  if (room.isHost && seat.kind !== 'open') {
    // 房主点已有人的 AI 位 → 收回成空位；点真人的位置不做处理
    if (seat.kind === 'ai') send({ t: C2S.SET_SEAT, seat: seat.seat, kind: 'open' });
    return;
  }
}

function renderLeaderboard(rows) {
  el.leaderboard.innerHTML = '';
  if (!rows || rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '还没有人对局过';
    el.leaderboard.append(li);
    return;
  }
  for (const r of rows) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'lb-name';
    name.textContent = r.name;
    const score = document.createElement('span');
    score.className = `lb-score ${r.score > 0 ? 'pos' : r.score < 0 ? 'neg' : ''}`;
    score.textContent = r.score > 0 ? `+${r.score}` : String(r.score);
    li.append(name, score);
    el.leaderboard.append(li);
  }
}

function appendChat(msg, scroll) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  line.dataset.at = msg.at ?? '';
  line.dataset.name = msg.name ?? '';
  if (msg.seat === null || msg.seat === undefined) {
    line.classList.add('system');
    line.textContent = `${msg.name}：${msg.text}`;
  } else {
    const b = document.createElement('b');
    b.style.color = SEAT_HEX[msg.seat] ?? '';
    b.textContent = msg.name;
    line.append(b, document.createTextNode(msg.text));
  }
  el.chatLog.append(line);
  if (scroll) el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

/* ══════════════════════════ 对局 UI ══════════════════════════ */

const board = new BoardView(el.boardCanvas, {
  onConfirm: (move) => {
    send({ t: C2S.MOVE, pieceId: move.pieceId, orient: move.orient, x: move.x, y: move.y });
  },
  onTip: (text) => {
    el.boardTip.textContent = text;
    el.boardTip.hidden = !text;
  },
  onSelectChange: (pieceId) => {
    app.selectedPiece = pieceId;
    updateTraySelection();
    updateActionButtons();
  },
});

function squaresOfState(state) {
  const out = new Array(SEAT_COUNT).fill(0);
  if (!state) return out;
  const s = state.board;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 46) out[c - 48]++;
  }
  return out;
}

function updateForState(state) {
  const mySeat = app.room?.yourSeat ?? null;
  const squares = squaresOfState(state);
  const isMine = mySeat !== null && state.turn === mySeat && !state.over;

  // board.setState 可能因为棋子已落下而静默清空选择，这里同步回来
  app.selectedPiece = board.selection?.pieceId ?? null;

  // 回合横幅
  const dot = el.turnBanner.querySelector('.turn-dot');
  const text = el.turnBanner.querySelector('.turn-text');
  el.turnBanner.classList.toggle('is-mine', isMine);
  if (state.over) {
    dot.style.background = 'var(--muted)';
    text.textContent = '本局已结束';
  } else if (isMine) {
    dot.style.background = SEAT_HEX[mySeat];
    text.textContent = '轮到你落子';
  } else {
    dot.style.background = SEAT_HEX[state.turn];
    const name = app.room?.seats?.[state.turn]?.name ?? SEAT_LABELS[state.turn];
    text.textContent = `等待 ${name}（${SEAT_LABELS[state.turn]}）落子…`;
  }

  // 棋子栏
  renderTray(state, mySeat);

  // 对局结束后，如果玩家关掉了结算浮层，用顶栏这个按钮还能再打开
  el.btnResult.hidden = !state.over;

  // 操作按钮
  updateActionButtons();
}

function updateActionButtons() {
  const sel = board.selection;
  const state = app.lastState;
  const mySeat = app.room?.yourSeat ?? null;
  const canPlay = !!state && !state.over && mySeat !== null && state.turn === mySeat;
  el.btnRotate.disabled = !sel || !canPlay;
  el.btnFlip.disabled = !sel || !canPlay;
  el.btnConfirm.disabled = !sel || !canPlay;
  el.btnCancel.disabled = !sel;
}

function renderTray(state, mySeat) {
  if (mySeat === null || mySeat === undefined) {
    el.tray.innerHTML = '<div class="tray-empty">你在旁观，没有棋子。</div>';
    el.trayInfo.textContent = '旁观中';
    return;
  }
  const remaining = state.remaining[mySeat] ?? [];
  const played = 21 - remaining.length;
  const placeable = new Set(board.legal.map((m) => m.pieceId));
  const hasTurn = state.turn === mySeat && !state.over;

  el.trayInfo.textContent = `已下 ${played}/21 块 · 剩 ${remaining.length} 块${
    hasTurn ? '' : '（等对手）'
  }`;

  // 棋子集合没变就只更新状态，避免反复重建 canvas
  const key = remaining.join(',');
  if (el.tray.dataset.key !== key) {
    el.tray.dataset.key = key;
    el.tray.innerHTML = '';
    if (remaining.length === 0) {
      const d = document.createElement('div');
      d.className = 'tray-empty';
      d.textContent = '21 块全部下完，太强了！';
      el.tray.append(d);
    }
    for (const id of remaining) {
      const piece = PIECE_BY_ID.get(id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tray-item';
      btn.dataset.pieceId = id;
      btn.title = `${id}（${piece.size} 格）`;
      const canvas = document.createElement('canvas');
      drawPiecePreview(canvas, piece, 0, SEAT_HEX[mySeat], 8, Math.min(2, devicePixelRatio || 1));
      btn.append(canvas);
      btn.addEventListener('click', () => {
        const st = app.lastState;
        const my = app.room?.yourSeat ?? null;
        if (st && !st.over && my !== null && st.turn !== my) {
          toast('还没轮到你', '');
          return;
        }
        if (app.selectedPiece === id) {
          board.clearSelection();
        } else {
          board.selectPiece(id);
        }
      });
      el.tray.append(btn);
    }
  }

  // 灰显放不下的棋子
  for (const btn of el.tray.querySelectorAll('.tray-item')) {
    const id = btn.dataset.pieceId;
    btn.classList.toggle('is-active', app.selectedPiece === id);
    btn.classList.toggle('is-disabled', hasTurn && !placeable.has(id));
  }
}

function updateTraySelection() {
  for (const btn of el.tray.querySelectorAll('.tray-item')) {
    btn.classList.toggle('is-active', btn.dataset.pieceId === app.selectedPiece);
  }
}

/** 把新出现的弃权 / 托管记录提示出来 */
function noteNewLogs(state) {
  const logs = state.log ?? [];
  if (logs.length < app.seenLogLength) app.seenLogLength = 0;
  for (let i = app.seenLogLength; i < logs.length; i++) {
    const entry = logs[i];
    if (entry.type === 'pass') {
      const name = app.room?.seats?.[entry.seat]?.name ?? SEAT_LABELS[entry.seat];
      toast(`${name} 无处可下，弃权`, '');
    }
  }
  app.seenLogLength = logs.length;
}

/* ------------------------------ 计分板抽屉 ------------------------------ */

function openSheet(title, buildBody) {
  el.sheetTitle.textContent = title;
  el.sheetBody.innerHTML = '';
  buildBody(el.sheetBody);
  el.sheet.hidden = false;
  el.sheetBackdrop.hidden = false;
}

function closeSheet() {
  el.sheet.hidden = true;
  el.sheetBackdrop.hidden = true;
}

function buildScoreBody(container) {
  const state = app.lastState;
  const room = app.room;
  if (!state || !room) {
    container.textContent = '还没有对局数据。';
    return;
  }
  const squares = squaresOfState(state);

  const addRow = (seat) => {
    const row = document.createElement('div');
    row.className = 'score-row';
    row.style.setProperty('--c', SEAT_HEX[seat]);

    const sw = document.createElement('div');
    sw.className = 'swatch';

    const who = document.createElement('div');
    who.className = 'who';
    const nm = room.seats?.[seat]?.name ?? SEAT_LABELS[seat];
    who.innerHTML = '';
    who.append(document.createTextNode(nm));
    const small = document.createElement('small');
    small.textContent = `${SEAT_LABELS[seat]} · 剩 ${state.remaining[seat].length} 块${
      state.finished[seat] ? ' · 已下完' : ''
    }`;
    who.append(small);

    const num = document.createElement('div');
    num.className = 'num';
    num.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = String(squares[seat]);
    num.append(b, document.createTextNode(' 格'));
    if (state.turn === seat && !state.over) {
      const t = document.createElement('small');
      t.style.display = 'block';
      t.style.color = 'var(--primary)';
      t.textContent = '进行中';
      num.append(t);
    }

    row.append(sw, who, num);
    container.append(row);
  };

  if (room.mode === MODE_TEAM) {
    for (const team of [0, 1]) {
      const seats = [0, 1, 2, 3].filter((s) => TEAM_OF_SEAT[s] === team);
      const total = seats.reduce((sum, s) => sum + squares[s], 0);
      const head = document.createElement('div');
      head.className = 'team-head';
      head.textContent = `第 ${team + 1} 队（${seats.map((s) => SEAT_LABELS[s]).join(' + ')}）合计 ${total} 格`;
      container.append(head);
      for (const s of seats) addRow(s);
    }
  } else {
    const order = [0, 1, 2, 3].sort((a, b) => squares[b] - squares[a] || b - a);
    for (const s of order) addRow(s);
  }

  // 最近战报
  const logs = (state.log ?? []).slice(-10).reverse();
  if (logs.length) {
    const ul = document.createElement('ul');
    ul.className = 'log-list';
    for (const entry of logs) {
      const li = document.createElement('li');
      const nm = app.room?.seats?.[entry.seat]?.name ?? SEAT_LABELS[entry.seat] ?? '';
      if (entry.type === 'move') {
        li.textContent = `${nm} 下了一枚 ${entry.size} 格棋子${entry.auto ? '（托管）' : ''}`;
      } else if (entry.type === 'pass') {
        li.textContent = `${nm} 无处可下，弃权`;
      } else if (entry.type === 'start') {
        li.textContent = '本局开始';
      } else if (entry.type === 'end') {
        li.textContent = '本局结束';
      }
      if (li.textContent) ul.append(li);
    }
    const h = document.createElement('div');
    h.className = 'team-head';
    h.textContent = '最近动作';
    container.append(h, ul);
  }
}

/* ------------------------------ 结算 ------------------------------ */

function showResult(result) {
  const room = app.room;
  el.resultRows.innerHTML = '';
  el.resultBonus.innerHTML = '';

  const ffa = result.mode !== MODE_TEAM;
  const order = ffa
    ? result.ranking.map((r) => ({ seat: r.seat, rank: r.rank, detail: `${r.squares} 格 · 剩 ${r.remaining} 块` }))
    : (() => {
        const [t0, t1] = result.teams;
        const win = t0.win ? t0 : t1;
        const lose = t0.win ? t1 : t0;
        const rows = [];
        for (const s of win.seats) {
          rows.push({ seat: s, rank: 1, detail: `胜方 ${win.squares} 格（我队合计）` });
        }
        for (const s of lose.seats) {
          rows.push({ seat: s, rank: 2, detail: `败方 ${lose.squares} 格（我队合计）` });
        }
        return rows;
      })();

  el.resultTitle.textContent = ffa ? '本局结束 · 四人混战' : '本局结束 · 二对二';
  const tieNote = result.tie ? '（出现同分，按规则后手获胜）' : '';
  el.resultSub.textContent = `${tieNote}第 ${result.gameNo ?? ''} 局`;

  for (const row of order) {
    const node = document.createElement('div');
    node.className = 'result-row';
    if (row.rank === 1) node.classList.add('is-winner');
    node.style.setProperty('--c', SEAT_HEX[row.seat]);

    const rank = document.createElement('div');
    rank.className = 'rank';
    rank.textContent = ffa ? String(row.rank) : row.rank === 1 ? '胜' : '负';

    const name = document.createElement('div');
    name.className = 'rname';
    const nm = room?.seats?.[row.seat]?.name ?? SEAT_LABELS[row.seat];
    name.textContent = nm;
    const small = document.createElement('small');
    small.textContent = `${SEAT_LABELS[row.seat]} · ${row.detail}`;
    name.append(small);

    const delta = document.createElement('div');
    const d = result.deltas[row.seat];
    delta.className = `rdelta ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}`;
    delta.textContent = d > 0 ? `+${d}` : String(d);

    node.append(rank, name, delta);
    el.resultRows.append(node);
  }

  for (const b of result.bonuses ?? []) {
    const chip = document.createElement('span');
    chip.className = 'bonus-chip';
    const nm = room?.seats?.[b.seat]?.name ?? SEAT_LABELS[b.seat];
    chip.textContent = `${nm}：${b.label} +${b.points}`;
    el.resultBonus.append(chip);
  }

  el.resultSummary.textContent = result.summary ?? '';

  const mySeat = room?.yourSeat ?? null;
  el.btnAgain.disabled = !room?.isHost;
  el.btnAgain.textContent = room?.isHost ? '再来一局' : '等房主再开一局';

  el.resultModal.hidden = false;
  if (mySeat !== null) {
    const d = result.deltas[mySeat];
    toast(d > 0 ? `本局 ${d > 0 ? '+' : ''}${d} 分` : d < 0 ? `本局 ${d} 分` : '本局 0 分', d > 0 ? 'ok' : d < 0 ? 'err' : '');
  }
}

function closeResult() {
  el.resultModal.hidden = true;
}

/* ══════════════════════════ 事件绑定 ══════════════════════════ */

el.btnCreate.addEventListener('click', async () => {
  localStorage.setItem('blokus.name', currentName());
  el.homeHint.textContent = '正在分配房号…';
  el.btnCreate.disabled = true;
  try {
    // 先向服务器要一个没被占用的房号，再按房号连到对应的房间实例
    const res = await fetch('/api/new-room', { cache: 'no-store' });
    if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
    const { code } = await res.json();
    enterRoom(code);
  } catch (err) {
    el.homeHint.textContent = `建房失败：${err.message}`;
  } finally {
    el.btnCreate.disabled = false;
  }
});

el.btnJoin.addEventListener('click', () => {
  localStorage.setItem('blokus.name', currentName());
  enterRoom(el.inputCode.value);
});

el.inputCode.addEventListener('input', () => {
  el.inputCode.value = el.inputCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

el.inputCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnJoin.click();
});

el.inputName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnCreate.click();
});

el.btnShare.addEventListener('click', async () => {
  const url = `${location.origin}/?r=${app.roomCode}`;
  const text = `来下角斗士棋！房号 ${app.roomCode}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: '角斗士棋', text, url });
      return;
    } catch {
      /* 用户取消，退回复制 */
    }
  }
  copyText(url);
});

el.btnCopy.addEventListener('click', () => {
  copyText(`${location.origin}/?r=${app.roomCode}`);
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('邀请链接已复制', 'ok');
  } catch {
    // 非 HTTPS 或旧浏览器下 clipboard 不可用，用兜底方案
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('邀请链接已复制', 'ok');
    } catch {
      prompt('复制这个链接分享给朋友：', text);
    }
    ta.remove();
  }
}

el.segMode.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (btn) send({ t: C2S.SET_MODE, mode: btn.dataset.mode });
});

el.segDifficulty.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (btn) send({ t: C2S.SET_DIFFICULTY, difficulty: btn.dataset.difficulty });
});

el.btnStart.addEventListener('click', () => {
  if (app.room?.phase === 'over') send({ t: C2S.REMATCH });
  else send({ t: C2S.START });
});
el.btnAgain.addEventListener('click', () => {
  closeResult();
  send({ t: C2S.REMATCH });
});
el.btnViewBoard.addEventListener('click', closeResult);
el.btnBackRoom.addEventListener('click', () => {
  closeResult();
  showScreen('room');
});

el.btnLeave.addEventListener('click', () => {
  // 直接断开连接即可：服务端在 socket 关闭时会回收座位/标记离线
  leaveRoom();
});

el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  send({ t: C2S.CHAT, text });
  el.chatInput.value = '';
});

el.btnRotate.addEventListener('click', () => board.rotate(1));
el.btnFlip.addEventListener('click', () => board.flip());
el.btnCancel.addEventListener('click', () => board.clearSelection());
el.btnConfirm.addEventListener('click', () => {
  const r = board.confirm();
  if (!r.ok) toast(r.reason, 'err');
});

el.chkSnap.addEventListener('change', () => board.setSnapEnabled(el.chkSnap.checked));
board.setSnapEnabled(el.chkSnap.checked);

el.btnScoreboard.addEventListener('click', () => openSheet('计分板', buildScoreBody));
el.btnResult.addEventListener('click', () => {
  if (app.result) showResult(app.result);
});
el.btnRules.addEventListener('click', () => {
  openSheet('规则速查', (body) => {
    body.innerHTML = `
      <p><b>逆时针轮流</b>，每人第一枚棋子必须盖住自己那一角的起始点。</p>
      <p>之后每枚新棋子至少要有一个<b>角</b>与自己的棋子<b>角对角</b>相接；同色棋子之间<b>不能边边相邻</b>；与其他颜色无限制。</p>
      <p>无处可下自动弃权；所有人都下不动时本局结束。</p>
      <p><b>混战</b>：占格多者胜，同格后手排名更高；增减分 +3 / +1 / 0 / −2。</p>
      <p><b>二对二</b>：对角为一队，总数多者胜，同数后手胜；胜方每人 +2、败方每人 −1。</p>
      <p>统治力奖励与全清奖励额外加分。</p>
      <p style="color:var(--muted);font-size:12.5px">操作：单指拖动棋盘平移，双指缩放；选中棋子后单指拖动影子，松手自动吸附，点「落子」确认。</p>
    `;
  });
});

el.btnSheetClose.addEventListener('click', closeSheet);
el.sheetBackdrop.addEventListener('click', closeSheet);

window.addEventListener('resize', () => {
  if (el.screenGame.classList.contains('is-active')) board.resize();
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (el.screenGame.classList.contains('is-active')) board.resize();
  }, 250);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !app.connected) connect();
});

/* ══════════════════════════ 启动 ══════════════════════════ */

// 注意：这里**不再**一上来就连 WebSocket。
// 房间是「按房号连」的（Cloudflare Workers 那边一个房号一个 Durable Object），
// 所以要先有房号才建立连接 —— 没进房间就不必占一条长连接。
connect();

// 供自动化测试与线上排查使用（浏览器控制台里可以直接 __blokus.board 看状态）
window.__blokus = { app, board, send, showScreen, enterRoom, leaveRoom, disconnect, el };

// 关页面时干净地断开，省得浏览器控制台里报一堆重连失败
window.addEventListener('pagehide', disconnect);

// 群里点开邀请链接：**立刻开始建立连接**。
//
// WebSocket 握手要 2~3 个来回（TCP + TLS + 协议升级），网络差的时候能占掉
// 一两秒钟。这段时间正好用来让用户输昵称 —— 等他们点「加入」时连接已经就绪，
// 体感上就是"秒进"。
//
// 注意这时候**不打招呼**（pendingHello 还是 false），所以不会占座位；
// 点了「加入」才会 hello + joinRoom。
if (urlRoom) {
  app.roomCode = urlRoom;
  connect();
  if (savedName) {
    enterRoom(urlRoom); // 存过昵称，直接就进
  } else {
    el.homeHint.textContent = `填个昵称，点「加入」进入房间 ${urlRoom}`;
    el.inputName.focus();
  }
}
