/**
 * 全项目 JS 语法检查。
 *
 *   node tools/check-syntax.js
 *
 * 为什么单独做这个：语法错误未必会被测试覆盖到（比如某个只在手动流程里用的
 * 工具脚本），而一旦提交上去，别人拿到就是坏的。
 * 这个项目就真的踩过一次：用文本替换工具改文件时丢了一个模板字符串的反引号，
 * 导致 tools/check-persistence.js 整体解析失败，而且一路提交了上去。
 *
 * 实现细节：用 `node --check` 逐个文件检查，spawn 时 stdio 设成 'ignore' ——
 * 受限环境（沙箱/CI）不允许管道式 spawn（会 EPERM），但我们只需要退出码，
 * 不需要捕获子进程输出，所以 'ignore' 既能工作又快。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 这些目录不是源码，检查它们没意义还拖慢速度 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', 'art', '.edge-profile']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (/\.(js|mjs)$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/**
 * 扫描全项目，返回语法有问题的文件列表（相对路径）。
 * @returns {string[]}
 */
export function findSyntaxErrors() {
  const bad = [];
  for (const file of walk(ROOT).sort()) {
    const res = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' });
    if (res.status !== 0) bad.push(path.relative(ROOT, file));
  }
  return bad;
}

/* ───────────────────────── CLI ───────────────────────── */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const files = walk(ROOT);
  console.log(`\n检查 ${files.length} 个 JS 文件的语法\n`);

  const bad = findSyntaxErrors();
  if (bad.length === 0) {
    console.log('  ✓ 全部通过\n');
    process.exit(0);
  }

  console.log(`  发现 ${bad.length} 个文件语法有问题：\n`);
  for (const rel of bad) {
    console.log(`  ✗ ${rel}`);
    // 单独再跑一次把错误信息拿出来（只在出错时才需要捕获输出）
    const res = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], {
      encoding: 'utf8',
    });
    const msg = (res.stderr || '').split('\n').slice(0, 4).join('\n');
    if (msg.trim()) console.log(msg.replace(/^/gm, '      '));
  }
  console.log('');
  process.exit(1);
}
