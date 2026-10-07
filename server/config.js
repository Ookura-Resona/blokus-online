/**
 * 运行配置：默认值来自 shared/constants.js，可被项目根目录的
 * blokus.config.json 与环境变量覆盖。改积分规则只需要动 JSON，不用改代码。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SCORING } from '../shared/constants.js';

/**
 * 去掉以下划线开头的键。
 * JSON 不支持注释，所以 blokus.config.example.json 里用 "_说明" 这类键写文档；
 * 这样它们不会混进 /api/config 的响应里。
 */
function stripDocKeys(value) {
  if (Array.isArray(value)) return value.map(stripDocKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_')) continue;
      out[k] = stripDocKeys(v);
    }
    return out;
  }
  return value;
}

export function loadConfig(rootDir) {
  const file = path.join(rootDir, 'blokus.config.json');
  let user = {};
  let loaded = false;

  if (fs.existsSync(file)) {
    try {
      user = stripDocKeys(JSON.parse(fs.readFileSync(file, 'utf8')));
      loaded = true;
    } catch (err) {
      console.warn(`[config] 读取 ${file} 失败，改用默认配置：${err.message}`);
    }
  }

  const scoring = {
    ...DEFAULT_SCORING,
    ...(user.scoring ?? {}),
    domination: { ...DEFAULT_SCORING.domination, ...(user.scoring?.domination ?? {}) },
    fullClear: { ...DEFAULT_SCORING.fullClear, ...(user.scoring?.fullClear ?? {}) },
  };

  return {
    configFile: loaded ? file : null,
    scoring,
    port: Number(process.env.PORT ?? user.port ?? 3000),
    host: process.env.HOST ?? user.host ?? '0.0.0.0',
    /** AI 每步停顿（毫秒），让真人看得清 */
    aiDelayMs: Number(process.env.AI_DELAY_MS ?? user.aiDelayMs ?? 650),
    /** 轮到离线玩家多久后自动托管 */
    offlineTakeoverMs: Number(
      process.env.OFFLINE_TAKEOVER_MS ?? user.offlineTakeoverMs ?? 30_000,
    ),
  };
}
