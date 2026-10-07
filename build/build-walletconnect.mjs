// Builds dapp/vendor/tacit-walletconnect.min.js from entry-walletconnect.mjs as one ES module with no imports. The
// provider's own modal (@reown/appkit) is left out: the page draws the pairing QR itself, so the modal's code, fonts
// and wallet images never load. Prints the output's SHA-384.
//   node build/build-walletconnect.mjs

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(resolve(HERE, '..'), 'dapp/vendor/tacit-walletconnect.min.js');
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
const out = readFileSync(OUT);
console.log(`${OUT}\n  ${out.length.toLocaleString()} bytes · sha384-${createHash('sha384').update(out).digest('base64')}`);
