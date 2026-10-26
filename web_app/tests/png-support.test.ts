import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng } from './support/png.ts';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();
function crc32(buffer: Buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}
/** Encode an 8-bit truecolour PNG with filter 0 rows; enough to exercise the acceptance decoder. */
function encodePng(width: number, height: number, channels: 3 | 4, pixels: number[][][]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = pixels.map(row => Buffer.from([0, ...row.flat()]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('browser acceptance PNG decoder', () => {
  it('decodes 8-bit RGB pixels exactly', () => {
    const png = encodePng(2, 2, 3, [
      [[255, 0, 0], [0, 255, 0]],
      [[0, 0, 255], [12, 34, 56]],
    ]);
    const decoded = decodePng(png);
    expect({ width: decoded.width, height: decoded.height, channels: decoded.channels }).toEqual({ width: 2, height: 2, channels: 3 });
    expect([...decoded.data]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 12, 34, 56]);
  });

  it('decodes 8-bit RGBA pixels exactly', () => {
    const png = encodePng(1, 2, 4, [
      [[1, 2, 3, 4]],
      [[250, 251, 252, 253]],
    ]);
    const decoded = decodePng(png);
    expect(decoded.channels).toBe(4);
    expect([...decoded.data]).toEqual([1, 2, 3, 4, 250, 251, 252, 253]);
  });

  it('rejects a non-PNG buffer', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow('PNG signature mismatch');
  });
});
