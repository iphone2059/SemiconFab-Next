// Offline conversion only; the application never loads a Tailwind CDN/runtime.
//
// The style blocks are local (gitignored) parity inputs extracted from the frozen original HUD;
// web_app/assets/original-twin-hud.css is the committed generated artifact.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let postcss;
try {
  postcss = require(path.join(root, '.local/parity-tools/node_modules/postcss'));
} catch {
  console.error('HUD CSS conversion needs the local parity toolchain (gitignored): .local/parity-tools/node_modules/postcss');
  process.exit(2);
}

// The frozen HUD is mounted inside <div class="original-hud"> under the twin page, so every
// original selector is re-scoped to that container instead of the whole page.
const SCOPE = '.twin-page .original-hud';
const args = process.argv.slice(2);
const check = args.includes('--check');
const positional = args.filter(argument => argument !== '--check');
if (positional.length > 2) {
  console.error('usage: node tools/build_twin_hud_css.cjs [--check] [input-blocks.json] [output.css]');
  process.exit(2);
}
const inputPath = path.resolve(root, positional[0] ?? '.local/original-style-blocks.json');
const outputPath = path.resolve(root, positional[1] ?? 'web_app/assets/original-twin-hud.css');
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const parsed = postcss.parse(input.map(block => block.css).join('\n'));
parsed.walkRules(rule => {
  if (rule.parent.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
  rule.selectors = rule.selectors.map(selector => {
    const value = selector.trim().replace(/^(?:html|body|:root)(?![a-z0-9_-])/i, SCOPE);
    return value.startsWith(SCOPE) ? value : SCOPE + ' ' + value;
  });
});
const content = '/* Frozen original HUD CSS, scoped to .twin-page .original-hud. Source b3666132.\n * Original styles: PolyForm Noncommercial. Generated utilities: Tailwind MIT.\n * Offline source conversion; no Tailwind runtime/CDN is shipped. */\n' + parsed.toString() + '\n';

if (check) {
  let existing;
  try {
    existing = fs.readFileSync(outputPath, 'utf8');
  } catch {
    console.error('HUD CSS is missing: ' + path.relative(root, outputPath) + '; regenerate with: node tools/build_twin_hud_css.cjs');
    process.exit(1);
  }
  if (existing !== content) {
    console.error('HUD CSS is stale: ' + path.relative(root, outputPath) + '; regenerate with: node tools/build_twin_hud_css.cjs');
    process.exit(1);
  }
  console.log('HUD CSS is up to date: ' + path.relative(root, outputPath));
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content);
  console.log('Scoped original HUD CSS: ' + path.relative(root, outputPath));
}
