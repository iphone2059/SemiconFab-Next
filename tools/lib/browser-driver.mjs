/**
 * Shared Chrome DevTools Protocol driver for the Phase E browser gates.
 *
 * No external dependencies: Node's global WebSocket/fetch drive a fixed local
 * Chrome install. Every script that uses it launches an isolated profile, enables
 * the domains it needs, and closes Chrome in a finally block.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const now = () => new Date().toISOString();

export function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export async function waitForHttp(url, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch { /* not ready yet */ }
    await sleep(250);
  }
  return false;
}

export async function waitForAuthorized(url, headers = {}, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return true;
    } catch { /* not ready yet */ }
    await sleep(250);
  }
  return false;
}

export const CHROME_WEBGPU_ARGS = [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu', '--use-angle=d3d11', '--disable-gpu-sandbox',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', '--window-size=1440,1000',
];

export function launchChrome({ chrome, port, userDataDir, extraArgs = [] }) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const child = spawn(chrome, [
    ...CHROME_WEBGPU_ARGS,
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir,
    ...extraArgs,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  return child;
}

export async function connectChrome(port) {
  let version;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (response.ok) { version = await response.json(); break; }
    } catch { /* not ready */ }
    await sleep(250);
  }
  if (!version) throw new Error('Chrome DevTools endpoint did not start on port ' + port);
  let target;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    target = pages.find((entry) => entry.type === 'page');
    if (target) break;
    await sleep(250);
  }
  if (!target) throw new Error('Chrome page target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
    for (const handler of listeners.get(message.method) ?? []) handler(message.params);
  };
  const send = (method, params = {}, timeout = 30000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, timeout);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error('CDP error ' + method + ': ' + message.error.message));
      else resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (method, handler) => {
    const values = listeners.get(method) ?? [];
    values.push(handler);
    listeners.set(method, values);
  };
  return { ws, version, send, on, close: () => { try { if (ws.readyState === 1) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); } catch { /* ignore */ } try { ws.close(); } catch { /* ignore */ } } };
}

export class Browser {
  constructor(session) {
    this.session = session;
    this.consoleErrors = [];
    this.requests = [];
    this.responses = [];
    this.activeEventSources = new Set();
  }

  static async open({ chrome, port, userDataDir, extraArgs = [], instrument }) {
    const child = launchChrome({ chrome, port, userDataDir, extraArgs });
    child.userDataDir = userDataDir;
    let session;
    try {
      session = await connectChrome(port);
    } catch (error) {
      killProcessTree(child);
      throw error;
    }
    const browser = new Browser(session);
    browser.child = child;
    browser.port = port;
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');
    await session.send('Performance.enable');
    await session.send('Log.enable');
    session.on('Runtime.exceptionThrown', (params) => {
      browser.consoleErrors.push('uncaught: ' + (params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || 'exception'));
    });
    session.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error') return;
      const text = params.args.map((value) => value.value ?? value.description ?? '').join(' ');
      if (/Failed to load resource: the server responded with a status of 404/.test(text) && /favicon/.test(text)) return;
      browser.consoleErrors.push('console: ' + text);
    });
    session.on('Log.entryAdded', (params) => { if (params.entry.level === 'error') browser.consoleErrors.push('log: ' + params.entry.text); });
    session.on('Network.requestWillBeSent', (params) => {
      browser.requests.push({ url: params.request.url, method: params.request.method, type: params.type, requestId: params.requestId });
      if (params.type === 'EventSource') browser.activeEventSources.add(params.requestId + ' ' + params.request.url);
    });
    session.on('Network.responseReceived', (params) => {
      const url = params.response?.url ?? '';
      if (url.includes('/api/')) browser.responses.push({ url, status: params.response?.status ?? 0 });
    });
    session.on('Network.loadingFinished', (params) => { for (const key of [...browser.activeEventSources]) if (key.startsWith(params.requestId + ' ')) browser.activeEventSources.delete(key); });
    session.on('Network.loadingFailed', (params) => { for (const key of [...browser.activeEventSources]) if (key.startsWith(params.requestId + ' ')) browser.activeEventSources.delete(key); });
    if (instrument) await session.send('Page.addScriptToEvaluateOnNewDocument', { source: instrument });
    return browser;
  }

  send(method, params = {}) { return this.session.send(method, params); }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
    if (result.result?.exceptionDetails) {
      throw new Error(result.result.exceptionDetails.text || result.result.exceptionDetails.exception?.description || 'page evaluation failed');
    }
    return result.result?.result?.value;
  }

  async waitFor(expression, timeoutMs = 30000, label = expression) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await this.evaluate('Boolean(' + expression + ')').catch(() => undefined);
      if (value) return true;
      await sleep(100);
    }
    throw new Error('timed out waiting for ' + label);
  }

  async waitText(needle, timeoutMs = 30000) {
    return this.waitFor('document.body && document.body.innerText.includes(' + JSON.stringify(needle) + ')', timeoutMs, 'text ' + needle);
  }

  async click(selector) {
    const clicked = await this.evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; el.scrollIntoView({block:"center"}); el.click(); return true; })()');
    if (!clicked) throw new Error('cannot click ' + selector);
  }

  async clickText(selector, text) {
    const clicked = await this.evaluate('(() => { const el = [...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(node => node.textContent.includes(' + JSON.stringify(text) + ')); if (!el) return false; el.scrollIntoView({block:"center"}); el.click(); return true; })()');
    if (!clicked) throw new Error('cannot click ' + selector + ' containing ' + text);
  }

  async setValue(selector, value) {
    const ok = await this.evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; const proto = Object.getPrototypeOf(el); const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set; if (setter) setter.call(el, ' + JSON.stringify(String(value)) + '); else el.value = ' + JSON.stringify(String(value)) + '; el.dispatchEvent(new Event("input", {bubbles:true})); el.dispatchEvent(new Event("change", {bubbles:true})); return true; })()');
    if (!ok) throw new Error('cannot set ' + selector);
  }

  async setSelect(selector, value) {
    const ok = await this.evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; el.value = ' + JSON.stringify(String(value)) + '; el.dispatchEvent(new Event("change", {bubbles:true})); return true; })()');
    if (!ok) throw new Error('cannot set select ' + selector);
  }

  async navigate(url, waitExpression, timeoutMs = 45000) {
    this.consoleErrors = [];
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 30000, 'document ready ' + url);
    if (waitExpression) await this.waitFor(waitExpression, timeoutMs, 'page content ' + url);
  }

  async bodyText() { return this.evaluate('document.body ? document.body.innerText : ""'); }
  async count(selector) { return this.evaluate('document.querySelectorAll(' + JSON.stringify(selector) + ').length'); }
  async textOf(selector) { return this.evaluate('(document.querySelector(' + JSON.stringify(selector) + ')?.innerText ?? "").trim()'); }
  async url() { return this.evaluate('location.href'); }

  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(result.result.data, 'base64'));
    return file;
  }

  async performance() {
    const metrics = Object.fromEntries(((await this.send('Performance.getMetrics')).result?.metrics ?? []).map((entry) => [entry.name, entry.value]));
    let heap = null;
    try { heap = await this.send('Runtime.getHeapUsage'); } catch { /* not available */ }
    return {
      jsHeapUsedMb: Number(((heap?.result?.usedSize ?? metrics.JSHeapUsedSize ?? 0) / 1024 / 1024).toFixed(2)),
      taskDurationMs: Number(((metrics.TaskDuration ?? 0) * 1000).toFixed(1)),
    };
  }

  close() {
    try { this.session.close(); } catch { /* ignore */ }
    killProcessTree(this.child);
    const profile = this.child?.userDataDir;
    if (process.platform === 'win32' && profile) {
      // The initial chrome.exe may be a launcher that already exited; kill the whole
      // tree that owns this isolated profile so no headless Chrome survives a failure.
      try {
        spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | Where-Object { $_.CommandLine -like '*" + profile.replaceAll('\\', '\\\\') + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
      } catch { /* ignore */ }
    }
  }
}

export function killProcessTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* ignore */ }
}

export function readDevKey(root) {
  const fromEnvironment = process.env.FAB_DEVELOPMENT_KEY;
  if (fromEnvironment && fromEnvironment.trim()) return fromEnvironment.trim();
  try { return fs.readFileSync(path.join(root, '.local/development-key'), 'utf8').trim(); } catch { return undefined; }
}

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Remove orphaned harness profiles older than an hour (crashed runs) so tmp does not grow. */
export function cleanupStaleProfiles(prefixPattern = 'fab-') {
  const temp = os.tmpdir();
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const entry of fs.readdirSync(temp)) {
    if (!entry.startsWith(prefixPattern)) continue;
    const absolute = path.join(temp, entry);
    try {
      if (fs.statSync(absolute).mtimeMs < cutoff) fs.rmSync(absolute, { recursive: true, force: true });
    } catch { /* another process may be using it */ }
  }
}

export function uniqueProfile(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

export function removeProfile(directory) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* Chrome may still hold a handle */ }
}
