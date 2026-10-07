// Routing for the front page, run in <head> so that a link meant for another page moves on before this one renders.
// The host serves this page for / and for every path that is not a file, so links made for the classic app (now
// /classic.html) and for this page's old home (/weld/, /lite/) arrive here. The query and fragment are carried over
// unchanged; a fragment never leaves the browser, which matters for the ones that carry a secret (#recv=, #claim=).
(function () {
  var CLASSIC = '/classic.html';
  // The classic app's tabs, which it writes into the address bar as clean paths (/market?aid=…). Mirrors preboot.js.
  var TABS = ['wallet', 'holdings', 'transfer', 'discover', 'market', 'pool', 'farms', 'etch', 'factory', 'drops', 'claim',
    'about', 'mixer', 'confidential-pool', 'otc', 'cdp', 'csend', 'cswap', 'earn', 'airdrop', 'points', 'govern'];
  // Pages in their own directories, asked for without the trailing slash.
  var PAGES = ['sats', 'secret-sats', 'ceremony', 'tacit-v1', 'tac', 'pay'];
  // The fragments and queries the classic app reads; this page's own are bare names (#eth, #farm) and #sp=/#st=.
  var CLASSIC_HASH = /^#(?:(?:tab|recv|claim|dclaim|gate|tacit-invoice|amm)=|amm-?ceremony$)/;
  var CLASSIC_QUERY = ['ceremony', 'coordinator', 'amm', 'ammceremony'];
  try {
    var loc = window.location, path = loc.pathname, q = loc.search, h = loc.hash;
    var seg = ((path.match(/^\/([a-z0-9-]+)\/?$/i) || [])[1] || '').toLowerCase();
    if (PAGES.indexOf(seg) !== -1 && !/\/$/.test(path)) return loc.replace('/' + seg + '/' + q + h);
    if (seg === 'classic') return loc.replace(CLASSIC + q + h);
    if (TABS.indexOf(seg) !== -1) {
      if (h) return loc.replace(CLASSIC + q + h);
      // The tab rides in the fragment, as preboot.js would put it, so the classic page opens on it.
      var qs = new URLSearchParams(q), aid = qs.get('aid') || '', lane = qs.get('lane') || '', tab = '#tab=' + seg;
      qs.delete('aid'); qs.delete('lane');
      if (/^[0-9a-f]{64}$/i.test(aid)) tab += '&aid=' + aid.toLowerCase() + (lane === 'btc' || lane === 'eth' ? '&lane=' + lane : '');
      var rest = qs.toString();
      return loc.replace(CLASSIC + (rest ? '?' + rest : '') + tab);
    }
    var params = new URLSearchParams(q);
    if (CLASSIC_HASH.test(h) || CLASSIC_QUERY.some(function (k) { return params.has(k); })) return loc.replace(CLASSIC + q + h);
    if (path !== '/') window.history.replaceState(null, '', '/' + q + h);
  } catch (e) { /* never keep the page from loading */ }
})();
