/** Hardware regression: node --test tools/test_render_perf.browser.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

test('rejects an initialized browser with an empty canvas and no renderer', { timeout: 20000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = path.join(root, '.local');
  fs.mkdirSync(directory, { recursive: true });
  const reportPath = path.join(directory, 'render-perf-negative.json');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><canvas width="1280" height="720"></canvas><p>FAB 场景初始化失败</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, [path.join(root, 'tools/render_perf.mjs'), '--url', `http://127.0.0.1:${server.address().port}`, '--frames', '24', '--warmup', '5', '--timeout', '1500', '--out', reportPath], { cwd: root, windowsHide: true, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 1, output);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.error, 'Renderer did not become ready before timeout');
    assert.equal(report.readiness.ready, 'complete');
    assert.equal(report.readiness.canvas, true);
    assert.equal(report.readiness.renderer, null);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
