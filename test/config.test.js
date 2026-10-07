import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../server/config.js';
import { DEFAULT_SCORING } from '../shared/constants.js';

// 用 fileURLToPath 而不是 import.meta.dirname（后者要 Node 20.11+）
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 造一个只含配置文件的临时目录 */
function tmpDirWith(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blokus-cfg-'));
  if (config !== null) {
    fs.writeFileSync(path.join(dir, 'blokus.config.json'), JSON.stringify(config, null, 2));
  }
  return dir;
}

/** 临时改环境变量并在结束后还原 */
function withEnv(pairs, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(pairs)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('没有配置文件时使用内置默认值', () => {
  const dir = tmpDirWith(null);
  withEnv({ PORT: undefined, HOST: undefined, AI_DELAY_MS: undefined, TURN_LIMIT_MS: undefined }, () => {
    const cfg = loadConfig(dir);
    assert.equal(cfg.configFile, null);
    assert.deepEqual(cfg.scoring, DEFAULT_SCORING);
    assert.equal(cfg.aiDelayMs, 650);
    assert.equal(cfg.turnLimitMs, 20_000);
  });
});

test('配置文件可以覆盖积分规则与运行参数', () => {
  const dir = tmpDirWith({
    port: 8123,
    host: '127.0.0.1',
    aiDelayMs: 0,
    turnLimitMs: 5000,
    scoring: { ffaRankDelta: [5, 2, 0, -3], teamWinDelta: 4 },
  });
  withEnv({ PORT: undefined, HOST: undefined, AI_DELAY_MS: undefined, TURN_LIMIT_MS: undefined }, () => {
    const cfg = loadConfig(dir);
    assert.ok(cfg.configFile.endsWith('blokus.config.json'));
    assert.equal(cfg.port, 8123);
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.aiDelayMs, 0);
    assert.equal(cfg.turnLimitMs, 5000);
    assert.deepEqual(cfg.scoring.ffaRankDelta, [5, 2, 0, -3]);
    assert.equal(cfg.scoring.teamWinDelta, 4);
    // 没覆盖的字段保持默认
    assert.equal(cfg.scoring.teamLoseDelta, DEFAULT_SCORING.teamLoseDelta);
    assert.equal(cfg.scoring.base, 1);
  });
});

test('嵌套的 domination / fullClear 支持部分覆盖', () => {
  const dir = tmpDirWith({
    scoring: { domination: { ffaGap: 7, enabled: false } },
  });
  const cfg = loadConfig(dir);
  assert.equal(cfg.scoring.domination.ffaGap, 7);
  assert.equal(cfg.scoring.domination.enabled, false);
  // 同一对象里没写的字段要保留默认
  assert.equal(cfg.scoring.domination.teamGap, DEFAULT_SCORING.domination.teamGap);
  assert.equal(cfg.scoring.domination.points, DEFAULT_SCORING.domination.points);
  assert.deepEqual(cfg.scoring.fullClear, DEFAULT_SCORING.fullClear);
});

test('环境变量优先级高于配置文件', () => {
  const dir = tmpDirWith({ port: 8123, aiDelayMs: 111 });
  withEnv({ PORT: '9999', AI_DELAY_MS: '7', HOST: undefined, TURN_LIMIT_MS: undefined }, () => {
    const cfg = loadConfig(dir);
    assert.equal(cfg.port, 9999, 'PORT 环境变量应当覆盖配置文件');
    assert.equal(cfg.aiDelayMs, 7, 'AI_DELAY_MS 环境变量应当覆盖配置文件');
  });
});

test('损坏的配置文件不会让服务器起不来，只是回退到默认值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blokus-cfg-'));
  fs.writeFileSync(path.join(dir, 'blokus.config.json'), '{ 这不是合法 JSON ');
  // 这里本来就预期会打警告，测试期间静音掉，免得污染输出
  const warn = console.warn;
  console.warn = () => {};
  try {
    const cfg = loadConfig(dir);
    assert.equal(cfg.configFile, null);
    assert.deepEqual(cfg.scoring, DEFAULT_SCORING);
  } finally {
    console.warn = warn;
  }
});

test('以 "_" 开头的注释键会被剔除，不会泄漏到 API 响应里', () => {
  const dir = tmpDirWith({
    _说明: '这是注释',
    scoring: {
      _base: '基础分说明',
      base: 2,
      domination: { _note: '阈值说明', ffaGap: 8 },
    },
  });
  const cfg = loadConfig(dir);
  assert.equal(cfg.scoring.base, 2);
  assert.equal(cfg.scoring.domination.ffaGap, 8);
  assert.equal(Object.keys(cfg.scoring).some((k) => k.startsWith('_')), false);
  assert.equal(Object.keys(cfg.scoring.domination).some((k) => k.startsWith('_')), false);
  assert.equal(JSON.stringify(cfg.scoring).includes('说明'), false);
});

test('随项目附带的 blokus.config.example.json 是合法 JSON 且能被解析', () => {
  const examplePath = path.resolve(HERE, '../blokus.config.example.json');
  const raw = fs.readFileSync(examplePath, 'utf8');
  const parsed = JSON.parse(raw); // 不合法会直接抛错
  assert.ok(parsed.scoring, '示例配置应当包含 scoring');

  // 把它当成真的配置文件跑一遍，确认能被正确处理
  const dir = tmpDirWith(parsed);
  const cfg = loadConfig(dir);
  assert.equal(cfg.scoring.base, DEFAULT_SCORING.base);
  assert.deepEqual(cfg.scoring.ffaRankDelta, DEFAULT_SCORING.ffaRankDelta);
  assert.equal(cfg.scoring.domination.ffaGap, DEFAULT_SCORING.domination.ffaGap);
  assert.equal(JSON.stringify(cfg.scoring).includes('说明'), false, '注释键应当被剔除');
});
