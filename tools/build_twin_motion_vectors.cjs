// Deterministic extraction of the frozen original Cinematic Tour and Wafer-follow
// fixed-time vectors.
//
// Source: SemiconFab/twin.html @ d76378c (sha256 pinned in
// docs/migration/twin-parity/source-manifest.json). Only character-for-character
// slices of the frozen page are executed inside node:vm. THREE, camera/controls,
// DOM elements, performance.now, requestAnimationFrame and setTimeout/setInterval
// are replaced by recording / virtual-time stubs listed in the fixture stubBoundary;
// the wall clock becomes a declared deterministic clock and the declared LCG seed
// is recorded for completeness (these frozen code paths draw no random numbers).
//
// Usage:
//   node tools/build_twin_motion_vectors.cjs          # (re)write the fixture
//   node tools/build_twin_motion_vectors.cjs --check  # fail on drift
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.resolve(root, '../SemiconFab/twin.html'), 'utf8');
const manifest = require('../docs/migration/twin-parity/source-manifest.json');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const hash = sha256(source);
if (hash !== manifest.source_sha256['twin.html']) throw new Error('Original source drift');

// The frozen page fetches these pinned assets at runtime; the pinned copies are
// what the original actually consumes when served, so the vectors use them.
const routesBytes = fs.readFileSync(path.resolve(root, '../SemiconFab/benchmark/routes.json'));
const layoutBytes = fs.readFileSync(path.resolve(root, '../SemiconFab/twin/layout-default.json'));
const routesSha256 = sha256(routesBytes);
const layoutSha256 = sha256(layoutBytes);
if (routesSha256 !== manifest.source_sha256['benchmark/routes.json']) {
  throw new Error('benchmark/routes.json drift');
}
if (layoutSha256 !== manifest.source_sha256['twin/layout-default.json']) {
  throw new Error('twin/layout-default.json drift');
}
const routesJson = JSON.parse(routesBytes.toString('utf8'));
const layoutJson = JSON.parse(layoutBytes.toString('utf8'));

// ---------------------------------------------------------------------------
// Frozen-source slicing (string/comment/template aware brace matching).
// ---------------------------------------------------------------------------
const lineOf = (index) => source.slice(0, index).split('\n').length;

function findMatching(startIndex, openChar, closeChar) {
  let depth = 0;
  let index = startIndex;
  let inLineComment = false;
  let inBlockComment = false;
  let quote = null;
  let escaped = false;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && source[index + 1] === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') { inLineComment = true; index += 1; continue; }
    if (char === '/' && source[index + 1] === '*') { inBlockComment = true; index += 1; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '\u0060') {
      index += 1;
      let templateEscaped = false;
      for (; index < source.length; index += 1) {
        const inner = source[index];
        if (templateEscaped) { templateEscaped = false; continue; }
        if (inner === '\\') { templateEscaped = true; continue; }
        if (inner === '\u0060') break;
      }
      continue;
    }
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('Unbalanced frozen source slice');
}

function sliceFrom(startIndex, endIndex) {
  return {
    text: source.slice(startIndex, endIndex + 1),
    startLine: lineOf(startIndex),
    endLine: lineOf(endIndex),
  };
}

function extractFunction(name) {
  const start = source.indexOf('      function ' + name + '(');
  if (start < 0) throw new Error('Missing frozen function ' + name);
  const parenStart = source.indexOf('(', start);
  const parenEnd = findMatching(parenStart, '(', ')');
  const braceStart = source.indexOf('{', parenEnd);
  return { name, ...sliceFrom(start, findMatching(braceStart, '{', '}')) };
}

function extractConst(name, openChar) {
  const start = source.indexOf('      const ' + name + ' = ' + openChar);
  if (start < 0) throw new Error('Missing frozen const ' + name);
  const valueStart = start + ('      const ' + name + ' = ').length;
  const closeChar = openChar === '{' ? '}' : ']';
  return { name, ...sliceFrom(start, findMatching(valueStart, openChar, closeChar)) };
}

// Line ranges asserted so source drift cannot silently move the sliced code.
const TOUR_RANGES = {
  CINEMATIC_WAYPOINTS: [19361, 19437],
  cancelActiveCameraAnimation: [19310, 19312],
  tweenCamera: [19314, 19351],
  clearTourTimers: [19439, 19448],
  updateTourTimerUI: [19450, 19456],
  setFabLevelQuiet: [19458, 19503],
  playTourWaypoint: [19505, 19578],
  nextTourWaypoint: [19580, 19588],
  prevTourWaypoint: [19590, 19597],
  startCinematicTour: [19599, 19635],
  stopCinematicTour: [19637, 19655],
};
const WAFER_RANGES = {
  CATEGORY_BAYS: [12692, 12797],
  WAFER_TOOL_GROUP_TO_CATEGORY: [16572, 16591],
  computeWaferWaypoints: [18066, 18116],
  initProductRoute: [18118, 18120],
  getCatmullRomSplinePoint: [18203, 18221],
  recordWaferTrailPoint: [18223, 18233],
  updateWaferTrailMesh: [18235, 18268],
  clearWaferTrail: [18270, 18276],
  updateWaferFollowFrame: [18278, 18350],
  updateWaferFollowHUD: [18352, 18407],
  toggleWaferPlay: [18503, 18521],
  setWaferSpeed: [18523, 18537],
  replayWaferRoute: [18563, 18583],
  onWaferProductChange: [18585, 18604],
  onWaferRouteFinished: [18606, 18616],
};

function extractAll(ranges, constNames) {
  const extracted = {};
  for (const [name, range] of Object.entries(ranges)) {
    let entry;
    if (constNames.includes(name)) {
      entry = extractConst(name, name === 'CINEMATIC_WAYPOINTS' ? '[' : '{');
    } else {
      entry = extractFunction(name);
    }
    if (entry.startLine !== range[0] || entry.endLine !== range[1]) {
      throw new Error('Frozen source line drift for ' + name + ': ' + entry.startLine + '-' + entry.endLine);
    }
    extracted[name] = entry;
  }
  return extracted;
}

const tourSlices = extractAll(TOUR_RANGES, ['CINEMATIC_WAYPOINTS']);
const waferSlices = extractAll(WAFER_RANGES, ['CATEGORY_BAYS', 'WAFER_TOOL_GROUP_TO_CATEGORY']);
const TOUR_DECLARATIONS = Object.values(tourSlices).map((entry) => entry.text).join('\n');
const WAFER_DECLARATIONS = Object.values(waferSlices).map((entry) => entry.text).join('\n');

// ---------------------------------------------------------------------------
// Declared deterministic scenario.
// ---------------------------------------------------------------------------
const TOUR_FRAME_MS = 16;
const WAFER_FRAME_MS = 16;
const WAFER_CLOCK_START_MS = 1000;

const TOUR_INITIAL = {
  camera: { x: 70, y: 50, z: 75 },
  target: { x: 0, y: 0, z: 0 },
  level: 'L1',
};

const TOUR_SCENARIO = {
  clockStartMs: 0,
  frameMs: TOUR_FRAME_MS,
  sampleEveryMs: 64,
  maxMs: 60000,
  // Declared input actions, all frame-grid aligned. next/prev/start/stop are the
  // frozen keyboard/button handlers; the trace also lets waypoint playback run on
  // its own countdown so automatic advancement is covered.
  actions: [
    { atMs: 0, action: 'start' },
    { atMs: 3008, action: 'next' },
    { atMs: 9616, action: 'prev' },
    { atMs: 20000, action: 'stop' },
    { atMs: 21008, action: 'start' },
    { atMs: 21504, action: 'next' },
    { atMs: 25008, action: 'next' },
    { atMs: 26000, action: 'prev' },
  ],
};

const WAFER_INITIAL = {
  camera: { x: 0, y: 8.5, z: -8 },
};

const WAFER_SCENARIO = {
  clockStartMs: WAFER_CLOCK_START_MS,
  frameMs: WAFER_FRAME_MS,
  dtClampSeconds: 0.1,
  routeSliceSteps: 5,
  traceProduct: 'A',
  traces: [
    { name: 'speed1x', speed: 1, sampleEveryFrames: 4 },
    { name: 'speed4x', speed: 4, sampleEveryFrames: 2 },
    { name: 'speed16x', speed: 16, sampleEveryFrames: 1 },
  ],
  controls: {
    speed: 16,
    sampleEveryFrames: 2,
    actions: [
      { frame: 6, action: 'pause' },
      { frame: 12, action: 'resume' },
      { frame: 16, action: 'speed', arg: 1 },
      { frame: 40, action: 'replay' },
      { frame: 46, action: 'product', arg: 'B' },
      { frame: 50, action: 'speed', arg: 16 },
    ],
  },
  stall: {
    speed: 16,
    // One declared 500 ms frame gap exercises the frozen 0.1 s dt clamp.
    frameTimes: [
      1000, 1016, 1032, 1048, 1064, 1080, 1096, 1112, 1128, 1144, 1160, 1176,
      1676, 1692, 1708, 1724, 1740, 1756, 1772, 1788, 1804, 1820, 1836, 1852,
      1868, 1884, 1900, 1916, 1932, 1948, 1964, 1980, 1996, 2012, 2028, 2044, 2060, 2076,
    ],
  },
};

const round = (value, digits = 6) =>
  Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits + 0 : null;

// ---------------------------------------------------------------------------
// Recording / virtual-time stubs.
// ---------------------------------------------------------------------------
function makeVec3(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    set(nextX, nextY, nextZ) { this.x = nextX; this.y = nextY; this.z = nextZ; return this; },
    copy(other) { this.x = other.x; this.y = other.y; this.z = other.z; return this; },
    clone() { return makeVec3(this.x, this.y, this.z); },
    lerpVectors(from, to, alpha) {
      this.x = from.x + (to.x - from.x) * alpha;
      this.y = from.y + (to.y - from.y) * alpha;
      this.z = from.z + (to.z - from.z) * alpha;
      return this;
    },
    distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); },
  };
}

class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
}

class BufferGeometry {
  constructor() { this.attributes = {}; this.drawStart = 0; this.drawCount = 0; }
  setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
  setDrawRange(start, count) { this.drawStart = start; this.drawCount = count; return this; }
}

function createThreeStub() {
  return {
    Vector3: function Vector3(x, y, z) { return makeVec3(x, y, z); },
    BufferAttribute,
    BufferGeometry,
    LineBasicMaterial: function LineBasicMaterial(parameters) { return Object.assign({}, parameters); },
    AdditiveBlending: 2,
  };
}

// Deterministic virtual scheduler: requestAnimationFrame fires on the declared
// frame grid, intervals keep their declared period, ties run in registration order.
class VirtualClock {
  constructor(frameMs) {
    this.frameMs = frameMs;
    this.ms = 0;
    this.queue = [];
    this.sequence = 0;
    this.nextTimerId = 1;
    this.timers = new Map();
  }
  now() { return this.ms; }
  requestAnimationFrame(callback) {
    const due = (Math.floor(this.ms / this.frameMs) + 1) * this.frameMs;
    this.queue.push({ due, sequence: this.sequence++, kind: 'raf', callback });
    return this.sequence;
  }
  setTimeout(callback, delay) {
    const id = this.nextTimerId++;
    this.timers.set(id, { kind: 'timeout', callback });
    this.queue.push({ due: this.ms + delay, sequence: this.sequence++, kind: 'timeout', id, callback });
    return id;
  }
  setInterval(callback, delay) {
    const id = this.nextTimerId++;
    this.timers.set(id, { kind: 'interval', callback, delay });
    this.queue.push({ due: this.ms + delay, sequence: this.sequence++, kind: 'interval', id, delay, callback });
    return id;
  }
  clearTimer(id) {
    this.timers.delete(id);
    for (const entry of this.queue) { if (entry.id === id) entry.cancelled = true; }
  }
  peek() {
    let best = null;
    for (const entry of this.queue) {
      if (entry.cancelled) continue;
      if (best === null || entry.due < best.due || (entry.due === best.due && entry.sequence < best.sequence)) best = entry;
    }
    return best;
  }
  advanceTo(targetMs, onAfterCallback) {
    for (;;) {
      const entry = this.peek();
      if (entry === null || entry.due > targetMs + 1e-9) break;
      this.queue = this.queue.filter((candidate) => candidate !== entry);
      this.ms = Math.max(this.ms, entry.due);
      if (entry.kind === 'interval') entry.due = this.ms + entry.delay;
      entry.callback(this.ms);
      if (onAfterCallback) onAfterCallback(this.ms);
      if (entry.kind === 'interval' && this.timers.has(entry.id) && !entry.cancelled) {
        this.queue.push(entry);
      }
    }
    this.ms = Math.max(this.ms, targetMs);
  }
}

function createElementRegistry() {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: '',
        innerHTML: '',
        className: '',
        style: { width: '' },
        classList: { add() {}, remove() {}, contains() { return false; } },
        setAttribute() {},
        appendChild() {},
      });
    }
    return elements.get(id);
  };
  return { getElement };
}

// ---------------------------------------------------------------------------
// Tour sandbox
// ---------------------------------------------------------------------------
function createTourSandbox() {
  const clock = new VirtualClock(TOUR_FRAME_MS);
  const elements = createElementRegistry();
  const lucide = { createIcons() {} };
  const sandbox = {
    Math,
    console,
    performance: { now: () => clock.ms },
    requestAnimationFrame: (callback) => clock.requestAnimationFrame(callback),
    setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
    setInterval: (callback, delay) => clock.setInterval(callback, delay),
    clearTimeout: (id) => clock.clearTimer(id),
    clearInterval: (id) => clock.clearTimer(id),
    camera: { position: makeVec3(TOUR_INITIAL.camera.x, TOUR_INITIAL.camera.y, TOUR_INITIAL.camera.z), lookAt() {} },
    controls: { target: makeVec3(TOUR_INITIAL.target.x, TOUR_INITIAL.target.y, TOUR_INITIAL.target.z), update() {} },
    document: { getElementById: elements.getElement, querySelectorAll: () => [] },
    window: {},
    lucide,
    THREE: createThreeStub(),
    currentFabLevel: TOUR_INITIAL.level,
    currentLang: 'en',
    isCinematicTourActive: false,
    tourTimeoutId: null,
    tourCountdownInterval: null,
    currentTourWaypointIndex: 0,
    activeCameraAnimId: 0,
    cleanroomFloorMaterial: { transparent: false, depthWrite: true, opacity: 1 },
    cleanroomSlabMesh: { visible: true },
    laminarParticleSystem: { visible: true },
    airflowHeatmapMesh: { visible: false },
    showLaminarFlow: false,
    showAirflowHeatmap: false,
    waferFollowState: {
      isActive: false, isPlaying: false, product: 'A', speed: 1,
      currentStepIndex: 0, stepTimer: 0, isFollowingCam: false, waypoints: [],
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const helpers = [
    'function __tourStart() { startCinematicTour(); }',
    'function __tourStop() { stopCinematicTour(); }',
    'function __tourNext() { nextTourWaypoint(); }',
    'function __tourPrev() { prevTourWaypoint(); }',
    'function __tourWaypoints() { return CINEMATIC_WAYPOINTS; }',
    'function __tourPhase() {',
    '  if (!isCinematicTourActive) return "IDLE";',
    '  return tourCountdownInterval ? "HOLD" : "TWEEN";',
    '}',
    'function __tourSnapshot() {',
    '  var get = document.getElementById;',
    '  var activeDot = -1;',
    '  for (var d = 0; d < CINEMATIC_WAYPOINTS.length; d++) {',
    '    if (get("tour-dot-" + d).className.indexOf("bg-emerald-400") >= 0) { activeDot = d; break; }',
    '  }',
    '  return {',
    '    active: isCinematicTourActive,',
    '    index: currentTourWaypointIndex,',
    '    phase: __tourPhase(),',
    '    level: currentFabLevel,',
    '    timerText: get("tour-timer-text").textContent,',
    '    progressWidth: get("tour-progress-bar").style.width,',
    '    hudTag: get("tour-hud-tag").textContent,',
    '    hudTitle: get("tour-hud-title").textContent,',
    '    activeDot: activeDot,',
    '    camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },',
    '    target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },',
    '  };',
    '}',
  ].join('\n');
  vm.runInContext(TOUR_DECLARATIONS + '\n' + helpers, sandbox, { filename: 'frozen-twin-tour.vm.js' });
  return { sandbox, clock, elements };
}

// ---------------------------------------------------------------------------
// Wafer sandbox
// ---------------------------------------------------------------------------
function createWaferSandbox() {
  const clock = new VirtualClock(WAFER_FRAME_MS);
  const elements = createElementRegistry();
  const lucide = { createIcons() {} };
  const sandbox = {
    Math,
    console,
    performance: { now: () => clock.ms },
    THREE: createThreeStub(),
    camera: { position: makeVec3(WAFER_INITIAL.camera.x, WAFER_INITIAL.camera.y, WAFER_INITIAL.camera.z), lookAt() {} },
    controls: { target: makeVec3(0, 2.5, 0), update() {} },
    document: { getElementById: elements.getElement },
    window: {},
    lucide,
    currentLang: 'en',
    waferRoutesData: null,
    waferLayoutTools: null,
    waferFollowState: null,
    foupGroup: null,
    waferTrailLine: null,
    waferTrailHistory: [],
    waferLastFrameTime: 0,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const helpers = [
    'function __waferTrailObject() {',
    '  var geometry = new THREE.BufferGeometry();',
    '  var maxTrailPoints = 32;',
    '  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(maxTrailPoints * 3), 3));',
    '  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(maxTrailPoints * 3), 3));',
    '  geometry.setDrawRange(0, 0);',
    '  return { visible: false, geometry: geometry };',
    '}',
    'function __waferSetup(routes, tools) {',
    '  waferRoutesData = { A: routes.A, B: routes.B, C: routes.C };',
    '  waferLayoutTools = tools;',
    '  waferFollowState = {',
    '    isActive: true, isPlaying: true, product: "A", speed: 1,',
    '    currentStepIndex: 0, stepTimer: 0, isFollowingCam: true, waypoints: [],',
    '  };',
    '  waferTrailHistory = [];',
    '  waferLastFrameTime = 0;',
    '  foupGroup = { position: new THREE.Vector3(0, 2.5, 0), rotation: { y: 0 }, visible: true };',
    '  waferTrailLine = __waferTrailObject();',
    '  initProductRoute(waferFollowState.product);',
    '  return waferFollowState.waypoints;',
    '}',
    'function __waferStart(product, speed) {',
    '  waferFollowState.product = product;',
    '  waferFollowState.speed = speed;',
    '  waferFollowState.currentStepIndex = 0;',
    '  waferFollowState.stepTimer = 0;',
    '  waferFollowState.isPlaying = true;',
    '  waferFollowState.isActive = true;',
    '  initProductRoute(product);',
    '  clearWaferTrail();',
    '  var p0 = waferFollowState.waypoints[0];',
    '  foupGroup.position.set(p0.x, 2.5, p0.z);',
    '  waferLastFrameTime = performance.now();',
    '  updateWaferFollowHUD();',
    '  return waferFollowState.waypoints;',
    '}',
    'function __waferFrame() { updateWaferFollowFrame(); }',
    'function __waferAction(action, arg) {',
    '  if (action === "pause" || action === "resume") { toggleWaferPlay(); return; }',
    '  if (action === "speed") { setWaferSpeed(arg); return; }',
    '  if (action === "replay") { replayWaferRoute(); return; }',
    '  if (action === "product") { onWaferProductChange(arg); return; }',
    '  throw new Error("Unknown wafer action " + action);',
    '}',
    'function __waferTrailPoints() {',
    '  var geometry = waferTrailLine.geometry;',
    '  var count = geometry.drawCount || 0;',
    '  var attribute = geometry.attributes.position;',
    '  var points = [];',
    '  for (var i = 0; i < count; i++) {',
    '    points.push([attribute.array[i * 3], attribute.array[i * 3 + 1], attribute.array[i * 3 + 2]]);',
    '  }',
    '  return points;',
    '}',
    'function __waferSnapshot() {',
    '  var get = document.getElementById;',
    '  return {',
    '    playing: waferFollowState.isPlaying,',
    '    product: waferFollowState.product,',
    '    speed: waferFollowState.speed,',
    '    index: waferFollowState.currentStepIndex,',
    '    stepTimer: waferFollowState.stepTimer,',
    '    waypointCount: waferFollowState.waypoints.length,',
    '    position: { x: foupGroup.position.x, y: foupGroup.position.y, z: foupGroup.position.z },',
    '    rotationY: foupGroup.rotation.y,',
    '    trailVisible: waferTrailLine.visible,',
    '    trailCount: waferTrailHistory.length,',
    '    drawRange: waferTrailLine.geometry.drawCount || 0,',
    '    hud: {',
    '      step: get("wafer-step-readout").textContent,',
    '      width: get("wafer-progress-bar").style.width,',
    '      toolGroup: get("wafer-tg-val").textContent,',
    '      recipe: get("wafer-recipe-val").textContent,',
    '      bay: get("wafer-bay-val").textContent,',
    '      status: get("wafer-status-readout").textContent,',
    '      badge: get("wafer-route-badge").textContent,',
    '    },',
    '    camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },',
    '  };',
    '}',
  ].join('\n');
  vm.runInContext(WAFER_DECLARATIONS + '\n' + helpers, sandbox, { filename: 'frozen-twin-wafer.vm.js' });
  return { sandbox, clock, elements };
}

// ---------------------------------------------------------------------------
// Tour trace
// ---------------------------------------------------------------------------
function roundVec(vec) { return { x: round(vec.x), y: round(vec.y), z: round(vec.z) }; }

function tourFrame(tick, timeMs, snapshot) {
  return {
    tick, timeMs,
    active: snapshot.active,
    index: snapshot.index,
    phase: snapshot.phase,
    level: snapshot.level,
    timerText: snapshot.timerText,
    progressWidth: snapshot.progressWidth,
    hudTag: snapshot.hudTag,
    hudTitle: snapshot.hudTitle,
    activeDot: snapshot.activeDot,
    camera: roundVec(snapshot.camera),
    target: roundVec(snapshot.target),
  };
}

function runTourTrace() {
  const { sandbox, clock } = createTourSandbox();
  const waypoints = sandbox.__tourWaypoints().map((waypoint) => ({
    index: waypoint.index,
    level: waypoint.level,
    cameraPos: { x: waypoint.cameraPos.x, y: waypoint.cameraPos.y, z: waypoint.cameraPos.z },
    lookAt: { x: waypoint.lookAt.x, y: waypoint.lookAt.y, z: waypoint.lookAt.z },
    durationMs: waypoint.duration,
    holdDurationMs: waypoint.holdDuration,
    tag: waypoint.tag,
    titleZh: waypoint.titleZh,
    titleEn: waypoint.titleEn,
    descZh: waypoint.descZh,
    descEn: waypoint.descEn,
  }));
  const actions = TOUR_SCENARIO.actions.map((action) => Object.assign({}, action));
  const events = [];
  const frames = [];
  let previous = sandbox.__tourSnapshot();
  let lastDeactivatedAtMs = null;
  const emitDiff = (timeMs) => {
    const current = sandbox.__tourSnapshot();
    if (current.active !== previous.active) {
      events.push({ timeMs, type: 'active', active: current.active });
      if (!current.active) lastDeactivatedAtMs = timeMs;
    }
    if (current.index !== previous.index) {
      const waypoint = waypoints[current.index];
      events.push({
        timeMs, type: 'waypoint', index: current.index,
        tag: waypoint ? waypoint.tag : null,
        titleEn: waypoint ? waypoint.titleEn : null,
        level: current.level,
        durationMs: waypoint ? waypoint.durationMs : null,
        holdDurationMs: waypoint ? waypoint.holdDurationMs : null,
      });
    }
    if (current.phase !== previous.phase) {
      events.push({ timeMs, type: 'phase', phase: current.phase });
    }
    if (current.level !== previous.level) {
      events.push({ timeMs, type: 'level', level: current.level });
    }
    if (current.timerText !== previous.timerText || current.progressWidth !== previous.progressWidth) {
      events.push({ timeMs, type: 'timer', text: current.timerText, width: current.progressWidth });
    }
    previous = current;
  };
  const applyAction = (action) => {
    if (action.action === 'start') sandbox.__tourStart();
    else if (action.action === 'stop') sandbox.__tourStop();
    else if (action.action === 'next') sandbox.__tourNext();
    else if (action.action === 'prev') sandbox.__tourPrev();
    else throw new Error('Unknown tour action ' + action.action);
    events.push({ timeMs: clock.now(), type: 'action', action: action.action });
    emitDiff(clock.now());
  };

  clock.ms = TOUR_SCENARIO.clockStartMs;
  const initial = tourFrame(0, clock.ms, previous);
  frames.push(initial);
  let actionIndex = 0;
  while (actionIndex < actions.length && actions[actionIndex].atMs === clock.ms) {
    applyAction(actions[actionIndex]);
    actionIndex += 1;
    previous = sandbox.__tourSnapshot();
  }
  let tick = 0;
  let stoppedAtMs = null;
  for (;;) {
    tick += 1;
    const frameTime = TOUR_SCENARIO.clockStartMs + tick * TOUR_SCENARIO.frameMs;
    if (frameTime > TOUR_SCENARIO.maxMs) throw new Error('Tour trace did not settle');
    clock.advanceTo(frameTime, (callbackTime) => emitDiff(callbackTime));
    while (actionIndex < actions.length && actions[actionIndex].atMs === frameTime) {
      applyAction(actions[actionIndex]);
      actionIndex += 1;
    }
    emitDiff(frameTime);
    const snapshot = sandbox.__tourSnapshot();
    if (frameTime % TOUR_SCENARIO.sampleEveryMs === 0) {
      frames.push(tourFrame(tick, frameTime, snapshot));
    }
    if (!snapshot.active && actionIndex >= actions.length) {
      stoppedAtMs = frameTime;
      if (frames[frames.length - 1].tick !== tick) frames.push(tourFrame(tick, frameTime, snapshot));
      break;
    }
  }
  const last = sandbox.__tourSnapshot();
  const stats = {
    frames: frames.length,
    events: events.length,
    waypointAdvances: events.filter((event) => event.type === 'waypoint').length,
    phaseTransitions: events.filter((event) => event.type === 'phase').length,
    timerUpdates: events.filter((event) => event.type === 'timer').length,
    levelChanges: events.filter((event) => event.type === 'level').length,
    starts: actions.filter((action) => action.action === 'start').length,
    stops: actions.filter((action) => action.action === 'stop').length,
    nexts: actions.filter((action) => action.action === 'next').length,
    prevs: actions.filter((action) => action.action === 'prev').length,
    completedAtMs: lastDeactivatedAtMs,
    finalIndex: last.index,
    finalActive: last.active,
    waypointCount: waypoints.length,
  };
  return { waypoints, actions: TOUR_SCENARIO.actions, frames, events, stats };
}

// ---------------------------------------------------------------------------
// Wafer traces
// ---------------------------------------------------------------------------
function slicedRoutes(routeSliceSteps) {
  return {
    A: routesJson.products.A.route.slice(0, routeSliceSteps),
    B: routesJson.products.B.route.slice(0, routeSliceSteps),
    C: routesJson.products.C.route.slice(0, routeSliceSteps),
  };
}

function runWaferSetup(routeSliceSteps) {
  const { sandbox, clock } = createWaferSandbox();
  clock.ms = WAFER_SCENARIO.clockStartMs;
  sandbox.__waferSetup(slicedRoutes(routeSliceSteps), layoutJson.tools);
  return { sandbox, clock };
}

function computeFullRouteWaypointCounts() {
  const { sandbox, clock } = createWaferSandbox();
  clock.ms = WAFER_CLOCK_START_MS;
  sandbox.__waferSetup(
    {
      A: routesJson.products.A.route,
      B: routesJson.products.B.route,
      C: routesJson.products.C.route,
    },
    layoutJson.tools,
  );
  const counts = {};
  for (const product of ['A', 'B', 'C']) {
    counts[product] = vm.runInContext('computeWaferWaypoints("' + product + '").length', sandbox);
  }
  return counts;
}

function computeWaferProducts(routeSliceSteps) {
  const { sandbox, clock } = runWaferSetup(routeSliceSteps);
  void clock;
  const products = {};
  for (const product of ['A', 'B', 'C']) {
    const computed = vm.runInContext('computeWaferWaypoints("' + product + '")', sandbox);
    products[product] = computed.map((waypoint) => ({
      step: waypoint.step,
      tool_group: waypoint.tool_group,
      recipe: waypoint.recipe,
      category: waypoint.category,
      x: waypoint.x,
      y: waypoint.y,
      z: waypoint.z,
    }));
  }
  return products;
}

function isRouteCompletion(previous, snapshot) {
  return (
    previous.playing === true &&
    snapshot.playing === false &&
    snapshot.index === snapshot.waypointCount - 1 &&
    snapshot.stepTimer === 0
  );
}

function waferFrame(tick, timeMs, dt, snapshot) {
  const stepDurationSeconds = 2.0 / snapshot.speed;
  const progress = Math.min(snapshot.stepTimer / stepDurationSeconds, 1.0);
  const lastIndex = snapshot.waypointCount - 1;
  let segment;
  if (!snapshot.playing) {
    segment = snapshot.index === lastIndex && snapshot.stepTimer === 0 ? 'complete' : 'paused';
  } else if (snapshot.index === 0) {
    segment = 'start';
  } else {
    segment = progress < 0.75 ? 'transit' : 'dwell';
  }
  return {
    tick, timeMs,
    dt: round(dt),
    playing: snapshot.playing,
    product: snapshot.product,
    speed: snapshot.speed,
    index: snapshot.index,
    stepTimer: round(snapshot.stepTimer),
    stepDurationSeconds: round(stepDurationSeconds),
    progress: round(progress),
    segment,
    waypointCount: snapshot.waypointCount,
    position: roundVec(snapshot.position),
    rotationY: round(snapshot.rotationY),
    trailVisible: snapshot.trailVisible,
    trailCount: snapshot.trailCount,
    drawRange: snapshot.drawRange,
    hud: snapshot.hud,
    camera: roundVec(snapshot.camera),
  };
}

function trailSample(tick, timeMs, sandbox) {
  const points = sandbox.__waferTrailPoints().map((point) => [round(point[0]), round(point[1]), round(point[2])]);
  const snapshot = sandbox.__waferSnapshot();
  return {
    tick, timeMs,
    visible: snapshot.trailVisible,
    count: snapshot.trailCount,
    drawRange: snapshot.drawRange,
    points,
  };
}

function createWaferEventDiff(pushEvent, initialSnapshot) {
  let previous = initialSnapshot;
  return (timeMs, tick, snapshot) => {
    if (snapshot.playing !== previous.playing) {
      pushEvent({ timeMs, tick, type: 'playing', playing: snapshot.playing });
    }
    if (snapshot.product !== previous.product) {
      pushEvent({ timeMs, tick, type: 'product', product: snapshot.product });
    }
    if (snapshot.speed !== previous.speed) {
      pushEvent({ timeMs, tick, type: 'speed', speed: snapshot.speed });
    }
    if (snapshot.index !== previous.index) {
      pushEvent({ timeMs, tick, type: 'index', index: snapshot.index });
    }
    if (
      snapshot.hud.step !== previous.hud.step ||
      snapshot.hud.width !== previous.hud.width ||
      snapshot.hud.status !== previous.hud.status ||
      snapshot.hud.badge !== previous.hud.badge ||
      snapshot.hud.toolGroup !== previous.hud.toolGroup ||
      snapshot.hud.recipe !== previous.hud.recipe ||
      snapshot.hud.bay !== previous.hud.bay
    ) {
      pushEvent({ timeMs, tick, type: 'hud', hud: snapshot.hud });
    }
    if (
      snapshot.trailVisible !== previous.trailVisible ||
      snapshot.trailCount !== previous.trailCount ||
      snapshot.drawRange !== previous.drawRange
    ) {
      pushEvent({
        timeMs, tick, type: 'trail',
        visible: snapshot.trailVisible,
        count: snapshot.trailCount,
        drawRange: snapshot.drawRange,
      });
    }
    previous = snapshot;
  };
}

function runWaferSpeedTrace(speed, sampleEveryFrames) {
  const { sandbox, clock } = runWaferSetup(WAFER_SCENARIO.routeSliceSteps);
  sandbox.__waferStart(WAFER_SCENARIO.traceProduct, speed);
  const initial = waferFrame(0, clock.now(), 0, sandbox.__waferSnapshot());
  const frames = [initial];
  const events = [];
  const trailSamples = [];
  const pushEvent = (event) => events.push(event);
  const emitDiff = createWaferEventDiff(pushEvent, sandbox.__waferSnapshot());
  let previous = sandbox.__waferSnapshot();
  let previousTime = clock.now();
  let tick = 0;
  let completed = false;
  let completionTimeMs = null;
  for (;;) {
    tick += 1;
    const frameTime = WAFER_SCENARIO.clockStartMs + tick * WAFER_SCENARIO.frameMs;
    clock.ms = frameTime;
    sandbox.__waferFrame();
    const snapshot = sandbox.__waferSnapshot();
    emitDiff(frameTime, tick, snapshot);
    if (isRouteCompletion(previous, snapshot)) {
      completionTimeMs = frameTime;
      events.push({ timeMs: frameTime, tick, type: 'complete', index: snapshot.index });
      completed = true;
    }
    if (tick % sampleEveryFrames === 0 || !snapshot.playing) {
      frames.push(waferFrame(tick, frameTime, Math.min((frameTime - previousTime) / 1000, 0.1), snapshot));
    }
    if (tick % 32 === 0 || !snapshot.playing) trailSamples.push(trailSample(tick, frameTime, sandbox));
    previous = snapshot;
    previousTime = frameTime;
    if (completed) break;
    if (tick > 5000) throw new Error('Wafer trace did not complete');
  }
  const last = sandbox.__waferSnapshot();
  const stats = {
    frames: frames.length,
    events: events.length,
    speed,
    stepDurationSeconds: round(2.0 / speed, 6),
    completed,
    completionTimeMs,
    finalIndex: last.index,
    waypointCount: last.waypointCount,
    trailMax: Math.max(...trailSamples.map((sample) => sample.count)),
    trailSamples: trailSamples.length,
    durationMs: completionTimeMs === null ? null : completionTimeMs - WAFER_SCENARIO.clockStartMs,
  };
  return { speed, frames, events, trailSamples, stats };
}

function runWaferControlsTrace(products) {
  const controls = WAFER_SCENARIO.controls;
  const { sandbox, clock } = runWaferSetup(WAFER_SCENARIO.routeSliceSteps);
  void products;
  sandbox.__waferStart(WAFER_SCENARIO.traceProduct, controls.speed);
  const initial = waferFrame(0, clock.now(), 0, sandbox.__waferSnapshot());
  const frames = [initial];
  const events = [];
  const trailSamples = [];
  const pushEvent = (event) => events.push(event);
  const emitDiff = createWaferEventDiff(pushEvent, sandbox.__waferSnapshot());
  let previous = sandbox.__waferSnapshot();
  let previousTime = clock.now();
  let actionIndex = 0;
  let completed = false;
  let completionTimeMs = null;
  let tick = 0;
  const actions = controls.actions;
  for (;;) {
    tick += 1;
    const frameTime = WAFER_SCENARIO.clockStartMs + tick * WAFER_SCENARIO.frameMs;
    clock.ms = frameTime;
    sandbox.__waferFrame();
    let snapshot = sandbox.__waferSnapshot();
    emitDiff(frameTime, tick, snapshot);
    if (isRouteCompletion(previous, snapshot)) {
      completionTimeMs = frameTime;
      events.push({ timeMs: frameTime, tick, type: 'complete', index: snapshot.index });
      completed = true;
    }
    while (actionIndex < actions.length && actions[actionIndex].frame === tick) {
      const action = actions[actionIndex];
      sandbox.__waferAction(action.action, action.arg);
      const event = { timeMs: frameTime, tick, type: 'action', action: action.action };
      if (action.arg !== undefined) event.arg = action.arg;
      events.push(event);
      actionIndex += 1;
      snapshot = sandbox.__waferSnapshot();
      emitDiff(frameTime, tick, snapshot);
    }
    if (tick % controls.sampleEveryFrames === 0 || !snapshot.playing) {
      frames.push(waferFrame(tick, frameTime, Math.min((frameTime - previousTime) / 1000, 0.1), snapshot));
    }
    if (tick % 32 === 0 || !snapshot.playing) trailSamples.push(trailSample(tick, frameTime, sandbox));
    previous = snapshot;
    previousTime = frameTime;
    if (completed) break;
    if (tick > 5000) throw new Error('Wafer controls trace did not complete');
  }
  const last = sandbox.__waferSnapshot();
  const stats = {
    frames: frames.length,
    events: events.length,
    speed: controls.speed,
    completed,
    completionTimeMs,
    finalIndex: last.index,
    finalProduct: last.product,
    finalSpeed: last.speed,
    waypointCount: last.waypointCount,
    trailMax: Math.max(...trailSamples.map((sample) => sample.count)),
    trailSamples: trailSamples.length,
    durationMs: completionTimeMs === null ? null : completionTimeMs - WAFER_SCENARIO.clockStartMs,
    actions: actions.length,
    actionLog: actions.map((action) => {
      const entry = { frame: action.frame, action: action.action };
      if (action.arg !== undefined) entry.arg = action.arg;
      return entry;
    }),
  };
  return { frames, events, trailSamples, stats };
}

function runWaferStallTrace() {
  const stall = WAFER_SCENARIO.stall;
  const { sandbox, clock } = runWaferSetup(WAFER_SCENARIO.routeSliceSteps);
  sandbox.__waferStart(WAFER_SCENARIO.traceProduct, stall.speed);
  const frames = [];
  const events = [];
  const trailSamples = [];
  const pushEvent = (event) => events.push(event);
  const emitDiff = createWaferEventDiff(pushEvent, sandbox.__waferSnapshot());
  let previous = sandbox.__waferSnapshot();
  let previousTime = clock.now();
  frames.push(waferFrame(0, previousTime, 0, previous));
  let completed = false;
  for (let index = 1; index < stall.frameTimes.length; index += 1) {
    const frameTime = stall.frameTimes[index];
    clock.ms = frameTime;
    sandbox.__waferFrame();
    const snapshot = sandbox.__waferSnapshot();
    emitDiff(frameTime, index, snapshot);
    const dt = Math.min((frameTime - previousTime) / 1000, 0.1);
    if (isRouteCompletion(previous, snapshot)) {
      events.push({ timeMs: frameTime, tick: index, type: 'complete', index: snapshot.index });
      completed = true;
    }
    frames.push(waferFrame(index, frameTime, dt, snapshot));
    if (index % 8 === 0 || !snapshot.playing) trailSamples.push(trailSample(index, frameTime, sandbox));
    previous = snapshot;
    previousTime = frameTime;
    if (completed) break;
  }
  const last = sandbox.__waferSnapshot();
  const dtValues = frames.map((frame) => frame.dt);
  const stats = {
    frames: frames.length,
    events: events.length,
    speed: stall.speed,
    completed,
    dtClamp: WAFER_SCENARIO.dtClampSeconds,
    maxObservedDt: Math.max(...dtValues),
    stalledFrameIndex: frames.findIndex((frame) => frame.dt === WAFER_SCENARIO.dtClampSeconds),
    finalIndex: last.index,
    trailMax: Math.max(...trailSamples.map((sample) => sample.count)),
    trailSamples: trailSamples.length,
  };
  return { frames, events, trailSamples, stats };
}

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------
const stubBoundary = {
  frozenSource:
    'SemiconFab/twin.html @ d76378c; benchmark/routes.json and twin/layout-default.json are the pinned assets the frozen page fetches at runtime (see source-manifest.json).',
  execution:
    'Only character-for-character frozen slices are executed inside node:vm; every emitted number comes from original source code.',
  three:
    'THREE is a recording stub: Vector3 (set/copy/clone/lerpVectors/distanceTo), BufferAttribute, BufferGeometry, LineBasicMaterial. The FOUP group and trail line are declared recording objects shaped exactly as frozen initWaferFollowSystem builds them; no rendering happens.',
  camera:
    'camera.position / controls.target are plain Vector3 recording objects; camera.lookAt and controls.update are no-ops (they do not feed any recorded value).',
  dom:
    'document.getElementById returns recording elements (textContent / style.width / classList) so the frozen HUD, countdown and dot updates are inspectable data.',
  clock:
    'performance.now() is the declared deterministic clock. requestAnimationFrame fires on the declared 16 ms frame grid; setTimeout/setInterval run on a deterministic virtual event queue (ties by registration order). The frozen Tour uses performance.now + RAF + a 100 ms setInterval countdown; the frozen Wafer derives its own dt from performance.now with Math.min(dt, 0.1).',
  randomness:
    'No Math.random draws exist on these frozen code paths; the fixture records the declared LCG seed (42) for harness reproducibility.',
  tourState:
    'Tour module-level state (isCinematicTourActive, tourTimeoutId, tourCountdownInterval, currentTourWaypointIndex, activeCameraAnimId, currentFabLevel) is declared in the sandbox with the frozen initial values; CINEMATIC_WAYPOINTS is sliced from source.',
  crossFeature:
    'Tour/wafer mutual exclusion is stubbed: the tour sandbox declares an inactive waferFollowState (so startCinematicTour skips closeWaferFollow), and the wafer sandbox leaves stopCinematicTour undefined (typeof guards skip it). Cross-feature exclusivity is not part of these timing vectors.',
  waferState:
    'waferFollowState / foupGroup / waferTrailLine / waferTrailHistory / waferLastFrameTime are declared sandbox state; waferFollowState is initialised to the frozen literal values, then the declared session setup positions the FOUP on waypoint 0 and primes waferLastFrameTime exactly like toggleWaferFollowPanel does.',
  routeData:
    'computeWaferWaypoints is executed against the pinned benchmark/routes.json + twin/layout-default.json route/layout data that the page fetches. The trace uses a declared 5-step prefix of each product route (the full pinned routes have 120/104/92 steps) so a fixed-time trace stays bounded; waypoint x/z are still chosen by the frozen round-robin against the full layout tool list.',
  seekAdvance:
    'Frozen source has no seek/scrub for the wafer follow flow: the wafer UI exposes play/pause, speed 1x/4x/16x, replay, product select and camera follow only (twin.html:955-1036, 18503-18616). Fast-forward is setWaferSpeed scaling dur = 2.0 / speed (18293); replayWaferRoute resets index/stepTimer/trail. The Tour advances via timer callbacks + tweenCamera RAF frames; next/prev jump waypoints. There is no seek in either flow and none was invented.',
  dtClamp:
    'updateWaferFollowFrame computes dt = Math.min((performance.now() - waferLastFrameTime) / 1000, 0.1); the declared stall trace feeds one 500 ms frame gap to exercise the 0.1 s clamp.',
  hudLanguage:
    'HUD text is captured with currentLang = "en" (the frozen HUD renders English for any non-zh language); Tour HUD titles are captured in English for the same reason.',
};

function buildFixture() {
  const tourTrace = runTourTrace();
  const products = computeWaferProducts(WAFER_SCENARIO.routeSliceSteps);
  const speedTraces = {};
  for (const trace of WAFER_SCENARIO.traces) {
    speedTraces[trace.name] = runWaferSpeedTrace(trace.speed, trace.sampleEveryFrames);
  }
  const controlsTrace = runWaferControlsTrace(products);
  const stallTrace = runWaferStallTrace();
  const { sandbox: baySandbox } = createWaferSandbox();
  const bays = vm.runInContext('CATEGORY_BAYS', baySandbox);
  const categoryBays = {};
  for (const [category, bay] of Object.entries(bays)) {
    categoryBays[category] = { nameEn: bay.nameEn, nameZh: bay.nameZh };
  }
  return {
    sourceSha256: hash,
    sourceFunctions: { tour: TOUR_RANGES, wafer: WAFER_RANGES },
    assets: {
      routesJson: {
        path: 'benchmark/routes.json',
        sha256: routesSha256,
        bytes: routesBytes.length,
        productSteps: {
          A: routesJson.products.A.route.length,
          B: routesJson.products.B.route.length,
          C: routesJson.products.C.route.length,
        },
      },
      layoutDefault: {
        path: 'twin/layout-default.json',
        sha256: layoutSha256,
        bytes: layoutBytes.length,
        toolCount: layoutJson.tools.length,
      },
    },
    stubBoundary,
    scenario: {
      seed: 42,
      tour: {
        clockStartMs: TOUR_SCENARIO.clockStartMs,
        frameMs: TOUR_SCENARIO.frameMs,
        sampleEveryMs: TOUR_SCENARIO.sampleEveryMs,
        countdownIntervalMs: 100,
        initialCamera: TOUR_INITIAL.camera,
        initialTarget: TOUR_INITIAL.target,
        initialLevel: TOUR_INITIAL.level,
        maxMs: TOUR_SCENARIO.maxMs,
        actions: TOUR_SCENARIO.actions,
        hudLanguage: 'en',
      },
      wafer: {
        clockStartMs: WAFER_SCENARIO.clockStartMs,
        frameMs: WAFER_SCENARIO.frameMs,
        dtClampSeconds: WAFER_SCENARIO.dtClampSeconds,
        routeSliceSteps: WAFER_SCENARIO.routeSliceSteps,
        traceProduct: WAFER_SCENARIO.traceProduct,
        initialCamera: WAFER_INITIAL.camera,
        products: ['A', 'B', 'C'],
        speedTraces: WAFER_SCENARIO.traces,
        controls: WAFER_SCENARIO.controls,
        stall: WAFER_SCENARIO.stall,
        hudLanguage: 'en',
        categoryBays,
      },
    },
    tour: tourTrace,
    wafer: {
      routeSource: {
        routesJsonSha256: routesSha256,
        layoutDefaultSha256: layoutSha256,
        fullProductSteps: {
          A: routesJson.products.A.route.length,
          B: routesJson.products.B.route.length,
          C: routesJson.products.C.route.length,
        },
        fullProductWaypointCounts: computeFullRouteWaypointCounts(),
        declaredSliceSteps: WAFER_SCENARIO.routeSliceSteps,
      },
      products,
      traces: {
        ...speedTraces,
        controls: controlsTrace,
        stall: stallTrace,
      },
      seek: {
        supported: false,
        evidence:
          'No seek/scrub control exists in the frozen wafer-follow UI (only play/pause, speed 1x/4x/16x, replay, product select, camera follow; twin.html:955-1036). Fast-forward is setWaferSpeed -> dur = 2.0 / speed (18293); replayWaferRoute resets index/stepTimer/trail (18563-18583). Tour advance is nextTourWaypoint/prevTourWaypoint + timer callbacks; no seek.',
      },
    },
  };
}

const fixture = buildFixture();
const json = JSON.stringify(fixture) + '\n';
const destination = path.join(root, 'web_app/tests/fixtures/original-tour-wafer-vectors.json');

if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== json) throw new Error('Tour/wafer vectors drift');
  console.log(
    'Tour/wafer vectors stable: tour ' + fixture.tour.waypoints.length + ' waypoints, ' +
      fixture.tour.stats.events + ' events, ' + fixture.tour.stats.frames + ' frames; wafer ' +
      Object.keys(fixture.wafer.traces).length + ' traces, ' +
      Object.values(fixture.wafer.traces).reduce((sum, trace) => sum + trace.frames.length, 0) + ' frames',
  );
} else {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, json);
  console.log(
    'Original tour/wafer vectors: tour ' + fixture.tour.waypoints.length + ' waypoints, ' +
      fixture.tour.stats.events + ' events, ' + fixture.tour.stats.frames + ' frames; wafer traces ' +
      Object.entries(fixture.wafer.traces).map(([name, trace]) => name + '=' + trace.frames.length).join(', '),
  );
}
