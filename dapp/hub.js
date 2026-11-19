// The front page as a hub: before the first paint, say which view the page opens on, so the old long page never flashes.
//   /               html[data-hub="home"]   the hero and the grid of apps (#hub), nothing else
//   /#app=shield    html[data-hub="shield"] one tool alone: the tile on that tab, its tab strip hidden, a back link to the hub
//   /#card=…        html[data-hub="card"]   a link that fills the tile: a focused view too; the page's module names the tab once it has read the link
// A sheet's link (#portfolio, #activity, …) opens over the hub. The SPX and TAC pages (html[data-page]) are made from this page and stay as they are.
(function () {
  var d = document.documentElement;
  if (d.dataset.page) return;
  var p = location.pathname, h = location.hash;
  if (p !== '/' && p !== '/index.html') return;
  var app = /^#app=([a-z]+)$/.exec(h);
  d.dataset.hub = app ? app[1] : /^#card=/.test(h) ? 'card' : 'home';
})();
