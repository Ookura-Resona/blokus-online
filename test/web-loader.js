/**
 * 模块解析钩子：把前端源码里的绝对路径 import 映射到本地文件。
 *
 * public/app.js 里写的是浏览器用的 '/shared/constants.js'、'/board.js'，
 * Node 默认会当成裸模块名而报错。这里把它们改写到磁盘上的真实位置，
 * 于是同一份源码既能在浏览器里跑，也能在测试里跑。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/shared/')) {
    return nextResolve(pathToFileURL(path.join(ROOT, specifier.slice(1))).href, context);
  }
  if (specifier.startsWith('/')) {
    return nextResolve(pathToFileURL(path.join(ROOT, 'public', specifier.slice(1))).href, context);
  }
  return nextResolve(specifier, context);
}
