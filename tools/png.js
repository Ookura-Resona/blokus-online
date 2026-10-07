/**
 * 零依赖 PNG 编码器（只用 Node 内置 zlib）。
 *
 * 生成的 PNG 规格：8 位 RGBA、颜色类型 6、无隔行，
 * 每个扫描行前面加一个 filter byte 0（None），IDAT 用 zlib deflate 压缩。
 * 块顺序：IHDR → IDAT → IEND，每块都带 CRC32。
 */

import zlib from 'node:zlib';

/** CRC32 查表（PNG 规范附录里的多项式 0xEDB88320） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * 把 RGBA8 像素编码成 PNG 文件内容。
 * @param {{width:number, height:number, data:Uint8ClampedArray|Uint8Array}} img
 * @returns {Buffer}
 */
export function encodePNG(img) {
  const { width, height, data } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`PNG 尺寸不合法：${width}x${height}`);
  }
  if (data.length !== width * height * 4) {
    throw new Error(`像素数据长度 ${data.length} 与 ${width}x${height} 不匹配`);
  }

  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 = None
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
