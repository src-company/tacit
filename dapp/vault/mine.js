// The Bitcoin side's own position (/vault/#btc): the locks this key made and where each stands, its loans, and the cBTC and cUSD it holds
// privately. Read only for now: locking, the bond, minting, borrowing and repaying are still the front page's, and each line links there.
// Nothing here is loaded until the holder asks: this module, the key, the pool and Bitcoin's history all come in on that press.
import { sha256 } from '/vendor/tacit-deps.min.js';
import { makeKeySession, signInSheet } from '/trade/key.js?cb=149c5b79';
import { getUx, forgetUx } from '/trade/poolux.js?cb=e792b253';
import { readLocks, readLoans, readHeld, lockStep } from '/cbtc/read.js?cb=97e55024';
import { esc, short, grp } from '/trade/util.js?cb=509d6618';

const btcTxt = (sats) => { const x = Number(sats) / 1e8; return x === 0 ? '0' : x >= 1 ? grp(x, 4) : x >= 0.001 ? x.toFixed(6).replace(/0+$/, '') : x.toFixed(8).replace(/0+$/, ''); };
const cusdTxt = (v) => grp(Number(v) / 1e8, Number(v) / 1e8 >= 100 ? 0 : 2);
// where each step of a lock is done today
const NEXT = { 'post its bond': ['Post the bond', '/#lock'], 'ready to mint': ['Mint cBTC', '/#lock'] };

export function mountMine(root, { pick } = {}) {
  let D = null, seq = 0, histP = null;
  const key = makeKeySession({ moved: () => forget() });
  const history = () => (histP ||= import('/confidential-recovery-btc.js').then(({ makeBtcHistoryProvider }) => makeBtcHistoryProvider({ sha256, hrp: 'bc', fetchImpl: (u, o) => fetch(u, o) })));
  function forget() { key.lock(); forgetUx(); seq++; D = null; paint(); }

  async function read() {
    if (!key.unlocked) return paint();
    const pub = key.key.pubHex, my = ++seq, priv = key.priv();
    D = { pub, loading: true }; paint();
    try {
      const ux = await getUx(), hist = await history();
      // each read stands on its own: a failed one is said, the others still show
      const [held, locks, loans] = await Promise.allSettled([readHeld({ ux, priv }), readLocks({ ux, priv, hist }), readLoans({ ux, priv })]);
      if (my !== seq || key.key?.pubHex !== pub) return;
      const v = (r) => (r.status === 'fulfilled' ? r.value : null), why = (r) => (r.status === 'rejected' ? String(r.reason?.message || r.reason).slice(0, 140) : null);
      D = { pub, held: v(held), locks: v(locks), loans: v(loans), errs: { held: why(held), locks: why(locks), loans: why(loans) } };
    } catch (e) { if (my === seq) D = { pub, err: String(e?.message || e).slice(0, 160) }; }
    paint();
  }

  function paint() {
    let h;
    if (!key.unlocked) h = `<p class="note">Your locks, loans and cBTC.</p><button class="btn ghost" type="button" data-mine="open">Show mine</button>`;
    else if (!D || D.loading) h = '<p class="note">Reading your locks and loans…</p>';
    else if (D.err) h = `<p class="note err">${esc(D.err)} <button class="linkbtn" type="button" data-mine="again">Try again</button></p>`;
    else {
      const rows = [], { held, locks, loans, errs } = D;
      if (held) {
        rows.push(`<div class="kv"><span>cBTC, private</span><b class="num">${esc(btcTxt(held.cbtc.value))}</b></div>`);
        if (held.cusd.value > 0n) rows.push(`<div class="kv"><span>cUSD, private</span><b class="num">${esc(cusdTxt(held.cusd.value))}</b></div>`);
      } else rows.push(`<p class="note err">Could not read your balance: ${esc(errs.held)}</p>`);
      if (loans) for (const l of loans) rows.push(`<div class="kv"><span>Loan</span><b class="num">${esc(cusdTxt(l.debt))} cUSD<small>against ${esc(btcTxt(l.cbtc))} cBTC · <a href="/#borrow">Repay</a></small></b></div>`);
      else rows.push(`<p class="note err">Could not read your loans: ${esc(errs.loans)}</p>`);
      if (locks) for (const l of locks) {
        const step = lockStep(l), [act, href] = NEXT[step] || [];
        rows.push(`<div class="kv"><span>Lock ${esc(short(l.lockTxid, 4))}:${l.lockVout}</span><b class="num">${esc(btcTxt(l.sats))} BTC<small class="${l.minted ? 'ok' : ''}">${act ? `<a href="${href}">${act}</a>` : esc(step)}</small></b></div>`);
      }
      else rows.push(`<p class="note err">Could not read your locks: ${esc(errs.locks)}</p>`);
      if (locks && loans && !locks.length && !loans.length) rows.push('<p class="note">No locks or loans yet.</p>');
      h = `<div class="rows flat">${rows.join('')}</div><p class="note"><button class="linkbtn" type="button" data-mine="again">Read again</button> · <button class="linkbtn" type="button" data-mine="lock">Lock your key</button></p>`;
    }
    if (root.__h !== h) { root.__h = h; root.innerHTML = h; }
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mine]');
    if (!b) return;
    const what = b.dataset.mine;
    if (what === 'lock') return forget();
    if (what === 'again') return read();
    signInSheet(key, { pick, why: 'Open your Tacit wallet to see your locks, loans and cBTC. Nothing is stored or sent.' }).then(() => read(), () => {});
  });
  key.onChange(() => { if (key.unlocked && D?.pub !== key.key.pubHex) read(); else paint(); });
  paint();
  return { read, forget };
}
