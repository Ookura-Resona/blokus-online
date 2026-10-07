/**
 * 大小写敏感检查。
 *
 * Windows / macOS 的文件系统默认不区分大小写，Linux（也就是 Docker 容器和
 * 绝大多数云主机）区分。所以把 shared 写成 Shared 这类笔误，在本机跑得好好的，
 * 一部署就 404 / MODULE_NOT_FOUND —— 而且报错信息通常很绕。
 *
 * 这个脚本把所有 import / href / src 的站内路径按「逐段大小写精确比对」解析一遍。
 *
 *   node tools/check-case.js
 *
 * 也可以 import 进来当测试用（见 test/ui.test.js）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'art']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (/\.(js|mjs|html|css)$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** 逐段检查路径大小写是否与磁盘完全一致；不一致返回磁盘上的真实写法 */
function caseMismatch(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (rel.startsWith('..')) return null;
  let cur = ROOT;
  for (const seg of rel.split(path.sep)) {
    let entries;
    try {
      entries = fs.readdirSync(cur);
    } catch {
      return null;
    }
    if (entries.includes(seg)) {
      cur = path.join(cur, seg);
      continue;
    }
    const ci = entries.find((e) => e.toLowerCase() === seg.toLowerCase());
    return ci || null;
  }
  return null;
}

/**
 * 扫描整个项目，返回所有站内路径问题。
 * @returns {{file:string, spec:string, kind:'missing'|'case', actual?:string}[]}
 */
export function findCaseProblems() {
  const problems = [];
  const seen = new Set();

  for (const file of walk(ROOT).sort()) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    const specs = [];

    if (file.endsWith('.js') || file.endsWith('.mjs')) {
      // 注意：注释里也可能出现 import '...' 的字样，所以匹配到的路径必须真实存在，
      // 否则当成「文档里的举例」忽略（见下面的 missing 分支）。
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
    } else if (file.endsWith('.html')) {
      for (const m of src.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/g)) specs.push(m[1]);
    } else if (file.endsWith('.css')) {
      for (const m of src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) specs.push(m[1]);
    }

    for (const spec of specs) {
      if (!spec.startsWith('/') || spec.startsWith('//')) continue;
      const clean = spec.split('?')[0].split('#')[0];
      const key = `${rel} -> ${clean}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const target = clean.startsWith('/shared/')
        ? path.join(ROOT, clean.slice(1))
        : path.join(ROOT, 'public', clean.slice(1));

      if (!fs.existsSync(target)) {
        // 只有「大小写不同但确实存在同名文件」才算问题；
        // 完全不存在就当它是注释里的举例，跳过（本文件顶部就有一个）。
        const ci = caseMismatch(target);
        if (ci) problems.push({ file: rel, spec: clean, kind: 'case', actual: ci });
        continue;
      }
      const actual = caseMismatch(target);
      if (actual) problems.push({ file: rel, spec: clean, kind: 'case', actual });
    }
  }
  return problems;
}

/* ───────────────────────── CLI ───────────────────────── */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  console.log('');
  const problems = findCaseProblems();
  for (const p of problems) {
    const dir = path.posix.dirname(p.spec);
    console.log(
      `  \u2717 ${p.file} 里写的是 ${p.spec}，但磁盘上是 ` +
        `${path.posix.join(dir, p.actual)} —— Linux 上会 404 / MODULE_NOT_FOUND`,
    );
  }
  console.log(`  检查完成，发现 ${problems.length} 处问题`);
  console.log(problems.length === 0 ? '\n大小写全部正确 \u2713\n' : '\n有大小写问题 \u2717\n');
  process.exit(problems.length === 0 ? 0 : 1);
}

