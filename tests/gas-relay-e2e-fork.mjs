#!/usr/bin/env node
// The gas relay end to end on a mainnet fork against the LIVE contract (0x000000197E…): the page's own code (dapp/gas-relay.js) builds and signs a TAC → USDC
// order and the TAC permit for a wallet with no ETH, the order board (worker/src/gas-relay-queue.js) accepts it, and the settle relay's own encoding
// (worker-relay/src/lib/gas-calls.js) sends it, as the relay's solver would. Needs anvil and network (KyberSwap's quote). node tests/gas-relay-e2e-fork.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { checkGasOrder, makeGasBoard } from '../worker/src/gas-relay-queue.js';
import * as gr from '../dapp/gas-relay.js';
import { encodeExecute, abi as GAS_ABI } from '../worker-relay/src/lib/gas-calls.js';
if (spawnSync('anvil', ['--version']).status !== 0) { console.log('skip - needs anvil'); process.exit(0); }
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { createPublicClient, http, parseAbi, encodeFunctionData } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { mainnet } = require('viem/chains');
const PORT = 27300 + Math.floor(Math.random() * 100), RPC = `http://127.0.0.1:${PORT}`, RELAY = gr.GAS_RELAY[1];
const TAC = gr.TAC, USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ZR = '0x000000000000FB114709235f1ccBFfb925F600e4', FWD = '0x087735d470fd040661d8c48935e2d665ea682fc5';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const a = spawn('anvil', ['--port', String(PORT), '--fork-url', process.env.FORK || 'https://mainnet.gateway.tenderly.co', '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => a.kill('SIGKILL'));
const pub = createPublicClient({ chain: mainnet, transport: http(RPC) }), rpc = (m, p) => pub.request({ method: m, params: p });
for (let i = 0; ; i++) { try { await pub.getBlockNumber(); break; } catch { if (i > 150) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 200)); } }
const erc = parseAbi(['function balanceOf(address) view returns (uint256)', 'function nonces(address) view returns (uint256)', 'function transfer(address,uint256)']);
const bal = (t, w) => pub.readContract({ address: t, abi: erc, functionName: 'balanceOf', args: [w] });
const payer = privateKeyToAccount('0x' + 'd4e5f6a7'.repeat(8)), relayer = '0x000000000000000000000000000000000007a0f0', HOLDER = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2', to = '0x00000000000000000000000000000000000c0ffe';
await rpc('anvil_impersonateAccount', [HOLDER]); await rpc('anvil_setBalance', [HOLDER, '0xde0b6b3a7640000']);
await rpc('eth_sendTransaction', [{ from: HOLDER, to: TAC, data: encodeFunctionData({ abi: erc, functionName: 'transfer', args: [payer.address, 500n * 10n ** 18n] }) }]);
await rpc('anvil_impersonateAccount', [relayer]); await rpc('anvil_setBalance', [relayer, '0x56bc75e2d63100000']);
ok((await bal(TAC, payer.address)) === 500n * 10n ** 18n && BigInt(await rpc('eth_getBalance', [payer.address, 'latest'])) === 0n, 'a wallet with 500 TAC and no ETH');
ok(String(await rpc('eth_getCode', [RELAY, 'latest'])).length > 2, 'the relay is deployed at ' + RELAY);

// the swap's route: KyberSwap through zRouter.snwap, exactly as the card builds it (dapp/swap/solvers.js snwapCall)
const amountIn = 100n * 10n ** 18n, fee = 4n * 10n ** 18n;
const r = await (await fetch(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=${TAC}&tokenOut=${USDC}&amountIn=${amountIn}`)).json();
const b = await (await fetch('https://aggregator-api.kyberswap.com/ethereum/api/v1/route/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routeSummary: r.data.routeSummary, sender: FWD, recipient: FWD, slippageTolerance: 300, deadline: Math.floor(Date.now() / 1000) + 600 }) })).json();
const word = (v) => BigInt(v).toString(16).padStart(64, '0'), addr = (x) => x.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const bytes = (h) => { const s = h.replace(/^0x/, ''); return word(s.length / 2) + s.padEnd(Math.ceil(s.length / 64) * 64, '0'); };
const minOut = BigInt(b.data.amountOut) * 97n / 100n;
const inner = '54d61b9c' + addr(b.data.routerAddress) + addr(TAC) + addr(USDC) + addr(to) + word(5 * 32) + bytes(b.data.data);
const call = '0x5f3bd1c8' + addr(TAC) + word(amountIn) + addr(to) + addr(USDC) + word(minOut) + addr(FWD) + word(7 * 32) + bytes(inner);

// the page: build, then sign the permit (the input and the fee together, in TAC) and the order
const { order, data } = gr.buildOrder({ payer: payer.address, tokenIn: TAC, amountIn, feeToken: TAC, fee, tokenOut: USDC, minOut, recipient: to, target: ZR, data: call });
const dl = Math.floor(Date.now() / 1000) + 900, total = amountIn + fee;
const pt = gr.permitTypedData({ token: TAC, owner: payer.address, value: total, nonce: await pub.readContract({ address: TAC, abi: erc, functionName: 'nonces', args: [payer.address] }), deadline: dl });
const strip = (t) => ({ domain: t.domain, types: Object.fromEntries(Object.entries(t.types).filter(([k]) => k !== 'EIP712Domain')), primaryType: t.primaryType, message: t.message });
const inPermit = { value: String(total), deadline: String(dl), ...gr.splitSig(await payer.signTypedData(strip(pt))) };
const signature = await payer.signTypedData(strip(gr.orderTypedData(order)));
const x = { order, data, signature, inPermit, feePermit: gr.NO_PERMIT, p2: gr.NO_P2 };
ok(checkGasOrder(x) === null, 'the board accepts the order the page built');
const board = makeGasBoard({ kv: { m: new Map(), get(k) { return this.m.get(k) ?? null; }, put(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } } });
const posted = await board.post(x); ok(posted.ok, 'it is listed on the board'); const listed = (await board.list())[0];

// the settle relay: simulate with its own encoding, then send
const cd = encodeExecute(listed);
const used0 = await pub.readContract({ address: RELAY, abi: GAS_ABI, functionName: 'used', args: [order.payer, BigInt(order.nonce)] });
const gas = await pub.estimateGas({ account: relayer, to: RELAY, data: cd });
ok(!used0 && gas > 0n, `the relay's encoding simulates (gas ${gas})`);
const before = { usdc: await bal(USDC, to), tac: await bal(TAC, relayer) };
const hash = await rpc('eth_sendTransaction', [{ from: relayer, to: RELAY, data: cd, gas: '0x' + (gas * 12n / 10n).toString(16) }]);
const rc = await pub.waitForTransactionReceipt({ hash });
ok(rc.status === 'success', 'sent');
ok((await bal(USDC, to)) - before.usdc >= minOut, `the wallet's USDC arrived (${Number((await bal(USDC, to)) - before.usdc) / 1e6})`);
ok((await bal(TAC, relayer)) - before.tac === fee, 'the relayer earned the fee in TAC');
ok((await bal(TAC, payer.address)) === 500n * 10n ** 18n - total && BigInt(await rpc('eth_getBalance', [payer.address, 'latest'])) === 0n, 'the wallet paid 104 TAC and still has no ETH');
ok(await pub.readContract({ address: RELAY, abi: GAS_ABI, functionName: 'used', args: [order.payer, BigInt(order.nonce)] }), "the order's nonce reads used, so the board clears it");
console.log(fails ? `\n${fails} FAILED` : `\n${n} checks passed`);
process.exit(fails ? 1 : 0);
