// Builds dapp/kit/tacit-address-kit.js (entry-tacit-address-kit.mjs) as one ES module with no imports, and prints its
// SHA-256, which integrators pin. --check rebuilds in memory and fails if the committed file differs.
//   node build/build-tacit-address-kit.mjs [--check]

import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'dapp/kit/tacit-address-kit.js');
const CHECK = process.argv.includes('--check');

// The site's prebuilt vendor bundles resolve to their sources, so what the kit does not use drops out. Poseidon stays:
// the pool module builds its hashes when it loads, though addresses never use them.
const width = (ns) => ns.map((n) => `export { poseidon${n} } from 'poseidon-lite/poseidon${n}';`).join('\n');
const VENDOR = {
  deps: readFileSync(join(HERE, 'entry.mjs'), 'utf8').replace(/^export \{[^}]*\} from 'poseidon-lite';$/m, width([1, 2, 3])),
  poseidon: width([2, 3, 4, 5, 7]),
};
const siteVendor = {
  name: 'site-vendor',
  setup(b) {
    b.onResolve({ filter: /vendor\/tacit-(deps|poseidon)\.min\.js$/ }, (a) => ({ path: a.path.match(/tacit-(\w+)\.min/)[1], namespace: 'site-vendor' }));
    b.onLoad({ filter: /.*/, namespace: 'site-vendor' }, (a) => ({ contents: VENDOR[a.path], loader: 'js', resolveDir: HERE }));
  },
};
const r = await build({
  entryPoints: [join(HERE, 'entry-tacit-address-kit.mjs')], bundle: true, minify: true, format: 'esm', target: 'es2020', platform: 'browser',
  legalComments: 'inline', nodePaths: [join(HERE, 'node_modules')], logLevel: 'warning', write: false, plugins: [siteVendor],
});
const out = Buffer.from(r.outputFiles[0].contents);
if (/\bimport\s*\(|^\s*import\s|\bfrom\s*["']/m.test(out.toString().replace(/"(?:[^"\\]|\\.)*"/g, '""'))) throw new Error('the kit still has an import');
const sha = createHash('sha256').update(out).digest('hex');
if (CHECK) {
  const have = existsSync(OUT) ? readFileSync(OUT) : null;
  if (!have || !have.equals(out)) { console.error(`✗ ${OUT} is stale: run node build/build-tacit-address-kit.mjs and commit it`); process.exit(1); }
  console.log(`• tacit-address-kit.js current: sha256 ${sha}`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out);
  console.log(`${OUT}\n  ${out.length} bytes  sha256 ${sha}`);
}
