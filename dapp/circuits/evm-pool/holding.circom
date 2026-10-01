pragma circom 2.1.6;

// SPIKE (not for deployment): proof that the prover holds an unspent EVM-pool note of at least `bucketMin`
// at a snapshot, without revealing which note.
//
// Same note and key model as ../evm-pool/transact.circom:
//   npk  = Poseidon(Ak.x, Ak.y, NK.x, NK.y)    NK = nk·Base8
//   leaf = Poseidon(asset, v, npk, rho)
//   nf   = Poseidon(nk, leaf, index)
//
// Public: root (note tree at the snapshot), nfRoot (sparse tree of spent nullifiers at the snapshot), asset,
// epoch, bucketMin, claimHash (binds the claim address), retNf (one tag per note per epoch).
//
// retNf = Poseidon(TAG_RET, nk, leaf, epoch). The tag and the extra input keep it from ever equalling the
// spend nullifier, whatever the epoch, so a claim never reveals what the later spend will publish.
//
// Authority: EdDSA-Poseidon under the note's own spend key Ak over every public value, so a party that
// knows the note's openings or even nk, but not the spend key, cannot claim for it.

include "../btc-pool/btc_pool_templates.circom";
include "../node_modules/circomlib/circuits/eddsaposeidon.circom";
include "../node_modules/circomlib/circuits/smt/smtverifier.circom";

function TAG_RET() { return 0x686f6c645f726574; }
function TAG_SIG() { return 0x686f6c645f736967; }

template EvmPoolHolding(depth, smtLevels, valueBits) {
    // public
    signal input root;
    signal input nfRoot;
    signal input asset;
    signal input epoch;
    signal input bucketMin;
    signal input claimHash;
    signal input retNf;

    // private
    signal input v;
    signal input rho;
    signal input nk;
    signal input ak[2];
    signal input index;
    signal input path[depth];
    signal input sigR8[2];
    signal input sigS;
    signal input smtSiblings[smtLevels];
    signal input smtOldKey;
    signal input smtOldValue;
    signal input smtIsOld0;

    // 0 < bucketMin <= v < 2^valueBits
    component vBits = Num2Bits(valueBits);
    vBits.in <== v;
    component bBits = Num2Bits(valueBits);
    bBits.in <== bucketMin;
    component bZero = IsZero();
    bZero.in <== bucketMin;
    bZero.out === 0;
    component ge = GreaterEqThan(valueBits);
    ge.in[0] <== v;
    ge.in[1] <== bucketMin;
    ge.out === 1;

    // the note
    component nkMul = CanonicalKeyMul();
    nkMul.k <== nk;
    component npk = Poseidon(4);
    npk.inputs[0] <== ak[0];
    npk.inputs[1] <== ak[1];
    npk.inputs[2] <== nkMul.out[0];
    npk.inputs[3] <== nkMul.out[1];
    component leaf = NoteLeaf();
    leaf.asset <== asset;
    leaf.v <== v;
    leaf.npk <== npk.out;
    leaf.rho <== rho;

    // in the tree at the snapshot
    component tree = MerkleRoot(depth);
    tree.leaf <== leaf.out;
    tree.index <== index;
    for (var j = 0; j < depth; j++) tree.path[j] <== path[j];
    tree.root === root;

    // not spent at the snapshot
    component nfh = Poseidon(3);
    nfh.inputs[0] <== nk;
    nfh.inputs[1] <== leaf.out;
    nfh.inputs[2] <== index;
    // circomlib's verifier takes isOld0 as given and weights the terminal node by 1 - isOld0, so a value other than 0 or 1 lets
    // the prover pick the terminal node, and with it a spent nullifier's real leaf hash for a key that is not there.
    smtIsOld0 * (smtIsOld0 - 1) === 0;
    component smt = SMTVerifier(smtLevels);
    smt.enabled <== 1;
    smt.fnc <== 1;
    smt.root <== nfRoot;
    for (var i = 0; i < smtLevels; i++) smt.siblings[i] <== smtSiblings[i];
    smt.oldKey <== smtOldKey;
    smt.oldValue <== smtOldValue;
    smt.isOld0 <== smtIsOld0;
    smt.key <== nfh.out;
    smt.value <== 0;

    // one tag per note per epoch
    component ret = Poseidon(4);
    ret.inputs[0] <== TAG_RET();
    ret.inputs[1] <== nk;
    ret.inputs[2] <== leaf.out;
    ret.inputs[3] <== epoch;
    ret.out === retNf;

    // authority of the note's spend key over everything public
    component msg = Poseidon(8);
    msg.inputs[0] <== TAG_SIG();
    msg.inputs[1] <== asset;
    msg.inputs[2] <== epoch;
    msg.inputs[3] <== root;
    msg.inputs[4] <== nfRoot;
    msg.inputs[5] <== bucketMin;
    msg.inputs[6] <== claimHash;
    msg.inputs[7] <== retNf;
    component sig = EdDSAPoseidonVerifier();
    sig.enabled <== 1;
    sig.Ax <== ak[0];
    sig.Ay <== ak[1];
    sig.R8x <== sigR8[0];
    sig.R8y <== sigR8[1];
    sig.S <== sigS;
    sig.M <== msg.out;
}

component main {public [root, nfRoot, asset, epoch, bucketMin, claimHash, retNf]} =
    EvmPoolHolding(32, 40, 120);
