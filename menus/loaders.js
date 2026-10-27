import{LSC as t}from"./cache.js";
import{db as DB}from"./cloud-sync.js";
import{doc as vDoc,getDoc as vGet}from"./runtime-ext.js";

/* ======================================================================
   Smart content cache
   ----------------------------------------------------------------------
   - Memory layer on top of localStorage: no repeated JSON.parse of big
     blobs while navigating (smoother), auto-synced across tabs.
   - Long TTLs (catalog 6h, questions 12h) instead of 5 min.
   - Optional server "version stamp": ONE tiny read of settings/contentVersion
     (at most every 15 min, persisted across reloads). If the admin bumped
     it, only then are caches invalidated and re-downloaded.
       settings/contentVersion = { v: <anything>, q: <anything> }
       v changes -> everything is re-fetched
       q changes -> only question banks are re-fetched
     If the doc doesn't exist the app simply falls back to the TTLs.
   - Manual "Check for new content" (rate-limited) also invalidates.
   ====================================================================== */
const MEM=new Map();
if(typeof window!=="undefined")window.addEventListener("storage",e=>{e.key?MEM.delete(e.key):MEM.clear()});

export const CATALOG_TTL=6*36e5;
export const QUESTIONS_TTL=12*36e5;
const CATALOG_TTL_LONG=3*24*36e5,QUESTIONS_TTL_LONG=7*24*36e5;
const VER_CHECK_MS=15*6e4;
const MINTS_KEY="atlas_cache_min_ts_v1",MINTS_Q_KEY="atlas_cache_min_ts_q_v1";
const VER_KEY="atlas_content_ver_v1",VERCHK_KEY="atlas_content_ver_chk_v1",MANUAL_KEY="atlas_manual_refresh_v1";
const num=k=>{try{return Number(localStorage.getItem(k))||0}catch(_){return 0}};
const put=(k,v)=>{try{localStorage.setItem(k,String(v))}catch(_){}};

export function getCachedWithTTL(k){
  if(MEM.has(k))return MEM.get(k);
  const r=t.get(k),v=r&&"object"==typeof r&&"ts"in r&&"data"in r?r:null;
  if(v)MEM.set(k,v);
  return v;
}
export function setCachedWithTTL(k,d){
  const v={data:d,ts:Date.now()};
  MEM.set(k,v);t.set(k,v);
}
/* "missing" | "invalidated" (admin/manual bump) | "expired" (TTL) | "fresh" */
export function cacheState(entry,kind){
  if(!entry)return"missing";
  const min=Math.max(num(MINTS_KEY),"q"===kind?num(MINTS_Q_KEY):0);
  if(entry.ts<min)return"invalidated";
  /* When the admin content stamp is live (window.__alifCV), the stamp is the source of truth:
     content only re-downloads after the admin actually changes it. TTL is just a long safety net. */
  const ttl=window.__alifCV?("q"===kind?QUESTIONS_TTL_LONG:CATALOG_TTL_LONG):("q"===kind?QUESTIONS_TTL:CATALOG_TTL);
  return Date.now()-entry.ts<ttl?"fresh":"expired";
}
export function isFresh(entry,kind){return"fresh"===cacheState(entry,kind)}

let verInflight=null;
function applyVersion(v,q){
  let prev=null;try{prev=JSON.parse(localStorage.getItem(VER_KEY)||"null")}catch(_){}
  put(VER_KEY,JSON.stringify({v,q}));
  if(!prev)return!1;
  let changed=!1;
  if(prev.v!==v){put(MINTS_KEY,Date.now());changed=!0}
  else if(prev.q!==q){put(MINTS_Q_KEY,Date.now());changed=!0}
  if(changed)window.dispatchEvent(new Event("atlas:content-updated"));
  return changed;
}
export function checkContentVersion({force=!1}={}){
  if(verInflight)return verInflight;
  if(!DB||"undefined"!=typeof navigator&&!1===navigator.onLine)return Promise.resolve(!1);
  /* Zero-read path: the stamp arrives through the appVersion listener that is already open. */
  if(window.__alifCV)return Promise.resolve(applyVersion(window.__alifCV.v,window.__alifCV.q));
  if(!force&&Date.now()-num(VERCHK_KEY)<VER_CHECK_MS)return Promise.resolve(!1);
  put(VERCHK_KEY,Date.now());
  verInflight=(async()=>{
    try{
      /* Give the listener up to 1.8s to deliver the stamp before spending a read. */
      await new Promise(r=>{const f=()=>{window.removeEventListener("alif:cv",f);r()};window.addEventListener("alif:cv",f);setTimeout(f,1800)});
      if(window.__alifCV)return applyVersion(window.__alifCV.v,window.__alifCV.q);
      const snap=await vGet(vDoc(DB,"settings","contentVersion"));
      if(!snap.exists())return!1;
      const d=snap.data(),v=null!=d.v?String(d.v):"",q=null!=d.q?String(d.q):"";
      return applyVersion(v,q);
    }catch(_){return!1}finally{verInflight=null}
  })();
  return verInflight;
}
/* Manual refresh: invalidates everything; limited to once / 2 min so it
   can't be abused to burn reads. Returns false when rate-limited. */
export function forceContentRefresh(){
  if(Date.now()-num(MANUAL_KEY)<12e4)return!1;
  put(MANUAL_KEY,Date.now());put(MINTS_KEY,Date.now());
  window.dispatchEvent(new Event("atlas:content-updated"));
  return!0;
}
if("undefined"!=typeof window){
  setTimeout(()=>{checkContentVersion()},1500);
  window.addEventListener("alif:cv",()=>{checkContentVersion()});
  document.addEventListener("visibilitychange",()=>{"visible"===document.visibilityState&&checkContentVersion()});
}

export function escapeHtml(t){return String(t||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
