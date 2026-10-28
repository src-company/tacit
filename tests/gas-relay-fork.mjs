#!/usr/bin/env node
// TacitGasRelay on a mainnet fork with the LIVE zRouter, LIVE TAC and a LIVE KyberSwap route: a wallet that holds only TAC (no ETH) pays a
// relayer in TAC and receives USDC (one order) and ETH (another), the swap running as zRouter.snwap through KyberSwap's forwarder.
//   node tests/gas-relay-fork.mjs     (FORK=<rpc url>; needs anvil, `forge build` in contracts/, network for the KyberSwap quote)
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const ROOT = new URL('../', import.meta.url).pathname;
if (spawnSync('anvil', ['--version']).status !== 0) { console.log('skip - needs anvil'); process.exit(0); }
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, encodeAbiParameters, keccak256, concat, toHex, pad, encodeDeployData } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { mainnet } = require('viem/chains');
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', PORT = 26000 + Math.floor(Math.random() * 500), RPC = `http://127.0.0.1:${PORT}`;
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ETH = '0x0000000000000000000000000000000000000000';
const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', KYBER_FWD = '0x087735d470fd040661d8c48935e2d665ea682fc5';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const pub = createPublicClient({ chain: mainnet, transport: http(RPC) });
const rpc = (method, params) => pub.request({ method, params });
for (let i = 0; ; i++) { try { await pub.getBlockNumber(); break; } catch { if (i > 150) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 200)); } }
const erc = parseAbi(['function balanceOf(address) view returns (uint256)', 'function nonces(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
const bal = (t, a) => t === ETH ? pub.getBalance({ address: a }) : pub.readContract({ address: t, abi: erc, functionName: 'balanceOf', args: [a] });

// a wallet with TAC and no ETH: the ops multisig (a large holder, impersonated) sends it 2000 TAC
const payer = privateKeyToAccount('0x' + 'a1b2c3d4'.repeat(8)), relayer = privateKeyToAccount('0x' + 'b2c3d4e5'.repeat(8)), deployer = privateKeyToAccount('0x' + 'c3d4e5f6'.repeat(8));
const HOLD = 2000n * 10n ** 18n, HOLDER = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
await rpc('anvil_impersonateAccount', [HOLDER]); await rpc('anvil_setBalance', [HOLDER, '0x' + (10n ** 18n).toString(16)]);
await rpc('eth_sendTransaction', [{ from: HOLDER, to: TAC, data: encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [payer.address, HOLD] }) }]);
await new Promise((r) => setTimeout(r, 500));
ok((await bal(TAC, payer.address)) === HOLD, 'the wallet holds 2000 TAC and no ETH (' + (await bal(ETH, payer.address)) + ' wei)');
for (const a of [relayer, deployer]) await rpc('anvil_setBalance', [a.address, '0x' + (10n ** 20n).toString(16)]);

const art = JSON.parse(readFileSync(ROOT + 'contracts/out/TacitGasRelay.sol/TacitGasRelay.json', 'utf8'));
const TARGETS = [ZROUTER];
const wDeployer = createWalletClient({ account: deployer, chain: mainnet, transport: http(RPC) });
const dep = await wDeployer.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [TARGETS] });
const RELAY = (await pub.waitForTransactionReceipt({ hash: dep })).contractAddress;
ok(!!RELAY, 'TacitGasRelay deployed at ' + RELAY);

const route = async (out) => {
  const amountIn = 100n * 10n ** 18n, tokenOut = out === ETH ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : out;
  const r = await (await fetch(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=${TAC}&tokenOut=${tokenOut}&amountIn=${amountIn}`)).json();
  const b = await (await fetch('https://aggregator-api.kyberswap.com/ethereum/api/v1/route/build', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routeSummary: r.data.routeSummary, sender: KYBER_FWD, recipient: KYBER_FWD, slippageTolerance: Number(process.env.SLIP || 300), deadline: Math.floor(Date.now() / 1000) + 600 }) })).json();
  return { amountIn, router: b.data.routerAddress, data: b.data.data, out: BigInt(b.data.amountOut) };
};
// zRouter.snwap(tokenIn, amountIn, to, tokenOut, minOut, executor, executorData) with the solver's call inside, as dapp/swap/solvers.js snwapCall builds it
const word = (v) => BigInt(v).toString(16).padStart(64, '0'), addr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const bytes = (h) => { const s = h.replace(/^0x/, ''); return word(s.length / 2) + s.padEnd(Math.ceil(s.length / 64) * 64, '0'); };
const snwap = ({ tokenIn, tokenOut, amountIn, to, minOut, fwd, router, data }) => {
  const inner = '54d61b9c' + addr(router) + addr(tokenIn) + addr(tokenOut) + addr(to) + word(5 * 32) + bytes(data);
  return '0x5f3bd1c8' + addr(tokenIn) + word(amountIn) + addr(to) + addr(tokenOut) + word(minOut) + addr(fwd) + word(7 * 32) + bytes(inner);
};

const ORDER = [['payer', 'address'], ['tokenIn', 'address'], ['amountIn', 'uint256'], ['feeToken', 'address'], ['fee', 'uint256'], ['tokenOut', 'address'], ['minOut', 'uint256'], ['recipient', 'address'], ['target', 'address'], ['dataHash', 'bytes32'], ['deadline', 'uint64'], ['nonce', 'uint256']].map(([name, type]) => ({ name, type }));
const recipient = '0x00000000000000000000000000000000000c0ffe';
const run = async (out, nonce, feeInInput) => {
  const rt = await route(out), fee = 3n * 10n ** 18n;
  const minOut = rt.out * 98n / 100n;
  // the swap pays the relay (so the relay forwards it, and a native-ETH output is received by it)
  const data = snwap({ tokenIn: TAC, tokenOut: out, amountIn: rt.amountIn, to: RELAY, minOut, fwd: KYBER_FWD, router: rt.router, data: rt.data });
  const order = { payer: payer.address, tokenIn: TAC, amountIn: rt.amountIn, feeToken: TAC, fee, tokenOut: out, minOut, recipient, target: ZROUTER, dataHash: keccak256(data), deadline: BigInt(Math.floor(Date.now() / 1000) + 600), nonce: BigInt(nonce) };
  const signature = await payer.signTypedData({ domain: { name: 'TacitGasRelay', version: '1', chainId: 1, verifyingContract: RELAY }, types: { Order: ORDER }, primaryType: 'Order', message: order });
  if (process.env.DEBUG) { const { hashTypedData } = require('viem'); console.log('viem', hashTypedData({ domain: { name: 'TacitGasRelay', version: '1', chainId: 1, verifyingContract: RELAY }, types: { Order: ORDER }, primaryType: 'Order', message: order }), 'contract', await pub.readContract({ address: RELAY, abi: art.abi, functionName: 'orderHash', args: [order] }), 'signer', payer.address); }
  // one TAC permit for the input and the fee together (the fee is in the input token)
  const value = rt.amountIn + fee, deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const pn = await pub.readContract({ address: TAC, abi: erc, functionName: 'nonces', args: [payer.address] });
  const ps = await payer.signTypedData({ domain: { name: 'Tacit Token', version: '1', chainId: 1, verifyingContract: TAC }, types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, primaryType: 'Permit', message: { owner: payer.address, spender: RELAY, value, nonce: pn, deadline } });
  const v = parseInt(ps.slice(130, 132), 16), r = '0x' + ps.slice(2, 66), s = '0x' + ps.slice(66, 130);
  const permit = { value, deadline, v, r, s }, none = { value: 0n, deadline: 0n, v: 0, r: pad('0x'), s: pad('0x') };
  const p2 = { use: false, batch: { details: [], spender: ETH, sigDeadline: 0n }, sig: '0x' };
  const before = { tac: await bal(TAC, relayer.address), out: await bal(out, recipient), payerEth: await bal(ETH, payer.address), payerTac: await bal(TAC, payer.address) };
  if (process.env.DEBUG) { const { recoverTypedDataAddress } = require('viem'); console.log('local recover', await recoverTypedDataAddress({ domain: { name: 'TacitGasRelay', version: '1', chainId: 1, verifyingContract: RELAY }, types: { Order: ORDER }, primaryType: 'Order', message: order, signature }), 'sig len', (signature.length - 2) / 2); }
  if (process.env.DEBUG) {
    const cd = encodeFunctionData({ abi: art.abi, functionName: 'execute', args: [order, signature, data, permit, none, p2] });
    const t = await rpc('debug_traceCall', [{ from: relayer.address, to: RELAY, data: cd }, 'latest', { tracer: 'callTracer' }]);
    const walk = (c, d = 0) => { console.log('TRACE', ' '.repeat(d), c.type, c.to, (c.input || '').slice(0, 10), c.error || '', (c.output || '').slice(0, 10)); for (const x of c.calls || []) walk(x, d + 1); };
    walk(t);
  }
  const w = createWalletClient({ account: relayer, chain: mainnet, transport: http(RPC) });
  const hash = await w.writeContract({ address: RELAY, abi: art.abi, functionName: 'execute', args: [order, signature, data, permit, none, p2] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  ok(rc.status === 'success', `100 TAC → ${out === ETH ? 'ETH' : 'USDC'} through zRouter.snwap and KyberSwap, the relayer sent it (gas ${rc.gasUsed})`);
  const got = (await bal(out, recipient)) - before.out;
  ok(got >= minOut, `the recipient received ${out === ETH ? Number(got) / 1e18 + ' ETH' : Number(got) / 1e6 + ' USDC'} (floor ${out === ETH ? Number(minOut) / 1e18 : Number(minOut) / 1e6})`);
  ok((await bal(TAC, relayer.address)) - before.tac === fee, 'the relayer was paid the fee in TAC: ' + Number(fee) / 1e18);
  ok(before.payerTac - (await bal(TAC, payer.address)) === rt.amountIn + fee && (await bal(ETH, payer.address)) === 0n, 'the wallet paid only TAC (input + fee) and still holds no ETH');
  ok((await bal(TAC, RELAY)) === 0n && (await bal(out, RELAY)) === 0n && (await pub.readContract({ address: TAC, abi: erc, functionName: 'allowance', args: [RELAY, ZROUTER] })) === 0n, 'the relay holds nothing and no approval is left');
};
// the first order's input and fee ride one permit, so the second needs a fresh one (the permit sets the allowance)
await run(USDC, 1);
await run(ETH, 2);
// Permit2: WETH has no ERC-2612. The wallet approved Permit2 once (before it had no ETH); one Permit2 batch signature then covers the input and the fee.
{
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3', amountIn = 10n ** 17n, fee = 10n ** 15n;
  await rpc('anvil_setBalance', [payer.address, '0x' + (10n ** 18n).toString(16)]);
  const wp = createWalletClient({ account: payer, chain: mainnet, transport: http(RPC) });
  await pub.waitForTransactionReceipt({ hash: await wp.sendTransaction({ to: WETH, value: 2n * 10n ** 17n, data: '0xd0e30db0' }) });
  await pub.waitForTransactionReceipt({ hash: await wp.writeContract({ address: WETH, abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: [PERMIT2, 2n ** 256n - 1n] }) });
  await rpc('anvil_setBalance', [payer.address, '0x0']);
  const r = await (await fetch(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=${WETH}&tokenOut=${USDC}&amountIn=${amountIn}`)).json();
  const b = await (await fetch('https://aggregator-api.kyberswap.com/ethereum/api/v1/route/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routeSummary: r.data.routeSummary, sender: KYBER_FWD, recipient: KYBER_FWD, slippageTolerance: 300, deadline: Math.floor(Date.now() / 1000) + 600 }) })).json();
  const minOut = BigInt(b.data.amountOut) * 97n / 100n;
  const data = snwap({ tokenIn: WETH, tokenOut: USDC, amountIn, to: RELAY, minOut, fwd: KYBER_FWD, router: b.data.routerAddress, data: b.data.data });
  const order = { payer: payer.address, tokenIn: WETH, amountIn, feeToken: WETH, fee, tokenOut: USDC, minOut, recipient, target: ZROUTER, dataHash: keccak256(data), deadline: BigInt(Math.floor(Date.now() / 1000) + 600), nonce: 3n };
  const signature = await payer.signTypedData({ domain: { name: 'TacitGasRelay', version: '1', chainId: 1, verifyingContract: RELAY }, types: { Order: ORDER }, primaryType: 'Order', message: order });
  const pa = parseAbi(['function allowance(address,address,address) view returns (uint160,uint48,uint48)']);
  const [, , pnonce] = await pub.readContract({ address: PERMIT2, abi: pa, functionName: 'allowance', args: [payer.address, WETH, RELAY] });
  const batch = { details: [{ token: WETH, amount: amountIn + fee, expiration: Math.floor(Date.now() / 1000) + 600, nonce: pnonce }], spender: RELAY, sigDeadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
  const sig2 = await payer.signTypedData({ domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 }, types: { PermitBatch: [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] }, primaryType: 'PermitBatch', message: batch });
  const none = { value: 0n, deadline: 0n, v: 0, r: pad('0x'), s: pad('0x') };
  const w = createWalletClient({ account: relayer, chain: mainnet, transport: http(RPC) });
  const before = await bal(USDC, recipient);
  const rc = await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: RELAY, abi: art.abi, functionName: 'execute', args: [order, signature, data, none, none, { use: true, batch, sig: sig2 }] }) });
  ok(rc.status === 'success', 'WETH (no permit) → USDC with one Permit2 signature and a fee in WETH, a wallet with no ETH');
  ok((await bal(USDC, recipient)) - before >= minOut && (await bal(WETH, relayer.address)) === fee && (await bal(ETH, payer.address)) === 0n, 'the recipient got the USDC, the relayer the WETH fee');
}
console.log(fails ? `\n${fails} FAILED` : `\n${n} checks passed`);
process.exit(fails ? 1 : 0);
