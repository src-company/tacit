// WalletConnect as one more Ethereum wallet. It is announced the way browser wallets announce themselves (EIP-6963), so
// a page's wallet picker lists it beside them with no special case, and on a phone with no wallet extension it is the
// one wallet offered. Its bundle loads the first time it is used. Pairing shows through the page's own sheet: `onPair`
// gets the pairing link, a QR code of it, and `cancel`, and returns a function that puts the sheet away when pairing
// ends (approved, refused or cancelled). A request the wallet app has to approve shows the same way: `onAsk` gets the
// app's name and, where it gave one, a link that opens it, and returns a function called once the app answers.
//
//   announceWalletConnect({ projectId, chains, rpcMap, metadata, onPair, onAsk }) → { provider, disconnect }

const BUNDLE = '/vendor/tacit-walletconnect.min.js?cb=e850e423';
const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#3B99FC"/>'
  + '<path transform="translate(10 18.5) scale(.147)" fill="#fff" d="M61.4 36.3c48.9-47.9 128.3-47.9 177.2 0l5.9 5.8c2.4 2.4 2.4 6.3 0 8.7l-20.1 19.7c-1.2 1.2-3.2 1.2-4.4 0l-8.1-7.9c-34.1-33.4-89.4-33.4-123.5 0l-8.7 8.5c-1.2 1.2-3.2 1.2-4.4 0L55.2 51.4c-2.4-2.4-2.4-6.3 0-8.7l6.2-6.4zm218.9 40.8l17.9 17.5c2.4 2.4 2.4 6.3 0 8.7l-80.7 79c-2.4 2.4-6.4 2.4-8.9 0l-57.3-56.1c-.6-.6-1.6-.6-2.2 0L91.8 182.3c-2.4 2.4-6.4 2.4-8.9 0L1.8 103.3c-2.4-2.4-2.4-6.3 0-8.7l17.9-17.5c2.4-2.4 6.4-2.4 8.9 0l57.3 56.1c.6.6 1.6.6 2.2 0l57.3-56.1c2.4-2.4 6.4-2.4 8.9 0l57.3 56.1c.6.6 1.6.6 2.2 0l57.3-56.1c2.4-2.4 6.4-2.4 8.9 0z"/></svg>');
// Requests the wallet app answers, which is where they are approved.
const ASKS = new Set(['personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_watchAsset']);
const rejected = (message) => Object.assign(new Error(message), { code: 4001 });

export function announceWalletConnect({ projectId, chains, rpcMap, metadata, onPair, onAsk }) {
  const listeners = new Map();                                    // event → handlers, kept until the provider exists
  let wc = null, loading = null;
  const load = () => (wc ? Promise.resolve(wc) : (loading ||= (async () => {
    const { EthereumProvider, qrcode } = await import(BUNDLE);
    const p = await EthereumProvider.init({ projectId, optionalChains: chains, rpcMap, metadata, showQrModal: false, telemetryEnabled: false });
    for (const [ev, fns] of listeners) for (const fn of fns) p.on(ev, fn);
    // A session ended from the wallet app reads to the page as the wallet locking.
    p.on('disconnect', () => { for (const fn of listeners.get('accountsChanged') || []) fn([]); });
    wc = { p, qrcode };
    return wc;
  })().catch((e) => { loading = null; throw e; })));

  async function pair({ p, qrcode }) {
    let cancel, done = null;
    const cancelled = new Promise((_, reject) => { cancel = () => { try { p.signer?.abortPairingAttempt?.(); } catch { /* already ended */ } reject(rejected('Connection cancelled')); }; });
    cancelled.catch(() => {});
    const shown = (uri) => {
      const q = qrcode(0, 'M');
      q.addData(uri); q.make();
      done = onPair?.({ uri, qrSvg: q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }), cancel }) || null;
    };
    p.on('display_uri', shown);
    const connecting = p.connect();
    connecting.catch(() => {});                                   // settles after a cancel too, with no one waiting
    try { await Promise.race([connecting, cancelled]); }
    catch (e) { throw e?.code === 4001 || /reject|denied|cancel/i.test(e?.message || '') ? rejected(e?.message || 'Connection refused') : e; }
    finally { p.removeListener('display_uri', shown); done?.(); }
  }

  // The wallet app as it named itself when it paired, and the link that opens it: its own scheme, else its https link.
  // A browser opens either only from a tap, so the page shows it as a button rather than following it here.
  function peer(p) {
    const m = p.session?.peer?.metadata, r = m?.redirect;
    const native = /^[a-z][a-z0-9+.-]*:/i.test(r?.native || '') && !/^(https?|javascript|data|file|blob|about|vbscript):/i.test(r.native) ? r.native : null;
    return { name: String(m?.name || '').slice(0, 40) || 'your wallet app', link: native || (/^https:\/\//i.test(r?.universal || '') ? r.universal : null) };
  }

  const provider = {
    isWalletConnect: true,
    async request(args) {
      const w = await load();
      if (!w.p.session) {
        if (args?.method === 'eth_accounts') return [];
        if (args?.method !== 'eth_requestAccounts') throw Object.assign(new Error('Connect a wallet through WalletConnect first.'), { code: 4100 });
        await pair(w);
      }
      if (args?.method === 'eth_requestAccounts') return w.p.accounts;
      if (!ASKS.has(args?.method)) return w.p.request(args);
      const done = onAsk?.(peer(w.p)) || null;
      try { return await w.p.request(args); } finally { done?.(); }
    },
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); wc?.p.on(ev, fn); return provider; },
    removeListener(ev, fn) { listeners.get(ev)?.delete(fn); wc?.p.removeListener(ev, fn); return provider; },
  };
  // Ends the session in the wallet app too, and reads to the page as the wallet locking. Nothing to do when WalletConnect
  // was never used here.
  async function disconnect() {
    if (!wc?.p.session) return;
    try { await wc.p.disconnect(); } catch { /* already gone */ }
    for (const fn of listeners.get('accountsChanged') || []) fn([]);
  }

  // Listed beside the wallets that announce themselves, or alone where there is no wallet in the page at all. A wallet
  // app's own browser that only sets window.ethereum keeps being the wallet used there, as before.
  const detail = Object.freeze({ info: Object.freeze({ uuid: crypto.randomUUID(), name: 'WalletConnect', icon: ICON, rdns: 'com.walletconnect' }), provider });
  const others = new Set();
  window.addEventListener('eip6963:announceProvider', (e) => { const u = e.detail?.info?.uuid; if (u && u !== detail.info.uuid) others.add(u); });
  const announce = () => { if (others.size || !window.ethereum) window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })); };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  return { provider, disconnect };
}
