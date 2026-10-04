#!/usr/bin/env node
// Serves a page on localhost that deploys TacitEvmPoolZap from a browser wallet on Ethereum, Base and Robinhood Chain.
// The init code (from this checkout's forge build) goes through the deterministic CREATE2 proxy with one salt, so the
// zap lands at the same address on every chain whoever sends it, and code at that address can only be this init code.
// Before asking the wallet, the page dry-runs the deploy on the chain and sends only if it lands at ZAP.
//   (cd contracts && forge build) && node contracts/script/deploy-zap.mjs [port]
import http from 'node:http';
import { readFileSync } from 'node:fs';

const DIR = new URL('../', import.meta.url).pathname;
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const PROXY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
// Mined for leading zero bytes: cast create2 --starts-with 000000 --init-code-hash <keccak of the init code>.
const SALT = '0x5300daf54c991d5d91b243882b41035f32a46c2509b812b9effde366cd6f70b0';
const ZAP = '0x0000008EbBF2323f95c4fBc18254f3D65C53998c';
const CHAINS = [
  { id: 1, name: 'Ethereum', rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'], explorer: 'https://etherscan.io' },
  { id: 8453, name: 'Base', rpc: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'], explorer: 'https://basescan.org' },
  { id: 4663, name: 'Robinhood Chain', rpc: ['https://rpc.mainnet.chain.robinhood.com'], explorer: 'https://robinhoodchain.blockscout.com' },
];
// RPC_<chainId>=<url> reads a chain through another node (a local fork, for a dry run of this page).
for (const c of CHAINS) if (process.env['RPC_' + c.id]) c.rpc = [process.env['RPC_' + c.id]];

const art = JSON.parse(readFileSync(DIR + 'out/TacitEvmPoolZap.sol/TacitEvmPoolZap.json', 'utf8'));
const word = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const data = SALT + art.bytecode.object.slice(2) + word(POOL) + word(ZROUTER) + word(PERMIT2);

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deploy TacitEvmPoolZap</title>
<style>
:root{--bg:#f7f6f2;--fg:#1d1c1a;--mut:#6b675f;--line:#dcd8cf;--ok:#1f7a4d;--bad:#a8322d;--btn:#1d1c1a;--btnfg:#f7f6f2}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--mut:#9a968c;--line:#33312d;--ok:#5cc28f;--bad:#e2786f;--btn:#ecebe6;--btnfg:#141413}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:var(--mut)}code{font:13px ui-monospace,monospace;word-break:break-all}
.row{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.row b{display:block}.st{font-size:13px;color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad)}
button{background:var(--btn);color:var(--btnfg);border:0;border-radius:8px;padding:9px 14px;font:inherit;cursor:pointer}button:disabled{opacity:.35;cursor:default}
a{color:inherit}
</style></head><body><main>
<h1>Deploy TacitEvmPoolZap</h1>
<p>Same init code and salt through the CREATE2 proxy on each chain, so it lands at <code>${ZAP}</code> everywhere. Constructor: pool <code>${POOL}</code>, zRouter <code>${ZROUTER}</code>, Permit2 <code>${PERMIT2}</code>. Any account can send it; about 661k gas each.</p>
<button id="conn">Connect wallet</button> <span class="st" id="who"></span>
<div id="rows"></div>
<p class="st">Init code: ${(data.length - 66) / 2} bytes · salt <code>${SALT}</code></p>
</main><script>
const ZAP=${JSON.stringify(ZAP)},PROXY=${JSON.stringify(PROXY)},DATA=${JSON.stringify(data)},CHAINS=${JSON.stringify(CHAINS)};
const WANT={'0x7535d246':${JSON.stringify(POOL)},'0x777ff99e':${JSON.stringify(ZROUTER)},'0x6afdd850':${JSON.stringify(PERMIT2)}};
const $=(s)=>document.querySelector(s),lc=(s)=>String(s).toLowerCase();
let acct=null,prov=null;
const wallets=[];window.addEventListener('eip6963:announceProvider',(e)=>wallets.push(e.detail));window.dispatchEvent(new Event('eip6963:requestProvider'));
async function rpc(c,method,params){let err;for(const u of c.rpc){try{const j=await(await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();if(j.error)throw new Error(j.error.message);return j.result}catch(e){err=e}}throw err}
function row(c){return $('#r'+c.id)}
function say(c,html,cls=''){const s=row(c).querySelector('.st');s.className='st '+cls;s.innerHTML=html}
async function check(c){
  const code=await rpc(c,'eth_getCode',[ZAP,'latest']);
  const btn=row(c).querySelector('button');
  if(code&&code!=='0x'){
    const got=await Promise.all(Object.keys(WANT).map((sel)=>rpc(c,'eth_call',[{to:ZAP,data:sel},'latest'])));
    const wired=Object.values(WANT).every((a,i)=>lc('0x'+got[i].slice(-40))===lc(a));
    say(c,wired?'Deployed · '+((code.length-2)/2)+' bytes, wired to the pool, zRouter and Permit2 · <a target="_blank" href="'+c.explorer+'/address/'+ZAP+'">explorer</a>':'Code is there but its wiring does not match',wired?'ok':'bad');
    btn.disabled=true;btn.textContent='Deployed';return true}
  const lands=await rpc(c,'eth_call',[{to:PROXY,data:DATA},'latest']).catch((e)=>'error: '+e.message);
  if(lc('0x'+String(lands).slice(-40))!==lc(ZAP)){say(c,'Dry run does not land at the zap address: '+lands,'bad');btn.disabled=true;return false}
  say(c,'Not deployed yet. The dry run lands at the zap address.');btn.disabled=!acct;return false}
async function onChain(c){
  const hexId='0x'+c.id.toString(16);
  if(Number(await prov.request({method:'eth_chainId'}))===c.id)return;
  try{await prov.request({method:'wallet_switchEthereumChain',params:[{chainId:hexId}]})}
  catch(e){if(e.code!==4902&&!/unrecogni|not been added|unknown chain/i.test(e.message||''))throw e;
    await prov.request({method:'wallet_addEthereumChain',params:[{chainId:hexId,chainName:c.name,nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:[c.rpc[0]],blockExplorerUrls:[c.explorer]}]})}
  if(Number(await prov.request({method:'eth_chainId'}))!==c.id)throw new Error('Switch the wallet to '+c.name)}
async function deploy(c){
  const btn=row(c).querySelector('button');btn.disabled=true;
  try{
    if(await check(c))return;
    say(c,'Switch to '+c.name+' in your wallet…');await onChain(c);
    say(c,'Confirm the deploy in your wallet…');
    const h=await prov.request({method:'eth_sendTransaction',params:[{from:acct,to:PROXY,data:DATA,value:'0x0'}]});
    say(c,'Sent <a target="_blank" href="'+c.explorer+'/tx/'+h+'">'+h.slice(0,10)+'…</a>, waiting for the block…');
    for(let i=0;i<180;i++){const r=await rpc(c,'eth_getTransactionReceipt',[h]).catch(()=>null);
      if(r){if(r.status!=='0x1')throw new Error('The deploy reverted: '+h);break}
      await new Promise((ok)=>setTimeout(ok,2000))}
    await check(c)||say(c,'Sent, but no code yet. Reload in a minute.','bad');
  }catch(e){say(c,String(e.message||e),'bad');btn.disabled=false}}
$('#rows').innerHTML=CHAINS.map((c)=>'<div class="row" id="r'+c.id+'"><div><b>'+c.name+'</b><span class="st">Reading…</span></div><button disabled>Deploy on '+c.name+'</button></div>').join('');
CHAINS.forEach((c)=>{row(c).querySelector('button').onclick=()=>deploy(c);check(c).catch((e)=>say(c,'Could not read '+c.name+': '+e.message,'bad'))});
$('#conn').onclick=async()=>{
  prov=(wallets[0]&&wallets[0].provider)||window.ethereum;
  if(!prov)return($('#who').textContent='No wallet found in this browser.');
  acct=(await prov.request({method:'eth_requestAccounts'}))[0];
  $('#who').textContent='Connected '+acct+(wallets[0]?' ('+wallets[0].info.name+')':'');
  CHAINS.forEach((c)=>check(c).catch(()=>{}))};
</script></body></html>`;

const port = Number(process.argv[2] || 8797);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page);
}).listen(port, '127.0.0.1', () => console.log(`TacitEvmPoolZap deploy page: http://127.0.0.1:${port}  (zap ${ZAP}, init code ${(data.length - 66) / 2} bytes)`));
