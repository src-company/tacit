// Builds dapp/vendor/tacit-walletconnect.min.js from entry-walletconnect.mjs as one ES module with no imports. The
// provider's own modal (@reown/appkit) is left out: the page draws the pairing QR itself, so the modal's code, fonts
// and wallet images never load. Prints the output's SHA-384. With --verify it writes nothing: it rebuilds from the pinned
// packages and fails unless the result is byte for byte the committed bundle.
//   node build/build-walletconnect.mjs [--verify]

import { build } from 'esbuild';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(resolve(HERE, '..'), 'dapp/vendor/tacit-walletconnect.min.js');
const verify = process.argv.includes('--verify');
const scratch = verify ? mkdtempSync(join(tmpdir(), 'tacit-wc-')) : null;
const OUT = verify ? join(scratch, 'tacit-walletconnect.min.js') : BUNDLE;
const PINNED = { '@walletconnect/ethereum-provider': '2.24.0', 'qrcode-generator': '2.0.4' };
for (const [name, want] of Object.entries(PINNED)) {
  const got = JSON.parse(readFileSync(join(HERE, 'node_modules', name, 'package.json'), 'utf8')).version;
  if (got !== want) throw new Error(`${name} ${got}, expected ${want}`);
}

// Asked for only when the provider is told to show its modal, which this page never does.
const noModal = {
  name: 'no-modal',
  setup(b) {
    b.onResolve({ filter: /^@reown\/appkit/ }, (a) => ({ path: a.path, namespace: 'no-modal' }));
    b.onLoad({ filter: /.*/, namespace: 'no-modal' }, () => ({ contents: "export function createAppKit() { throw new Error('WalletConnect runs here without its modal'); }", loader: 'js' }));
  },
};

await build({
  entryPoints: [join(HERE, 'entry-walletconnect.mjs')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'inline',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  plugins: [noModal],
  outfile: OUT,
  logLevel: 'warning',
});
const out = readFileSync(OUT), sha = (b) => 'sha384-' + createHash('sha384').update(b).digest('base64');
if (verify) {
  const committed = readFileSync(BUNDLE);
  rmSync(scratch, { recursive: true, force: true });
  if (!out.equals(committed)) { console.error(`✗ ${BUNDLE} is not what the pinned packages build: ${sha(committed)}, built ${sha(out)}`); process.exit(1); }
  console.log(`• ${BUNDLE} verified: ${sha(out)}`);
} else console.log(`${OUT}\n  ${out.length.toLocaleString()} bytes · ${sha(out)}`);
