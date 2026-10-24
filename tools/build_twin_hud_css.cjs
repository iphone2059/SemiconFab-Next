// Offline conversion only; the application never loads a Tailwind CDN/runtime.
const fs = require('node:fs');
const path = require('node:path');
const postcss = require(path.resolve('.local/parity-tools/node_modules/postcss'));
const input = JSON.parse(fs.readFileSync(process.argv[2] ?? '.local/original-style-blocks.json', 'utf8'));
const root = postcss.parse(input.map(block => block.css).join('\n'));
root.walkRules(rule => {
  if (rule.parent.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
  rule.selectors = rule.selectors.map(selector => {
    const value = selector.trim().replace(/^(?:html|body|:root)(?=[\s.#[:]|$)/, '.twin-page');
    if (value.startsWith('.twin-page')) return value;
    return `.twin-page ${value}`;
  });
});
const output = process.argv[3] ?? 'web_app/assets/original-twin-hud.css';
fs.writeFileSync(output, '/* Frozen original HUD CSS, scoped to .twin-page. Source b3666132.\n * Original styles: PolyForm Noncommercial. Generated utilities: Tailwind MIT.\n * Offline source conversion; no Tailwind runtime/CDN is shipped. */\n' + root.toString() + '\n');
console.log(`Scoped original HUD CSS: ${output}`);
