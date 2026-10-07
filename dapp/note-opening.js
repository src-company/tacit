// The opening (amount, blinding) of a confidential-transfer output that a key received or changed, from the transaction
// that made it and the key alone, as the holdings scan derives it, and checked against the commitment on chain.
//
// A note's opening is what lets it be spent or bridged, and it is not stored anywhere but the holder's own browser. For a
// note made by an ordinary transfer it follows from the key: an output sent to this key opens through the amount channel
// shared with the sender (ECDH over the first asset input), and an output the key changed to itself opens through the key's
// own derivation. Neither needs any other record.
//
// Deps: the primitives tacit.js already holds, injected so this runs (and is tested) without the page:
//   { hexToBytes, concatBytes, reverseBytes, decodeEnvelopeScript, decodePayload(opcode, payload) → decoded | null,
//     deriveAmountKeystreamECDH, deriveAmountKeystreamSelf, decryptAmount, deriveBlinding, deriveChangeBlinding,
//     pedersenCommit, bytesToPoint }

export function makeNoteOpener(p) {
  const need = ['hexToBytes', 'concatBytes', 'reverseBytes', 'decodeEnvelopeScript', 'decodePayload', 'deriveAmountKeystreamECDH',
    'deriveAmountKeystreamSelf', 'decryptAmount', 'deriveBlinding', 'deriveChangeBlinding', 'pedersenCommit', 'bytesToPoint'];
  for (const k of need) if (typeof p[k] !== 'function') throw new Error(`note-opening: ${k} required`);

  const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  const inRange = (a) => typeof a === 'bigint' && a >= 0n && a < (1n << 64n);

  // tx: the creating transaction as the explorer serves it (vin[].witness as hex strings). → { amount, blinding, assetId } | null
  return function openNote({ tx, vout, walletPriv }) {
    const wit0 = tx && tx.vin && tx.vin[0] && tx.vin[0].witness;
    if (!tx || !tx.vin || tx.vin.length < 2 || !wit0 || wit0.length < 3) return null;
    let env;
    try { env = p.decodeEnvelopeScript(p.hexToBytes(wit0[1])); } catch { return null; }
    const dec = env && p.decodePayload(env.opcode, env.payload);
    const out = dec && dec.outputs && dec.outputs[vout];
    if (!out) return null;

    // The first asset input anchors the amount channel (asset inputs follow the envelope input).
    const first = tx.vin[1];
    const anchor = p.concatBytes(p.reverseBytes(p.hexToBytes(first.txid)), u32le(first.vout));
    const matches = (amount, blinding) => {
      try { return p.pedersenCommit(amount, blinding).equals(p.bytesToPoint(out.commitment)); } catch { return false; }
    };

    // Sent to this key: the amount channel is ECDH between this key and the sender's key, which the first asset input reveals.
    const senderHex = first.witness && first.witness.length === 2 && first.witness[1].length === 66 ? first.witness[1] : null;
    if (senderHex) {
      try {
        const sender = p.hexToBytes(senderHex);
        const amount = p.decryptAmount(out.encryptedAmount, p.deriveAmountKeystreamECDH(walletPriv, sender, anchor, vout));
        if (inRange(amount)) {
          const blinding = p.deriveBlinding(walletPriv, sender, anchor, vout);
          if (matches(amount, blinding)) return { amount, blinding, assetId: dec.assetId };
        }
      } catch { /* not an output sent to this key */ }
    }
    // Changed to itself by this key: the key's own keystream and change blinding.
    try {
      const amount = p.decryptAmount(out.encryptedAmount, p.deriveAmountKeystreamSelf(walletPriv, anchor, vout));
      if (inRange(amount)) {
        const blinding = p.deriveChangeBlinding(walletPriv, anchor, vout);
        if (matches(amount, blinding)) return { amount, blinding, assetId: dec.assetId };
      }
    } catch { /* not this key's change */ }
    return null;
  };
}
