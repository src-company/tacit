// Builds dapp/evm-pool/tacit-evm-pool-wallet.js: the standalone private-ETH wallet (entry-evm-pool-wallet.mjs) as
// one ES module with no imports. The prove worker (entry-evm-pool-worker.mjs, snarkjs included) is bundled first
// and inlined as a string, so the wallet starts it from a Blob. Prints the output's SHA-256.
//   node build/build-evm-pool-wallet.mjs

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'dapp/evm-pool/tacit-evm-pool-wallet.js');
const snarkjsVersion = JSON.parse(readFileSync(join(HERE, 'node_modules/snarkjs/package.json'), 'utf8')).version;
if (snarkjsVersion !== '0.7.6') throw new Error(`snarkjs ${snarkjsVersion}, expected 0.7.6`);

// The site's prebuilt vendor files resolve to their sources, so unused code drops out: the deps and Poseidon
// bundles to the same packages (Poseidon one width at a time, since poseidon-lite's index loads every width), and
// the lazily imported snarkjs bundle to a stub, since the worker always passes snarkjs in.
const width = (ns) => ns.map((n) => `export { poseidon${n} } from 'poseidon-lite/poseidon${n}';`).join('\n');
const VENDOR = {
  deps: readFileSync(join(HERE, 'entry.mjs'), 'utf8').replace(/^export \{[^}]*\} from 'poseidon-lite';$/m, width([1, 2, 3])),
  poseidon: width([2, 3, 4, 5, 7]),
  mixer: 'export const snarkjs = null;',
};
if (/from 'poseidon-lite'/.test(VENDOR.deps)) throw new Error('build/entry.mjs still imports the poseidon-lite index');
const siteVendor = {
  name: 'site-vendor',
  setup(b) {
    b.onResolve({ filter: /vendor\/tacit-(deps|poseidon|mixer)\.min\.js$/ }, (a) => ({ path: a.path.match(/tacit-(\w+)\.min/)[1], namespace: 'site-vendor' }));
    b.onLoad({ filter: /.*/, namespace: 'site-vendor' }, (a) => ({ contents: VENDOR[a.path], loader: 'js', resolveDir: HERE }));
  },
};
const common = { bundle: true, minify: true, target: 'es2020', platform: 'browser', legalComments: 'inline', nodePaths: [join(HERE, 'node_modules')], logLevel: 'warning' };

const worker = await build({
  ...common, entryPoints: [join(HERE, 'entry-evm-pool-worker.mjs')], format: 'iife', write: false, plugins: [siteVendor],
});
const workerSrc = worker.outputFiles[0].text;

await build({
  ...common, entryPoints: [join(HERE, 'entry-evm-pool-wallet.mjs')], format: 'esm', outfile: OUT,
  plugins: [siteVendor, {
    name: 'worker-source',
    setup(b) {
      b.onResolve({ filter: /^evm-pool-worker-source$/ }, () => ({ path: 'worker', namespace: 'worker-source' }));
      b.onLoad({ filter: /.*/, namespace: 'worker-source' }, () => ({ contents: `export default ${JSON.stringify(workerSrc)};`, loader: 'js' }));
    },
  }],
});

const out = readFileSync(OUT);
if (/\bimport\s*\(|^\s*import\s|\bfrom\s*["']/m.test(out.toString().replace(/"(?:[^"\\]|\\.)*"/g, '""'))) console.warn('warning: the bundle still has an import');
console.log(`${OUT}\n  ${out.length} bytes  sha256 ${createHash('sha256').update(out).digest('hex')}  (snarkjs ${snarkjsVersion})`);
