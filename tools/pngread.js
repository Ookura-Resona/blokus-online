/**
 * 极简 PNG 读取器（零依赖，只用 Node 内置 zlib）。
 *
 * 只支持本工具生成的 PNG：8 位 RGBA（颜色类型 6）、非隔行。
 * 支持全部 5 种扫描行 filter（我们的编码器只写 0，但读的时候一并实现，
 * 这样用其它工具重新保存过的图也能读）。
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export class PNG {
  constructor(width, height, data) {
    this.width = width;
    this.height = height;
    this.data = data; // Uint8Array，RGBA
  }

  /** 读某个像素，返回 [r,g,b,a] */
  pixel(x, y) {
    const xx = Math.max(0, Math.min(this.width - 1, Math.round(x)));
    const yy = Math.max(0, Math.min(this.height - 1, Math.round(y)));
    const i = (yy * this.width + xx) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  static read(file) {
    return PNG.decode(fs.readFileSync(file));
  }

  static decode(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
    let off = 8;
    let width = 0;
    let height = 0;
    let colorType = 0;
    let bitDepth = 0;
    let interlace = 0;
    const idat = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        interlace = data[12];
      } else if (type === 'IDAT') {
        idat.push(Buffer.from(data));
      } else if (type === 'IEND') {
        break;
      }
      off += 12 + len;
    }
    if (bitDepth !== 8) throw new Error(`只支持 8 位深，实际 ${bitDepth}`);
    if (colorType !== 6) throw new Error(`只支持 RGBA（颜色类型 6），实际 ${colorType}`);
    if (interlace !== 0) throw new Error('不支持隔行 PNG');

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = 4;
    const stride = width * bpp;
    const out = new Uint8Array(width * height * bpp);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
      const cur = new Uint8Array(stride);
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const v = line[i];
        let val;
        switch (filter) {
          case 0: val = v; break;
          case 1: val = v + a; break;
          case 2: val = v + b; break;
          case 3: val = v + ((a + b) >> 1); break;
          case 4: val = v + paeth(a, b, c); break;
          default: throw new Error(`未知 filter ${filter}`);
        }
        cur[i] = val & 0xff;
      }
      out.set(cur, y * stride);
      prev = cur;
    }
    return new PNG(width, height, out);
  }
}
