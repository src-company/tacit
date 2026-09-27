const RK = process.env.RK;
const api = async (p) => { const r = await fetch("https://api.render.com/v1"+p, {headers:{Authorization:`Bearer ${RK}`}}); if(!r.ok) throw new Error(r.status+" "+await r.text()); return r.json(); };
const svcs = (await api("/services?limit=50")).map(x=>x.service||x);
const s = svcs.find(x=>x.name === "tacit-api");
const envs = await api(`/services/${s.id}/env-vars?limit=100`);
const bt = envs.find(e=>e.envVar.key==="CONFIDENTIAL_BOX_TOKEN");
const TOKEN = bt.envVar.value;

const jobRes = await fetch("https://api.tacit.finance/reflection/job?network=mainnet", { headers: { Authorization: `Bearer ${TOKEN}` } });
console.log("status", jobRes.status);
const text = await jobRes.text();
console.log("body bytes:", text.length);
try {
  const job = JSON.parse(text);
  console.log("attestedTo:", job.attestedTo, "jobId:", job.jobId, "hasInput:", !!job.input);
} catch {
  console.log("body:", text.slice(0, 300));
}
