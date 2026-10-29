#!/usr/bin/env node
/** Reproducible bundle metrics: raw and gzip size per emitted asset (A4). */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const arg = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const dir = path.resolve(arg('dir', path.join(root, 'web_app/dist/assets')));
const out = arg('out', '');
if (!fs.existsSync(dir)) throw new Error('assets directory not found: ' + dir);
const files = fs.readdirSync(dir).filter((name) => /[.](?:js|css|html|txt)$/.test(name)).map((name) => {
  const buffer = fs.readFileSync(path.join(dir, name));
  return { name, rawBytes: buffer.length, gzipBytes: zlib.gzipSync(buffer).length };
}).sort((a, b) => a.name.localeCompare(b.name));
const js = files.filter((file) => file.name.endsWith('.js'));
const css = files.filter((file) => file.name.endsWith('.css'));
const sum = (list, key) => list.reduce((total, file) => total + file[key], 0);
const report = {
  generatedAt: new Date().toISOString(),
  assetsDir: dir,
  files,
  totals: {
    jsRawBytes: sum(js, 'rawBytes'), jsGzipBytes: sum(js, 'gzipBytes'),
    cssRawBytes: sum(css, 'rawBytes'), cssGzipBytes: sum(css, 'gzipBytes'),
    allRawBytes: sum(files, 'rawBytes'), allGzipBytes: sum(files, 'gzipBytes'),
  },
};
if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
