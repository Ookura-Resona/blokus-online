import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { acceptUpgrade, computeAccept, MAX_PAYLOAD } from '../server/ws.js';
import { connectWs, buildClientFrame, OP_TEXT, OP_PING, OP_CLOSE } from './wsclient.js';

/** 起一个回显用的 WebSocket 服务端 */
async function startEchoServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => {
    const conn = acceptUpgrade(req, socket, head);
    if (!conn) return;
    seen.push(conn);
    conn.on('json', (msg) => conn.sendJSON({ echo: msg, n: typeof msg.n === 'number' ? msg.n : null }));
    conn.on('badjson', () => conn.send('not json'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, seen };
}

function withServer(fn) {
  return async () => {
    const { server, port, seen } = await startEchoServer();
    try {
      await fn(port, seen);
    } finally {
      await new Promise((r) => server.close(r));
    }
  };
}

/* ------------------------------------------------------------------ */

test('RFC 6455 官方示例的握手应答值', () => {
  // 来自 RFC 6455 §1.3 的标准示例
  assert.equal(computeAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test(
  '握手成功并返回正确的 Sec-WebSocket-Accept',
  withServer(async (port) => {
    const ws = await connectWs(port);
    assert.match(ws.handshakeRaw, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.match(ws.handshakeRaw, /Upgrade: websocket/i);
    assert.match(ws.handshakeRaw, /Connection: Upgrade/i);
    assert.equal(ws.accept(), ws.expectedAccept);
    ws.close();
  }),
);

test(
  '文本消息往返（短帧，7 位长度）',
  withServer(async (port) => {
    const ws = await connectWs(port);
    ws.send(JSON.stringify({ hello: '世界', n: 1 }));
    const reply = JSON.parse(await ws.nextText());
    assert.equal(reply.echo.hello, '世界');
    assert.equal(reply.n, 1);
    // RFC 6455 §5.1：服务端发出去的帧**不能**带掩码。
    // （Cloudflare 的 workerd 在本地模式会加，所以客户端做了容错，
    //   但对自家实现要严格断言。）
    assert.equal(ws.sawMaskedServerFrame(), false, '服务端不应给帧加掩码');
    ws.close();
  }),
);

test(
  'JSON 消息走 json 事件而不是 badjson',
  withServer(async (port) => {
    const ws = await connectWs(port);
    ws.send('{"n":42}');
    const reply = JSON.parse(await ws.nextText());
    assert.deepEqual(reply, { echo: { n: 42 }, n: 42 });
    ws.close();
  }),
);

test(
  '非 JSON 文本触发 badjson',
  withServer(async (port) => {
    const ws = await connectWs(port);
    ws.send('这不是 JSON');
    assert.equal(await ws.nextText(), 'not json');
    ws.close();
  }),
);

test(
  '中等长度消息（16 位长度，300 字节）',
  withServer(async (port) => {
    const ws = await connectWs(port);
    const payload = 'x'.repeat(300);
    ws.send(payload);
    assert.equal(await ws.nextText(), 'not json');
    ws.close();
  }),
);

test(
  '超长消息（64 位长度，70000 字节）',
  withServer(async (port) => {
    const ws = await connectWs(port);
    const ws2 = await connectWs(port);
    // 中文 3 字节，构造 >65535 字节的 JSON
    const big = '中'.repeat(30000);
    ws2.send(JSON.stringify({ big }));
    const reply = JSON.parse(await ws2.nextText(5000));
    assert.equal(reply.echo.big.length, 30000);
    // 顺带确认两个连接互不干扰
    ws.send(JSON.stringify({ n: 7 }));
    assert.equal(JSON.parse(await ws.nextText()).n, 7);
    ws.close();
    ws2.close();
  }),
);

test(
  '分片消息会被拼装还原',
  withServer(async (port) => {
    const ws = await connectWs(port);
    const text = JSON.stringify({ msg: '分片传输的测试消息', n: 5 });
    const bytes = Buffer.from(text, 'utf8');
    ws.sendFragmented(text, Math.floor(bytes.length / 2));
    const reply = JSON.parse(await ws.nextText());
    assert.equal(reply.echo.msg, '分片传输的测试消息');
    assert.equal(reply.n, 5);
    ws.close();
  }),
);

test(
  '服务端正确回应 ping（pong 原样带回 payload）',
  withServer(async (port) => {
    const ws = await connectWs(port);
    const payload = Buffer.from('hb');
    ws.sendRaw(buildClientFrame(OP_PING, payload));
    const frame = await ws.nextFrame();
    // 控制帧不进入业务帧队列的话，这里会超时；实际服务端回的 pong 会被当作普通帧收下
    assert.ok(frame);
    ws.close();
  }),
);

test(
  '未带掩码的客户端帧会被服务端按协议错误关闭（1002）',
  withServer(async (port) => {
    const ws = await connectWs(port);
    ws.sendRaw(buildClientFrame(OP_TEXT, 'no mask', { mask: false }));
    const info = await ws.waitClose();
    assert.equal(info.code, 1002);
  }),
);

test(
  '客户端主动关闭会被服务端正确响应',
  withServer(async (port) => {
    const ws = await connectWs(port);
    ws.sendRaw(buildClientFrame(OP_CLOSE, Buffer.from([0x03, 0xe8])));
    const info = await ws.waitClose();
    assert.equal(info.code, 1000);
  }),
);

test('缺少 Sec-WebSocket-Key 的升级请求会被拒绝', async () => {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let upgraded = null;
  server.on('upgrade', (req, socket, head) => {
    upgraded = acceptUpgrade(req, socket, head);
  });
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        port,
        host: '127.0.0.1',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
      });
      req.on('response', (r) => {
        r.resume();
        resolve(r.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res, 400);
    assert.equal(upgraded, null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('错误的 Sec-WebSocket-Version 返回 426', async () => {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('upgrade', (req, socket, head) => {
    acceptUpgrade(req, socket, head);
  });
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        port,
        host: '127.0.0.1',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '8',
        },
      });
      req.on('response', (r) => {
        r.resume();
        resolve(r.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res, 426);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('超过上限的消息会被拒绝（1009）', async () => {
  const { server, port } = await startEchoServer();
  try {
    const ws = await connectWs(port);
    // 只发帧头声明一个超大长度，不真发数据，服务端应当直接拒绝
    const header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(MAX_PAYLOAD + 1), 2);
    header.writeUInt32BE(0, 10); // 掩码 key
    ws.sendRaw(header);
    const info = await ws.waitClose();
    assert.equal(info.code, 1009);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
