#!/usr/bin/env node
// The TacitGasRelay deploy kit: its init code (the compiled contract + its target list), the CreateX CREATE2 salt that gives it a vanity address
// (leading zero bytes, mined with tools/vanity-create2), and the address that salt gives. Written to dapp/admin/gas-relay/kit.json, which the admin page
// there sends from the owner's wallet. The address commits to the exact init code, so only this code can land there, and only on this chain.
//
//   cd contracts && forge build            (the bytecode: solc 0.8.37, via_ir, runs 1, no metadata hash)
//   node tools/gas-relay-kit.mjs [--zeros 4] [--salt 0x..] [--deployer 0x..] [--chain-id 1] [--targets 0x..,0x..] [--remine]
// CREATE3: the address comes from the salt alone, not the code, so a code nit changes nothing: the kit reuses the salt in kit.json (--remine mines
// a new one). The salt is bound to --deployer (CreateX's permissioned form), so only that wallet can deploy to it.
// The targets are the only contracts an order's call may go to (zRouter and the pools' routers on Ethereum); fixed at deployment.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { encodeAbiParameters, keccak256 } = require('viem');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const chainId = Number(arg('--chain-id', '1')), zeros = arg('--zeros', '4');
const DEPLOYER = arg('--deployer', '0x1C0Aa8cCD568d90d61659F060D1bFb1e6f855A20');   // the wallet that deployed ProofMarket
const TARGETS = ['0x000000000000FB114709235f1ccBFfb925F600e4',   // zRouter
  '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5',   // ETH pool router
  '0x000000fA029Eaf69840C1490Bf9AA6C094794D5a',   // TAC pool router
  '0x000000e96fcFf90F220fa65F8b82C6114Cd1Cc30',   // TACD pool router
  '0x000000e66C32bEC739180A5eDeeB40A8225c5223',   // TACE pool router
  '0xe77D82b9A7B686ADc5F31F4cb83286981AC55FE4',   // USDC pool router
  '0x5650c850872bc89FC6E22CBB7a51b0e0DAC97198',   // USDT pool router
  '0x000000005dA3E3B73726af3c774Deeb9472D4992'];  // ConfidentialRouter (the Bitcoin-backed pool)
const targets = arg('--targets', null)?.split(',') || TARGETS;
const FACTORY = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
const art = join(ROOT, 'contracts/out/TacitGasRelay.sol/TacitGasRelay.json');
if (!existsSync(art)) { console.error('no artifact: run `forge build` in contracts/ first'); process.exit(1); }
const j = JSON.parse(readFileSync(art, 'utf8'));
const initCode = j.bytecode.object + encodeAbiParameters([{ type: 'address[]' }], [targets]).slice(2);   // ownerless, immutable; the only constructor argument is the target list
const initHash = keccak256(initCode);
const miner = join(ROOT, 'tools/vanity-create2/target/release/vanity-create2');
if (!existsSync(miner)) { console.error('build the miner: cargo build --release in tools/vanity-create2'); process.exit(1); }
const common = ['--create3', '--deployer', DEPLOYER, '--factory', FACTORY, '--chain-id', String(chainId)];
const KIT = join(ROOT, 'dapp/admin/gas-relay/kit.json');
const old = !process.argv.includes('--remine') && existsSync(KIT) ? JSON.parse(readFileSync(KIT, 'utf8')) : null;
let salt = arg('--salt', old?.deployer?.toLowerCase() === DEPLOYER.toLowerCase() ? old.salt : null), expected;
if (salt) expected = spawnSync(miner, ['address', ...common, '--salt', salt], { encoding: 'utf8' }).stdout.trim();
else { const r = spawnSync(miner, ['mine', ...common, '--zeros', zeros, '--tag', 'TacitGasRelay'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }); ({ salt, address: expected } = JSON.parse(r.stdout)); }
const kit = {
  name: 'TacitGasRelay', chainId, deployer: DEPLOYER, create3: true, orderTypehash: keccak256(new TextEncoder().encode('Order(address payer,address tokenIn,uint256 amountIn,address feeToken,uint256 fee,address tokenOut,uint256 minOut,address recipient,address target,bytes32 dataHash,uint64 deadline,uint256 nonce)')), factory: FACTORY, salt, expected, initHash, initCode,
  args: { targets },
  build: { solc: '0.8.37', viaIR: true, optimizerRuns: 1, source: 'contracts/src/TacitGasRelay.sol', sourceSha256: createHash('sha256').update(readFileSync(join(ROOT, 'contracts/src/TacitGasRelay.sol'))).digest('hex') },
  rpc: ['https://mainnet.gateway.tenderly.co', 'https://ethereum-rpc.publicnode.com'],
};
writeFileSync(KIT, JSON.stringify(kit, null, 1) + '\n');
console.log(`TacitGasRelay → ${expected}\n  salt ${salt}\n  init hash ${initHash} (${(initCode.length - 2) / 2} bytes)\n  written to dapp/admin/gas-relay/kit.json`);
