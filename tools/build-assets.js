/**
 * 生成 Cloudflare Workers 的静态资源目录 dist/。
 *
 * 为什么要这一步：Workers 的静态资源只能挂一个目录，而我们的浏览器端需要
 *   /app.js /board.js /style.css /index.html   （来自 public/）
 *   /shared/rules.js /shared/pieces.js ...     （来自 shared/）
 * 两个目录。所以这里合成一个 dist/。
 *
 * 关键点：**不是把整个 shared/ 拷过去**，而是从 public/ 的入口出发做
 * import 传递闭包，只拷浏览器真正会加载的那几个模块。
 * 否则 shared/rooms.js（服务端房间逻辑）就会被公开到公网上。
 *
 *   node tools/build-assets.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_PUBLIC = path.join(ROOT, 'public');
const SRC_SHARED = path.join(ROOT, 'shared');
const OUT = path.join(ROOT, 'dist');

/* ───────────────────────── 工具 ───────────────────────── */

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/** 抓出一个 JS 文件里所有 import/export 的模块路径 */
function importsOf(src) {
  const out = new Set();
  for (const m of src.matchAll(/(?:^|[\s;{(])(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g)) {
    out.add(m[1]);
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
  return [...out];
}

/**
 * 把「源码位置」映射到「dist 里的位置」。
 * public/x  → dist/x
 * shared/x  → dist/shared/x
 */
function toOutputPath(absPath) {
  if (absPath.startsWith(SRC_SHARED + path.sep)) {
    return path.join(OUT, 'shared', path.relative(SRC_SHARED, absPath));
  }
  if (absPath.startsWith(SRC_PUBLIC + path.sep)) {
    return path.join(OUT, path.relative(SRC_PUBLIC, absPath));
  }
  return null;
}

/* ───────────────────────── 主流程 ───────────────────────── */

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. 先把 public/ 整个拷过去（html/css/js 都在里面）
copyDir(SRC_PUBLIC, OUT);

// 2. 从 dist 里的入口 JS 出发，做 import 闭包。
//
//    队列里存的是 { 源码路径, 产物路径 } 成对的信息。
//    这点很关键：dist/shared/pieces.js 里写的是 `./constants.js`，
//    如果按 dist/ 去解析就会找错人；必须按它**对应的源码位置**解析。
const queue = fs
  .readdirSync(OUT)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ src: path.join(SRC_PUBLIC, f), dst: path.join(OUT, f) }));

const visited = new Set();
const copied = [];

while (queue.length > 0) {
  const { src, dst } = queue.shift();
  if (visited.has(dst)) continue;
  visited.add(dst);

  const text = fs.readFileSync(src, 'utf8');
  for (const spec of importsOf(text)) {
    // 只处理站内路径：'./x'、'../x'、'/x'。裸模块名（第三方包）这里不存在。
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;

    let target;
    if (spec.startsWith('/shared/')) {
      target = path.join(ROOT, spec.slice(1)); // /shared/rules.js
    } else if (spec.startsWith('/')) {
      target = path.join(SRC_PUBLIC, spec.slice(1)); // /board.js
    } else {
      target = path.resolve(path.dirname(src), spec); // ./constants.js
    }

    const outPath = toOutputPath(target);
    if (!outPath) {
      console.warn(`  ! ${path.relative(ROOT, src)} 引用了项目外的路径：${spec}`);
      continue;
    }
    if (!fs.existsSync(target)) {
      console.warn(`  ! ${path.relative(ROOT, src)} 引用了不存在的模块：${spec}`);
      continue;
    }

    if (!fs.existsSync(outPath)) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.copyFileSync(target, outPath);
      copied.push(path.relative(OUT, outPath));
    }
    if (outPath.endsWith('.js')) queue.push({ src: target, dst: outPath });
  }
}

/* ───────────────────────── 报告与校验 ───────────────────────── */

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

const all = listFiles(OUT).sort();
const bytes = all.reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);

console.log(`\n生成 dist/  共 ${all.length} 个文件，${(bytes / 1024).toFixed(1)} KB\n`);
console.log('  静态资源（直接来自 public/）：');
for (const f of all.filter((f) => !f.startsWith('shared' + path.sep))) {
  console.log(`    ${f.padEnd(34)} ${fs.statSync(path.join(OUT, f)).size} 字节`);
}
console.log('\n  按 import 依赖自动带入的 shared 模块：');
for (const f of copied.sort()) {
  console.log(`    ${f.padEnd(34)} ${fs.statSync(path.join(OUT, f)).size} 字节`);
}

// 关键校验：服务端专用模块绝不能出现在 dist 里
const SERVER_ONLY = ['shared/rooms.js'];
let leak = 0;
for (const f of SERVER_ONLY) {
  if (all.includes(f.replace('/', path.sep)) || all.includes(f)) {
    console.error(`\n  ✗ ${f} 被拷进了 dist/ —— 这是服务端代码，不该公开！`);
    leak++;
  }
}

// 浏览器真正需要的模块必须都在
const REQUIRED = ['index.html', 'style.css', 'app.js', 'board.js'];
const missing = REQUIRED.filter((f) => !all.includes(f));
if (missing.length) console.error(`\n  ✗ dist 里缺少：${missing.join(', ')}`);

if (leak || missing.length) {
  console.error('\n构建失败\n');
  process.exit(1);
}
console.log('\n  ✓ 服务端代码没有泄漏，入口文件齐全\n');
