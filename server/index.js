/**
 * 角斗士棋（Blokus）联机服务器启动入口。
 *
 * 零依赖：只用 Node 内置模块 + 自己写的 WebSocket（server/ws.js）。
 * 同一个端口同时提供静态站点与 WebSocket。
 *
 *   node server/index.js                 # 默认 0.0.0.0:3000
 *   PORT=8080 node server/index.js
 *   npm start
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { loadConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const config = loadConfig(ROOT);
const app = createApp({
  scoring: config.scoring,
  aiDelayMs: config.aiDelayMs,
  turnLimitMs: config.turnLimitMs,
});

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

app.server.listen(config.port, config.host, () => {
  const addr = app.server.address();
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log('');
  console.log('  角斗士棋（Blokus）联机服务器已启动');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  本机访问：   http://${shown}:${addr.port}/`);
  for (const ip of localAddresses()) {
    console.log(`  局域网访问： http://${ip}:${addr.port}/   ← 手机连同一 WiFi 用这个`);
  }
  console.log('');
  console.log(
    `  积分规则：   ${config.configFile ? `来自 ${path.basename(config.configFile)}` : '使用内置默认值'}`,
  );
  console.log(
    `  AI 每步停顿：${config.aiDelayMs}ms    思考时限：${config.turnLimitMs / 1000}s（超时自动托管）`,
  );
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n正在关闭…');
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => console.error('[未捕获的 Promise 拒绝]', err));
