/**
 * 房间 Durable Object。
 *
 * 一个房间 = 一个 DO 实例（用 `env.ROOMS.idFromName(房号)` 定位）。
 *
 * 为什么是这个映射：DO 天生就是「单点串行处理 + 有状态」，正好等于一个房间
 * 需要一个权威服务端的需求。落子校验、AI 调度、座位管理全都集中在同一个
 * 实例里串行执行，天然没有并发竞争，也不需要任何锁。
 *
 * 复用：房间逻辑本身在 shared/rooms.js 里，和 Node 自托管版本**是同一份代码**。
 * 这里只做三件事：把 WebSocket 包装成 hub 认识的 conn、把状态持久化、加载恢复。
 *
 * 关于休眠：这里用 `ws.accept()`（不启用 Hibernation），所以只要房间里有人在，
 * DO 就留在内存里、状态不用每次从存储读。代价是连接期间按时长计费 ——
 * 按免费额度（13000 GB-s/天）算，一局两小时的四人棋约 900 GB-s，够用。
 * 同时每次状态变化都写一份快照，万一 DO 被回收（比如发新版本），
 * 重新连上来还能接着打，而不是丢局。
 */

import { DurableObject } from 'cloudflare:workers';

import { RoomManager, RoomHub } from '../shared/rooms.js';
import { SEAT_COUNT, DEFAULT_SCORING, MODE_FFA, DIFFICULTY_NORMAL } from '../shared/constants.js';
import { deserializeState, serializeState } from '../shared/rules.js';

const STORAGE_KEY = 'room';
/** 房号预定标记：/api/new-room 分配后、客户端还没连上来的这段时间 */
const CLAIM_KEY = 'claim';
/** 预定多久没被兑现就作废（客户端正常情况下 1 秒内就连上来了） */
const CLAIM_TTL_MS = 2 * 60 * 1000;
/** 多久没人动过，房号就可以被重新分配 */
const STALE_MS = 6 * 60 * 60 * 1000;

/** 把 Workers 的 WebSocket 包装成 shared/rooms.js 期望的 conn 接口 */
function wrapSocket(ws) {
  const conn = {
    ws,
    closed: false,
    data: { playerId: null, name: null, roomCode: null, seat: null },
    sendJSON(obj) {
      if (conn.closed) return;
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        conn.closed = true;
      }
    },
    close(code = 1000, reason = '') {
      conn.closed = true;
      try {
        ws.close(code, reason);
      } catch {
        /* 忽略 */
      }
    },
  };
  return conn;
}

export class RoomDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    /** @type {RoomManager|null} */
    this.manager = null;
    /** @type {RoomHub|null} */
    this.hub = null;
    this.roomCode = null;
    this.ready = null;
  }

  /* ───────────────────────── 初始化与持久化 ───────────────────────── */

  /**
   * 确保房间已就绪。用 blockConcurrencyWhile 保证并发的第一个请求
   * 不会同时去创建 manager 或读两次存储。
   */
  #ensureReady(code) {
    if (this.ready) return this.ready;
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.roomCode = code;
      this.manager = new RoomManager({
        singleRoomCode: code,
        scoring: this.#scoring(),
        aiDelayMs: Number(this.env.AI_DELAY_MS ?? 650),
        turnLimitMs: Number(this.env.TURN_LIMIT_MS ?? 20_000),
        onChange: (room) => this.#persist(room),
      });
      this.hub = new RoomHub(this.manager);

      const saved = await this.ctx.storage.get(STORAGE_KEY);
      this.manager.ensureRoom();
      if (saved) this.#restore(saved);
      // 客户端已经连上来了，预定的使命完成，清掉
      await this.ctx.storage.delete(CLAIM_KEY);
    });
    return this.ready;
  }

  #scoring() {
    // 允许用环境变量微调，没配就用内置默认值
    const base = DEFAULT_SCORING;
    const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
    return {
      ...base,
      ffaRankDelta: base.ffaRankDelta,
      teamWinDelta: num(this.env.TEAM_WIN_DELTA, base.teamWinDelta),
      teamLoseDelta: num(this.env.TEAM_LOSE_DELTA, base.teamLoseDelta),
      domination: {
        ...base.domination,
        ffaGap: num(this.env.DOMINATION_FFA_GAP, base.domination.ffaGap),
        teamGap: num(this.env.DOMINATION_TEAM_GAP, base.domination.teamGap),
      },
      fullClear: { ...base.fullClear },
    };
  }

  /** 每次房间状态变化都会走到这里（由 RoomHub.touch 触发） */
  #persist(room) {
    if (!this.manager?.singleRoomCode) return;
    const snapshot = {
      v: 1,
      savedAt: Date.now(),
      // lastActivity 也存下来，房号过期回收要靠它
      lastActivity: room.lastActivity,
      mode: room.mode,
      difficulty: room.difficulty,
      phase: room.phase,
      hostId: room.hostId,
      gameNo: room.gameNo,
      createdAt: room.createdAt,
      seats: room.seats.map((s) => ({
        kind: s.kind,
        playerId: s.playerId,
        name: s.name,
        ready: s.ready,
        auto: s.auto,
      })),
      totals: [...room.totals.entries()],
      chat: room.chat,
      state: room.state ? serializeState(room.state) : null,
      result: room.result ?? null,
    };
    // 不 await：DO 有 output gate，会在把消息发给客户端之前先把写入落盘。
    // 这样既不用每个地方都 await 一遍，也不会出现「客户端看到了、存储还没写」。
    this.ctx.storage.put(STORAGE_KEY, snapshot);
  }

  #restore(saved) {
    const room = this.manager.ensureRoom();
    room.mode = saved.mode ?? MODE_FFA;
    room.difficulty = saved.difficulty ?? DIFFICULTY_NORMAL;
    room.phase = saved.phase ?? 'lobby';
    room.hostId = saved.hostId ?? null;
    room.gameNo = saved.gameNo ?? 0;
    room.createdAt = saved.createdAt ?? Date.now();
    room.lastActivity = saved.lastActivity ?? Date.now();
    room.totals = new Map(saved.totals ?? []);
    room.chat = Array.isArray(saved.chat) ? saved.chat : [];
    room.result = saved.result ?? null;

    room.seats = (saved.seats ?? []).map((s) => ({
      kind: s.kind ?? 'open',
      playerId: s.playerId ?? null,
      name: s.name ?? null,
      ready: !!s.ready,
      auto: !!s.auto,
      // 连接对象不可能跨实例恢复，全部置空；玩家重连后会重新绑定
      conn: null,
    }));
    while (room.seats.length < SEAT_COUNT) {
      room.seats.push({ kind: 'open', playerId: null, name: null, ready: false, auto: false, conn: null });
    }

    room.state = saved.state ? deserializeState(saved.state) : null;
  }

  /* ───────────────────────── HTTP ───────────────────────── */

  async fetch(request) {
    const url = new URL(request.url);

    // 房号分配用：/api/new-room 会挨个问「这个房号还能用吗」
    if (url.pathname === '/internal/claim') {
      return this.#claim();
    }

    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('这个端点只接受 WebSocket 连接', { status: 426 });
    }

    const code = (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 4) {
      return new Response('房号不合法', { status: 400 });
    }

    // WebSocketPair 必须在 accept 之前建好；先等房间就绪再做，避免异步打断升级
    await this.#ensureReady(code);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    const conn = wrapSocket(server);
    conn.data.roomCode = code;

    server.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        conn.sendJSON({ t: 'error', message: '消息不是合法 JSON' });
        return;
      }
      try {
        this.hub.handle(conn, msg);
      } catch (err) {
        console.error('处理消息出错：', err?.stack ?? err);
        conn.sendJSON({ t: 'error', message: '服务器内部错误' });
      }
    });

    server.addEventListener('close', () => {
      conn.closed = true;
      try {
        this.hub.handleLeave(conn);
      } catch (err) {
        console.error('断开处理出错：', err?.stack ?? err);
      }
    });

    server.addEventListener('error', () => {
      conn.closed = true;
      try {
        this.hub.handleLeave(conn);
      } catch {
        /* 忽略 */
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 房号能不能用。
   *
   * 关键：**必须落一个预定标记**。否则同一个房号可能被连续分配两次 ——
   * 两个陌生人各自点「创建房间」，拿到同一个房号，然后连进同一个房间。
   * 光读不写是防不住的。
   */
  async #claim() {
    const now = Date.now();
    const [room, claim] = await Promise.all([
      this.ctx.storage.get(STORAGE_KEY),
      this.ctx.storage.get(CLAIM_KEY),
    ]);

    const taken = (msg) =>
      new Response(JSON.stringify({ ok: false, reason: msg }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });

    if (room) {
      const idle = now - (room.lastActivity ?? room.savedAt ?? 0);
      if (idle < STALE_MS) return taken('已有房间且仍活跃');
      // 太久没人来，清掉让房号可以被复用
      await this.ctx.storage.delete(STORAGE_KEY);
    }
    if (claim && now - claim.at < CLAIM_TTL_MS) return taken('已被预定，客户端还没连上来');

    await this.ctx.storage.put(CLAIM_KEY, { at: now });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  }
}
