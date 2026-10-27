/* ALIF Med — Unified Access Manager
   One screen for effective student entitlements. Bundles/payments are sources,
   not competing access systems. Runtime entitlements live at:
   access/{uid}/resources/{resourceKey}
*/
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, query, orderBy, setDoc, deleteDoc,
  serverTimestamp, Timestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const app = getApp();
const auth = getAuth(app);
const db = getFirestore(app);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key = (type,id) => `${type}_${String(id).replace(/[^A-Za-z0-9_-]/g,'')}`;
const toMs = t => !t ? 0 : t.toMillis ? t.toMillis() : t.seconds ? t.seconds*1000 : Number(t)||0;

let state = { students: [], modules: [], subjects: [], quizzes: [], packages: [], selected: null, grants: new Map(), initialized:false };

function toast(msg,type='info'){ window.toast?.(msg,type); }
function hasPermission(){ return !!window.__alifAdminHasPermission?.('programaccess') || !!window.__alifAdminIsOwner?.(); }
function resourceLabel(t,id){
  const a = t==='module' ? state.modules : t==='subject' ? state.subjects : state.quizzes;
  const x = a.find(v=>v.id===id); return x?.name || `${t} ${id}`;
}
function studentLabel(id){ const s=state.students.find(x=>x.id===id); return s ? `${s.name||'Unnamed'}${s.batch?` · ${s.batch}`:''}` : id; }
function expiryText(ms){ if(!ms) return 'No expiry'; return new Date(ms).toLocaleDateString([], {year:'numeric',month:'short',day:'numeric'}); }

async function loadCatalog(){
  const readCol = async name => (await getDocs(collection(db,name))).docs.map(d=>({id:d.id,...d.data()}));
  state.modules = await readCol('modules');
  state.subjects = await readCol('subjects');
  state.packages = await readCol('packages');
  state.quizzes = [];
  for (const s of state.subjects) {
    const q = await getDocs(collection(db,'subjects',s.id,'quizzes'));
    q.forEach(d => state.quizzes.push({id:d.id,...d.data(),subjectId:s.id}));
  }
}
async function loadStudents(){
  const snap=await getDocs(collection(db,'secretkeys'));
  state.students=snap.docs.map(d=>({id:d.id,...d.data()})).filter(s=>s.authUid);
  state.students.sort((a,b)=>(a.name||'').localeCompare(b.name||''));
}

async function loadSelectedGrants(){
  state.grants.clear(); if(!state.selected) return;
  const snap=await getDocs(collection(db,'access',state.selected,'resources'));
  snap.forEach(d=>state.grants.set(d.id,d.data()));
}

function renderStudents(){
  const q=($('amStudentSearch')?.value||'').trim().toLowerCase();
  const rows=state.students.filter(s=>!q || [s.name,s.batch,s.ID,s.email].some(v=>String(v||'').toLowerCase().includes(q))).slice(0,100);
  $('amStudentList').innerHTML=rows.length?rows.map(s=>`<button class="am-student ${s.id===state.selected?'active':''}" data-student="${esc(s.id)}"><span class="am-avatar">${esc((s.name||'?').trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase())}</span><span class="am-student-text"><b>${esc(s.name||'Unnamed')}</b><small>${esc([s.batch,s.ID].filter(Boolean).join(' · '))}</small></span><span class="am-chevron">›</span></button>`).join(''):'<div class="am-empty">No students found.</div>';
  $('amStudentList').querySelectorAll('[data-student]').forEach(b=>b.addEventListener('click',()=>selectStudent(b.dataset.student)));
}

function renderGrantRows(){
  const rows=[...state.grants.entries()].filter(([,g])=>g.mode==='allow' && g.status==='active').sort((a,b)=>String(a[1].resourceType).localeCompare(String(b[1].resourceType)));
  const box=$('amGrantList');
  if(!rows.length){ box.innerHTML='<div class="am-empty">No active access grants for this student.</div>'; return; }
  box.innerHTML=rows.map(([k,g])=>`<div class="am-grant"><div><span class="am-type">${esc(g.resourceType)}</span><b>${esc(g.resourceLabel||resourceLabel(g.resourceType,g.resourceId))}</b><small>${esc(g.sourceLabel||g.sourceType||'Manual')} · ${expiryText(toMs(g.expiresAt))}</small></div><button class="am-revoke" data-revoke="${esc(k)}">Remove</button></div>`).join('');
  box.querySelectorAll('[data-revoke]').forEach(b=>b.addEventListener('click',()=>removeGrant(b.dataset.revoke)));
}

function renderSummary(){
  const n=[...state.grants.values()].filter(g=>g.mode==='allow'&&g.status==='active').length;
  $('amSelectedStudent').textContent=state.selected?studentLabel(state.selected):'Select a student';
  $('amGrantCount').textContent=String(n);
  $('amGrantList').innerHTML='<div class="am-empty">Loading access…</div>';
}

async function selectStudent(id){ state.selected=id; renderStudents(); renderSummary(); await loadSelectedGrants(); renderGrantRows(); }

function selectedResource(){
  const type=$('amResourceType').value, id=$('amResourceId').value; return type&&id?{type,id}:null;
}
function populateResources(){
  const type=$('amResourceType').value;
  const arr=type==='module'?state.modules:type==='subject'?state.subjects:type==='quiz'?state.quizzes:state.packages;
  $('amResourceId').innerHTML='<option value="">Choose…</option>'+arr.map(x=>`<option value="${esc(x.id)}">${esc(x.name||x.title||x.id)}</option>`).join('');
}

function expiryFromUI(){
  const v=$('amExpiry').value;
  if(v==='forever') return null;
  const d=$('amExpiryDate').value;
  if(v==='date') { if(!d) throw new Error('Choose an expiry date.'); return Timestamp.fromDate(new Date(`${d}T23:59:59`)); }
  const months=Number(v), dt=new Date(); dt.setMonth(dt.getMonth()+months); return Timestamp.fromDate(dt);
}

async function saveGrant(mode){
  if(!hasPermission()) throw new Error('You do not have permission to manage access.');
  if(!state.selected) throw new Error('Select a student first.');
  const r=selectedResource(); if(!r) throw new Error('Choose what to change.');
  const expiresAt=mode==='allow'?expiryFromUI():null;
  const k=key(r.type,r.id), ref=doc(db,'access',state.selected,'resources',k);
  const payload={resourceType:r.type,resourceId:r.id,resourceLabel:resourceLabel(r.type,r.id),mode,status:'active',expiresAt,sourceType:$('amSource').value||'manual',sourceId:$('amSourceId').value.trim()||null,sourceLabel:$('amSourceLabel').value.trim()||'Manual',updatedAt:serverTimestamp(),updatedBy:auth.currentUser?.uid||null};
  await setDoc(ref,payload,{merge:true});
  await setDoc(doc(collection(db,'accessHistory')),{studentId:state.selected,resourceKey:k,...payload,action:mode==='allow'?'grant':'deny',createdAt:serverTimestamp(),createdBy:auth.currentUser?.uid||null});
  await loadSelectedGrants(); renderGrantRows(); toast(mode==='allow'?'Access granted':'Access blocked','success');
}

async function removeGrant(k){
  if(!state.selected) return;
  if(!confirm('Remove this access grant?')) return;
  await deleteDoc(doc(db,'access',state.selected,'resources',k));
  await setDoc(doc(collection(db,'accessHistory')),{studentId:state.selected,resourceKey:k,action:'revoke',createdAt:serverTimestamp(),createdBy:auth.currentUser?.uid||null});
  await loadSelectedGrants(); renderGrantRows(); toast('Access removed','info');
}

async function grantBundle(){
  if(!state.selected) throw new Error('Select a student first.');
  const id=$('amResourceId').value, p=state.packages.find(x=>x.id===id); if(!p) throw new Error('Choose a bundle.');
  const expiresAt=expiryFromUI(), ops=[];
  for(const mid of (p.moduleIds||[])) if(state.modules.some(x=>x.id===mid)) ops.push(['module',mid]);
  for(const sid of (p.subjectIds||[])) if(state.subjects.some(x=>x.id===sid)) ops.push(['subject',sid]);
  if(!ops.length) throw new Error('This bundle contains no modules or subjects.');
  const b=writeBatch(db);
  for(const [type,rid] of ops){ b.set(doc(db,'access',state.selected,'resources',key(type,rid)),{resourceType:type,resourceId:rid,resourceLabel:resourceLabel(type,rid),mode:'allow',status:'active',expiresAt,sourceType:'bundle',sourceId:id,sourceLabel:p.name||'Bundle',updatedAt:serverTimestamp(),updatedBy:auth.currentUser?.uid||null},{merge:true}); }
  await b.commit(); await loadSelectedGrants(); renderGrantRows(); toast(`Bundle access granted (${ops.length} items)`,'success');
}

function buildUI(){
  const panel=document.getElementById('tab-access'); if(!panel) return;
  panel.innerHTML=`<div class="am-layout"><aside class="am-sidebar"><div class="am-side-head"><div><h2>Access</h2><p>One place to manage what each student can use.</p></div></div><input id="amStudentSearch" class="am-search" placeholder="Search students…" autocomplete="off"><div id="amStudentList" class="am-students"></div></aside><main class="am-main"><div class="am-main-head"><div><div class="am-eyebrow">STUDENT ACCESS</div><h3 id="amSelectedStudent">Select a student</h3><span><b id="amGrantCount">0</b> active grants</span></div></div><section class="am-card"><div class="am-card-head"><div><b>Grant or change access</b><small>Choose one content scope. Access is stored separately from the catalog and devices.</small></div></div><div class="am-form"><label>What <select id="amResourceType"><option value="module">Module</option><option value="subject">Subject</option><option value="quiz">Quiz</option><option value="package">Bundle</option></select></label><label>Resource <select id="amResourceId"><option value="">Choose…</option></select></label><label>Duration <select id="amExpiry"><option value="forever">No expiry</option><option value="1">1 month</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">1 year</option><option value="date">Until date…</option></select></label><label id="amDateWrap" class="hidden">Expiry date <input id="amExpiryDate" type="date"></label></div><div class="am-source"><input id="amSource" value="manual" type="hidden"><input id="amSourceId" placeholder="Source ID (optional)"><input id="amSourceLabel" placeholder="Reason / source label" value="Manual"></div><div class="am-actions"><button id="amGrantBtn" class="btn btn-primary">Grant access</button><button id="amDenyBtn" class="btn btn-warning">Block for student</button></div></section><section class="am-card"><div class="am-card-head"><div><b>Current access</b><small>Only active grants are shown. Removing a grant takes effect immediately.</small></div></div><div id="amGrantList"></div></section></main></div>`;
  $('amStudentSearch').addEventListener('input',renderStudents); $('amResourceType').addEventListener('change',populateResources);
  $('amExpiry').addEventListener('change',()=> $('amDateWrap').classList.toggle('hidden',$('amExpiry').value!=='date'));
  $('amGrantBtn').addEventListener('click',async()=>{try{$('amGrantBtn').disabled=true; if($('amResourceType').value==='package') await grantBundle(); else await saveGrant('allow');}catch(e){toast(e.message||String(e),'error')}finally{$('amGrantBtn').disabled=false}});
  $('amDenyBtn').addEventListener('click',async()=>{try{$('amDenyBtn').disabled=true; await saveGrant('deny');}catch(e){toast(e.message||String(e),'error')}finally{$('amDenyBtn').disabled=false}});
  populateResources(); loadStudents().then(()=>{renderStudents(); if(state.students[0]) selectStudent(state.students[0].id);});
}

export function initAccessManager(){ if(state.initialized) return; state.initialized=true; buildUI(); }
window.__alifAccessGrant = async ({uid,type,id,expiresAt,sourceType='manual',sourceId=null,sourceLabel='Manual'}={}) => {
  if(!uid||!type||!id) throw new Error('Missing access target.');
  await setDoc(doc(db,'access',uid,'resources',key(type,id)),{resourceType:type,resourceId:id,resourceLabel:resourceLabel(type,id),mode:'allow',status:'active',expiresAt:expiresAt||null,sourceType,sourceId,sourceLabel,updatedAt:serverTimestamp(),updatedBy:auth.currentUser?.uid||null},{merge:true});
};
window.__alifAccessRevoke = async ({uid,type,id}={}) => { if(uid&&type&&id) await deleteDoc(doc(db,'access',uid,'resources',key(type,id))); };
