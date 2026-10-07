/**
 * Cloudflare Worker 入口。
 *
 * 路由：
 *   GET /ws?room=CODE    → 交给对应房号的 Durable Object（WebSocket 升级）
 *   GET /api/new-room    → 分配一个没被占用的房号
 *   GET /api/config      → 前端/自检工具要的配置
 *   GET /healthz         → 健康检查
 *   其它                  → dist/ 里的静态资源
 *
 * 为什么要 /api/new-room：DO 是「一个房号一个实例」，所以客户端必须先知道房号，
 * 才能连到正确的 DO 上。Node 自托管版本没有这个限制（一个进程管所有房间），
 * 但两边都实现了这个端点，前端代码才能完全不用改。
 */

import { randomCode } from '../shared/rooms.js';
import {
  BOARD_SIZE,
  SEAT_LABELS,
  SEAT_HEX,
  SEAT_CORNERS,
  TEAM_OF_SEAT,
  DEFAULT_SCORING,
} from '../shared/constants.js';

export { RoomDurableObject } from './room.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

/** 最多试几次房号，避免极端情况下一直撞已占用的 */
const CLAIM_ATTEMPTS = 8;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    /* ---------------- 房号分配 ---------------- */

    if (path === '/api/new-room') {
      if (request.method !== 'GET' && request.method !== 'POST') {
        return json({ error: '只支持 GET' }, 405);
      }
      for (let i = 0; i < CLAIM_ATTEMPTS; i++) {
        const code = randomCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch('https://do/internal/claim');
        if (res.ok) return json({ code });
        if (res.status !== 409) {
          console.error('claim 失败', res.status, await res.text());
          break;
        }
      }
      return json({ error: '房号分配失败，请重试' }, 503);
    }

    /* ---------------- WebSocket ---------------- */

    if (path === '/ws') {
      const code = (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 4) {
        return new Response('缺少或非法的房号，请先用 /api/new-room 拿一个，或用邀请链接打开', {
          status: 400,
        });
      }
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }

    /* ---------------- 健康检查与配置 ---------------- */

    if (path === '/healthz') {
      return json({ ok: true, runtime: 'cloudflare-workers', region: request.cf?.colo ?? null });
    }

    if (path === '/api/config') {
      return json({
        boardSize: BOARD_SIZE,
        seatLabels: SEAT_LABELS,
        seatHex: SEAT_HEX,
        seatCorners: SEAT_CORNERS,
        teamOfSeat: TEAM_OF_SEAT,
        scoring: DEFAULT_SCORING,
        runtime: 'cloudflare-workers',
      });
    }

    /* ---------------- 静态资源 ---------------- */

    const res = await env.ASSETS.fetch(request);
    // Workers 静态资源默认不带缓存头；这几个文件不大，让浏览器短缓存一下
    if (res.ok && /\.(css|js)$/.test(path)) {
      const headers = new Headers(res.headers);
      headers.set('cache-control', 'public, max-age=300');
      return new Response(res.body, { status: res.status, headers });
    }
    return res;
  },
};
