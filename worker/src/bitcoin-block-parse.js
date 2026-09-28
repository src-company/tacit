// Byte-level Bitcoin block parser, shared by every caller that needs a block's transactions without paying
// for a per-tx esplora round-trip: fetch /block/<hash>/raw once (immutable, edge-cached) and walk the bytes
// locally. Extracted from reflection-attest.js's (and reflection-attest-bigbatch.mjs's, which had grown an
// independent copy) local `splitBlockTxs` — same parse, validated byte-exact against a live mainnet block
// (4491 txs, full consumption) — plus wtxid, which neither of those callers needed but a Bitcoin merkle-path
// proof over the witness commitment (burndep-live-tracer.js) does.
//
// Per tx: txid (dsha256 of the witness-stripped serialization — version‖vins‖vouts‖locktime), wtxid (dsha256
// of the full serialization including any witness data — identical to txid for a non-segwit tx), the raw
// hex (for guest folding / classification), and each vin's prevout (txid + vout only; no scriptSig/witness
// contents are needed downstream).

const readVarint = (d, p) => {
  const f = d[p];
  if (f < 0xfd) return [f, 1];
  if (f === 0xfd) return [d[p + 1] | (d[p + 2] << 8), 3];
  if (f === 0xfe) return [d[p + 1] | (d[p + 2] << 8) | (d[p + 3] << 16) | (d[p + 4] * 0x1000000), 5];
  let n = 0;
  for (let i = 0; i < 8; i++) n += d[p + 1 + i] * 2 ** (8 * i);
  return [n, 9];
};
const toHex = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0'); return s; };

// Every tx of a raw block (header + varint count + txs), in order.
//   dsha256(Uint8Array) -> Uint8Array   (double-SHA256, internal byte order — same dependency reflection's
//                                        own deps.sha256 composes into, so callers pass `(b) => sha256(sha256(b))`)
export function splitBlockTxs(blockBytes, dsha256) {
  const d = blockBytes;
  let p = 80; // skip the 80-byte header
  const [txCount, tcl] = readVarint(d, p); p += tcl;
  const out = [];
  for (let t = 0; t < txCount; t++) {
    const start = p;
    const version = d.slice(p, p + 4); p += 4;
    let segwit = false;
    if (d[p] === 0x00 && d[p + 1] === 0x01) { segwit = true; p += 2; }
    const [vinN, vl] = readVarint(d, p); p += vl;
    const vins = [];
    for (let i = 0; i < vinN; i++) {
      const txidLE = d.slice(p, p + 32);
      const vout = d[p + 32] | (d[p + 33] << 8) | (d[p + 34] << 16) | (d[p + 35] * 0x1000000); p += 36;
      const [sl, sll] = readVarint(d, p); p += sll + sl; p += 4;
      vins.push({ prevTxidDisplay: '0x' + toHex(txidLE.slice().reverse()), vout });
    }
    const [voutN, ol] = readVarint(d, p); p += ol;
    for (let i = 0; i < voutN; i++) { p += 8; const [sl, sll] = readVarint(d, p); p += sll + sl; }
    const voutEnd = p;
    if (segwit) { for (let i = 0; i < vinN; i++) { const [wc, wl] = readVarint(d, p); p += wl; for (let w = 0; w < wc; w++) { const [il, ill] = readVarint(d, p); p += ill + il; } } }
    p += 4; // locktime
    const full = d.slice(start, p);
    // txid = dsha256 of the witness-stripped serialization; wtxid = dsha256 of the full one (BIP141 — the
    // two coincide for a non-segwit tx, which has no marker/flag/witness to strip).
    const stripped = segwit
      ? Uint8Array.from([...version, ...d.slice(start + 6, voutEnd), ...d.slice(p - 4, p)])
      : full;
    const txid = dsha256(stripped);
    const wtxid = dsha256(full);
    out.push({
      txidDisplay: '0x' + toHex(txid.slice().reverse()),
      wtxidDisplay: '0x' + toHex(wtxid.slice().reverse()),
      rawHex: '0x' + toHex(full),
      vins,
    });
  }
  return out;
}
