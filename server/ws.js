/**
 * 极简 RFC 6455 WebSocket 服务端实现（零依赖）。
 *
 * 只实现游戏需要的部分：文本帧、分片、ping/pong、close，
 * 以及服务端必须做的握手与掩码校验。
 *
 * 为什么不用 ws / socket.io：本机环境完全无法访问 npm registry，
 * 任何外部依赖都装不上。手写这一层反而让项目「拷贝即可运行」。
 *
 * 协议要点（RFC 6455）：
 *  - 握手：Sec-WebSocket-Accept = base64(sha1(key + GUID))
 *  - 客户端发来的帧**必须**带掩码，服务端发出去的帧**必须**不带掩码
 *  - 控制帧（close/ping/pong）必须 ≤125 字节且不能分片
 *  - 长度 7 位：≤125 直接表示；126 → 后接 2 字节；127 → 后接 8 字节
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 单条消息上限（默认 1 MiB）——远超游戏所需，防止内存被撑爆 */
export const MAX_PAYLOAD = 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** 计算握手应答值 */
export function computeAccept(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export class WsConnection extends EventEmitter {
  #socket;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentOpcode = 0;
  #fragmentBytes = 0;

  constructor(socket) {
    super();
    this.#socket = socket;
    this.closed = false;
    this.isAlive = true;
    this.data = null; // 调用方挂载业务数据（如所属房间）

    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('close', () => this.#finalize());
    socket.on('error', () => this.#finalize());
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
  }

  get remoteAddress() {
    return this.#socket.remoteAddress;
  }

  /** 把已读到的字节喂进解析器（握手时 head 里可能已经带了帧数据） */
  feed(chunk) {
    if (this.closed) return;
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;

    for (;;) {
      if (this.closed) return;
      const frame = this.#parseFrame();
      if (!frame) return;
      this.#handleFrame(frame);
    }
  }

  #parseFrame() {
    const buf = this.#buffer;
    if (buf.length < 2) return null;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) {
      this.close(1002, 'RSV 必须为 0');
      return null;
    }

    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD)) {
        this.close(1009, '消息过大');
        return null;
      }
      len = Number(big);
      offset = 10;
    }

    if (len > MAX_PAYLOAD) {
      this.close(1009, '消息过大');
      return null;
    }

    // 客户端 → 服务端的帧必须带掩码，否则按协议错误断开
    if (!masked) {
      this.close(1002, '客户端帧必须带掩码');
      return null;
    }

    if (buf.length < offset + 4 + len) return null;

    const mask = buf.subarray(offset, offset + 4);
    const start = offset + 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[start + i] ^ mask[i & 3];
    this.#buffer = buf.subarray(start + len);

    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }) {
    const isControl = opcode >= 0x8;

    if (isControl) {
      if (!fin || payload.length > 125) {
        this.close(1002, '控制帧不合法');
        return;
      }
      if (opcode === OP_CLOSE) {
        // RFC 6455 §5.5.1：收到关闭帧后必须回送一个关闭帧，再关 TCP。
        // 注意 1005 是「没有状态码」的保留值，不允许出现在线路上。
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.emit('close', code, reason);
        const echo = code === 1005 || code === 1006 ? 1000 : code;
        this.close(echo, '');
        return;
      }
      if (opcode === OP_PING) {
        this.#writeFrame(OP_PONG, payload);
        return;
      }
      if (opcode === OP_PONG) {
        this.isAlive = true;
        this.emit('pong');
        return;
      }
      this.close(1002, `不支持的控制帧 ${opcode}`);
      return;
    }

    if (opcode === OP_CONT) {
      if (this.#fragmentOpcode === 0) {
        this.close(1002, '没有待续帧却收到续帧');
        return;
      }
      this.#fragmentBytes += payload.length;
      if (this.#fragmentBytes > MAX_PAYLOAD) {
        this.close(1009, '消息过大');
        return;
      }
      this.#fragments.push(payload);
      if (fin) this.#flushFragments();
      return;
    }

    if (opcode !== OP_TEXT && opcode !== OP_BINARY) {
      this.close(1002, `不支持的帧类型 ${opcode}`);
      return;
    }

    if (fin) {
      this.#deliver(opcode, payload);
      return;
    }

    this.#fragmentOpcode = opcode;
    this.#fragments = [payload];
    this.#fragmentBytes = payload.length;
  }

  #flushFragments() {
    const opcode = this.#fragmentOpcode;
    const merged = Buffer.concat(this.#fragments);
    this.#fragments = [];
    this.#fragmentOpcode = 0;
    this.#fragmentBytes = 0;
    this.#deliver(opcode, merged);
  }

  #deliver(opcode, payload) {
    if (opcode === OP_BINARY) {
      this.emit('binary', payload);
      return;
    }
    const text = payload.toString('utf8');
    this.emit('message', text);
    // 约定游戏协议是 JSON；解析失败不算致命，交给上层处理
    try {
      this.emit('json', JSON.parse(text));
    } catch {
      this.emit('badjson', text);
    }
  }

  #writeFrame(opcode, payload) {
    if (this.closed || this.#socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN = 1，服务端不分片
    try {
      this.#socket.write(Buffer.concat([header, payload]));
      return true;
    } catch {
      this.#finalize();
      return false;
    }
  }

  /** 发送文本消息 */
  send(data) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return this.#writeFrame(OP_TEXT, payload);
  }

  /** 发送 JSON */
  sendJSON(obj) {
    return this.send(JSON.stringify(obj));
  }

  ping(payload = Buffer.alloc(0)) {
    return this.#writeFrame(OP_PING, payload);
  }

  /** 发送关闭帧并关闭连接 */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.#writeFrame(OP_CLOSE, payload);
    this.#shutdown();
  }

  #shutdown() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.#socket.end();
    } catch {
      /* 忽略 */
    }
    // 对端不收敛就强断，避免句柄泄漏
    setTimeout(() => {
      try {
        this.#socket.destroy();
      } catch {
        /* 忽略 */
      }
    }, 1000).unref?.();
  }

  #finalize() {
    if (this.closed) {
      this.emit('_closed');
      return;
    }
    this.closed = true;
    this.emit('close', 1006, '');
    this.emit('_closed');
  }
}

/**
 * 完成 HTTP → WebSocket 升级。
 * @returns {WsConnection|null} 握手失败时返回 null（socket 已被处理）
 */
export function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();

  const fail = (status, text) => {
    try {
      socket.write(
        `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      socket.destroy();
    } catch {
      /* 忽略 */
    }
    return null;
  };

  if (upgrade !== 'websocket') return fail(400, 'Bad Request');
  if (!key || typeof key !== 'string') return fail(400, 'Bad Request');
  if (version !== '13') return fail(426, 'Upgrade Required');

  const accept = computeAccept(key);
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n');

  try {
    socket.write(headers);
  } catch {
    socket.destroy();
    return null;
  }
  if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

  const conn = new WsConnection(socket);
  if (head && head.length) conn.feed(head);
  return conn;
}
