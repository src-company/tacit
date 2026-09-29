// tacit.finance/tac — shielded TAC on Bitcoin.
//
// Everything here runs against the same modules the /sats page uses: dapp/sats/secret.js owns the pool
// operations (shield, private pay, exit, note scanning) and dapp/tacit.js owns the wallet and the chain
// reads. This file is the page: wallet gate, balances, the four panes, and the live pool strip.
//
// Every proof is made on this device. The pool's relayer is used for payments whenever it quotes TAC —
// then the sender needs no BTC at all and pays the relayer inside the pool. Shields and exits always fund
// their own carrier, by design, so those need a little BTC in the wallet.

const SATS_URL = '/tac/sats.js?cb=032e8bf8';   // token rewritten by build/build.mjs (TAC_CB_FILES)

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let T = null;          // dapp/tacit.js
let S = null;          // dapp/sats/secret.js
let poolWallet = null;
let pub = { loading: false, notes: [], decimals: 8 };
let shielded = { loading: false, notes: [] };
let relayLive = null;
let busyId = null;

const DECIMALS = 8;
const fmt = (units, d = DECIMALS) => {
  const s = BigInt(units).toString().padStart(d + 1, '0');
  const whole = s.slice(0, -d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(-d).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};
const parseUnits = (str, d = DECIMALS) => {
  const m = String(str || '').trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2]) || (m[2] || '').length > d) throw new Error(`Enter an amount with at most ${d} decimals.`);
  return BigInt((m[1] || '0') + (m[2] || '').padEnd(d, '0'));
};
const short = (s, a = 14, b = 8) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const txLink = (txid) => {
  const a = document.createElement('a');
  a.href = `https://mempool.space/tx/${txid}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = `${txid.slice(0, 10)}…`;
  return a;
};
function say(id, ...nodes) {
  const el = $(id);
  if (!el) return;
  el.replaceChildren(...nodes.map((n) => (typeof n === 'string' ? document.createTextNode(n) : n)));
}
function errSay(id, e) {
  const msg = String(e?.message || e || 'Something went wrong.');
  const span = document.createElement('span');
  span.className = 'err'; span.setAttribute('role', 'alert'); span.textContent = msg;
  say(id, span);
  if (!/^Cancelled/.test(msg)) console.warn('[tac]', id, e);
}

async function busy(btn, id, fn) {
  if (busyId) return;
  busyId = id;
  const wasDisabled = btn.disabled;
  btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try { await fn(); }
  catch (e) { errSay(id, e); }
  finally { busyId = null; btn.disabled = wasDisabled; btn.removeAttribute('aria-busy'); }
}

// ── modules ──
async function loadTacit() {
  if (T) return T;
  globalThis.__TACIT_NO_INIT__ = true;
  try { localStorage.setItem('tacit-network-v1', 'mainnet'); } catch {}
  T = await import('/tacit.js');
  S = await import('/sats/secret.js');
  return T;
}

// ── wallet ──
function haveWallet() { return !!(T && T.wallet.pub); }

function refreshChip() {
  const dot = $('wallet-dot'), label = $('wallet-label');
  if (!haveWallet()) { dot.className = 'dot'; label.textContent = 'Connect'; return; }
  dot.className = T.wallet.priv ? 'dot on' : 'dot live';
  label.textContent = T.wallet.priv ? short(T.wallet.address(), 10, 6) : 'Unlock';
}

// Unlock if needed, and always leave `poolWallet` derived. These are separate conditions: a key can already
// be in memory while this page has never derived the pool wallet from it, and every pool call below would
// then be handed a null wallet.
async function ensureKey() {
  if (!haveWallet()) throw new Error('Connect a wallet first.');
  if (!T.wallet.priv) await T.ensurePrivkey();
  if (!poolWallet) afterUnlock();
}

function afterUnlock() {
  poolWallet = S.poolWalletFor(T.wallet.priv, 'mainnet');
  $('recv-addr').value = poolWallet.addressString;
  refreshChip();
}

async function createWallet() {
  await loadTacit();
  const existed = !!T.wallet.pub || !!store.get('tacit-wallet-v1');
  await T.wallet.load();
  afterUnlock();
  $('connect-sheet').close();
  say('st-connect', '');
  if (!existed) showKey();
  await refreshAll();
}

async function importKey() {
  await loadTacit();
  const hex = $('import-key').value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('A Tacit key is 64 hex characters.');
  await T.wallet.setPriv(hex);
  $('import-key').value = '';
  afterUnlock();
  $('connect-sheet').close();
  await refreshAll();
}

function showKey() {
  if (!T?.wallet.priv) return;
  $('key-out').value = T.bytesToHex(T.wallet.priv);
  $('key-sheet').showModal();
}

// ── balances ──
async function loadPublic() {
  if (!T?.wallet.priv) return;
  pub = { ...pub, loading: true }; renderBalances();
  try {
    const h = await T.scanHoldings();
    const entry = h instanceof Map ? h.get(S.TAC_ASSET_MAINNET) : null;
    pub = {
      loading: false,
      notes: entry?.utxos || [],
      decimals: Number.isInteger(entry?.decimals) ? entry.decimals : DECIMALS,
    };
  } catch (e) { pub = { ...pub, loading: false }; errSay('st-shield', e); }
  renderBalances(); renderShieldPicker();
}

async function loadShielded() {
  if (!poolWallet) return;
  shielded = { ...shielded, loading: true }; renderBalances();
  try { shielded = { loading: false, notes: await S.poolNotes(poolWallet, S.TAC_ASSET_MAINNET) }; }
  catch (e) { shielded = { ...shielded, loading: false }; errSay('st-recv', e); }
  renderBalances();
}

const noteVal = (u) => (typeof u.amount === 'bigint' ? u.amount : BigInt(u.amount));
const publicTotal = () => pub.notes.reduce((t, u) => t + noteVal(u), 0n);
const shieldedTotal = () => (shielded.notes || []).filter((n) => !n.spent).reduce((t, n) => t + BigInt(n.value), 0n);

function renderBalances() {
  $('bal-shielded').textContent = !haveWallet() ? '—' : shielded.loading ? '…' : fmt(shieldedTotal());
  $('bal-public').textContent = !haveWallet() ? '—' : pub.loading ? '…' : fmt(publicTotal());
  // Spends pad to three outputs with zero-value notes so the real count stays hidden on chain. They are
  // padding, not holdings — counting them would tell the wallet's owner they have notes they don't.
  const n = (shielded.notes || []).filter((x) => !x.spent && BigInt(x.value) > 0n).length;
  $('bal-note').textContent = !haveWallet() ? 'Connect a wallet to see your balances.'
    : !T.wallet.priv ? 'Unlock to scan the pool for your notes.'
    : `${n} shielded note${n === 1 ? '' : 's'} only you can see.`;
  $('btn-refresh').hidden = !haveWallet();
}

function renderShieldPicker() {
  const sel = $('shield-pick');
  sel.replaceChildren();
  if (!pub.notes.length) {
    const o = document.createElement('option');
    o.textContent = T?.wallet.priv ? 'No public TAC in this wallet' : 'Unlock to load your TAC';
    sel.append(o); sel.disabled = true; return;
  }
  sel.disabled = false;
  [...pub.notes]
    .sort((a, b) => (noteVal(b) > noteVal(a) ? 1 : noteVal(b) < noteVal(a) ? -1 : 0))
    .forEach((u, i) => {
      const o = document.createElement('option');
      o.value = `${u.utxo.txid}:${u.utxo.vout}`;
      o.textContent = `${fmt(noteVal(u))} TAC`;
      if (i === 0) o.selected = true;
      sel.append(o);
    });
}

// ── pool stats ──
async function loadStats() {
  try {
    const st = await S.poolClientFor('mainnet').status();
    $('s-set').textContent = Number(st.leafCount || 0).toLocaleString('en-US');
    $('s-height').textContent = Number(st.height || 0).toLocaleString('en-US');
    $('s-proof').textContent = st.proofSystem === 'halo2-kzg-bn254' ? 'Halo2·KZG' : (st.proofSystem || '—');
    const feed = await S.poolClientFor('mainnet').allNotes().catch(() => null);
    const spends = feed ? new Set(feed.filter((n) => n.txid).map((n) => n.txid)).size : null;
    $('s-spends').textContent = spends == null ? '—' : spends.toLocaleString('en-US');
  } catch { /* the strip stays dashed; the page still works */ }
  try {
    relayLive = !!(await S.poolClientFor('mainnet').relayInfo());
  } catch { relayLive = false; }
  renderRelayNote();
}

function renderRelayNote() {
  const el = $('relay-note');
  if (!el) return;
  el.textContent = relayLive
    ? 'A relayer is live: payments ride it, paying their fee in TAC, so you need no bitcoin at all.'
    : 'No relayer is quoting TAC right now, so payments fund their own Bitcoin fee from this wallet.';
}

// ── actions ──
async function doShield() {
  await ensureKey();
  if (!pub.notes.length) await loadPublic();
  const picked = $('shield-pick').value;
  const u = pub.notes.find((x) => `${x.utxo.txid}:${x.utxo.vout}` === picked) || pub.notes[0];
  if (!u) throw new Error('No public TAC in this wallet yet.');
  const blinding = (() => {
    const v = u.blinding;
    const big = typeof v === 'bigint' ? v : BigInt(/^0x/i.test(String(v)) ? v : '0x' + String(v));
    return big.toString(16).padStart(64, '0');
  })();
  const note = { assetId: S.TAC_ASSET_MAINNET, txid: u.utxo.txid, vout: u.utxo.vout, amount: noteVal(u).toString(), blinding };
  const r = await S.shieldNote(T, { note, poolWallet, say: (m) => say('st-shield', m) });
  say('st-shield', `${fmt(r.poolNote.value)} TAC shielded in `, txLink(r.revealTxid), '. It joins the pool after one confirmation.');
  try { T.invalidateHoldingsCache?.(); } catch {}
  await loadPublic(); await loadShielded();
}

async function doSend(anchor = null) {
  await ensureKey();
  const to = $('send-to').value.trim();
  if (!to) throw new Error('Paste the pool address you are paying.');
  const amount = parseUnits($('send-amt').value);
  if (amount <= 0n) throw new Error('Enter an amount above zero.');
  const r = await S.payPrivately(T, { poolWallet, to, amount, asset: S.TAC_ASSET_MAINNET, anchor, say: (m) => say('st-send', m) });
  if (r.wait) return waitBox('st-send', r, (tip) => doSend(tip));
  $('send-to').value = ''; $('send-amt').value = '';
  say('st-send', `Sent ${fmt(amount)} TAC in `, txLink(r.revealTxid), r.relayed ? ' — relayed, you paid the fee in TAC.' : ' — self-funded.');
  await loadShielded();
}

async function doExit(anchor = null) {
  await ensureKey();
  const amount = parseUnits($('exit-amt').value);
  if (amount <= 0n) throw new Error('Enter an amount above zero.');
  const r = await S.exitToWallet(T, { poolWallet, amount, asset: S.TAC_ASSET_MAINNET, anchor, say: (m) => say('st-exit', m) });
  if (r.wait) return waitBox('st-exit', r, (tip) => doExit(tip));
  $('exit-amt').value = '';
  say('st-exit', `${fmt(amount)} TAC withdrawn in `, txLink(r.revealTxid), '. The rest stays shielded.');
  try { T.invalidateHoldingsCache?.(); } catch {}
  await loadPublic(); await loadShielded();
}

// A note younger than the wallet's anchor policy can still be spent — against the newest block instead of a
// settled one — but that tells an observer the note is new. The choice is the wallet owner's, not ours.
function waitBox(statusId, w, retry) {
  const wrap = document.createElement('div');
  const p = document.createElement('div');
  p.textContent = `Your newest note needs ${w.wait} more Bitcoin block${w.wait === 1 ? '' : 's'} (about ${w.wait * 10} min) before the wallet will spend it against a settled block.`;
  const row = document.createElement('div');
  row.className = 'row2';
  const now = document.createElement('button');
  now.className = 'btn ghost'; now.textContent = 'Spend now anyway';
  now.onclick = () => busy(now, statusId, () => retry(w.tip));
  const wait = document.createElement('button');
  wait.className = 'btn ghost'; wait.textContent = 'Wait';
  wait.onclick = () => say(statusId, 'Waiting. Try again in a few minutes.');
  row.append(now, wait);
  const why = document.createElement('p');
  why.className = 'note';
  why.textContent = 'Spending now anchors at the newest block, which hints to an observer that the note is fresh.';
  wrap.append(p, row, why);
  say(statusId, wrap);
}

// ── tabs ──
function tabs(ids, panes, onPick) {
  ids.forEach((id, i) => {
    $(id).addEventListener('click', () => {
      ids.forEach((x, j) => { $(x).setAttribute('aria-selected', String(i === j)); $(panes[j]).hidden = i !== j; });
      onPick?.(i);
    });
  });
}

async function refreshAll() {
  renderBalances(); refreshChip();
  await Promise.all([loadPublic(), loadShielded()]);
}

// ── boot ──
(async function boot() {
  tabs(['tab-shield', 'tab-send', 'tab-withdraw', 'tab-receive'], ['pane-shield', 'pane-send', 'pane-withdraw', 'pane-receive'],
    (i) => { if (i === 3 && poolWallet) $('recv-addr').value = poolWallet.addressString; });
  tabs(['wtab-self', 'wtab-sats'], ['wpane-self', 'wpane-sats'], (i) => { if (i === 1) renderSats(); });

  $('wallet-chip').onclick = async () => {
    await loadTacit();
    if (!haveWallet()) return $('connect-sheet').showModal();
    if (!T.wallet.priv) return busy($('wallet-chip'), 'st-connect', async () => { await ensureKey(); await refreshAll(); });
    showKey();
  };
  $('connect-x').onclick = () => $('connect-sheet').close();
  $('key-x').onclick = () => $('key-sheet').close();
  $('btn-create').onclick = (e) => busy(e.currentTarget, 'st-connect', createWallet);
  $('btn-import').onclick = (e) => busy(e.currentTarget, 'st-connect', importKey);
  $('btn-key-copy').onclick = () => { navigator.clipboard?.writeText($('key-out').value); };
  $('btn-refresh').onclick = () => refreshAll();

  $('btn-shield').onclick = (e) => busy(e.currentTarget, 'st-shield', doShield);
  $('btn-send').onclick = (e) => busy(e.currentTarget, 'st-send', () => doSend());
  $('btn-exit').onclick = (e) => busy(e.currentTarget, 'st-exit', () => doExit());
  // "max" before the pool scan has run would otherwise quietly write 0 and look like an empty balance.
  const maxInto = (field, statusId) => async () => {
    if (!haveWallet()) return say(statusId, 'Connect a wallet first.');
    if (!shielded.notes.length && !shielded.loading) { await ensureKey(); await loadShielded(); }
    const total = shieldedTotal();
    if (total <= 0n) return say(statusId, 'Nothing shielded yet — shield some TAC first.');
    $(field).value = fmt(total);
    say(statusId, '');
  };
  $('send-max').onclick = () => maxInto('send-amt', 'st-send')().catch((e) => errSay('st-send', e));
  $('exit-max').onclick = () => maxInto('exit-amt', 'st-exit')().catch((e) => errSay('st-exit', e));
  $('btn-copy').onclick = () => {
    if (!poolWallet) return say('st-recv', 'Unlock the wallet first — your pool address is derived from its key.');
    navigator.clipboard?.writeText(poolWallet.addressString);
    say('st-recv', 'Address copied.');
  };
  $('btn-scan').onclick = (e) => busy(e.currentTarget, 'st-recv', async () => { await ensureKey(); await loadShielded(); say('st-recv', 'Scanned.'); });

  await loadTacit();
  // A key already saved in this browser shows as connected-but-locked. Reading the stored pubkey needs no
  // passphrase; unlocking is always a deliberate click, never something this page does on load.
  try {
    const j = JSON.parse(store.get('tacit-wallet-v1:mainnet') || 'null');
    if (j && /^0[23][0-9a-f]{64}$/.test(j.pub || '')) T.wallet.pub = T.hexToBytes(j.pub);
  } catch {}
  refreshChip(); renderBalances(); renderShieldPicker();
  await loadStats();
  if (T.wallet.priv) await refreshAll();
})();

// ── withdraw to sats ──
// Filled in by renderSats(); see sats.js.
function renderSats() {
  const host = $('sats-body');
  if (host.dataset.ready) return;
  host.dataset.ready = '1';
  import(SATS_URL).then((m) => m.mount(host, {
    get T() { return T; }, get S() { return S; }, get poolWallet() { return poolWallet; },
    ensureKey, busy, say, errSay, fmt, parseUnits, shieldedTotal, txLink, loadShielded,
  })).catch((e) => { host.textContent = ''; errSay('st-exit', e); });
}
