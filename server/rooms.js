/**
 * 房间与对局流程管理。
 *
 * 设计要点：
 *  - 服务端权威：所有落子都在服务端用规则引擎校验，客户端只做本地预演。
 *  - 一个 room 有 4 个座位，可以是 人 / AI / 空。
 *  - 观众（没座位的人）也能看到棋盘与聊天。
 *  - 连接断开 ≠ 离开房间：座位保留，界面显示离线；若轮到他且离线过久，
 *    服务端会自动托管一手，避免整局卡死。
 */

import { randomUUID } from 'node:crypto';

import {
  MODE_FFA,
  MODE_TEAM,
  SEAT_LABELS,
  SEAT_COUNT,
  DEFAULT_SCORING,
  DIFFICULTY_NORMAL,
} from '../shared/constants.js';
import {
  createState,
  serializeState,
  applyMove,
  validateMove,
  hasAnyMove,
  passSeat,
  settle,
} from '../shared/rules.js';
import { computeScore } from '../shared/scoring.js';
import { chooseMove } from '../shared/ai.js';
import { C2S, S2C } from '../shared/protocol.js';

/** 房号字符集：去掉了容易看错的 I O 0 1 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

/** AI 每步之间的停顿，让真人看得清 */
const AI_DELAY_MS = 650;
/** 轮到离线玩家多久之后自动托管 */
const OFFLINE_TAKEOVER_MS = 30_000;
/** 空房间保留时长 */
const ROOM_TTL_MS = 20 * 60 * 1000;
const MAX_CHAT = 60;

function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function cleanName(raw, fallback) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 16);
  return s || fallback;
}

export class RoomManager {
  constructor(options = {}) {
    /** @type {Map<string, object>} */
    this.rooms = new Map();
    this.scoring = options.scoring ?? DEFAULT_SCORING;
    this.aiDelayMs = options.aiDelayMs ?? AI_DELAY_MS;
    this.offlineTakeoverMs = options.offlineTakeoverMs ?? OFFLINE_TAKEOVER_MS;
    this.reaper = setInterval(() => this.reap(), 60_000);
    this.reaper.unref?.();
  }

  stop() {
    clearInterval(this.reaper);
    for (const room of this.rooms.values()) clearTimeout(room.aiTimer);
    this.rooms.clear();
  }

  reap() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActivity;
      if (room.clients.size === 0 && idle > ROOM_TTL_MS) {
        clearTimeout(room.aiTimer);
        this.rooms.delete(code);
      }
    }
  }

  get(code) {
    return this.rooms.get(String(code ?? '').toUpperCase().trim()) ?? null;
  }

  create(hostConn) {
    let code = randomCode();
    let guard = 0;
    while (this.rooms.has(code) && guard++ < 500) code = randomCode();

    const room = {
      code,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      hostId: hostConn.data.playerId,
      mode: MODE_FFA,
      difficulty: DIFFICULTY_NORMAL,
      scoring: this.scoring,
      phase: 'lobby',
      seats: Array.from({ length: SEAT_COUNT }, () => ({
        kind: 'open',
        playerId: null,
        name: null,
        ready: false,
        conn: null,
        auto: false,
      })),
      clients: new Set(),
      state: null,
      result: null,
      totals: new Map(),
      chat: [],
      aiTimer: null,
      gameNo: 0,
    };
    this.rooms.set(code, room);
    return room;
  }
}

export class RoomHub {
  constructor(manager) {
    this.manager = manager;
  }

  /* --------------------------- 底层发送 --------------------------- */

  send(conn, msg) {
    conn.sendJSON(msg);
  }

  broadcast(room, msg) {
    for (const conn of room.clients) {
      if (!conn.closed) conn.sendJSON(msg);
    }
  }

  broadcastRoom(room) {
    for (const conn of room.clients) {
      if (!conn.closed) conn.sendJSON(this.serializeRoom(room, conn));
    }
  }

  broadcastState(room) {
    if (!room.state) return;
    const payload = { t: S2C.STATE, state: serializeState(room.state) };
    this.broadcast(room, payload);
  }

  error(conn, message) {
    this.send(conn, { t: S2C.ERROR, message });
  }

  touch(room) {
    room.lastActivity = Date.now();
  }

  /* --------------------------- 序列化 --------------------------- */

  isSeatConnected(room, seat) {
    const s = room.seats[seat];
    return s.kind === 'human' && !!s.conn && !s.conn.closed;
  }

  serializeRoom(room, conn) {
    const you = conn?.data ?? {};
    const seats = room.seats.map((s, seat) => ({
      seat,
      kind: s.kind,
      name: s.kind === 'open' ? null : s.name,
      ready: !!s.ready,
      connected: s.kind === 'ai' ? true : this.isSeatConnected(room, seat),
      auto: !!s.auto,
      isHost: s.kind === 'human' && s.playerId === room.hostId,
      isYou: s.kind === 'human' && !!you.playerId && s.playerId === you.playerId,
      sessionScore: s.kind === 'human' ? (room.totals.get(s.playerId) ?? 0) : null,
    }));

    const leaderboard = [...room.totals.entries()]
      .map(([playerId, score]) => ({
        playerId,
        score,
        name: this.nameOfPlayer(room, playerId),
      }))
      .sort((a, b) => b.score - a.score);

    return {
      t: S2C.ROOM,
      code: room.code,
      phase: room.phase ?? (room.state ? (room.state.over ? 'over' : 'playing') : 'lobby'),
      mode: room.mode,
      difficulty: room.difficulty,
      hostId: room.hostId,
      isHost: !!you.playerId && you.playerId === room.hostId,
      yourSeat: seats.find((x) => x.isYou)?.seat ?? null,
      seats,
      scoring: room.scoring,
      gameNo: room.gameNo,
      humans: seats.filter((s) => s.kind === 'human').length,
      canStart: (room.phase ?? 'lobby') === 'lobby' && seats.some((s) => s.kind === 'human'),
      leaderboard,
      chat: room.chat.slice(-30),
    };
  }

  nameOfPlayer(room, playerId) {
    const s = room.seats.find((x) => x.kind === 'human' && x.playerId === playerId);
    return s?.name ?? '（已离开）';
  }

  /* --------------------------- 进房 / 离房 --------------------------- */

  handleJoin(conn, room) {
    const data = conn.data;
    const prevCode = data.roomCode;
    if (prevCode && prevCode !== room.code) this.handleLeave(conn);

    data.roomCode = room.code;
    room.clients.add(conn);

    // 断线重连：如果这个 playerId 本来就有座位，直接坐回去
    const existing = room.seats.findIndex(
      (s) => s.kind === 'human' && s.playerId === data.playerId,
    );
    if (existing >= 0) {
      room.seats[existing].conn = conn;
      room.seats[existing].name = room.seats[existing].name ?? data.name;
      data.seat = existing;
    } else if ((room.phase ?? 'lobby') === 'lobby') {
      const open = room.seats.findIndex((s) => s.kind === 'open');
      if (open >= 0) {
        room.seats[open] = {
          kind: 'human',
          playerId: data.playerId,
          name: data.name,
          ready: false,
          conn,
          auto: false,
        };
        data.seat = open;
      }
    }

    this.touch(room);
    this.broadcastRoom(room);
    if (room.state) this.send(conn, { t: S2C.STATE, state: serializeState(room.state) });
    if (room.result) this.send(conn, { t: S2C.RESULT, result: this.publicResult(room) });
    this.tick(room);
  }

  handleLeave(conn) {
    const data = conn.data;
    const room = this.manager.get(data.roomCode);
    data.roomCode = null;
    data.seat = null;
    if (!room) return;

    room.clients.delete(conn);
    const seat = room.seats.find((s) => s.kind === 'human' && s.conn === conn);
    if (seat) {
      seat.conn = null;
      if ((room.phase ?? 'lobby') === 'lobby') {
        // 大厅阶段直接释放座位
        seat.kind = 'open';
        seat.playerId = null;
        seat.name = null;
        seat.ready = false;
        seat.auto = false;
      }
    }
    this.reassignHost(room);
    this.touch(room);
    this.broadcastRoom(room);
    this.tick(room);
  }

  reassignHost(room) {
    const hostStillHere = room.seats.some(
      (s) => s.kind === 'human' && s.playerId === room.hostId && s.conn && !s.conn.closed,
    );
    if (hostStillHere) return;
    const next =
      room.seats.find((s) => s.kind === 'human' && s.conn && !s.conn.closed) ??
      room.seats.find((s) => s.kind === 'human');
    room.hostId = next?.playerId ?? null;
  }

  /* --------------------------- 座位管理 --------------------------- */

  takeSeat(conn, seatIndex) {
    const room = this.manager.get(conn.data.roomCode);
    if (!room) return this.error(conn, '你还没有加入房间');
    if ((room.phase ?? 'lobby') !== 'lobby') return this.error(conn, '对局进行中，不能换座位');
    const seat = room.seats[seatIndex];
    if (!seat) return this.error(conn, '座位不存在');
    if (seat.kind !== 'open') return this.error(conn, '这个座位已经有人了');

    // 先离开原座位
    const mine = room.seats.find((s) => s.kind === 'human' && s.playerId === conn.data.playerId);
    if (mine) {
      mine.kind = 'open';
      mine.playerId = null;
      mine.name = null;
      mine.ready = false;
    }
    room.seats[seatIndex] = {
      kind: 'human',
      playerId: conn.data.playerId,
      name: conn.data.name,
      ready: false,
      conn,
      auto: false,
    };
    conn.data.seat = seatIndex;
    this.touch(room);
    this.broadcastRoom(room);
  }

  leaveSeat(conn) {
    const room = this.manager.get(conn.data.roomCode);
    if (!room) return;
    if ((room.phase ?? 'lobby') !== 'lobby') return this.error(conn, '对局进行中，不能离开座位');
    const seat = room.seats.find((s) => s.kind === 'human' && s.playerId === conn.data.playerId);
    if (!seat) return;
    seat.kind = 'open';
    seat.playerId = null;
    seat.name = null;
    seat.ready = false;
    conn.data.seat = null;
    this.reassignHost(room);
    this.touch(room);
    this.broadcastRoom(room);
  }

  setSeatKind(conn, seatIndex, kind) {
    const room = this.manager.get(conn.data.roomCode);
    if (!room) return this.error(conn, '你还没有加入房间');
    if (conn.data.playerId !== room.hostId) return this.error(conn, '只有房主能设置座位');
    if ((room.phase ?? 'lobby') !== 'lobby') return this.error(conn, '对局进行中，不能改座位');
    const seat = room.seats[seatIndex];
    if (!seat) return this.error(conn, '座位不存在');

    if (kind === 'ai') {
      if (seat.kind === 'human' && seat.conn && !seat.conn.closed) {
        return this.error(conn, '这个座位上有人在');
      }
      room.seats[seatIndex] = {
        kind: 'ai',
        playerId: null,
        name: `${SEAT_LABELS[seatIndex]}AI`,
        ready: true,
        conn: null,
        auto: false,
      };
    } else if (kind === 'open') {
      room.seats[seatIndex] = {
        kind: 'open',
        playerId: null,
        name: null,
        ready: false,
        conn: null,
        auto: false,
      };
    } else {
      return this.error(conn, '未知的座位类型');
    }
    this.touch(room);
    this.broadcastRoom(room);
  }

  setMode(conn, mode) {
    const room = this.manager.get(conn.data.roomCode);
    if (!room) return this.error(conn, '你还没有加入房间');
    if (conn.data.playerId !== room.hostId) return this.error(conn, '只有房主能切换模式');
    if ((room.phase ?? 'lobby') !== 'lobby') return this.error(conn, '对局进行中，不能切换模式');
    if (mode !== MODE_FFA && mode !== MODE_TEAM) return this.error(conn, '未知模式');
    room.mode = mode;
    this.touch(room);
    this.broadcastRoom(room);
  }

  setDifficulty(conn, difficulty) {
    const room = this.manager.get(conn.data.roomCode);
    if (!room) return this.error(conn, '你还没有加入房间');
    if (conn.data.playerId !== room.hostId) return this.error(conn, '只有房主能切换 AI 难度');
    if (!['easy', 'normal', 'hard'].includes(difficulty)) return this.error(conn, '未知难度');
    room.difficulty = difficulty;
    this.touch(room);
    this.broadcastRoom(room);
  }

  setReady(conn, ready) {
    const room = this.manager.get(conn.data.roomCode);
    if (!room) return;
    const seat = room.seats.find((s) => s.kind === 'human' && s.playerId === conn.data.playerId);
    if (!seat) return;
    seat.ready = !!ready;
    this.touch(room);
    this.broadcastRoom(room);
  }

  /* --------------------------- 开局 --------------------------- */

  start(conn) {
    const room = this.manager.get(conn.data.roomCode);
    if (!room) return this.error(conn, '你还没有加入房间');
    if (conn.data.playerId !== room.hostId) return this.error(conn, '只有房主能开始游戏');
    if ((room.phase ?? 'lobby') !== 'lobby') return this.error(conn, '已经在对局中了');

    const humans = room.seats.filter((s) => s.kind === 'human').length;
    if (humans === 0) return this.error(conn, '至少需要一位玩家');

    // 空位自动补 AI
    for (let i = 0; i < SEAT_COUNT; i++) {
      if (room.seats[i].kind === 'open') {
        room.seats[i] = {
          kind: 'ai',
          playerId: null,
          name: `${SEAT_LABELS[i]}AI`,
          ready: true,
          conn: null,
          auto: false,
        };
      }
    }

    room.state = createState(room.mode);
    room.result = null;
    room.phase = 'playing';
    room.gameNo += 1;
    room.state.log.push({ type: 'start', mode: room.mode, at: Date.now() });
    this.touch(room);

    this.broadcastRoom(room);
    this.broadcast(room, {
      t: S2C.STATE,
      state: serializeState(room.state),
      gameNo: room.gameNo,
    });
    this.tick(room);
  }

  rematch(conn) {
    const room = this.manager.get(conn.data.roomCode);
    if (!room) return this.error(conn, '你还没有加入房间');
    if (conn.data.playerId !== room.hostId) return this.error(conn, '只有房主能再来一局');
    if (room.phase === 'playing') return this.error(conn, '本局还没结束');

    clearTimeout(room.aiTimer);
    room.aiTimer = null;
    room.state = null;
    room.result = null;
    room.phase = 'lobby';
    for (const s of room.seats) {
      if (s.kind === 'human') {
        s.ready = false;
        s.auto = false;
      }
    }
    this.touch(room);
    this.broadcastRoom(room);
  }

  /* --------------------------- 对局推进 --------------------------- */

  /** 把状态推到「等某人落子」，并安排 AI / 托管的定时器 */
  tick(room) {
    clearTimeout(room.aiTimer);
    room.aiTimer = null;
    if (!room.state) return;

    if (room.state.over) {
      if (room.phase !== 'over') this.finish(room);
      return;
    }
    if (room.phase !== 'playing') return;

    const seat = room.state.turn;
    const s = room.seats[seat];
    if (!s) return;

    if (s.kind === 'ai') {
      room.aiTimer = setTimeout(() => this.aiMove(room, seat, {}), this.manager.aiDelayMs);
      room.aiTimer.unref?.();
      return;
    }
    if (!this.isSeatConnected(room, seat)) {
      // 轮到他但人不在 —— 等一会儿自动托管，避免整局卡死
      room.aiTimer = setTimeout(
        () => this.aiMove(room, seat, { substitute: true }),
        this.manager.offlineTakeoverMs,
      );
      room.aiTimer.unref?.();
    }
  }

  aiMove(room, seat, opts) {
    if (!room.state || room.state.over || room.phase !== 'playing') return;
    if (room.state.turn !== seat) {
      this.tick(room);
      return;
    }
    const move = chooseMove(room.state, seat, { difficulty: room.difficulty });
    if (move) {
      try {
        applyMove(room.state, seat, move.pieceId, move.orient, move.x, move.y);
        if (opts.substitute) {
          const last = room.state.log[room.state.log.length - 1];
          if (last) last.auto = true;
        }
      } catch (err) {
        // 理论上不会发生；真发生了就用「弃权」兜底，保证对局能继续
        room.state.log.push({
          type: 'pass',
          seat,
          at: Date.now(),
          reason: `AI 落子失败：${err.message}`,
        });
        room.state.passStreak++;
        room.state.turn = (seat + 1) % SEAT_COUNT;
        settle(room.state);
      }
    } else {
      settle(room.state);
    }

    this.touch(room);
    this.broadcast(room, {
      t: S2C.MOVE_MADE,
      seat,
      pieceId: move?.pieceId ?? null,
      auto: !!opts.substitute || room.seats[seat]?.kind === 'ai',
    });
    this.broadcastState(room);
    this.tick(room);
  }

  /** 真人落子 */
  move(conn, pieceId, orient, x, y) {
    const room = this.manager.get(conn.data.roomCode);
    if (!room || !room.state) return this.error(conn, '当前没有进行中的对局');
    if (room.phase !== 'playing') return this.error(conn, '本局已经结束了');

    const seat = room.seats.findIndex(
      (s) => s.kind === 'human' && s.playerId === conn.data.playerId,
    );
    if (seat < 0) return this.error(conn, '你在旁观，没有座位');
    if (room.state.turn !== seat) return this.error(conn, '还没轮到你');

    const check = validateMove(room.state, seat, pieceId, orient, x, y);
    if (!check.ok) return this.error(conn, check.reason);

    try {
      applyMove(room.state, seat, pieceId, orient, x, y);
    } catch (err) {
      return this.error(conn, err.message);
    }

    this.touch(room);
    this.broadcast(room, { t: S2C.MOVE_MADE, seat, pieceId, auto: false });
    this.broadcastState(room);
    this.tick(room);
  }

  /** 真人主动弃权（只有确实无子可下时才允许） */
  pass(conn) {
    const room = this.manager.get(conn.data.roomCode);
    if (!room || !room.state) return this.error(conn, '当前没有进行中的对局');
    if (room.phase !== 'playing') return this.error(conn, '本局已经结束了');
    const seat = room.seats.findIndex(
      (s) => s.kind === 'human' && s.playerId === conn.data.playerId,
    );
    if (seat < 0) return this.error(conn, '你在旁观，没有座位');
    if (room.state.turn !== seat) return this.error(conn, '还没轮到你');
    if (hasAnyMove(room.state, seat)) return this.error(conn, '你还有地方可以下，不能弃权');

    passSeat(room.state, seat);
    settle(room.state);
    this.touch(room);
    this.broadcastState(room);
    this.tick(room);
  }

  finish(room) {
    room.phase = 'over';
    room.result = computeScore(room.state, room.scoring);

    // 累计积分只记在人身上，AI 不计入排行榜
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const s = room.seats[seat];
      if (s.kind === 'human' && s.playerId) {
        const prev = room.totals.get(s.playerId) ?? 0;
        room.totals.set(s.playerId, prev + room.result.deltas[seat]);
      }
    }

    this.broadcastRoom(room);
    this.broadcast(room, { t: S2C.RESULT, result: this.publicResult(room) });
  }

  publicResult(room) {
    const r = room.result;
    if (!r) return null;
    return {
      ...r,
      gameNo: room.gameNo,
      seats: room.seats.map((s, seat) => ({
        seat,
        kind: s.kind,
        name: s.name,
        delta: r.deltas[seat],
        sessionScore: s.kind === 'human' ? (room.totals.get(s.playerId) ?? 0) : null,
      })),
    };
  }

  /* --------------------------- 聊天 --------------------------- */

  chat(conn, text) {
    const room = this.manager.get(conn.data.roomCode);
    if (!room) return;
    const clean = String(text ?? '').slice(0, 200).trim();
    if (!clean) return;
    const seat = room.seats.findIndex(
      (s) => s.kind === 'human' && s.playerId === conn.data.playerId,
    );
    const entry = {
      seat: seat >= 0 ? seat : null,
      name: conn.data.name,
      text: clean,
      at: Date.now(),
    };
    room.chat.push(entry);
    if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
    this.touch(room);
    this.broadcast(room, { t: S2C.CHAT, ...entry });
  }

  /* --------------------------- 消息分发 --------------------------- */

  handle(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    const t = msg.t;

    switch (t) {
      case C2S.HELLO: {
        conn.data.playerId = String(msg.playerId ?? '').slice(0, 64) || randomUUID();
        conn.data.name = cleanName(msg.name, `玩家${Math.floor(Math.random() * 9000) + 1000}`);
        this.send(conn, {
          t: S2C.WELCOME,
          you: { playerId: conn.data.playerId, name: conn.data.name },
        });
        return;
      }
      case C2S.CREATE_ROOM: {
        this.handleLeave(conn);
        const room = this.manager.create(conn);
        if (msg.mode === MODE_FFA || msg.mode === MODE_TEAM) room.mode = msg.mode;
        if (['easy', 'normal', 'hard'].includes(msg.difficulty)) room.difficulty = msg.difficulty;
        this.handleJoin(conn, room);
        return;
      }
      case C2S.JOIN_ROOM: {
        const room = this.manager.get(msg.code);
        if (!room) return this.error(conn, `房号 ${String(msg.code ?? '').toUpperCase()} 不存在`);
        this.handleJoin(conn, room);
        return;
      }
      case C2S.LEAVE_ROOM:
        this.handleLeave(conn);
        this.send(conn, { t: S2C.ROOM, code: null, left: true });
        return;
      case C2S.TAKE_SEAT:
        return this.takeSeat(conn, Number(msg.seat));
      case C2S.LEAVE_SEAT:
        return this.leaveSeat(conn);
      case C2S.SET_SEAT:
        return this.setSeatKind(conn, Number(msg.seat), msg.kind);
      case C2S.SET_MODE:
        return this.setMode(conn, msg.mode);
      case C2S.SET_DIFFICULTY:
        return this.setDifficulty(conn, msg.difficulty);
      case C2S.SET_READY:
        return this.setReady(conn, msg.ready);
      case C2S.START:
        return this.start(conn);
      case C2S.REMATCH:
        return this.rematch(conn);
      case C2S.MOVE:
        return this.move(conn, msg.pieceId, Number(msg.orient), Number(msg.x), Number(msg.y));
      case C2S.PASS:
        return this.pass(conn);
      case C2S.CHAT:
        return this.chat(conn, msg.text);
      case C2S.PING:
        return this.send(conn, { t: S2C.PONG, at: Date.now() });
      default:
        return this.error(conn, `未知消息类型 ${String(t)}`);
    }
  }
}
