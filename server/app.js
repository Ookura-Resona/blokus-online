/**
 * HTTP + WebSocket 应用工厂。
 *
 * 拆成工厂是为了让集成测试可以自己起一个监听随机端口、AI 停顿极短的实例，
 * 而不是把 index.js 的启动逻辑硬编码进测试。
 */

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { acceptUpgrade } from './ws.js';
import { RoomManager, RoomHub } from './rooms.js';
import {
  BOARD_SIZE,
  SEAT_CORNERS,
  SEAT_LABELS,
  SEAT_HEX,
  TEAM_OF_SEAT,
  DEFAULT_SCORING,
} from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** 把 URL 路径解析成磁盘上的真实文件，越界一律拒绝 */
export async function resolveStatic(urlPath) {
  let rel = decodeURIComponent(String(urlPath).split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  let baseDir;
  let sub;
  if (rel === '/shared' || rel.startsWith('/shared/')) {
    baseDir = SHARED_DIR;
    sub = rel.slice('/shared'.length) || '/';
  } else {
    baseDir = PUBLIC_DIR;
    sub = rel;
  }

  const target = path.resolve(baseDir, '.' + path.posix.normalize(sub));
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) return null;

  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      const index = path.join(target, 'index.html');
      await fsp.access(index);
      return index;
    }
    return target;
  } catch {
    return null;
  }
}

/**
 * 创建一个应用实例（不自动 listen）。
 * @param {{scoring?:object, aiDelayMs?:number, offlineTakeoverMs?:number}} [options]
 */
export function createApp(options = {}) {
  const settings = {
    scoring: options.scoring ?? DEFAULT_SCORING,
    aiDelayMs: options.aiDelayMs ?? 650,
    offlineTakeoverMs: options.offlineTakeoverMs ?? 30_000,
  };

  const manager = new RoomManager(settings);
  const hub = new RoomHub(manager);

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url === '/healthz' || url.startsWith('/healthz?')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, rooms: manager.rooms.size, uptimeSec: Math.round(process.uptime()) }));
      return;
    }

    if (url === '/api/config' || url.startsWith('/api/config?')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(
        JSON.stringify({
          boardSize: BOARD_SIZE,
          seatLabels: SEAT_LABELS,
          seatHex: SEAT_HEX,
          seatCorners: SEAT_CORNERS,
          teamOfSeat: TEAM_OF_SEAT,
          scoring: settings.scoring,
          aiDelayMs: settings.aiDelayMs,
          offlineTakeoverMs: settings.offlineTakeoverMs,
        }),
      );
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('405 只支持 GET');
      return;
    }

    const file = await resolveStatic(url);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 找不到这个资源');
      return;
    }
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`500 读取失败：${err.message}`);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const conn = acceptUpgrade(req, socket, head);
    if (!conn) return;

    conn.data = { playerId: null, name: null, roomCode: null, seat: null };

    conn.on('json', (msg) => {
      try {
        hub.handle(conn, msg);
      } catch (err) {
        console.error('[hub] 处理消息出错：', err);
        try {
          conn.sendJSON({ t: 'error', message: '服务器内部错误' });
        } catch {
          /* 忽略 */
        }
      }
    });

    conn.on('badjson', () => conn.sendJSON({ t: 'error', message: '消息不是合法 JSON' }));

    conn.on('close', () => {
      try {
        hub.handleLeave(conn);
      } catch (err) {
        console.error('[hub] 离开房间出错：', err);
      }
    });
  });

  // 心跳：定期 ping，回收僵尸连接
  const heartbeat = setInterval(() => {
    for (const room of manager.rooms.values()) {
      for (const conn of room.clients) {
        if (conn.closed) continue;
        if (conn.isAlive === false) {
          conn.close(1001, '心跳超时');
          continue;
        }
        conn.isAlive = false;
        conn.ping();
      }
    }
  }, 25_000);
  heartbeat.unref?.();

  function close() {
    clearInterval(heartbeat);
    manager.stop();
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, manager, hub, settings, close };
}
