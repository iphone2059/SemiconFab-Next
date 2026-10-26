// Deterministic extraction of the frozen original cleanroom-personnel, patrol
// behavior-tree and air-shower timing vectors.
//
// Source: SemiconFab/twin.html @ d76378c (sha256 pinned in
// docs/migration/twin-parity/source-manifest.json). The tool executes ONLY
// character-for-character slices of the frozen page inside node:vm (function,
// const and animation-loop block text). THREE, the canvas 2D context, document
// and the wall clock are replaced by recording stubs; see "stubBoundary" in the
// emitted fixture for the exact boundary. Nothing below re-implements source
// timing math: every number in the fixture is produced by original source code.
//
// Usage:
//   node tools/build_twin_personnel_vectors.cjs          # (re)write the fixture
//   node tools/build_twin_personnel_vectors.cjs --check  # fail on drift
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.resolve(root, '../SemiconFab/twin.html'), 'utf8');
const manifest = require('../docs/migration/twin-parity/source-manifest.json');
const hash = crypto.createHash('sha256').update(source).digest('hex');
if (hash !== manifest.source_sha256['twin.html']) throw new Error('Original source drift');

// ---------------------------------------------------------------------------
// Frozen-source slicing: string/comment/template aware brace matching so the
// extracted text is exactly the original characters (no reformatting).
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
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '\u0060') {
      // Skip a template literal wholesale. Its interpolations are balanced
      // braces and cannot affect the surrounding brace depth.
      index += 1;
      let templateEscaped = false;
      for (; index < source.length; index += 1) {
        const inner = source[index];
        if (templateEscaped) {
          templateEscaped = false;
          continue;
        }
        if (inner === '\\') {
          templateEscaped = true;
          continue;
        }
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
  const text = source.slice(startIndex, endIndex + 1);
  return { text, startLine: lineOf(startIndex), endLine: lineOf(endIndex) };
}

function extractFunction(name) {
  const start = source.indexOf('      function ' + name + '(');
  if (start < 0) throw new Error('Missing frozen function ' + name);
  const parenStart = source.indexOf('(', start);
  const parenEnd = findMatching(parenStart, '(', ')');
  const braceStart = source.indexOf('{', parenEnd);
  return { name, ...sliceFrom(start, findMatching(braceStart, '{', '}')) };
}

function extractConstObject(name) {
  const start = source.indexOf('      const ' + name + ' = {');
  if (start < 0) throw new Error('Missing frozen const ' + name);
  const braceStart = source.indexOf('{', start);
  return { name, ...sliceFrom(start, findMatching(braceStart, '{', '}')) };
}

function extractBlock(marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('Missing frozen block ' + marker);
  if (source.indexOf(marker, start + 1) >= 0) throw new Error('Ambiguous frozen block ' + marker);
  const braceStart = source.indexOf('{', start);
  return sliceFrom(start, findMatching(braceStart, '{', '}'));
}

// Line ranges asserted so source drift cannot silently move the sliced code.
const SOURCE_RANGES = {
  PATROL_BEHAVIOR_TREE: [9098, 9146],
  createPatrolStatusCanvas: [9148, 9194],
  createPatrolStatusSprite: [9196, 9214],
  updatePatrolStatusSprite: [9216, 9263],
  createAirlockVortexParticles: [9265, 9301],
  createBunnySuitOperator: [9303, 9476],
  buildCleanroomPersonnel: [9478, 9549],
  updatePatrolEngineerBehaviorTree: [9552, 9842],
  drawAirShowerBillboardCanvas: [9935, 10010],
  createAirShowerSprite: [10012, 10032],
  updateAllAirShowerSprites: [10034, 10050],
  createAirShower: [10095, 10257],
};
const INLINE_BLOCK_RANGES = {
  personnelBreathing: [19127, 19134],
  airShowerStandbyCycle: [19137, 19206],
};

const frozen = {};
for (const [name, range] of Object.entries(SOURCE_RANGES)) {
  frozen[name] = name === 'PATROL_BEHAVIOR_TREE' ? extractConstObject(name) : extractFunction(name);
  if (frozen[name].startLine !== range[0] || frozen[name].endLine !== range[1]) {
    throw new Error('Frozen source line drift for ' + name + ': ' + frozen[name].startLine + '-' + frozen[name].endLine);
  }
}
const inlineBlocks = {
  personnelBreathing: extractBlock('        if (cleanroomPersonnel.length > 0) {'),
  airShowerStandbyCycle: extractBlock('        if (airShowerChambers.length > 0) {'),
};
for (const [name, range] of Object.entries(INLINE_BLOCK_RANGES)) {
  if (inlineBlocks[name].startLine !== range[0] || inlineBlocks[name].endLine !== range[1]) {
    throw new Error('Frozen source line drift for inline block ' + name);
  }
}

const DECLARATIONS = Object.values(frozen).map((entry) => entry.text).join('\n');

// ---------------------------------------------------------------------------
// Declared deterministic scenario. The original page drives the behavior tree
// with a hard-coded 0.016 s frame step and reads the wall clock for the flashing
// / pulsing animation phases; both are replaced here by declared values.
// ---------------------------------------------------------------------------
const SCENARIO = {
  seed: 42,
  dt: 0.016,
  clockStartMs: 0,
  clockMsPerTick: 16,
  ticks: 3500,
  sampleEvery: 20,
  purgeSampleEvery: 8,
  vortexSampleEvery: 12,
  purgeSeconds: 4.5,
  airShowerStandbySeconds: 12.0,
  airShowerBlowStartSeconds: 7.0,
  personnelCount: 6,
  vortexParticleCount: 70,
  chamberUserDataModes: ['as-built', 'preserved'],
  airShowers: {
    main: {
      id: 'fac.airshower.main.1',
      isAmber: false,
      position: { x: 12.0, y: 0.0, z: 34.0 },
      options: { width: 2.8, height: 2.8, depth: 3.4, isAmber: false },
    },
    litho: {
      id: 'fac.airshower.litho.1',
      isAmber: true,
      position: { x: -16.5, y: 0.0, z: 3.0 },
      options: { width: 2.4, height: 2.8, depth: 3.2, isAmber: true },
    },
  },
};

const round = (value, digits = 6) =>
  Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits + 0 : null;

function createRandom(seed) {
  let state = seed >>> 0;
  return {
    random: () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    },
    seed: () => state,
  };
}

// ---------------------------------------------------------------------------
// Minimal recording THREE stub. Only the object surface touched by the frozen
// slices exists; every property is inspectable data, no rendering happens.
// ---------------------------------------------------------------------------
function makeVec3(x = 0, y = 0, z = 0) {
  return {
    x,
    y,
    z,
    set(nextX, nextY, nextZ) {
      this.x = nextX;
      this.y = nextY;
      this.z = nextZ;
      return this;
    },
    copy(vec) {
      this.x = vec.x;
      this.y = vec.y;
      this.z = vec.z;
      return this;
    },
    lerp(vec, alpha) {
      this.x += (vec.x - this.x) * alpha;
      this.y += (vec.y - this.y) * alpha;
      this.z += (vec.z - this.z) * alpha;
      return this;
    },
  };
}

class Object3D {
  constructor() {
    this.position = makeVec3();
    this.rotation = makeVec3();
    this.scale = makeVec3(1, 1, 1);
    this.userData = {};
    this.children = [];
    this.visible = true;
  }
  add(...objects) {
    this.children.push(...objects);
    return this;
  }
}

class Mesh extends Object3D {
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
  }
}

class Sprite extends Object3D {
  constructor(material) {
    super();
    this.material = material;
  }
}

class Points extends Object3D {
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
  }
}

class PointLight extends Object3D {
  constructor(color, intensity, distance) {
    super();
    this.color = color;
    this.intensity = intensity;
    this.distance = distance;
  }
}

class Color {
  constructor(hex) {
    this.hex = hex;
  }
  setHex(value) {
    this.hex = value;
    return this;
  }
}

function makeMaterial(parameters) {
  const params = parameters || {};
  const material = {
    opacity: params.opacity === undefined ? 1.0 : params.opacity,
    transparent: params.transparent === true,
    roughness: params.roughness,
    metalness: params.metalness,
    emissiveIntensity: params.emissiveIntensity === undefined ? 1.0 : params.emissiveIntensity,
    size: params.size,
    color: new Color(params.color === undefined ? 0xffffff : params.color),
    emissive: new Color(params.emissive === undefined ? 0x000000 : params.emissive),
    map: params.map,
    blending: params.blending,
    depthTest: params.depthTest,
    depthWrite: params.depthWrite,
    side: params.side,
    ior: params.ior,
    transmission: params.transmission,
    clone() {
      const copy = makeMaterial({});
      copy.opacity = material.opacity;
      copy.transparent = material.transparent;
      copy.color = new Color(material.color.hex);
      copy.emissive = new Color(material.emissive.hex);
      copy.emissiveIntensity = material.emissiveIntensity;
      copy.size = material.size;
      copy.map = material.map;
      copy.blending = material.blending;
      copy.side = material.side;
      copy.depthTest = material.depthTest;
      copy.depthWrite = material.depthWrite;
      copy.transparent = material.transparent;
      return copy;
    },
  };
  return material;
}

class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.needsUpdate = false;
  }
  setXYZ(index, x, y, z) {
    this.array[index * 3] = x;
    this.array[index * 3 + 1] = y;
    this.array[index * 3 + 2] = z;
  }
}

class BufferGeometry {
  constructor() {
    this.attributes = {};
  }
  setAttribute(name, attribute) {
    this.attributes[name] = attribute;
    return this;
  }
  rotateX() {
    return this;
  }
}

class ScalarGeometry {
  constructor(...parameters) {
    this.parameters = parameters;
  }
  rotateX() {
    return this;
  }
}

class CanvasTexture {
  constructor(canvas) {
    this.image = canvas;
    this.needsUpdate = false;
    this.minFilter = null;
    this.wrapS = null;
    this.wrapT = null;
    this.repeat = { set() {} };
    this.offset = { x: 0, y: 0 };
  }
}

function createThreeStub() {
  return {
    Vector3: function Vector3(x, y, z) {
      return makeVec3(x, y, z);
    },
    Group: class Group extends Object3D {},
    Object3D,
    Mesh,
    Sprite,
    Points,
    PointLight,
    BufferGeometry,
    ScalarGeometry,
    BufferAttribute,
    CanvasTexture,
    MeshStandardMaterial: function (parameters) {
      return makeMaterial(parameters);
    },
    MeshPhysicalMaterial: function (parameters) {
      return makeMaterial(parameters);
    },
    MeshBasicMaterial: function (parameters) {
      return makeMaterial(parameters);
    },
    SpriteMaterial: function (parameters) {
      return makeMaterial(parameters);
    },
    PointsMaterial: function (parameters) {
      return makeMaterial(parameters);
    },
    BoxGeometry: ScalarGeometry,
    CylinderGeometry: ScalarGeometry,
    SphereGeometry: ScalarGeometry,
    PlaneGeometry: ScalarGeometry,
    ConeGeometry: ScalarGeometry,
    LinearFilter: 1006,
    AdditiveBlending: 2,
    DoubleSide: 2,
    RepeatWrapping: 1000,
  };
}

// Canvas 2D recording stub: keeps the drawing command stream (text, fills,
// strokes, geometry) so status-board / billboard content is inspectable data.
function createCanvasRecorder() {
  const ops = [];
  const context = {
    canvas: null,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    clearRect() {
      ops.push(['clearRect']);
    },
    beginPath() {},
    closePath() {},
    roundRect(x, y, width, height, radius) {
      ops.push(['roundRect', x, y, width, height, radius]);
    },
    fill() {
      ops.push(['fill', this.fillStyle]);
    },
    stroke() {
      ops.push(['stroke', this.strokeStyle, this.lineWidth]);
    },
    fillText(text, x, y) {
      ops.push(['fillText', text, x, y, this.fillStyle, this.font, this.textAlign]);
    },
    fillRect(x, y, width, height) {
      ops.push(['fillRect', x, y, width, height, this.fillStyle]);
    },
    moveTo() {},
    lineTo() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    __ops: ops,
    getContext() {
      return context;
    },
  };
  context.canvas = canvas;
  return canvas;
}

// ---------------------------------------------------------------------------
// VM sandbox: frozen slices + thin instrumentation helpers. The helpers only
// call frozen functions, capture their outputs and re-attach constructor
// outputs; they add no timing/geometry math of their own.
// ---------------------------------------------------------------------------
function buildHelpers() {
  return [
    'function __setLang(lang) { currentLang = lang; }',
    'function __bt() { return PATROL_BEHAVIOR_TREE; }',
    'function __buildWithRecords() {',
    '  var records = [];',
    '  var realCreate = createBunnySuitOperator;',
    '  createBunnySuitOperator = function (options) {',
    '    var operator = realCreate(options);',
    '    records.push({ options: options, operator: operator });',
    '    return operator;',
    '  };',
    '  try {',
    '    buildCleanroomPersonnel();',
    '  } finally {',
    '    createBunnySuitOperator = realCreate;',
    '  }',
    '  return {',
    '    records: records,',
    '    personnel: cleanroomPersonnel,',
    '    patrol: patrolEngineer,',
    '    vortex: patrolAirlockVortexParticles,',
    '  };',
    '}',
    'function __donor() {',
    '  return createBunnySuitOperator({ badgeColor: 0xf59e0b, hasTablet: true, isPatrol: true });',
    '}',
    'function __attachPatrolParts(donor) {',
    '  var data = donor.userData;',
    '  var parts = {',
    '    leftLegPivot: data.leftLegPivot,',
    '    rightLegPivot: data.rightLegPivot,',
    '    leftArmPivot: data.leftArmPivot,',
    '    rightArmPivot: data.rightArmPivot,',
    '    statusSprite: data.statusSprite,',
    '    screenMat: data.screenMat,',
    '  };',
    '  Object.assign(patrolEngineer.userData, parts);',
    '  return parts;',
    '}',
    'function __statusBoard(lang) {',
    '  currentLang = lang;',
    '  return createPatrolStatusCanvas(',
    '    PATROL_BEHAVIOR_TREE.statusTextZh,',
    '    PATROL_BEHAVIOR_TREE.statusTextEn,',
    '    PATROL_BEHAVIOR_TREE.state,',
    '  );',
    '}',
    'function __billboardCanvas(isAmber, lang) {',
    '  var canvas = document.createElement("canvas");',
    '  drawAirShowerBillboardCanvas(canvas, isAmber, lang);',
    '  return canvas;',
    '}',
    'function __chamberRefs(chamber) {',
    '  var data = chamber.userData || {};',
    '  return {',
    '    indicators: data.indicators || [],',
    '    jets: data.jetStreams || [],',
    '    innerLight: data.innerLight || null,',
    '    labelSprite: data.labelSprite || null,',
    '  };',
    '}',
    'function __chamberRecord(chamber) {',
    '  var data = chamber.userData || {};',
    '  var labelSprite = data.labelSprite || null;',
    '  return {',
    '    height: data.height,',
    '    isAmber: data.isAmber,',
    '    timer: data.timer,',
    '    userDataKeys: Object.keys(data),',
    '    indicators: (data.indicators || []).map(function (indicator) {',
    '      return {',
    '        color: indicator.material.color.hex,',
    '        emissive: indicator.material.emissive.hex,',
    '        emissiveIntensity: indicator.material.emissiveIntensity,',
    '        position: { x: indicator.position.x, y: indicator.position.y, z: indicator.position.z },',
    '      };',
    '    }),',
    '    jets: (data.jetStreams || []).map(function (jet) {',
    '      return {',
    '        opacity: jet.material.opacity,',
    '        color: jet.material.color.hex,',
    '        blending: jet.material.blending,',
    '        position: { x: jet.position.x, y: jet.position.y, z: jet.position.z },',
    '        rotationZ: jet.rotation.z,',
    '      };',
    '    }),',
    '    innerLight: data.innerLight',
    '      ? {',
    '          intensity: data.innerLight.intensity,',
    '          color: data.innerLight.color,',
    '          distance: data.innerLight.distance,',
    '          position: {',
    '            x: data.innerLight.position.x,',
    '            y: data.innerLight.position.y,',
    '            z: data.innerLight.position.z,',
    '          },',
    '        }',
    '      : null,',
    '    labelSprite: labelSprite',
    '      ? {',
    '          isAmber: labelSprite.userData.isAmber,',
    '          scale: { x: labelSprite.scale.x, y: labelSprite.scale.y, z: labelSprite.scale.z },',
    '          position: { x: labelSprite.position.x, y: labelSprite.position.y, z: labelSprite.position.z },',
    '          canvasWidth: labelSprite.userData.canvas.width,',
    '          canvasHeight: labelSprite.userData.canvas.height,',
    '          ops: labelSprite.userData.canvas.__ops.slice(),',
    '        }',
    '      : null,',
    '  };',
    '}',
    'function __createChambers(spec, mode) {',
    '  var main = createAirShower(spec.main.options);',
    '  main.position.set(spec.main.position.x, spec.main.position.y, spec.main.position.z);',
    '  var litho = createAirShower(spec.litho.options);',
    '  litho.position.set(spec.litho.position.x, spec.litho.position.y, spec.litho.position.z);',
    '  var result = {',
    '    chambers: [main, litho],',
    '    records: [__chamberRecord(main), __chamberRecord(litho)],',
    '    refs: [__chamberRefs(main), __chamberRefs(litho)],',
    '  };',
    '  if (mode === "as-built") {',
    '    main.userData = { id: spec.main.id };',
    '    litho.userData = { id: spec.litho.id };',
    '  }',
    '  airShowerChambers = [main, litho];',
    '  return result;',
    '}',
    'function __renderStatusBoard(sprite, lang) {',
    '  currentLang = lang;',
    '  if (!sprite || !sprite.userData || !sprite.userData.canvas) return null;',
    '  var canvas = sprite.userData.canvas;',
    '  canvas.__ops.length = 0;',
    '  updatePatrolStatusSprite(',
    '    sprite,',
    '    PATROL_BEHAVIOR_TREE.statusTextZh,',
    '    PATROL_BEHAVIOR_TREE.statusTextEn,',
    '    PATROL_BEHAVIOR_TREE.state,',
    '  );',
    '  return canvas.__ops.slice();',
    '}',
    'function __clearStatusBoard(sprite) {',
    '  if (sprite && sprite.userData && sprite.userData.canvas && sprite.userData.canvas.__ops) {',
    '    sprite.userData.canvas.__ops.length = 0;',
    '  }',
    '}',
    'function __redrawAirShowerSprites(lang) {',
    '  currentLang = lang;',
    '  var canvases = [];',
    '  for (var i = 0; i < airShowerChambers.length; i += 1) {',
    '    var data = airShowerChambers[i].userData || {};',
    '    var sprite = data.labelSprite;',
    '    if (sprite && sprite.userData && sprite.userData.canvas) canvases.push(sprite.userData.canvas);',
    '  }',
    '  var before = canvases.map(function (canvas) { return canvas.__ops.length; });',
    '  updateAllAirShowerSprites(lang);',
    '  return canvases.map(function (canvas, index) {',
    '    return { ops: canvas.__ops.slice(before[index]) };',
    '  });',
    '}',
    'function __step(dt) { updatePatrolEngineerBehaviorTree(dt); }',
    'function __breath() {',
    inlineBlocks.personnelBreathing.text,
    '}',
    'function __airShowerCycle() {',
    inlineBlocks.airShowerStandbyCycle.text,
    '}',
  ].join('\n');
}

function createSandbox() {
  const clock = { ms: 0 };
  const random = createRandom(SCENARIO.seed);
  const math = Object.create(Math);
  math.random = random.random;
  const canvases = [];
  const context = {
    Math: math,
    Date: { now: () => clock.ms, nowMs: () => clock.ms },
    document: {
      createElement(tag) {
        if (tag !== 'canvas') throw new Error('Unsupported document element: ' + tag);
        const canvas = createCanvasRecorder();
        canvases.push(canvas);
        return canvas;
      },
    },
    currentLang: 'en',
    console,
    scene: {
      objects: [],
      add(...objects) {
        this.objects.push(...objects);
      },
    },
    cleanroomPersonnel: [],
    patrolEngineer: null,
    patrolAirlockVortexParticles: null,
    airShowerChambers: [],
    isPatrolCameraFollow: false,
    controls: null,
    camera: null,
    THREE: createThreeStub(),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(DECLARATIONS + '\n' + buildHelpers(), context, {
    filename: 'frozen-twin-personnel.vm.js',
  });
  return { context, clock, random, canvases };
}

// ---------------------------------------------------------------------------
// Vector capture
// ---------------------------------------------------------------------------
function captureVortex(vortex) {
  const data = vortex.userData.vData;
  const attribute = vortex.geometry.attributes.position;
  const particles = data.map((particle, index) => ({
    angle: particle.angle,
    radius: particle.r,
    y: particle.y,
    speed: particle.speed,
    vy: particle.vy,
    position: {
      x: attribute.array[index * 3],
      y: attribute.array[index * 3 + 1],
      z: attribute.array[index * 3 + 2],
    },
  }));
  return {
    count: vortex.userData.count,
    opacity: vortex.material.opacity,
    size: vortex.material.size,
    color: vortex.material.color.hex,
    blending: vortex.material.blending,
    particles,
  };
}

// Compact sample: particles are [angle, y, positionX, positionY, positionZ].
function captureVortexSamples(vortex, tick) {
  const data = vortex.userData.vData;
  const attribute = vortex.geometry.attributes.position;
  const particles = data.map((particle, index) => [
    round(particle.angle, 6),
    round(particle.y, 6),
    round(attribute.array[index * 3], 6),
    round(attribute.array[index * 3 + 1], 6),
    round(attribute.array[index * 3 + 2], 6),
  ]);
  return { tick, opacity: round(vortex.material.opacity, 6), particles };
}

function summarizeCanvasOps(canvas) {
  const ops = canvas.__ops || canvas;
  return ops.map((op) => Array.from(op));
}

function readChamberFrame(refs, chamber, id) {
  const data = chamber.userData || {};
  const timerValue = data.timer;
  const timer = Number.isFinite(timerValue) ? round(timerValue, 6) : null;
  const cycleTime =
    timer === null ? null : round(timerValue % SCENARIO.airShowerStandbySeconds, 6);
  const indicator = refs.indicators[0];
  const jets = [];
  for (let index = 0; index < refs.jets.length; index += 1) {
    const jet = refs.jets[index];
    jets.push({ opacity: round(jet.material.opacity, 6), scale: round(jet.scale.x, 6) });
  }
  return {
    id,
    timer,
    cycleTime,
    cycleBlowing: cycleTime !== null && cycleTime > SCENARIO.airShowerBlowStartSeconds,
    isPurging: data.isPurging === true,
    indicator: {
      color: indicator.material.color.hex,
      emissive: indicator.material.emissive.hex,
      intensity: round(indicator.material.emissiveIntensity, 6),
    },
    jets,
    innerLight: refs.innerLight ? round(refs.innerLight.intensity, 6) : null,
    labelSpriteY: refs.labelSprite ? round(refs.labelSprite.position.y, 6) : null,
  };
}

function statusKeyOf(phase, waypointIndex, statusTextZh, waypoints) {
  if (phase !== 'PATROL_WAYPOINTS') return phase;
  const waypoint = waypoints[waypointIndex];
  const inspecting = Boolean(waypoint) && statusTextZh.startsWith(waypoint.nameZh + ' (');
  return (inspecting ? 'inspect:' : 'travel:') + waypointIndex;
}

function simulate(mode) {
  const sandbox = createSandbox();
  const { context, clock, random } = sandbox;
  const built = context.__buildWithRecords();
  const bt = context.__bt();
  const waypoints = bt.waypoints.map((waypoint) => ({
    x: waypoint.x,
    z: waypoint.z,
    targetTool: waypoint.targetTool,
    nameZh: waypoint.nameZh,
    nameEn: waypoint.nameEn,
    duration: waypoint.duration,
    inspectAngle: waypoint.inspectAngle,
  }));

  const roster = built.records.map((record, index) => {
    const operator = record.operator;
    const options = record.options || {};
    return {
      id: options.isPatrol ? 'patrol-engineer' : 'operator-' + (index + 1),
      role: operator.userData.role,
      isPatrol: options.isPatrol === true,
      badgeColor: options.badgeColor === undefined ? 0x10b981 : options.badgeColor,
      hasTablet: options.hasTablet !== false,
      x: round(operator.position.x, 6),
      y: round(operator.position.y, 6),
      z: round(operator.position.z, 6),
      rotY: round(operator.rotation.y, 6),
    };
  });

  // Frozen canvas painter variants for the overhead status boards.
  const statusBoards = {
    initialEn: summarizeCanvasOps(context.__statusBoard('en')),
    initialZh: summarizeCanvasOps(context.__statusBoard('zh-CN')),
  };
  context.__setLang('en');

  // A fresh frozen operator supplies the constructor outputs (limb pivots,
  // status sprite, tablet screen material) that the frozen build overwrites.
  const donor = context.__donor();
  const donorParts = donor.userData;
  const parts = mode === 'preserved' ? context.__attachPatrolParts(donor) : donorParts;
  const statusSprite = mode === 'preserved' ? parts.statusSprite : null;

  const vortex = built.vortex;
  const vortexInitial = captureVortex(vortex);

  const billboardVariants = {};
  for (const variant of [
    { key: 'mainEn', isAmber: false, lang: 'en' },
    { key: 'mainZh', isAmber: false, lang: 'zh-CN' },
    { key: 'amberEn', isAmber: true, lang: 'en' },
    { key: 'amberZh', isAmber: true, lang: 'zh-CN' },
  ]) {
    const canvas = context.__billboardCanvas(variant.isAmber, variant.lang);
    billboardVariants[variant.key] = {
      isAmber: variant.isAmber,
      lang: variant.lang,
      ops: summarizeCanvasOps(canvas),
    };
  }
  context.__setLang('en');

  const chambers = context.__createChambers(SCENARIO.airShowers, mode);
  const chamberRefs = chambers.refs;
  const chamberObjects = chambers.chambers;
  const chamberIds = [SCENARIO.airShowers.main.id, SCENARIO.airShowers.litho.id];
  const finalUserDataKeys = chamberObjects.map((chamber) => Object.keys(chamber.userData));
  const spriteRedraws = {
    en: context.__redrawAirShowerSprites('en'),
    zhCn: context.__redrawAirShowerSprites('zh-CN'),
  };
  context.__setLang('en');

  const readFrame = (tick) => {
    const actors = [];
    for (let index = 0; index < built.personnel.length; index += 1) {
      const operator = built.personnel[index];
      actors.push({
        x: round(operator.position.x, 6),
        y: round(operator.position.y, 6),
        z: round(operator.position.z, 6),
        rotY: round(operator.rotation.y, 6),
        walkPhase: index === built.personnel.length - 1 ? round(bt.walkPhase, 6) : 0,
      });
    }
    return {
      tick,
      time: round(tick * SCENARIO.dt, 6),
      actors,
      patrol: {
        phase: bt.state,
        stateTimer: round(bt.stateTimer, 6),
        waypointIndex: bt.waypointIndex,
        statusKey: statusKeyOf(bt.state, bt.waypointIndex, bt.statusTextZh, waypoints),
        statusTextZh: bt.statusTextZh,
        statusTextEn: bt.statusTextEn,
        screenColor: parts.screenMat ? parts.screenMat.color.hex : null,
        screenEmissive: parts.screenMat ? parts.screenMat.emissive.hex : null,
        screenEmissiveIntensity: parts.screenMat
          ? round(parts.screenMat.emissiveIntensity, 6)
          : null,
        statusSpriteY: parts.statusSprite ? round(parts.statusSprite.position.y, 6) : null,
        statusSpriteVisible: parts.statusSprite ? parts.statusSprite.visible : null,
        legs: {
          left: round(parts.leftLegPivot.rotation.x, 6),
          right: round(parts.rightLegPivot.rotation.x, 6),
        },
        arms: {
          left: round(parts.leftArmPivot.rotation.x, 6),
          right: round(parts.rightArmPivot.rotation.x, 6),
        },
      },
      airShowers: [
        readChamberFrame(chamberRefs[0], chamberObjects[0], chamberIds[0]),
        readChamberFrame(chamberRefs[1], chamberObjects[1], chamberIds[1]),
      ],
      vortexOpacity: round(vortex.material.opacity, 6),
    };
  };

  const readPurgeFrame = (tick) => ({
    tick,
    time: round(tick * SCENARIO.dt, 6),
    patrol: {
      phase: bt.state,
      stateTimer: round(bt.stateTimer, 6),
      statusKey: statusKeyOf(bt.state, bt.waypointIndex, bt.statusTextZh, waypoints),
    },
    airShowers: [
      readChamberFrame(chamberRefs[0], chamberObjects[0], chamberIds[0]),
      readChamberFrame(chamberRefs[1], chamberObjects[1], chamberIds[1]),
    ],
    vortexOpacity: round(vortex.material.opacity, 6),
  });

  const events = [];
  const frames = [];
  const purgeFrames = [];
  const vortexSamples = [];
  const statusBoardSamples = [];
  const phaseSequence = [];
  const phaseTicks = {};
  const waypointTicks = waypoints.map(() => ({ ticks: 0, reachedTick: null }));
  const purges = [];
  let purgeTicks = 0;
  let currentPurge = null;
  let previousPhase = null;
  let previousStatusKey = null;
  let previousWaypointIndex = null;
  let previousScreen = null;
  let previousVortexOpacity = null;
  let previousChamberState = null;
  let previousStateTimer = 0;
  let lastTick = 0;

  const pushEvent = (tick, fields) => {
    events.push({ tick, time: round(tick * SCENARIO.dt, 6), ...fields });
  };

  const initialFrame = readFrame(0);
  frames.push(initialFrame);
  previousPhase = initialFrame.patrol.phase;
  previousStatusKey = initialFrame.patrol.statusKey;
  previousWaypointIndex = initialFrame.patrol.waypointIndex;
  previousScreen = initialFrame.patrol.screenColor;
  previousVortexOpacity = initialFrame.vortexOpacity;
  previousChamberState = initialFrame.airShowers.map((chamber) => ({
    purging: chamber.isPurging,
    cycleBlowing: chamber.cycleBlowing,
  }));

  for (let tick = 1; tick <= SCENARIO.ticks; tick += 1) {
    clock.ms = SCENARIO.clockStartMs + tick * SCENARIO.clockMsPerTick;
    if (statusSprite) context.__clearStatusBoard(statusSprite);
    context.__step(SCENARIO.dt);
    context.__breath();
    context.__airShowerCycle();
    lastTick = tick;

    const frame = readFrame(tick);
    const phase = frame.patrol.phase;
    const statusKey = frame.patrol.statusKey;
    const statusKeyChanged = statusKey !== previousStatusKey;

    if (phase !== previousPhase) {
      pushEvent(tick, {
        type: 'patrol-phase',
        from: previousPhase,
        to: phase,
        statusKey,
        statusTextZh: frame.patrol.statusTextZh,
        statusTextEn: frame.patrol.statusTextEn,
        x: frame.actors[5].x,
        z: frame.actors[5].z,
      });
      phaseSequence.push(phase);
    }
    if (statusKeyChanged) {
      pushEvent(tick, {
        type: 'patrol-status',
        from: previousStatusKey,
        to: statusKey,
        statusTextZh: frame.patrol.statusTextZh,
        statusTextEn: frame.patrol.statusTextEn,
      });
    }
    if (frame.patrol.waypointIndex !== previousWaypointIndex) {
      pushEvent(tick, {
        type: 'waypoint-index',
        from: previousWaypointIndex,
        to: frame.patrol.waypointIndex,
        statusKey,
      });
    }
    // Frozen PATROL_WAYPOINTS sets the inspect status text on the arrival tick;
    // it is observable only through that text because the index may advance in
    // the same call.
    let arrivalIndex = null;
    for (let index = 0; index < waypoints.length; index += 1) {
      if (frame.patrol.statusTextZh.startsWith(waypoints[index].nameZh + ' (')) {
        arrivalIndex = index;
        break;
      }
    }
    if (arrivalIndex !== null) {
      if (waypointTicks[arrivalIndex].reachedTick === null) {
        waypointTicks[arrivalIndex].reachedTick = tick;
      }
      pushEvent(tick, {
        type: 'waypoint-reached',
        index: arrivalIndex,
        waypointIndex: frame.patrol.waypointIndex,
        indexAdvancedInSameCall: frame.patrol.waypointIndex !== arrivalIndex,
        stateTimer: frame.patrol.stateTimer,
        duration: waypoints[arrivalIndex].duration,
        statusTextZh: frame.patrol.statusTextZh,
        statusTextEn: frame.patrol.statusTextEn,
      });
    }
    if (statusKeyChanged && statusSprite) {
      const renderedEn = context.__renderStatusBoard(statusSprite, 'en');
      const renderedZh = context.__renderStatusBoard(statusSprite, 'zh-CN');
      context.__setLang('en');
      statusBoardSamples.push({
        tick,
        statusKey,
        statusTextZh: frame.patrol.statusTextZh,
        statusTextEn: frame.patrol.statusTextEn,
        en: renderedEn ? summarizeCanvasOps(renderedEn) : null,
        zhCn: renderedZh ? summarizeCanvasOps(renderedZh) : null,
      });
    }
    if (frame.patrol.screenColor !== previousScreen) {
      pushEvent(tick, {
        type: 'tablet-screen',
        color: frame.patrol.screenColor,
        emissive: frame.patrol.screenEmissive,
        emissiveIntensity: frame.patrol.screenEmissiveIntensity,
      });
      previousScreen = frame.patrol.screenColor;
    }
    for (let index = 0; index < frame.airShowers.length; index += 1) {
      const chamber = frame.airShowers[index];
      const before = previousChamberState[index];
      const chamberName = index === 0 ? 'main' : 'litho';
      if (chamber.isPurging !== before.purging) {
        pushEvent(tick, { type: 'air-shower-purge', chamber: chamberName, purging: chamber.isPurging });
      }
      if (!chamber.isPurging && chamber.cycleBlowing !== before.cycleBlowing) {
        pushEvent(tick, {
          type: 'air-shower-blow',
          chamber: chamberName,
          blowing: chamber.cycleBlowing,
          cycleTime: chamber.cycleTime,
        });
      }
      previousChamberState[index] = {
        purging: chamber.isPurging,
        cycleBlowing: chamber.cycleBlowing,
      };
    }
    if (frame.vortexOpacity !== previousVortexOpacity) {
      pushEvent(tick, {
        type: 'vortex-opacity',
        from: previousVortexOpacity,
        to: frame.vortexOpacity,
      });
      previousVortexOpacity = frame.vortexOpacity;
    }

    if (phase !== previousPhase && previousPhase === 'AIR_SHOWER_CYCLE' && currentPurge) {
      currentPurge.endTick = tick;
      currentPurge.ticks = tick - currentPurge.startTick;
      currentPurge.seconds = round(currentPurge.ticks * SCENARIO.dt, 6);
      currentPurge.lastStateTimer = round(previousStateTimer, 6);
      purges.push(currentPurge);
      currentPurge = null;
    }
    if (phase === 'AIR_SHOWER_CYCLE') {
      purgeTicks += 1;
      if (currentPurge === null) currentPurge = { startTick: tick, ticksInState: 0 };
      currentPurge.ticksInState += 1;
      if (purgeTicks % SCENARIO.purgeSampleEvery === 0) purgeFrames.push(readPurgeFrame(tick));
      if (purgeTicks % SCENARIO.vortexSampleEvery === 0) {
        vortexSamples.push(captureVortexSamples(vortex, tick));
      }
    }
    if (phase === 'PATROL_WAYPOINTS' && frame.patrol.waypointIndex < waypoints.length) {
      waypointTicks[frame.patrol.waypointIndex].ticks += 1;
    }
    phaseTicks[phase] = (phaseTicks[phase] || 0) + 1;

    previousPhase = phase;
    previousStatusKey = statusKey;
    previousWaypointIndex = frame.patrol.waypointIndex;
    previousStateTimer = frame.patrol.stateTimer;
    if (tick % SCENARIO.sampleEvery === 0) frames.push(frame);
  }

  const waypointTrace = waypoints.map((waypoint, index) => ({
    index,
    x: waypoint.x,
    z: waypoint.z,
    targetTool: waypoint.targetTool,
    nameZh: waypoint.nameZh,
    nameEn: waypoint.nameEn,
    duration: waypoint.duration,
    inspectAngle: waypoint.inspectAngle,
    ticks: waypointTicks[index].ticks,
    reachedTick: waypointTicks[index].reachedTick,
  }));

  return {
    mode,
    roster,
    personnelUserDataKeys: Object.keys(built.patrol.userData),
    statusBoards: {
      initialEn: statusBoards.initialEn,
      initialZh: statusBoards.initialZh,
      samples: mode === 'preserved' ? statusBoardSamples : [],
      samplesApplied: mode === 'preserved',
    },
    billboards: billboardVariants,
    vortex: { initial: vortexInitial, samples: vortexSamples },
    chambers: {
      records: chambers.records,
      spriteRedraws,
      spriteRedrawsApplied: mode === 'preserved',
      finalUserDataKeys,
      initialFrame: initialFrame.airShowers,
    },
    initialFrame,
    frames,
    purgeFrames,
    events,
    phases: {
      sequence: phaseSequence,
      ticks: phaseTicks,
      purgeTicks,
      purgeSeconds: round(purgeTicks * SCENARIO.dt, 6),
      purges,
    },
    waypointTrace,
    stats: {
      seedAfter: random.seed(),
      ticks: SCENARIO.ticks,
      dt: SCENARIO.dt,
      personnel: built.personnel.length,
      actors: initialFrame.actors.length,
      chambers: chamberObjects.length,
      vortexParticles: vortex.userData.count,
      events: events.length,
      frames: frames.length,
      purgeFrames: purgeFrames.length,
      vortexSamples: vortexSamples.length,
      statusBoardSamples: mode === 'preserved' ? statusBoardSamples.length : 0,
      phaseChanges: phaseSequence.length,
      purgeTicks,
      purgeSeconds: round(purgeTicks * SCENARIO.dt, 6),
      purges: purges.length,
      waypointsReached: waypointTrace.filter((waypoint) => waypoint.reachedTick !== null).length,
      lastTick,
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------
const humanNotes = {
  frozenSource:
    'SemiconFab/twin.html @ d76378c (twin.html sha256 pinned in docs/migration/twin-parity/source-manifest.json)',
  execution:
    'Frozen source slices are executed character-for-character inside node:vm; every emitted number is produced by original source code.',
  three:
    'THREE is a recording stub (Group/Mesh/Sprite/Points/PointLight, materials, buffer geometries/attributes, canvas textures). Positions, rotations, scales, colors, opacities and intensities are plain inspectable data; no rendering happens.',
  canvas2d:
    'The 2D context is a recording stub: the fill/stroke/roundRect/fillText/fillRect command stream is kept as data so status-board and billboard text/color output is verifiable. No pixels are rasterized.',
  document: 'document only supports createElement("canvas").',
  clock:
    'Date.now() is replaced by a declared monotonic clock: clockStartMs + tick * clockMsPerTick (16 ms per declared 0.016 s frame). The frozen page calls the behavior tree with a hard-coded 0.016 s step and samples the wall clock for flash/pulse phases; both are deterministic here.',
  random:
    'Math.random() is replaced by a declared 32-bit LCG (Math.imul(state, 1664525) + 1013904223, seed = scenario.seed). Draw order follows the frozen build: createAirlockVortexParticles (5 draws x 70 particles), then one createAirShower timer draw per chamber.',
  catalogRecords:
    'The two frozen air-shower chambers are built with createAirShower using the original dimension/amber options and positions; the catalog equipment record substituted as eqData is reduced to {id} because catalog metadata feeds no timing math.',
  operatorUserDataOverwrite:
    'Frozen buildCleanroomPersonnel overwrites operator.userData at twin.html:9525/9538, discarding the leg/arm pivots, floating status sprite and tablet screen material created by createBunnySuitOperator. As-built, the behavior tree therefore cannot animate limbs, the overhead board or the tablet screen.',
  chamberUserDataOverwrite:
    'The frozen facility builder overwrites chamber.userData at twin.html:10497/10515 with the catalog record, discarding indicators/jetStreams/innerLight/labelSprite. As-built, the behavior-tree purge and the 12 s standby cycle cannot animate air-shower materials, and the billboard sprite never refreshes.',
  preservedMode:
    'Diagnostic mode only. createBunnySuitOperator is executed once more (frozen function) and its outputs are re-attached to patrolEngineer.userData, and chamber.userData is left intact. This exposes the animation math that the frozen functions contain but the original build discards; it adds no new math. It is not original runtime behaviour.',
  inlineBlocks:
    'The two animation-loop bodies that own breathing and the 12 s air-shower standby cycle are not named functions; their frozen text was sliced from the animate() loop (lines 19127-19134 and 19137-19206) and executed verbatim inside wrapper functions.',
  extraFunction:
    'createBunnySuitOperator (9303-9476) is additionally sliced because frozen buildCleanroomPersonnel calls it; this keeps badge colors, tablet material and status-sprite construction original instead of stubbing them.',
  waypointDwellFinding:
    'Frozen PATROL_WAYPOINTS never resets stateTimer on arrival; it accumulates while walking and is only reset when the waypoint index advances. Every travel leg takes 6.7-12.6 s while inspect durations are 3.0-4.5 s, so the index advances on the arrival tick and no inspect/countdown frame is observable. waypointTrace records ticks per heading leg and the arrival tick; the arrival status text is still set (and captured) inside that same call.',
};

function buildFixture() {
  const modes = {};
  for (const mode of SCENARIO.chamberUserDataModes) modes[mode] = simulate(mode);
  const asBuilt = modes['as-built'];
  const preserved = modes.preserved;
  for (const field of ['roster', 'billboards']) {
    if (JSON.stringify(asBuilt[field]) !== JSON.stringify(preserved[field])) {
      throw new Error('Mode-dependent construction drift: ' + field);
    }
  }
  if (JSON.stringify(asBuilt.vortex.initial) !== JSON.stringify(preserved.vortex.initial)) {
    throw new Error('Mode-dependent vortex drift');
  }
  return {
    sourceSha256: hash,
    sourceFunctions: SOURCE_RANGES,
    inlineAnimationBlocks: INLINE_BLOCK_RANGES,
    stubBoundary: humanNotes,
    scenario: {
      seed: SCENARIO.seed,
      dt: SCENARIO.dt,
      clockStartMs: SCENARIO.clockStartMs,
      clockMsPerTick: SCENARIO.clockMsPerTick,
      ticks: SCENARIO.ticks,
      sampleEvery: SCENARIO.sampleEvery,
      purgeSampleEvery: SCENARIO.purgeSampleEvery,
      vortexSampleEvery: SCENARIO.vortexSampleEvery,
      purgeSeconds: SCENARIO.purgeSeconds,
      airShowerStandbySeconds: SCENARIO.airShowerStandbySeconds,
      airShowerBlowStartSeconds: SCENARIO.airShowerBlowStartSeconds,
      personnelCount: SCENARIO.personnelCount,
      vortexParticleCount: SCENARIO.vortexParticleCount,
      chamberUserDataModes: SCENARIO.chamberUserDataModes,
      airShowers: SCENARIO.airShowers,
      patrol: {
        initialState: 'APPROACH_AIRLOCK',
        initialPosition: { x: -13.0, y: 0.0, z: 8.5 },
        initialFacingAngle: -Math.PI / 2,
        initialWalkPhase: 0,
        walkSpeedApproach: 1.35,
        walkSpeedEnterAirlock: 1.1,
        walkSpeedExit: 1.3,
        walkSpeedWaypoints: 1.35,
        walkSpeedReturn: 1.4,
        waypoints: asBuilt.waypointTrace.map((waypoint) => ({
          x: waypoint.x,
          z: waypoint.z,
          targetTool: waypoint.targetTool,
          nameZh: waypoint.nameZh,
          nameEn: waypoint.nameEn,
          duration: waypoint.duration,
          inspectAngle: waypoint.inspectAngle,
        })),
      },
    },
    personnel: asBuilt.roster,
    statusBoards: {
      initialEn: asBuilt.statusBoards.initialEn,
      initialZh: asBuilt.statusBoards.initialZh,
      asBuiltSamplesApplied: asBuilt.statusBoards.samplesApplied,
      preservedSamplesApplied: preserved.statusBoards.samplesApplied,
    },
    airShowerBillboards: asBuilt.billboards,
    airShowerChambers: {
      records: asBuilt.chambers.records,
      preservedSpriteRedraws: preserved.chambers.spriteRedraws,
      asBuiltSpriteRedraws: asBuilt.chambers.spriteRedraws,
      userDataKeys: {
        'as-built': asBuilt.chambers.finalUserDataKeys,
        preserved: preserved.chambers.finalUserDataKeys,
      },
      personnelUserDataKeys: {
        'as-built': asBuilt.personnelUserDataKeys,
        preserved: preserved.personnelUserDataKeys,
      },
    },
    vortex: { initial: asBuilt.vortex.initial },
    modes: {
      'as-built': {
        initialFrame: asBuilt.initialFrame,
        frames: asBuilt.frames,
        purgeFrames: asBuilt.purgeFrames,
        events: asBuilt.events,
        phases: asBuilt.phases,
        waypointTrace: asBuilt.waypointTrace,
        statusBoardSamples: asBuilt.statusBoards.samples,
        vortexSamples: asBuilt.vortex.samples,
        stats: asBuilt.stats,
      },
      preserved: {
        initialFrame: preserved.initialFrame,
        frames: preserved.frames,
        purgeFrames: preserved.purgeFrames,
        events: preserved.events,
        phases: preserved.phases,
        waypointTrace: preserved.waypointTrace,
        statusBoardSamples: preserved.statusBoards.samples,
        vortexSamples: preserved.vortex.samples,
        stats: preserved.stats,
      },
    },
  };
}

const fixture = buildFixture();
const json = JSON.stringify(fixture) + '\n';
const destination = path.join(root, 'web_app/tests/fixtures/original-personnel-vectors.json');

if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== json) throw new Error('Personnel vectors drift');
  console.log(
    'Personnel vectors stable: ' +
      fixture.personnel.length +
      ' personnel, ' +
      Object.keys(fixture.modes['as-built'].phases.ticks).length +
      ' phases, ' +
      fixture.modes['as-built'].events.length +
      ' as-built events, ' +
      fixture.modes.preserved.events.length +
      ' preserved events, ' +
      fixture.modes['as-built'].frames.length +
      ' as-built frames, ' +
      fixture.modes.preserved.frames.length +
      ' preserved frames',
  );
} else {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, json);
  console.log(
    'Original personnel vectors: ' +
      fixture.personnel.length +
      ' personnel, ' +
      fixture.modes['as-built'].frames.length +
      ' as-built frames, ' +
      fixture.modes.preserved.frames.length +
      ' preserved frames, ' +
      fixture.modes['as-built'].events.length +
      ' as-built events, ' +
      fixture.modes.preserved.events.length +
      ' preserved events, ' +
      'vortex ' +
      fixture.vortex.initial.count +
      ' particles',
  );
}
