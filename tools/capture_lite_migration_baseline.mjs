// Capture immutable original and isolated old Next before accepting Lite geometry.
// node tools/capture_lite_migration_baseline.mjs 9492 http://127.0.0.1:5179 http://127.0.0.1:5176 OUTPUT_DIR
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { GOLDEN_CLOCK, GOLDEN_CASES, prepareGoldenCase, waitForGoldenReady } from '../web_app/tests/twin-goldens.browser.ts';
const [port, originalBase, nextBase, directory] = process.argv.slice(2);
if (!port || !originalBase || !nextBase || !directory) throw new Error('Expected CDP port, original URL, isolated Next URL, output directory');
fs.mkdirSync(directory, { recursive: true });
const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map();
const errors = [], warnings = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data));
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
    (message.params.type === 'error' ? errors : warnings).push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
  }
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout: ' + method)); }, 30000);
  pending.set(id, {
    resolve: result => { clearTimeout(timer); resolve(result); },
    reject: error => { clearTimeout(timer); reject(error); },
  });
  socket.send(JSON.stringify({ id, method, params }));
});
try {
  await command('Page.enable'); await command('Runtime.enable');
  // Match the Lite geometry fixture's viewport; this is a baseline capture, not a full Golden pass.
  await command('Emulation.setDeviceMetricsOverride', { width: 1536, height: 735, deviceScaleFactor: 1, mobile: false });
  for (const side of ['original', 'next']) {
    if (side === 'next') await command('Page.addScriptToEvaluateOnNewDocument', { source: GOLDEN_CLOCK });
    const url = side === 'original'
      ? originalBase + '/twin.html?layout=/twin/layout-default.json&mode=engineer&parity=1'
      : nextBase + '/twin?lang=zh-CN&mode=engineer&parity=1';
    for (const entry of GOLDEN_CASES.filter(entry => ['iso', 'top'].includes(entry.id))) {
      await command('Page.navigate', { url });
      const deadline = Date.now() + 30000;
      for (;;) {
        const state = await command('Runtime.evaluate', { expression: `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`, returnByValue: true });
        if (state.result?.value) break;
        if (Date.now() > deadline) throw new Error('Page did not finish loading: ' + url);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await waitForGoldenReady(command, side);
      const record = await prepareGoldenCase(command, side, entry);
      const screenshot = await command('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${directory}/${side}-${entry.id}.png`, Buffer.from(screenshot.data, 'base64'));
      fs.writeFileSync(`${directory}/${side}-${entry.id}.json`, JSON.stringify(record, null, 2) + '\n');
      console.log(`${side} ${entry.id}: ${record.viewport.width}x${record.viewport.height} DPR ${record.viewport.devicePixelRatio}`);
    }
  }
  const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  fs.writeFileSync(`${directory}/capture.json`, JSON.stringify({ browser, errors, warnings,
    scope: 'ISO/Top source baseline only; Lite full-FAB pixel comparison NOT_RUN' }, null, 2) + '\n');
  assert.deepEqual(errors, []);
} finally {
  socket.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`);
}
