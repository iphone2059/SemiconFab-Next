// Run a committed Twin acceptance module against an already running production
// preview and a dedicated Chrome CDP endpoint. Creates and closes its own tab.
// node tools/run_twin_browser.mjs wafer 9487 http://127.0.0.1:4173 .local/wafer.json
import assert from 'node:assert/strict';
import fs from 'node:fs';
const [suite = 'wafer', port = '9487', baseUrl = 'http://127.0.0.1:4173', output, screenshotOutput] = process.argv.slice(2);
const suites = {
  lite: ['lite-runtime.browser.ts', 'runLiteRuntimeAcceptance'],
  wafer: ['twin-wafer.browser.ts', 'runWaferAcceptance'],
  level: ['twin-level.browser.ts', 'runLevelAcceptance'],
  tour: ['twin-tour.browser.ts', 'runTourAcceptance'],
  'tour-stop': ['twin-tour.browser.ts', 'runTourInterruptionAcceptance'],
  ui: ['twin.browser.ts', 'runTwinUiAcceptance'],
  exploded: ['twin-exploded.browser.ts', 'runTwinExplodedAcceptance'],
  xray: ['xray-acceptance.browser.ts', 'runXrayAcceptance'],
  lighting: ['original-lighting.browser.ts', 'runLightingAcceptance'],
  shadow: ['native-static-shadows.browser.ts', 'runNativeShadowAcceptance'],
};
if (!suites[suite]) throw new Error('Unknown suite: ' + suite);
const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let sequence = 0;
const pending = new Map();
const errors = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data));
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) errors.push(message.params.args.map(value => value.value ?? value.description).join(' '));
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text + (message.params.entry.url ? ' (' + message.params.entry.url + ')' : ''));
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Timeout: ' + method)); }, 180000);
  pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
  socket.send(JSON.stringify({ id, method, params }));
});
try {
  await command('Page.enable'); await command('Runtime.enable'); await command('Log.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1536, height: 735, deviceScaleFactor: 1, mobile: false });
  const [file, exported] = suites[suite];
  const module = await import(new URL('../web_app/tests/' + file, import.meta.url));
  if (suite === 'shadow') {
    await command('Page.navigate', { url: baseUrl + '/twin?lang=zh-CN&mode=engineer&perf=1' });
    for (let attempt = 0; attempt < 300; attempt++) {
      const state = await command('Runtime.evaluate', { expression: "!!window.__SEMICONFAB_PERF__?.getShadow()?.readyForCurrentDevice", returnByValue: true });
      if (state.result?.value) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const result = await module[exported](command, baseUrl);
  const evidence = { suite, result, errors, browser: await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() };
  if (output) fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  assert.deepEqual(errors, [], 'Console/runtime errors');
  if (screenshotOutput) {
    const screenshot = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(screenshotOutput, Buffer.from(screenshot.data, 'base64'));
  }
  console.log(JSON.stringify({ suite, status: 'PASS', errors: errors.length, output }));
} finally {
  socket.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`);
}
