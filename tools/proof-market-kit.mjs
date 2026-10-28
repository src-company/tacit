#!/usr/bin/env node
// The ProofMarket deploy kit: its init code (the compiled contract + its constructor arguments), the CreateX CREATE2 salt that gives it a vanity address
// (leading zero bytes, mined with tools/vanity-create2), and the address that salt gives. Written to dapp/admin/proof-market/kit.json, which the admin page
// there sends from the owner's wallet. The address commits to the exact init code, so only this code can land there, and only on this chain.
//
//   cd contracts && forge build            (the bytecode: solc 0.8.37, via_ir, runs 1, no metadata hash)
//   node tools/proof-market-kit.mjs [--zeros 4] [--salt 0x..] [--pool 0x..] [--tac 0x..] [--window 60] [--owner 0x..] [--treasury 0x..] [--chain-id 1]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { encodeAbiParameters, keccak256 } = require('viem');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const FACTORY = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
const pool = arg('--pool', '0x000000000Ed1eabD231Be41d93b719056F7febFC'), tac = arg('--tac', '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279');
const claimWindow = BigInt(arg('--window', '60')), chainId = Number(arg('--chain-id', '1')), zeros = arg('--zeros', '4');
const OPS = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';   // the ops multisig: owns the bond setting, receives forfeited bonds
const owner = arg('--owner', OPS), treasury = arg('--treasury', OPS);
const art = join(ROOT, 'contracts/out/ProofMarket.sol/ProofMarket.json');
if (!existsSync(art)) { console.error('no artifact: run `forge build` in contracts/ first'); process.exit(1); }
const j = JSON.parse(readFileSync(art, 'utf8'));
const initCode = j.bytecode.object + encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint64' }, { type: 'address' }, { type: 'address' }], [pool, tac, claimWindow, owner, treasury]).slice(2);
const initHash = keccak256(initCode);
const miner = join(ROOT, 'tools/vanity-create2/target/release/vanity-create2');
if (!existsSync(miner)) { console.error('build the miner: cargo build --release in tools/vanity-create2'); process.exit(1); }
const common = ['--factory', FACTORY, '--init-hash', initHash, '--chain-id', String(chainId)];
let salt = arg('--salt', null), expected;
if (salt) expected = spawnSync(miner, ['address', ...common, '--salt', salt], { encoding: 'utf8' }).stdout.trim();
else { const r = spawnSync(miner, ['mine', ...common, '--zeros', zeros, '--tag', 'ProofMarket'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }); ({ salt, address: expected } = JSON.parse(r.stdout)); }
const kit = {
  name: 'ProofMarket', chainId, factory: FACTORY, salt, expected, initHash, initCode,
  args: { pool, tac, claimWindow: String(claimWindow), owner, treasury },
  build: { solc: '0.8.37', viaIR: true, optimizerRuns: 1, source: 'contracts/src/ProofMarket.sol', sourceSha256: createHash('sha256').update(readFileSync(join(ROOT, 'contracts/src/ProofMarket.sol'))).digest('hex') },
  rpc: ['https://mainnet.gateway.tenderly.co', 'https://ethereum-rpc.publicnode.com'],
};
writeFileSync(join(ROOT, 'dapp/admin/proof-market/kit.json'), JSON.stringify(kit, null, 1) + '\n');
console.log(`ProofMarket → ${expected}\n  salt ${salt}\n  init hash ${initHash} (${(initCode.length - 2) / 2} bytes)\n  written to dapp/admin/proof-market/kit.json`);
