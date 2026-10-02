# EVM pool: integration guide

A native-ETH shielded pool that users prove on their own device. Balances are fungible notes of any amount; a
single transaction can deposit, pay someone privately with change, withdraw, and pay a relayer. The contracts are
immutable: no owner, no pause, no upgrade. Design and measurements: [`DESIGN-evm-client-pool.md`](../contracts/sp1/confidential/DESIGN-evm-client-pool.md).

**Status.** The circuit's public trusted-setup ceremony is closed: 176 contributions, sealed with Bitcoin block
968840 as the beacon. The contracts are live at the addresses below on Ethereum, Base and Robinhood Chain; deploy blocks and
transactions are in [`contracts/deployments/evm-pool.json`](../contracts/deployments/evm-pool.json). Scan events from
each chain's deploy block.

**Which pool.** This is the smaller of Tacit's two pools: one fixed circuit, ETH only, multichain, with no
prover but the user's own device. For DeFi (swap, LP, lend, farm, OTC, bids), multi-asset notes, or the
Bitcoin bridge, see [`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md) — the confidential pool on Ethereum
mainnet, one SP1 program for every op. The two pools share nothing on chain; a hop between them is a public
exit/entry (["Moving between V1 and this pool"](#moving-between-v1-and-this-pool)).

## Addresses

The same on Ethereum (1), Base (8453) and Robinhood Chain (4663), the chains the suite is deployed on (CreateX
CREATE3, salts locked to deployer `0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7`; no other sender can deploy at these
addresses). On any other chain, treat code at these addresses as unrelated.

| Contract | Address |
|---|---|
| Pool (`TacitEvmPool`, native ETH) | `0x000000c2A20657CE25f2Ba99737933D031AFBEE9` |
| Router (`TacitEvmPoolRouter`) | `0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5` |
| Groth16 verifier | `0x000000b1c0e84CEc8AdF8278B90c4d6400DfB153` |
| PoseidonT5 (four-input Poseidon, used by receive boxes) | `0x555333f3f677Ca3930Bf7c56ffc75144c51D9767` |

PoseidonT5 is the standard deterministic deployment (poseidon-solidity, CREATE2 proxy
`0x4e59b44847b379578588920cA78FbF26c0B4956C`); the deploy script lands it first on chains that lack it.

Related Ethereum mainnet contracts:

| Contract | Address |
|---|---|
| Confidential pool (V1) | `0x000000000Ed1eabD231Be41d93b719056F7febFC` |
| ConfidentialRouter (V1 exit recipes) | `0x000000005dA3E3B73726af3c774Deeb9472D4992` |
| Native ETH asset id on V1 | `0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34` |

ABIs: [`docs/evm-pool/abi/`](./evm-pool/abi/). The script that deploys them is
`contracts/script/DeployEvmPoolCreateX.s.sol`; it refuses any verifier other than the ceremony's.

## Proving on the user's device

The relation is one Groth16 circuit, [`transact.circom`](../dapp/circuits/evm-pool/transact.circom): 2 inputs,
2 outputs, 120-bit values, a depth-32 Poseidon tree, 44,414 constraints. Proofs are 256 bytes and verify in one
pairing check on chain.

| Artifact | Size | Where |
|---|---|---|
| `transact.wasm` (witness generator) | ~4.9 MB | `bafybeia7b7euebs6dr7muhhvwf4yh472ftxodikyecxubipam4d7o7sxta`, and tacit.finance/evm-pool/ |
| `transact_final.zkey` (proving key) | ~28.5 MB | `bafybeia6c36bgww2svm6jfg6nl2pk337prc7t6gcfsvhuo5sufqjpi7z4a`, and tacit.finance/evm-pool/ |
| verification key hash | 32 B | `43d11e6e1607e1ea7f3980c9bca91beed95e2e80d173d0873189e99d402e5757`; clients refuse any other key |
| ceremony bundle (transcript, keys, verifier) | | `bafybeia4yvn2zoggvgpjwg5vpwpt6aivjbcm6tgzxoxsukao2nm5yyypfy` |

The reference client is plain ES modules with no build step:

- [`dapp/evm-pool-zk.js`](../dapp/evm-pool-zk.js): keys, notes, tree, nullifiers, witness.
- [`dapp/evm-pool-zk-prover.js`](../dapp/evm-pool-zk-prover.js): `makeGroth16System({ vk, wasm, zkey, pinnedVkHash })`
  → `prove(input)` / `verify(publics, wire)`. snarkjs, in the browser or Node.
- [`dapp/evm-pool-gateway.js`](../dapp/evm-pool-gateway.js): deposit-box intents, keeper completions, receive boxes,
  withdrawals to a box or escrow.

Proving time on a laptop is 5–14 s in Node. Phone and browser measurements are published with the final artifacts.
A signature, not the spending key, authorizes a spend (EdDSA-Poseidon over the transaction message), so a device
too slow to prove can hand the witness to another prover without giving up custody.

### Note model

```
npk  = Poseidon(Ak.x, Ak.y, NK.x, NK.y)            Ak = per-note spend key, NK = nk·Base8 (BabyJubJub)
leaf = Poseidon(asset, v, npk, rho)                v < 2^120
nf   = Poseidon(nk, leaf, index)
asset        = keccak256(abi.encode(chainId, pool, address(0))) mod p     (the pool's ASSET_FIELD())
extDataHash  = keccak256(abi.encode(chainId, pool, recipient, extAmount, relayer, fee,
                                    keccak256(memo0), keccak256(memo1))) mod p
publicAmount = extAmount − fee mod p
Σ inputs + publicAmount = Σ outputs
```

Keys and stealth derivation are the Bitcoin shielded pool's (`dapp/btc-pool-zk.js`): one wallet seed serves both,
and one Secret Sats address (`bp1…`) receives in both pools. A `tacit1…` address can carry the same 97 bytes as its
pool lane (flag `0x04`; flags `0x85` in full, 276 characters), so one address receives here too; see *Tacit address
format* in `BUILD-A-TACIT-DAPP.md`.

Each output note carries a 65-byte memo in `memo0` / `memo1` so its recipient can find it
(`dapp/evm-pool-wallet.js` `sealNote` / `openNote`):

```
memo = pk_eph (33) ‖ ct (16) ‖ tag (16)
s    = compress(e·V)  (sender)  =  compress(v·pk_eph)  (recipient)      V = the address's view key
npk, rho = outputKeys(A, N, s)                                          (the Bitcoin pool's per-note keys)
k    = keccak256("tacit-evm-pool-aead-v1" ‖ s)
ct   = be16(value) ⊕ keccak256(k ‖ 0x0000)[0..16)
tag  = keccak256("tacit-evm-pool-aead-tag-v1" ‖ k ‖ ct)[0..16)
```

A wallet accepts a memo only if `Poseidon(asset, value, npk, rho)` equals the output's leaf.
Public signal order: `root, oldRoot, newRoot, startIndex, publicAmount, extDataHash, asset, nf[2], outLeaf[2]`.

### Payment proofs and payment links

In `dapp/evm-pool-wallet.js` a spend's one-time keys are derived from the sender's key, so the sender finds its
payments again from the key alone (`paymentKey`); a deposit's are random, as are every output's in the standalone
wallet below:

```
e_k = HMAC-SHA256(sha256("tacit-evm-pool-eph-v1" ‖ be256(v)), be256(chainId) ‖ be256(nf0) ‖ k [‖ a]) mod n
      v = the sender's view scalar, nf0 = the spend's first nullifier, k = the output (0 or 1)
      a = the attempt, one byte 1 to 15, appended only when non-zero
```

A spend that never landed and is built again from the same note (a new quote, so a new change amount) takes the next
attempt, so two memos never share a one-time key or a keystream. The wallet remembers the count with its state and
looks through attempts 0 to 15 when it finds its payments again. Attempt 0 is the plain form above, so existing
proofs are unchanged.

A payment proof is `(chain, tx, k, e_k)`. Anyone holding the recipient's address checks it (`verifyPayment`):
`e_k·G` is the memo's `pk_eph`, the memo opens under `s = compress(e_k·V)`, and the note it opens to is the output's
leaf. It shows nothing about any other address.

A payment request link (`#pay=<address>&n=<npk>&ns=<sig>&amount=`) names the payee's deposit address by `n`
(`receiveBoxOf(n, 25)`) and signs it: `ns` is a secp256k1 signature, under the view key inside the pool address, over
`keccak256("tacit-pay-box-v1" ‖ be256(n))`. A payer's page pays the deposit address only when the signature checks
against the address in the link; otherwise it pays the pool address directly, so a link whose `n` was swapped cannot
redirect a payment.

A payment link hands over a key of its own, whose pool balance holds the payment:

```
seed_i = HMAC-SHA256(identity key, "tacit-pay-gift-v1" ‖ be32(chainId) ‖ be32(i))      i = 0, 1, 2, …
https://tacit.finance/pay/#gift=<seed_i hex>&chain=<ethereum|base|robinhood>&for=<note>
```

`seed_i` is an identity key like any other: its pool keys are `evmPoolKeys(seed_i)`, and whoever opens the link
withdraws its balance to an address or sends it into their own. The sender funds link `i` with a private send, so the
key alone finds every link it sent: each of its sends' paid outputs, opened with `e_k` under the keys of links `0, 1, …`
(ten past the last one found). A link was taken once its note's nullifier is on chain; taken back if that transaction
paid the sender. A link's index is chosen only after that chain's history is read, so no seed is funded twice.

## Calling the pool

```solidity
function transact(
    uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[11] publicInputs,
    address recipient, int256 extAmount, address relayer, uint256 fee, bytes memo0, bytes memo1
) external payable;
```

| `extAmount` | Effect |
|---|---|
| `> 0` | Deposit: send exactly `extAmount` wei as `msg.value`. |
| `< 0` | Withdraw `-extAmount` wei to `recipient` (must be non-zero). |
| `0` | Private transfer inside the pool. |

`fee` goes to `relayer` in the same call (a non-zero fee needs a non-zero relayer). The contract recomputes the asset,
`extDataHash` and `publicAmount` itself, so recipient, amounts, relayer, fee and memos cannot be altered after the
owner signs.

**Ordering.** A transaction with an output inserts two leaves at the pool's current size and must be proven
against the current root (`oldRoot == root()`, `startIndex == nextIndex()`; `head()` returns both in one call). If
another transaction lands first it reverts with `StaleRoot` or `WrongInsertionIndex`: rebuild the witness against
the new leaves and prove again; the owner's signature does not change. Submit through private order flow. A
transaction with no outputs (a full withdrawal) inserts nothing and never goes stale. Membership may be proven against any root the pool has held
(`everKnownRoot`); `rootSize(root)` is the leaf count the tree had when that root was current.

**Indexing.** Rebuild the tree from `Transact` events in `firstIndex` order, appending `(outLeaf0, outLeaf1)`; skip
events where both are zero (nothing was inserted). Notes are found by trial-decrypting the memos, and receive-box
notes from the router's `Received` events. Key notes by
`(leaf, index)`: the same leaf can appear twice if a deposit box is paid twice, and each copy is separately spendable.
`isSpent(nullifiers)` checks a wallet's notes in one call.

## Router

The router is optional periphery; everything it does can be done by calling the pool directly.

**Deposit boxes: pay an address now, get a note later.** A `DepositIntent` fixes the amount, both output leaves, both
memo hashes, a refund address and a deadline. `depositBoxOf(intent)` is a counterfactual address that holds only
what is paid to it. Any source can pay it: a wallet, an exchange withdrawal, a bridge, or a V1 withdrawal. Anyone
then calls `completeDeposit(intent, tx)` with a proof against the pool's root at that moment and collects the fee,
which is `amount − Σ output values`. The intent pins the notes, so a completer can only deliver exactly what the
owner chose. After the deadline, `reclaimDeposit(intent, token)` returns any token or ETH in the box to the refund
address. The completer learns each output's value (the leaves hide it) but cannot link later spends.
`depositBoxOf(intent)` is the same address on every chain, but the leaves bind the chain's asset, so a box funded
on the wrong chain can never be completed there, only reclaimed. Fund a box with a plain call carrying normal gas:
once completed it has code, and a 2300-gas stipend transfer to it can fail.

**Handing a box to a funding page.** A page that funds boxes on the user's behalf takes
`#tacit-box=<base64url(JSON.stringify({ chainId, intent, hint }))>`, where `intent` and `hint` are exactly the
keeper intake body below (integers as decimal strings or `0x` hex). The page checks the router has code on
`chainId`, forwards `{ intent, hint }` to a keeper, and funds exactly `intent.amount` there only once a keeper
accepts it, so no one pays a box nobody will complete. A funding page should also refuse a box that already holds
funds or has code (no reuse) and one whose deadline is less than an hour away. For funding from a V1 note, keep
`amount` a multiple of 10^10 wei.

A keeper service completes boxes for its fee: `POST /evm-pool/keeper/deposit` with `{ intent, hint }` from
`depositIntent()` (endpoint published at launch). Anyone can run one (`worker-relay/src/evm-pool-keeper.js`); the
same service sweeps receive boxes and relays (below).

**Wrap boxes and `withdrawToV1`.** A `WrapIntent` fixes a V1 asset id, amount, tip, tip recipient (zero = whoever
completes), V1 note commitment, refund and deadline. `completeWrap(intent)` wraps the box's funds into that V1 note.
`withdrawToV1(tx, intent)` withdraws from the pool into the wrap box and wraps in one transaction; the proof binds
the box as recipient.

**Receive boxes: one standing address, paid any number of times.** `receiveBoxOf(npk, feeBps)` is an address
tied to one note key of the owner and a fee cap in basis points. Anyone pays it ETH, as often as they like, from any
wallet or exchange. Anyone then calls `sweepReceive(npk, feeBps, tx)` to move its whole balance into the pool
(a sweep proves exactly the balance it finds, so rebuild if a payment lands first): the router computes the note
itself, `leaf = Poseidon(asset, amount − fee, npk, rho)` with
`rho = keccak256(abi.encode(keccak256("tacit-evm-pool-receive-box-v1"), box, n)) mod p` for the box's `n`-th sweep
(`receiveCount(box)`), so a sweeper can only credit the owner and keeps at most `feeBps` of what it sweeps.
`receiveState(npk, feeBps)` returns the box, its next `n` and `rho`, and the balance a sweep would take. The
sweep takes no memos and a single output. Each sweep emits `Received(box, n, index, value, rho, fee)`. The box's
contract exists only inside a sweep (created, emptied and removed in one transaction), so between sweeps the address
has no code and takes any payment, including a plain 21,000-gas transfer from an exchange.

- Keys: `receiveKeys(zk, wallet, i)` gives box `i`'s note key. It derives from the wallet's nullifier secret, so a
  box cannot be tied to the wallet's shielded address, and a wallet can hand out a separate box per counterparty.
- Recovery needs only the seed: for each `i`, `receiveKeys` → `receiveBoxOf(npk, feeBps)` → its `Received` events →
  `receivedNote(zk, wallet, i, event)` is a spendable input.
- Sweeping: `sweepWitness(zk, { npk, feeBps, box, n, amount, fee, relayer, … })`. The owner can sweep with no fee
  from any account; a zero-fee box (`feeBps = 0`) is swept only that way.
- Payments into one box are public and linked to each other, like any reused address. Spends of the swept notes
  are not: they reveal nullifiers, never the note key.
- Only the pool's asset leaves a receive box. Anything else sent to it stays there.
- Pay a receive box from a plain transfer or a call that does nothing else first. A sweep removes the box's code at the
  end of its transaction, so ETH paid to the box later in that same transaction is lost with it.

**Receive address (canonical, every app shows the same one).** The address a wallet displays depends on every
value below, so all apps use exactly these:

| | |
|---|---|
| Pool wallet seed | `HMAC-SHA256(key = Tacit identity private key (32 bytes), msg = "tacit-btc-pool-seed-v1")` |
| Wallet keys | `walletKeys(seed, "mainnet")` (`dapp/btc-pool-zk.js`), the `"mainnet"` tag on every EVM chain |
| Box key | `receiveKeys(zk, wallet, 0)`: tweak seed `0x00 ‖ keccak256("tacit-evm-pool-receive-key-v1" ‖ be32(n) ‖ be32(i))`, `i = 0` |
| Fee cap | `feeBps = 25` |
| Address | `receiveBoxOf(npk, 25)` on the router; offline, `receiveBoxAddress(npk)`. The same address on every chain. |

`evmPoolWallet(zk, identityKey)` and `receiveBoxAddress(npk)` in `dapp/evm-pool-gateway.js` implement this.
Vectors (identity key `0x11` × 32):

```
a      = 0x030d4f8c609bcd6f5c961113e9a379b14b5eacfe0cb693e3ee3a21f148144d9e
n      = 0x04b517b015712270664ae5481e694562bb14b28685c492be2436898a8ec97306
npk(0) = 4783613888947850950044057964142544727340891053660060203316524895455918575012
npk(1) = 2799937100355739972349309475928188484188423058204235589221587582372656968697
address (box 0, feeBps 25) = 0x52fc37ee7741468a15CE879320a7a41CEBaeb232
address (box 0, feeBps 0)  = 0x7ABc01dEAC9A65A0d2480a87DB6F22EbC1342639
```

**Keeper intake for receive boxes.** A payment to a box that has never been swept emits no event, so a keeper
sweeps only boxes it has been told about: `POST /evm-pool/keeper/receive` with `{ chainId, npk, feeBps }`
(idempotent; endpoint published at launch). The keeper then watches the box's balance and sweeps whenever the
capped fee covers its gas. Registering tells the keeper which box belongs to which note key, which the first sweep
makes public anyway; it never learns anything that spends. The owner can always sweep without a keeper.
At capacity the keeper makes room for a new registration, and for a new deposit or wrap intent, by dropping the
oldest one whose box has never held funds, so registrations that never pay cannot lock out new users; register again
before paying if a box was dropped. Requests are rate limited per client address (an IPv6 client by its /64).

**Zaps.** `zapTokenToDepositWithPermit2(tx, amountIn, permit, sig, swapData)` swaps any ERC-20 to ETH through the
pinned aggregator and deposits exactly the proven amount, refunding the rest.

**Withdraw and call.** A withdrawal can run actions with the funds in the same transaction: a swap, a bridge
deposit, a wrap or zap into a V1 note, or any call. A `CallIntent` lists the calls (target, value, data, and a token to
transfer or approve first), the tokens to deliver to `to` with their minimum amounts, a refund address and a deadline.
`callEscrowOf(intent)` is its escrow address; a withdrawal with that recipient binds the whole intent through the proof,
so a relayer can change neither the calls nor where their outputs go. `withdrawAndCall(tx, intent)` withdraws and runs
it at once: if any call fails or an output falls short, the transaction reverts and nothing is spent. Funds that reach
the escrow another way are run by anyone with `executeCall(intent)` before the deadline, and returned to `refund` with
`refundCall(intent, token)` after it. Whatever is left of the pool asset after the calls goes to `refund`; making
`refund` the owner's own receive box (`callRefundBox`) returns it to the pool privately. A keeper sweeps a box only
when its capped fee covers the gas, so on Ethereum a small refund waits there until it grows or the owner sweeps it. Calls cannot target the pool,
the router or the escrow itself. Client helpers in `dapp/evm-pool-gateway.js`: `callIntent`, `callEscrowAddress`,
`callWithdrawalWitness`, and call builders for V1 (`v1WrapCall`, `v1ZapShieldedNoteCall`, `v1ZapCanonicalNoteCall`).

**Funding with a call.** Contracts and bridge messages that deliver funds by calling a contract use
`fundDeposit(intent, hint)` (pays a deposit box exactly `intent.amount` and publishes the keeper hint in
`DepositFunded`, so any keeper can complete it) or `fundReceive(npk, feeBps, amount)` (pays a receive box and announces
it in `ReceiveFunded`, so a keeper sweeps it without registration). A published hint shows the note's value and public
key material; it does not let anyone spend the note or link its later spends.

## Relaying

A user never needs gas or a funded address: a relayer submits the transaction and is paid `fee` out of the
user's shielded funds in the same call. The proof binds `relayer` and `fee` (with recipient, amount and memos), so
a relayer cannot redirect the funds or raise its fee after it is signed, and a copy of the transaction submitted by anyone else still
pays the named relayer. Before signing, the wallet checks the relayer's quote: it must name this chain and pool, and
the fee must be within a per-chain ceiling (0.05 ETH on Ethereum, 0.002 ETH on Base and Robinhood Chain), so a
compromised relayer cannot quote more than that. In a browser on a real origin the quote must also come from the
relayer address the wallet expects for the chain. A chain config can set `relayer` and `maxRelayFee`. Withdrawing to a fresh, empty address through a relayer leaves no on-chain link to the
depositor's wallet.

With the keeper service:

1. `GET /evm-pool/keeper/quote` → `{ relayer, fee, sweepFee, receiveMin, … }`: the keeper's address and the fee it
   accepts now, plus what collecting a receive box costs now (`sweepFee`) and the smallest box balance whose 0.25%
   cap pays for it (`receiveMin`). A smaller balance stays in its box, owned by its keys, and is collected once more
   arrives or gas falls.
2. Build and prove the transaction with that `relayer` and `fee` (`withdrawalWitness` for a withdrawal, or a
   transfer with `extAmount = 0`).
3. `POST /evm-pool/keeper/relay` with `{ tx: { pA, pB, pC, publicInputs, recipient, extAmount, relayer, fee, memo0,
   memo1 } }` (integers as decimal strings) → `{ txHash }`.

**Many users at once.** The pool inserts only against its current head, so two transactions proven against the
same head cannot both land. The keeper keeps a queue instead of a race. Output leaves are fixed before proving, and
a spend's signature does not cover the root.
1. `POST /reserve { outLeaf0, outLeaf1, nfs }` → `{ id, oldRoot, start, root, size, pending, expires }`: a slot. The
   wallet proves from `oldRoot` at `start`, which is the pool at `root`/`size` with the `pending` leaves appended.
   Any number of wallets prove at once, each in its own slot.
2. `POST /relay { tx, reservation: id }`: the keeper checks the proof off chain against the slot and the transaction
   (proof, extDataHash, fee, nullifiers), then sends the slots in order, several per block.
3. A slot that is not fulfilled within 90 s is cut, with the slots behind it, and those wallets reserve again.
   `POST /cancel { reservation }` gives a slot up early. A slot that lapses, or is given up, with other slots behind
   it costs those wallets their proofs, so its requester may not reserve again for ten minutes (`403`); such a
   wallet proves against the queue's tail and sends without a reservation. A lapse with nobody behind it costs
   nothing and is not counted.

Unreserved relays still work: proven against `GET /head`'s `tail`, one takes the next slot. A withdraw-and-call or a
move to V1 is simulated before it is sent, so it waits for an empty queue. The queue runs where the keeper sends to
the chain's public mempool (Base, Robinhood Chain), since a private endpoint drops a reverting transaction and would
leave a nonce gap; on Ethereum each insertion proves against the head.

**History feed.** `GET /evm-pool/keeper/events?from=<block>` → `{ through, events }`: the pool's `Transact` and the
router's `Received` events in blocks `from..through`, confirmed, in chain order, whole blocks per page. A wallet syncs
most of its history from it in a few requests instead of thousands of log queries. It trusts nothing in it: each page
is kept only if the tree it builds is one the pool has held at that size (`rootSize(root) == size`). A feed can at
most hide a note (by withholding its memo or `Received` event) or a spend of one; `rescan()` rebuilds from chain logs
alone, and a spend that keeps failing runs it.

A `409` with `stale: true` means another transaction landed first: rebuild against the new root and prove again
(the owner's signature does not change). A `400` carrying `needFee` means gas moved; re-quote. Deposits are not
relayed, since a deposit is paid by whoever sends it.

## Standalone wallet

`dapp/evm-pool/tacit-evm-pool-wallet.js` (built by `node build/build-evm-pool-wallet.mjs`) is the whole private-ETH
wallet as one ES module with no imports: key derivation, note scanning, proving (snarkjs 0.7.6 in a worker started
from a Blob) and submission. It checks the ceremony files against their pinned hashes before it uses them. It is
served at `https://tacit.finance/evm-pool/tacit-evm-pool-wallet.js` with `Access-Control-Allow-Origin: *`, as are the
ceremony files beside it.

Current build: sha256 `cdc59dd5d5c95370a30161dd64637e32590b85290241944184283a05098c15c0`, IPFS
`bafybeigatwjp4gda4y3hj4zza7mgmk4qsipqs7gcgqipudql7625eefthy` (pinned on Filebase). The build is deterministic from
the repository: `node build/build-evm-pool-wallet.mjs` prints the same hash.

The wallet keeps its synced state in storage sealed under a key from the wallet's view scalar. It finds history
through the keeper's feed and checks every batch, from the feed or from a node's logs, against the pool (`rootSize`).
It never sends a note's nullifier to a node to ask whether it is spent. A feed could withhold a memo and so hide an
incoming note; `rescan()` rebuilds the state from chain logs alone, and a spend that keeps failing runs it.

```js
import { makeEvmPoolWallet } from './tacit-evm-pool-wallet.js';
const w = await makeEvmPoolWallet({
  provider,                 // EIP-1193, on chainId; signs, and reads unless `rpc` is given
  chainId: 8453,
  identityKey,              // the 32-byte Tacit identity key
  artifacts: { wasm, zkey, vk },   // transact.wasm, transact_final.zkey, transact_vk.json
  relay,                    // optional keeper base, …/evm-pool/keeper
});
await w.sync();                         // { balance, notes, leaves, block }
await w.deposit(wei);                   // from the user's wallet
await w.receive.sweep();                // the private ETH address → a note, from the user's wallet, no fee
await w.send('bp1…', wei);              // private payment
await w.withdraw('0x…', wei);           // to any address
```

`artifacts` may also be an async loader, called the first time an action proves, or left out and set later with
`w.setArtifacts(...)`: opening, `sync`, `balance`, the addresses and a view-only wallet (`rpc` without `provider`) never
download the proving files, and opening never asks the wallet to connect. On Ethereum, `w.toV1(wei, commit)` moves ETH
into a V1 tETH note in one `withdrawToV1` (commit = V1's wrap commitment for the wallet's own next note; the V1 wallet
finds and settles it as any wrap), and `w.bridgeOut(l2, wei, { l2Rpc })` moves it to the wallet's private ETH address
on Base or Robinhood Chain.

With no `relay`, every action is proved on the device and sent from `provider`: no keeper, no relayer, no fee
beyond gas. With `relay`, `send` and `withdraw` go through the keeper (its fee, no gas) unless called with
`{ via: 'self' }`. Each action takes `{ via, maxFee, onStep(msg) }` as its last argument: `maxFee` (wei) is the most a
relayed spend may pay the relayer, the fee the caller showed, and a dearer quote is refused before anything is signed
(the error's `feeMoved` is the new fee). `w.quote(gas?)` reads the relayer's quote, priced for a spend that burns `gas`
when given. A spend the wallet must merge notes for first pays the fee once per merge, and is refused before the first
when the notes cannot cover it. `w.receive.address` is the
private ETH address and `w.receive.waiting()` what sits there unswept. With `relay`, confirmed history is read from the
keeper's feed first (checked as below); `w.rescan()` rebuilds from chain logs alone. `w.terminate()` stops the
worker. Synced state stays small as the pool grows: the tree's right edge and the paths of the wallet's own notes.

## Moving to an L2

From the Ethereum pool, `wallet.bridgeOut({ toChainId, amount, l2Rpc })` withdraws into a call escrow whose one call
deposits through the L2's canonical bridge to the wallet's own private ETH address there (a receive box is at the same
address on every chain, since the router is); that chain's keeper sweeps it into a note. Gateway builder:
`bridgeEthCall`.

| To | Call from the escrow | Notes |
|---|---|---|
| Base (8453) | `L1StandardBridge.depositETHTo(to, 200000, 0x)` at `0x3154Cf16…2C35` | `depositETH` is EOA-only. Arrives in 1–3 min, exact. The portal burns about 620k L1 gas to buy the deposit's L2 gas. |
| Robinhood Chain (4663) | `Inbox.createRetryableTicket(to, amount, sc, to, to, gasLimit, maxFeePerGas, 0x)` at `0x1A07cc4B…7a2D` | Never `depositEth`, which credits a contract's L2 alias. `sc` = `calculateRetryableSubmissionFee(0, 2 × L1 basefee)`; `gasLimit` = 1.5 × `NodeInterface.estimateRetryableTicket`; `maxFeePerGas` = max(8 × L2 gas price, 0.1 gwei), so the ticket runs even if the L2 fee moves. Unused gas refunds to `to` on L2. `to` must have no code on Ethereum when the ticket is made. |

The amount and destination address are public on Ethereum; which note paid is not. Coming back from an L2 is the
canonical exit (about a week); no fast path is wired.

## Moving between V1 and this pool

The pools keep separate notes, so value moves by a public exit from one and a public entry into the other. Both
ends show the amount: a hop is linkable by amount, and by address once a box is completed. What the V1 route adds is
that the funds' origin is any V1 note holder rather than a public wallet.

| From → to | How |
|---|---|
| V1 → pool | A V1 settle withdrawal with `recipient = depositBoxOf(intent)` (native ETH, `value × 10^10` wei). `settle` pays an address with no code, so it cannot revert on the box. A keeper completes the deposit afterwards. |
| V1, other asset → pool | A V1 exit recipe (`ConfidentialRouter.exitAndExecute`) swaps to ETH and sweeps to `finalRecipient = depositBoxOf(intent)`. |
| Pool → V1 | `withdrawToV1(tx, intent)` with `intent.assetId` = the native ETH id above and `intent.commit` = the V1 note commitment. |
| Pool → V1 shielded note (any asset) | `withdrawAndCall` with a `v1ZapShieldedNoteCall` or `v1ZapCanonicalNoteCall`: swap and shield into V1 in the same transaction. |
| Pool → anything | `withdrawAndCall(tx, intent)` (above), on every chain. On Ethereum, a withdrawal can also name `ConfidentialRouter.escrowAddressFor(recipe)`, run by anyone with `activateExit(recipe)`. |

## Checklist

- Detect deployment by code at the pool address; fetch the final `wasm`/`zkey` by CID and pin the verification key
  hash in `makeGroth16System({ pinnedVkHash })`.
- Retry stale proofs automatically; send through private order flow.
- Always set a non-zero refund address on a box intent, and amounts below 2^120.
- Relayers: never submit someone else's deposit (`extAmount > 0` pulls `msg.value` from the sender).
- Chains need Shanghai (PUSH0) and Cancun (transient storage).
