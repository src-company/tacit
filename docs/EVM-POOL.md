# EVM pool: integration guide

A native-ETH shielded pool that users prove on their own device. Balances are fungible notes of any amount; a
single transaction can deposit, pay someone privately with change, withdraw, and pay a relayer. The contracts are
immutable: no owner, no pause, no upgrade. Design and measurements: [`DESIGN-evm-client-pool.md`](../contracts/sp1/confidential/DESIGN-evm-client-pool.md).

**Status.** The circuit's public trusted-setup ceremony is closed: 176 contributions, sealed with Bitcoin block
968840 as the beacon. The contracts deploy at the addresses below, which are fixed. Integrate against them today and treat the
pool as live once it has code on chain (`eth_getCode(pool) != "0x"`).

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
and one Secret Sats address (`bp1…`) receives in both pools.

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
a relayer cannot redirect the funds or raise its fee, and a copy of the transaction submitted by anyone else still
pays the named relayer. Withdrawing to a fresh, empty address through a relayer leaves no on-chain link to the
depositor's wallet.

With the keeper service:

1. `GET /evm-pool/keeper/quote` → `{ relayer, fee, … }`: the keeper's address and the fee it accepts now.
2. Build and prove the transaction with that `relayer` and `fee` (`withdrawalWitness` for a withdrawal, or a
   transfer with `extAmount = 0`).
3. `POST /evm-pool/keeper/relay` with `{ tx: { pA, pB, pC, publicInputs, recipient, extAmount, relayer, fee, memo0,
   memo1 } }` (integers as decimal strings) → `{ txHash }`.

A `409` with `stale: true` means another transaction landed first: rebuild against the new root and prove again
(the owner's signature does not change). A `400` carrying `needFee` means gas moved; re-quote. Deposits are not
relayed, since a deposit is paid by whoever sends it.

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
