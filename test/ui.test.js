/**
 * 界面静态一致性测试。
 *
 * 这些是在真实浏览器里才会暴露、但用静态检查就能提前拦住的坑：
 *   - JS 里 getElementById 的 id 在 HTML 里不存在（或者写错大小写）
 *   - CSS 里给某个类写了 display，把 hidden 属性顶掉，导致元素永远显示
 *   - 事件委托依赖的 data-* 属性没有对应按钮
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 用 fileURLToPath 而不是 import.meta.dirname（后者要 Node 20.11+）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const boardJs = fs.readFileSync(path.join(ROOT, 'public/board.js'), 'utf8');

/** 取 HTML 里所有 id="..." */
function htmlIds() {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

/** 取 JS 里 $('...') 与 getElementById('...') 用到的 id */
function jsIds(src) {
  const out = new Set();
  for (const m of src.matchAll(/\$\('([^']+)'\)/g)) out.add(m[1]);
  for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
  return out;
}

test('app.js 里引用的每个元素 id 都存在于 index.html', () => {
  const ids = htmlIds();
  const missing = [...jsIds(appJs)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `这些 id 在 HTML 里找不到：${missing.join(', ')}`);
});

test('index.html 里的 id 没有重复', () => {
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = all.filter((id, i) => all.indexOf(id) !== i);
  assert.deepEqual([...new Set(dup)], [], `重复的 id：${dup.join(', ')}`);
});

test('CSS 必须用 !important 兜住 hidden，否则 display:flex/grid 会把它顶掉', () => {
  // 这是真实踩过的坑：.conn-bar 和 .modal 都设了 display，
  // 结果 hidden 属性失效，连接条和结算浮层会一直显示在屏幕上。
  const rule = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/i;
  assert.match(css, rule, 'style.css 里必须有 [hidden] { display: none !important; }');
});

test('HTML 里带 hidden 属性的元素，其类名在 CSS 里设置了 display 的话必须被上面的规则覆盖', () => {
  // 找出所有 <tag ... hidden ...> 上的 class
  const hiddenClasses = new Set();
  for (const m of html.matchAll(/<[^>]*\shidden[^>]*>/g)) {
    const tag = m[0];
    const cm = /\sclass="([^"]*)"/.exec(tag);
    if (cm) for (const c of cm[1].split(/\s+/).filter(Boolean)) hiddenClasses.add(c);
  }
  // 这些类里凡是在 CSS 中设置了 display 的，都是「必须依赖兜底规则」的情况
  const risky = [];
  for (const cls of hiddenClasses) {
    const re = new RegExp(`\\.${cls}\\s*\\{[^}]*display\\s*:`, 'i');
    if (re.test(css)) risky.push(cls);
  }
  const guard = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/i.test(css);
  assert.ok(
    risky.length === 0 || guard,
    `这些类设置了 display 且用在带 hidden 的元素上，必须靠兜底规则才能隐藏：${risky.join(', ')}`,
  );
});

test('事件委托依赖的 data-* 按钮在 HTML 里存在', () => {
  for (const attr of ['data-mode', 'data-difficulty']) {
    assert.ok(
      html.includes(`${attr}=`),
      `HTML 里应当有带 ${attr} 的按钮（app.js 用事件委托读它）`,
    );
  }
  // app.js 里用到的取值必须都有对应按钮
  assert.match(html, /data-mode="ffa"/);
  assert.match(html, /data-mode="team"/);
  for (const d of ['easy', 'normal', 'hard']) {
    assert.ok(html.includes(`data-difficulty="${d}"`), `缺少 data-difficulty="${d}" 的按钮`);
  }
});

test('前端源码不引用 Node 专有 API（同一份代码要在浏览器里跑）', () => {
  for (const [name, src] of [
    ['app.js', appJs],
    ['board.js', boardJs],
  ]) {
    for (const bad of ["from 'node:", 'from "node:', 'require(', 'process.env', '__dirname']) {
      assert.equal(src.includes(bad), false, `${name} 不应出现 ${bad}`);
    }
  }
});

test('HTML 的 viewport 配置适合手机（禁止用户缩放，避免和棋盘手势打架）', () => {
  assert.match(html, /name="viewport"/);
  assert.match(html, /user-scalable=no/);
  assert.match(html, /viewport-fit=cover/, '要适配刘海屏');
});

test('静态资源都通过相对/绝对路径引用，没有外链 CDN', () => {
  // 外网不通也要能用：任何 http(s):// 的外链都是隐患
  const external = [
    ...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(external, [], `不应依赖外部资源：${external.join(', ')}`);
});

test('棋盘渲染用到的 Canvas API 都在已声明的集合里（防止 typo 成不存在的接口）', () => {
  // 把 board.js 里 ctx.xxx 的调用抓出来，跟 domstub 里声明支持的集合比对
  const declared = new Set(
    /const CTX_METHODS = \[([\s\S]*?)\];/
      .exec(fs.readFileSync(path.join(ROOT, 'test/domstub.js'), 'utf8'))[1]
      .match(/'([^']+)'/g)
      .map((s) => s.slice(1, -1)),
  );
  const used = new Set([...boardJs.matchAll(/\bctx\.([a-zA-Z]+)\s*\(/g)].map((m) => m[1]));
  const unknown = [...used].filter((m) => !declared.has(m));
  assert.deepEqual(unknown, [], `board.js 用了未声明的 Canvas 方法：${unknown.join(', ')}`);
});

test('运行时（server/ 与 shared/）不使用 Node 20+ 才有的 API，保证 Node 18 能跑', () => {
  // package.json 声明了 engines >= 18，所以运行时不能依赖更新的 API。
  // 注意：只检查运行时；测试与 tools/ 不受这个约束。
  const banned = [
    ['import.meta.dirname', 'Node 20.11+'],
    ['import.meta.filename', 'Node 20.11+'],
    ['Object.groupBy', 'Node 21+'],
    ['Map.groupBy', 'Node 21+'],
    ['Array.fromAsync', 'Node 22+'],
    ['.toSorted(', 'Node 20+'],
    ['.toReversed(', 'Node 20+'],
    ['.toSpliced(', 'Node 20+'],
    ['.with(', 'Node 20+'],
  ];

  const files = [];
  for (const dir of ['server', 'shared']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js')) files.push(path.join(dir, name));
    }
  }
  assert.ok(files.length >= 8, `应当扫描到 server/ 与 shared/ 下的源码，实际 ${files.length} 个`);

  const problems = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const [needle, since] of banned) {
      if (src.includes(needle)) problems.push(`${rel} 用了 ${needle}（${since}）`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('站内路径的大小写与磁盘完全一致（Windows 不区分大小写、Linux 区分）', async () => {
  // 这是很隐蔽的一类部署事故：本机跑得好好的，一进 Docker 就 404 / MODULE_NOT_FOUND。
  // 实现在 tools/check-case.js 里，这里直接复用，避免两套逻辑走偏。
  const { findCaseProblems } = await import('../tools/check-case.js');
  const problems = findCaseProblems();
  assert.deepEqual(
    problems.map((p) => `${p.file}: ${p.spec} → 磁盘上是 ${p.actual}`),
    [],
  );
});
