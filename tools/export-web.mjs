// Builds the drop-in web element and copies the baked card next to it:
//
//   node tools/export-web.mjs <target-dir> [assets-subdir]
//
// writes <target-dir>/wallet-card.js and <target-dir>/<assets-subdir>/ (default assets/wallet/):
// image.png, regions.png, shadow.png, card.json, params.json. Run node tools/bake.mjs first.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const target = process.argv[2];
if (!target) throw new Error('usage: node tools/export-web.mjs <target-dir> [assets-subdir]');
const sub = process.argv[3] || 'assets/wallet';
const read = p => readFileSync(join(root, p), 'utf8');

const js = read('web/wallet-card.src.js')
  .replace('__VERT__', JSON.stringify(read('shaders/wallet.vert')))
  .replace('__FRAG__', JSON.stringify(read('shaders/wallet.frag')))
  .replace('__SHADOW_FRAG__', JSON.stringify(read('shaders/shadow.frag')));
writeFileSync(join(target, 'wallet-card.js'), js);

const out = resolve(target, sub);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['image.png', 'regions.png', 'shadow.png', 'height.png', 'card.json', 'params.json'])
  if (existsSync(join(root, 'assets', f))) copyFileSync(join(root, 'assets', f), join(out, f));
console.log(`wrote ${join(target, 'wallet-card.js')} (${(js.length / 1024).toFixed(1)} KB) and ${out}/`);
