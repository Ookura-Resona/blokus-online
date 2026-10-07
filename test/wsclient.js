/**
 * 测试用的极简 WebSocket 客户端（服务端 ws.js 的对端实现）。
 * 特意手写而不是复用服务端代码，这样握手/分帧是两套独立实现，能真正互相校验。
 */

import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** 按客户端规则构造一个带掩码的帧 */
export function buildClientFrame(opcode, payload, { fin = true, mask = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  const b0 = (fin ? 0x80 : 0x00) | opcode;

  let header;
  if (len < 126) {
    header = Buffer.from([b0, (mask ? 0x80 : 0) | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = b0;
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = b0;
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  if (!mask) return Buffer.concat([header, data]);
  const key = randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

/** 期望的握手应答值（客户端侧独立计算） */
export function expectedAccept(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** 从缓冲区里解析一个服务端 → 客户端的帧 */
function parseServerFrame(state) {
  const buf = state.buffer;
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  // RFC 6455 规定服务端**不能**给帧加掩码。但 Cloudflare 的 workerd 在
  // `wrangler dev` 本地模式下会加（生产环境由边缘处理），所以这里容错解掩码，
  // 同时记一个标记 —— ws.test.js 会用这个标记断言「我们自己的服务端没加掩码」。
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
    state.sawMaskedServerFrame = true;
  }

  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (maskKey) {
    const plain = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) plain[i] = payload[i] ^ maskKey[i & 3];
    payload = plain;
  }
  state.buffer = buf.subarray(offset + len);
  if (!fin) throw new Error('测试客户端不支持分片的服务端帧');
  return { opcode, payload, masked };
}

/**
 * 建立一条 WebSocket 连接。
 * @returns {Promise<object>} 便于断言的连接对象
 */
export function connectWs(port, { host = '127.0.0.1', path = '/ws' } = {}) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const socket = net.connect(port, host);

    const state = {
      socket,
      key,
      buffer: Buffer.alloc(0),
      frames: [],
      frameWaiters: [],
      closeWaiters: [],
      handshakeRaw: '',
      handshakeDone: false,
      closeInfo: null,
      // 消息日志：一旦开启，由唯一的读取协程消费帧，其他人只看日志
      logging: false,
      log: [],
      logSeq: 0,
      consumedSeq: 0,
      textConsumedSeq: 0,
      logWaiters: [],
    };

    const settle = () => {
      while (state.frameWaiters.length > 0 && state.frames.length > 0) {
        const w = state.frameWaiters.shift();
        clearTimeout(w.timer);
        w.resolve(state.frames.shift());
      }
      // 连接断了就立刻唤醒所有还在等帧的人，否则他们要干等到超时，
      // 进程会因为这些悬挂的定时器而无法退出。
      if (state.closeInfo && state.frameWaiters.length > 0) {
        const waiters = state.frameWaiters;
        state.frameWaiters = [];
        for (const w of waiters) {
          clearTimeout(w.timer);
          w.reject(new Error(`连接已关闭 code=${state.closeInfo.code}`));
        }
      }
      if (state.closeInfo && state.closeWaiters.length > 0) {
        const waiters = state.closeWaiters;
        state.closeWaiters = [];
        for (const w of waiters) w(state.closeInfo);
      }
    };

    const pump = () => {
      for (;;) {
        const frame = parseServerFrame(state);
        if (!frame) break;
        if (frame.opcode === OP_CLOSE) {
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
          state.closeInfo = { code, reason: frame.payload.subarray(2).toString('utf8') };
          try {
            socket.write(buildClientFrame(OP_CLOSE, frame.payload.subarray(0, 2)));
          } catch {
            /* 忽略 */
          }
          settle();
          continue;
        }
        state.frames.push(frame);
        settle();
      }
    };

    socket.on('error', (err) => {
      if (!state.handshakeDone) {
        reject(err);
        return;
      }
      if (!state.closeInfo) state.closeInfo = { code: 1006, reason: String(err.message) };
      settle();
    });

    socket.on('close', () => {
      if (!state.closeInfo) state.closeInfo = { code: 1006, reason: '连接被关闭' };
      settle();
    });

    socket.on('data', (chunk) => {
      state.buffer = state.buffer.length ? Buffer.concat([state.buffer, chunk]) : chunk;

      if (!state.handshakeDone) {
        const end = state.buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        state.handshakeRaw = state.buffer.subarray(0, end + 4).toString('latin1');

        // 必须校验状态码是 101。否则服务端回 400/404 时，解析器会一路
        // 「成功」下去，表现为「连接建立了但永远收不到消息」，非常难查。
        if (!/^HTTP\/1\.1 101\b/.test(state.handshakeRaw)) {
          const first = state.handshakeRaw.split('\r\n')[0];
          reject(new Error(`WebSocket 升级失败：服务端返回「${first}」而不是 101`));
          try {
            socket.destroy();
          } catch {
            /* 忽略 */
          }
          return;
        }

        state.buffer = state.buffer.subarray(end + 4);
        state.handshakeDone = true;
        resolve(makeApi(state));
      }
      pump();
    });

    socket.on('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n'),
      );
    });
  });
}

/** 取下一个原始帧（内部使用；消息日志开启后由读取协程独占） */
function readFrame(state, timeoutMs) {
  if (state.frames.length > 0) return Promise.resolve(state.frames.shift());
  if (state.closeInfo) {
    return Promise.reject(new Error(`连接已关闭 code=${state.closeInfo.code}`));
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      state.frameWaiters = state.frameWaiters.filter((w) => w !== waiter);
      reject(new Error('等待服务端帧超时'));
    }, timeoutMs);
    state.frameWaiters.push(waiter);
  });
}

function notifyLog(state) {
  const waiters = state.logWaiters;
  state.logWaiters = [];
  for (const w of waiters) w();
}

function waitLog(state, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.logWaiters = state.logWaiters.filter((w) => w !== onLog);
      resolve();
    }, timeoutMs);
    const onLog = () => {
      clearTimeout(timer);
      resolve();
    };
    state.logWaiters.push(onLog);
  });
}

/** 启动唯一的帧读取协程，把收到的 JSON 消息按顺序记进日志 */
function ensureLogging(state) {
  if (state.logging) return;
  state.logging = true;
  (async () => {
    for (;;) {
      let frame;
      try {
        // 超时故意设得短：连接空闲时只留一个 1 秒的定时器，
        // 否则测试进程会被一个 120 秒的悬挂定时器拖住无法退出。
        frame = await readFrame(state, 1000);
      } catch {
        if (state.closeInfo) break;
        continue;
      }
      if (frame.opcode !== OP_TEXT) continue;
      const text = frame.payload.toString('utf8');
      let msg = null;
      try {
        msg = JSON.parse(text);
      } catch {
        /* 非 JSON，保留原文 */
      }
      state.log.push({ seq: ++state.logSeq, msg, text });
      if (state.log.length > 4000) state.log.splice(0, 2000);
      notifyLog(state);
    }
    notifyLog(state);
  })();
}

function makeApi(state) {
  const api = {
    raw: state.socket,

    /** 握手响应原文 */
    get handshakeRaw() {
      return state.handshakeRaw;
    },

    /** 服务端返回的 Sec-WebSocket-Accept */
    accept() {
      const m = /sec-websocket-accept:\s*(\S+)/i.exec(state.handshakeRaw);
      return m ? m[1] : null;
    },

    /** 客户端独立算出的期望应答值 */
    expectedAccept: expectedAccept(state.key),

    /** 开启消息日志（waitJson / latest 需要它） */
    startLogging() {
      ensureLogging(state);
      return api;
    },

    send(text) {
      state.socket.write(buildClientFrame(OP_TEXT, text));
    },

    sendJSON(obj) {
      api.send(JSON.stringify(obj));
    },

    sendRaw(buf) {
      state.socket.write(buf);
    },

    sendFragmented(text, splitAt) {
      const buf = Buffer.from(text, 'utf8');
      state.socket.write(buildClientFrame(OP_TEXT, buf.subarray(0, splitAt), { fin: false }));
      state.socket.write(buildClientFrame(OP_CONT, buf.subarray(splitAt), { fin: true }));
    },

    /** 取下一个原始帧。消息日志开启后帧由读取协程独占，这里会直接报错 */
    nextFrame(timeoutMs = 2000) {
      if (state.logging) {
        throw new Error('消息日志已开启，nextFrame 会与读取协程抢帧；请改用 nextText / waitJson / latest');
      }
      return readFrame(state, timeoutMs);
    },

    /**
     * 取下一个服务端消息（文本原文）。
     *
     * 这里刻意走消息日志而不是直接抢帧：只要有人调用过 waitJson/latest，
     * 帧就已经被唯一的读取协程消费了，再去 readFrame 只会互相吞消息。
     * 统一走日志之后，nextText / nextJson / waitJson 混用也不会出问题。
     */
    async nextText(timeoutMs = 2000) {
      api.startLogging();
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = state.log.find((e) => e.seq > state.textConsumedSeq);
        if (hit) {
          state.textConsumedSeq = hit.seq;
          return hit.text;
        }
        // 连接已关闭且没有新消息了，立刻报错而不是干等到超时
        if (state.closeInfo) throw new Error(`连接已关闭 code=${state.closeInfo.code}`);
        const remain = deadline - Date.now();
        if (remain <= 0) throw new Error('等待服务端消息超时');
        await waitLog(state, remain);
      }
    },

    async nextJson(timeoutMs = 2000) {
      return JSON.parse(await api.nextText(timeoutMs));
    },

    /**
     * 等待指定类型的消息，返回**还没被消费过的最早一条**。
     *
     * 这里用水位线（consumedSeq）而不是「本次调用之后到达的消息」：
     * 服务端向全房间广播时，各客户端的消息几乎同时到达，
     * 若只认调用之后到达的，就会把已经到达的那条判成过期而永远等不到。
     */
    async waitJson(type, timeoutMs = 5000) {
      api.startLogging();
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = state.log.find((e) => e.seq > state.consumedSeq && e.msg && e.msg.t === type);
        if (hit) {
          state.consumedSeq = hit.seq;
          return hit.msg;
        }
        const remain = deadline - Date.now();
        if (remain <= 0) {
          const seen =
            state.log
              .filter((e) => e.seq > state.consumedSeq)
              .map((e) => e.msg?.t ?? '?')
              .join(',') || '（无）';
          throw new Error(`等待 ${type} 超时，未消费的消息：${seen}`);
        }
        await waitLog(state, remain);
      }
    },

    /**
     * 等待一条**本次调用之后才到达**的指定类型消息。
     * 用于「我刚刚让房间状态变了，现在要拿最新的那一份」这类场景。
     */
    async waitLatest(type, timeoutMs = 5000) {
      api.startLogging();
      const startSeq = state.logSeq;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = state.log.find((e) => e.seq > startSeq && e.msg && e.msg.t === type);
        if (hit) return hit.msg;
        const remain = deadline - Date.now();
        if (remain <= 0) throw new Error(`等待新的 ${type} 超时`);
        await waitLog(state, remain);
      }
    },

    /** 日志里最近一条指定类型的消息（没有则 null），不等待 */
    latest(type) {
      api.startLogging();
      for (let i = state.log.length - 1; i >= 0; i--) {
        if (state.log[i].msg?.t === type) return state.log[i].msg;
      }
      return null;
    },

    /** 日志里出现过的所有指定类型消息 */
    all(type) {
      api.startLogging();
      return state.log.filter((e) => e.msg?.t === type).map((e) => e.msg);
    },

    /** 日志里出现过的所有错误消息文本 */
    errors() {
      return api.all('error').map((m) => m.message);
    },

    /** 服务端有没有给帧加掩码（RFC 6455 规定不该加；自家服务端应当始终是 false） */
    sawMaskedServerFrame() {
      return !!state.sawMaskedServerFrame;
    },

    /** 等待连接被服务端关闭，返回 { code, reason } */
    waitClose(timeoutMs = 3000) {
      if (state.closeInfo) return Promise.resolve(state.closeInfo);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待关闭超时')), timeoutMs);
        state.closeWaiters.push((info) => {
          clearTimeout(timer);
          resolve(info);
        });
      });
    },

    close() {
      try {
        state.socket.write(buildClientFrame(OP_CLOSE, Buffer.from([0x03, 0xe8])));
      } catch {
        /* 忽略 */
      }
      state.socket.end();
    },

    /** 强制断开底层连接（测试收尾用，确保事件循环能结束） */
    destroy() {
      if (!state.closeInfo) state.closeInfo = { code: 1000, reason: '客户端主动断开' };
      try {
        state.socket.destroy();
      } catch {
        /* 忽略 */
      }
      // 立刻唤醒所有还在等待的人，否则悬挂的定时器会让进程无法退出
      const fw = state.frameWaiters;
      state.frameWaiters = [];
      for (const w of fw) {
        clearTimeout(w.timer);
        w.reject(new Error('客户端主动断开'));
      }
      const cw = state.closeWaiters;
      state.closeWaiters = [];
      for (const w of cw) w(state.closeInfo);
      notifyLog(state);
    },
  };

  return api;
}
