// Activity on any page: the list this browser keeps (activity.js), in a dialog over the page you are on, so looking at it does not take you
// to the front page. It only reads: the front page's Activity (index.html, front/sheets.js) still runs what is under way, tries again, sends
// what was proved and clears finished rows, and the link at the foot opens it for that. chrome.js opens this from the app switcher's Activity
// row and the header's activity mark; the front page opens its own.
import { readActivity, listed, ended, actOpen, actDone, onActivity } from '/activity.js';

const EXPLORER = { 1: ['https://etherscan.io', 'Etherscan'], 8453: ['https://basescan.org', 'Basescan'], 4663: ['https://robinhoodchain.blockscout.com', 'Blockscout'] };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const day = (t) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : day(t); };
const hashOk = (h) => /^(0x)?[0-9a-fA-F]{64}$/.test(String(h || ''));
function txLink(it) {
  if (!hashOk(it.hash)) return '';
  const [base, site] = it.kind === 'btc' ? ['https://mempool.space', 'mempool.space'] : EXPLORER[it.chain || 1] || EXPLORER[1];
  return ` · <a href="${base}/tx/${esc(it.hash)}" target="_blank" rel="noopener noreferrer">${site} ↗</a>`;
}
function line(it, done, good) {
  if (actOpen(it)) return 'Bridge under way.';
  if (!done) return it.status === 'proven' ? 'Proved, waiting to be sent.' : 'In progress.';
  if (good) return (it.end && it.at && (it.kind === 'tx' || it.kind === 'btc') && !it.flip ? `Confirmed in ${clock(it.end - it.at)}` : 'Done') + txLink(it);
  if (it.status === 'stale') return `Not seen on chain.${txLink(it)}`;
  if (it.status === 'unknown') return `Not known how it ended.${txLink(it)}`;
  return `Did not go through.${txLink(it)}`;
}
function row(it) {
  const done = actDone(it), good = done && (it.status === 'settled' || it.status === 'confirmed'), bad = done && !good && !['unknown', 'stale', 'proven'].includes(it.status);
  const mark = good ? '<i class="tact-m ok" aria-label="Done">✓</i>' : bad ? '<i class="tact-m err" aria-label="Did not go through">✕</i>' : '';
  const when = done ? `<span>${esc(ago(it.end || it.up || it.at))}</span>` : `<span class="num"><i class="tact-live" aria-hidden="true"></i><span data-since="${Number(it.at) || Date.now()}">${clock(Date.now() - (Number(it.at) || Date.now()))}</span></span>`;
  return `<li class="tact-r${done ? ' fin' : ''}"><div class="tact-h"><b>${mark}${esc(it.label || 'Activity')}</b>${when}</div><div class="tact-f">${line(it, done, good)}</div></li>`;
}
function body() {
  const items = listed(readActivity().items).filter((it) => !it.retried).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  const on = items.filter((x) => !actDone(x)), off = items.filter(actDone), needs = items.some((x) => !actDone(x) || (ended(x) && x.status === 'failed'));
  const head = (t, n) => `<h3 class="tact-k">${t}${n ? ` <span class="num">${n}</span>` : ''}</h3>`;
  const list = items.length
    ? `${on.length ? `${off.length ? head('In progress', on.length) : ''}<ol class="tact-l">${on.map(row).join('')}</ol>` : ''}${off.length ? `${on.length ? head('Earlier') : ''}<ol class="tact-l">${off.map(row).join('')}</ol>` : ''}`
    : '<p class="tact-0">Nothing yet. What you send, and what the relay proves for you, shows up here as it happens.</p>';
  return `${list}<div class="tact-foot"><span>Kept in this browser only. Your balances never depend on it.</span>${items.length ? `<a href="/#activity"${needs ? ' class="go"' : ''}>${needs ? 'Follow it and act on it on the front page →' : 'Full details →'}</a>` : ''}</div>`;
}

let dlg = null, tick = 0;
function paint() { if (dlg?.open) dlg.querySelector('.tact-b').innerHTML = body(); }
export function openActivity() {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'tact'; dlg.setAttribute('aria-labelledby', 'tact-t');
    dlg.innerHTML = '<div class="tact-in"><div class="tact-top"><h2 id="tact-t" tabindex="-1">Activity</h2><button class="tact-x" type="button" aria-label="Close">×</button></div><div class="tact-b"></div></div>';
    document.body.append(dlg);
    dlg.querySelector('.tact-x').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });       // a click on the backdrop shuts it
    dlg.addEventListener('close', () => { clearInterval(tick); tick = 0; });
    onActivity(paint);
  }
  dlg.querySelector('.tact-b').innerHTML = body();
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('#tact-t').focus();
  clearInterval(tick);
  tick = setInterval(() => { for (const s of dlg.querySelectorAll('[data-since]')) s.textContent = clock(Date.now() - Number(s.dataset.since)); }, 1000);
}
