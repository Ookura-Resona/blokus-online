/**
 * 部署 Worker 的前置检查。
 *
 *   node tools/worker-preflight.js
 *
 * 为什么需要它：wrangler 在**找不到 wrangler.toml** 的时候不会报「配置文件缺失」，
 * 而是退回 autoconfig 流程去猜项目结构。如果当前目录恰好没有 index.html /
 * dist / public 之类的东西，它就会抛一个非常容易误导人的错误：
 *
 *   Could not detect a directory containing static files (e.g. html, css and js)
 *
 * 这个报错看起来像「项目里没有静态文件」，实际上原因是「你跑错目录了」。
 * 真踩过：在 D:\GAME1 而不是 D:\GAME1\Blokus 下执行 npx wrangler deploy。
 *
 * 所以这里在调 wrangler 之前先把「是不是在项目根目录」查清楚，
 * 给一句人话，而不是让 wrangler 去猜。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（脚本所在目录的上级），与当前工作目录无关 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 部署 Worker 必须要有的东西 */
const REQUIRED = [
  ['wrangler.toml', 'Worker 的部署配置（assets 绑定 + Durable Object 绑定）'],
  ['worker/index.js', 'Worker 入口'],
  ['worker/room.js', '房间 Durable Object'],
  ['public/index.html', '前端页面'],
  ['public/app.js', '前端主逻辑'],
  ['shared/rooms.js', '房间与对局流程（Node 与 Worker 共用）'],
];

/**
 * @returns {{ ok: boolean, problems: string[], hints: string[] }}
 */
export function checkDeployPrerequisites(cwd = process.cwd()) {
  const problems = [];
  const hints = [];

  // 1. 是不是在项目根目录跑
  const missingHere = REQUIRED.filter(([rel]) => !fs.existsSync(path.join(cwd, rel)));
  if (missingHere.length > 0) {
    problems.push(
      `当前目录（${cwd}）不是一个完整的项目根目录，缺少：` +
        missingHere.map(([rel]) => rel).join('、'),
    );
    // 如果项目根在别处，直接告诉用户该 cd 到哪儿
    const inRoot = REQUIRED.every(([rel]) => fs.existsSync(path.join(ROOT, rel)));
    if (inRoot && path.resolve(cwd) !== ROOT) {
      hints.push(`先在终端里进到项目目录再跑：cd "${ROOT}"`);
      hints.push('或者直接用 npm 脚本（npm 会自动切到 package.json 所在目录）：npm run worker:deploy');
    }
    // 这是 wrangler 那种误导性报错的正解，直接点名
    hints.push(
      '注意：如果 wrangler 报「Could not detect a directory containing static files」，' +
        '那不一定是缺静态文件，更可能是跑错目录了 —— 它没读到 wrangler.toml，' +
        '就退回 autoconfig 去猜项目结构，猜不到就报这个。',
    );
  }

  // 2. 依赖装了没（wrangler 是 devDependency）
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'wrangler'))) {
    problems.push('还没装 wrangler（部署 Worker 用的开发工具）');
    hints.push('先跑一次：npm install');
  }

  return { ok: problems.length === 0, problems, hints };
}

/* ───────────────────────── CLI ───────────────────────── */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const r = checkDeployPrerequisites();
  console.log('');
  if (r.ok) {
    console.log('  ✓ 部署前置检查通过');
    console.log(`    项目根：${ROOT}`);
    console.log('');
    process.exit(0);
  }
  console.log('  ✗ 还不能部署：\n');
  for (const p of r.problems) console.log(`    · ${p}`);
  if (r.hints.length) {
    console.log('\n  怎么办：\n');
    for (const h of r.hints) console.log(`    · ${h}`);
  }
  console.log('');
  process.exit(1);
}
