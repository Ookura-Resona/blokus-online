/**
 * 编码自检：确认所有源码都是**无 BOM 的合法 UTF-8**，
 * 且服务端给 .html/.js/.css 都带上了 charset=utf-8。
 *
 * 中文项目最容易踩的坑就是某个文件被存成 GBK，浏览器里全变乱码。
 *   node tools/check-encoding.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 用 fileURLToPath 而不是 import.meta.dirname：后者要 Node 20.11+，
// 而这个项目声明支持 Node 18。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.edge-profile', 'art']);
const EXTS = new Set(['.js', '.mjs', '.json', '.md', '.html', '.css', '.ps1']);

let failures = 0;
const bad = (m) => {
  failures++;
  console.log(`  ✗ ${m}`);
};

/** UTF-8 严格解码：非法字节序列会抛错 */
const decoder = new TextDecoder('utf-8', { fatal: true });

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT).sort();
console.log(`\n检查 ${files.length} 个文本文件的编码\n`);

let chinese = 0;
let bommed = 0;
for (const file of files) {
  const buf = fs.readFileSync(file);
  const rel = path.relative(ROOT, file);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

  // Windows PowerShell 5.1 读 .ps1 时默认按系统 ANSI 编码解码，
  // 没有 BOM 的中文会变成乱码，甚至把引号弄坏导致语法错误 —— 所以
  // .ps1 **必须**带 BOM；其他文件带 BOM 反而会在浏览器里多出不可见字符。
  if (path.extname(file) === '.ps1') {
    if (!hasBom) {
      bad(`${rel} 缺少 UTF-8 BOM（PowerShell 5.1 会把中文读成乱码）`);
      continue;
    }
    bommed++;
  } else if (hasBom) {
    bad(`${rel} 带了 UTF-8 BOM（浏览器里可能多出一个不可见字符）`);
    continue;
  }

  try {
    const text = decoder.decode(buf);
    if (/[\u4e00-\u9fff]/.test(text)) chinese++;
  } catch (err) {
    bad(`${rel} 不是合法的 UTF-8：${err.message}`);
  }
}

console.log(`  含中文的文件：${chinese} 个，全部为合法 UTF-8`);
if (bommed) console.log(`  带 BOM 的 PowerShell 脚本：${bommed} 个（PS 5.1 需要）`);

// 服务端必须声明 charset，否则浏览器可能按本地编码猜
const appJs = fs.readFileSync(path.join(ROOT, 'server/app.js'), 'utf8');
for (const ext of ['.html', '.js', '.css']) {
  const re = new RegExp(`'\\${ext}':\\s*'[^']*charset=utf-8'`, 'i');
  if (!re.test(appJs)) bad(`server/app.js 的 MIME 表里 ${ext} 没有声明 charset=utf-8`);
  else console.log(`  ✓ ${ext} 声明了 charset=utf-8`);
}

// 抽查几个关键中文字符串，确认没有变成乱码
const checks = [
  ['public/index.html', '角斗士棋'],
  ['public/app.js', '还没轮到你'],
  ['shared/constants.js', '蓝方'],
  ['shared/rules.js', '第一枚棋子必须盖住你的起始角'],
  ['shared/scoring.js', '统治力奖励'],
  ['server/rooms.js', '只有房主能开始游戏'],
];
console.log('');
for (const [file, needle] of checks) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (text.includes(needle)) console.log(`  ✓ ${file} 包含「${needle}」`);
  else bad(`${file} 里找不到「${needle}」（可能编码坏了）`);
}

console.log(failures === 0 ? '\n编码全部正常 ✓\n' : `\n有 ${failures} 项编码问题 ✗\n`);
process.exit(failures === 0 ? 0 : 1);
