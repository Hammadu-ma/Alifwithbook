/* ALIF Med — tiny TTL cache for rarely-changing Firestore reads (settings, price lists, catalog lists).
   Serves from localStorage while fresh; falls back to stale data if the network read fails. */
const PFX='atlas_rc_';
export async function ttlRead(key,ttlMs,fetcher){
  const k=PFX+key;
  let hit=null;
  try{hit=JSON.parse(localStorage.getItem(k)||'null')}catch(_){}
  if(hit&&Date.now()-hit.t<ttlMs)return hit.d;
  try{
    const d=await fetcher();
    try{localStorage.setItem(k,JSON.stringify({t:Date.now(),d}))}catch(_){}
    return d;
  }catch(e){
    if(hit)return hit.d;
    throw e;
  }
}
export function dropRead(key){try{localStorage.removeItem(PFX+key)}catch(_){}}

if(typeof window!=='undefined')window.addEventListener('atlas:content-updated',()=>{dropRead('packages');dropRead('modules_all')});
