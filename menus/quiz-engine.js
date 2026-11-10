import{setCategoryFilter as __setCat,getCategoryFilter as __getCat}from"./learn-mode.js";
/* "Browse by category" now FILTERS the feed to that category instead of scrolling to it. */
function __catBar(){
  let bar=document.getElementById("catFilterBar");
  const key=__getCat();
  if(!key){bar&&bar.remove();return}
  if(!bar){bar=document.createElement("div");bar.id="catFilterBar";bar.className="cat-filter-bar";const feed=document.getElementById("feed");feed&&feed.parentNode.insertBefore(bar,feed)}
  const meta=(CATEGORY_META||[]).find(m=>m.key===key);const first=(byCategory[key]||[])[0];
  const label=(first&&first.categoryLabel)||key;const n=(byCategory[key]||[]).length;
  bar.innerHTML="";
  const t=document.createElement("span");t.className="cf-label";t.textContent=label;
  const c=document.createElement("span");c.className="cf-count";c.textContent=n+" question"+(n===1?"":"s");
  const x=document.createElement("button");x.type="button";x.className="cf-clear";x.textContent="Show all";
  x.addEventListener("click",()=>__applyCat(null));
  if(meta)bar.style.setProperty("--cf",meta.color);
  bar.append(t,c,x);
}
function __applyCat(key){
  __setCat(key);
  document.querySelectorAll("#catList .cat-item").forEach(el=>el.classList.toggle("cat-active",!!key&&el.id==="sidebar-"+key));
  __catBar();
  const q=document.getElementById("searchInput");
  I(q?q.value:"");t();
  const hero=document.querySelector(".hero");(hero||document.getElementById("feed")).scrollIntoView({block:"start"});
}
function __resetCat(){__setCat(null);const b=document.getElementById("catFilterBar");b&&b.remove();document.querySelectorAll("#catList .cat-item.cat-active").forEach(el=>el.classList.remove("cat-active"))}
import{esc as __esc,videoThumb as __vt,thumbSrc as __ts}from"./resources-util.js";
function __ctx(subjectId){let m="";try{const sub=(__SC||[]).find(x=>x.id===subjectId);m=sub&&sub.moduleId||""}catch(_){}window.__alifQuizCtx={subjectId,moduleId:m};try{window.__alifRes&&window.__alifRes.ensure();__relCount()}catch(_){}}
function __relData(){const c=window.__alifQuizCtx||{};return window.__alifRes?window.__alifRes.get(c.moduleId,c.subjectId):{ready:false,videos:[],books:[]}}
function __relCount(){const el=document.getElementById("relCount");if(!el)return;const d=__relData();el.textContent=d.videos.length+d.books.length}
let __relTab="videos";
function __relRender(body){
  const d=__relData(),list=d[__relTab]||[];
  const tab=(k,l)=>`<button type="button" class="rel-tab${__relTab===k?" on":""}" data-rt="${k}">${l}<em>${d[k].length}</em></button>`;
  const row=(x,k)=>{const img=k==="videos"?__vt(x):__ts(x.thumbUrl);const meta=k==="videos"?(x.lecturer||""):(x.author||"");
    return `<button type="button" class="rel-row" data-ro="${k}" data-id="${__esc(x.id)}"><span class="rel-th${k==="books"?" book":""}">${img?`<img src="${__esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:""}<i class="fa-solid ${k==="videos"?"fa-play":"fa-book"}"></i></span><span class="rel-tx"><b>${__esc(x.title||"Untitled")}</b><small>${__esc([meta,x._same?"":(x._sub||"")].filter(Boolean).join(" · ")||(x._same?"This subject":""))}</small></span></button>`};
  body.innerHTML=`<div class="rel-tabs">${tab("videos","Videos")}${tab("books","Books")}</div><div class="rel-list">${list.length?list.map(x=>row(x,__relTab)).join(""):`<div class="bm-empty">${d.ready?"Nothing related yet for this quiz.":"Loading…"}</div>`}</div>`;
  body.querySelectorAll(".rel-row").forEach((it,i)=>it.style.setProperty("--i",i));
}
/* Desktop: drag the left sidebar's edge to resize it (same as the right-hand related sidebar). */
{const app=document.getElementById("appScreen"),sb=document.getElementById("sidebar");
if(app&&sb){
  const K="alif.leftSidebarW",MIN=280,MAX=560;
  const clamp=v=>Math.min(MAX,Math.max(MIN,v));
  try{const v=parseFloat(localStorage.getItem(K));if(v)app.style.setProperty("--left-sidebar-w",clamp(v)+"px")}catch(_){}
  const h=document.createElement("div");h.id="leftSidebarResize";h.className="left-sidebar-resize";h.title="Drag to resize";app.appendChild(h);
  let on=false,x0=0,w0=0;
  const mv=e=>{if(!on)return;const x=e.touches?e.touches[0].clientX:e.clientX;app.style.setProperty("--left-sidebar-w",clamp(w0+x-x0)+"px")};
  const up=()=>{if(!on)return;on=false;h.classList.remove("dragging");document.body.style.userSelect="";document.body.style.cursor="";
    try{localStorage.setItem(K,parseFloat(getComputedStyle(app).getPropertyValue("--left-sidebar-w"))||360)}catch(_){}
    document.removeEventListener("mousemove",mv);document.removeEventListener("mouseup",up);document.removeEventListener("touchmove",mv);document.removeEventListener("touchend",up)};
  const dn=e=>{on=true;x0=e.touches?e.touches[0].clientX:e.clientX;w0=sb.getBoundingClientRect().width;h.classList.add("dragging");document.body.style.userSelect="none";document.body.style.cursor="col-resize";
    document.addEventListener("mousemove",mv);document.addEventListener("mouseup",up);document.addEventListener("touchmove",mv,{passive:true});document.addEventListener("touchend",up);e.preventDefault&&e.preventDefault()};
  h.addEventListener("mousedown",dn);h.addEventListener("touchstart",dn,{passive:false});
  h.addEventListener("dblclick",()=>{app.style.removeProperty("--left-sidebar-w");try{localStorage.removeItem(K)}catch(_){}});
}}
/* Mobile: drag the sidebar's right edge to pull it out to full screen (and back). */
{const sb=document.getElementById("sidebar");
if(sb){
  const g=document.createElement("div");g.className="sb-grip";g.setAttribute("aria-hidden","true");sb.appendChild(g);sb.addEventListener("scroll",()=>{g.style.transform="translateY("+sb.scrollTop+"px)"},{passive:true});
  const vw=()=>window.innerWidth,base=()=>Math.min(340,vw()*.86);
  let on=false,x0=0,w0=0;
  const set=w=>{sb.style.setProperty("--sbm-w",w+"px");sb.style.setProperty("--sbm-max",w+"px")};
  const clear=()=>{sb.style.removeProperty("--sbm-w");sb.style.removeProperty("--sbm-max")};
  const mv=ev=>{if(!on)return;const x=ev.touches?ev.touches[0].clientX:ev.clientX;set(Math.min(vw(),Math.max(base(),w0+x-x0)))};
  const up=()=>{if(!on)return;on=false;sb.classList.remove("sb-dragging");
    const w=sb.getBoundingClientRect().width,full=w>base()+(vw()-base())*.35;
    clear();sb.classList.toggle("sb-full",full);
    document.removeEventListener("touchmove",mv);document.removeEventListener("touchend",up);document.removeEventListener("touchcancel",up)};
  g.addEventListener("touchstart",ev=>{on=true;x0=ev.touches[0].clientX;w0=sb.getBoundingClientRect().width;sb.classList.add("sb-dragging");set(w0);
    document.addEventListener("touchmove",mv,{passive:true});document.addEventListener("touchend",up);document.addEventListener("touchcancel",up)},{passive:true});
  window.__sbFull=(f=true)=>sb.classList.toggle("sb-full",!!f);
  /* closing the drawer returns it to normal width for next time */
  new MutationObserver(()=>{if(!sb.classList.contains("open")&&sb.classList.contains("sb-full"))setTimeout(()=>{sb.classList.remove("sb-full")},300)}).observe(sb,{attributes:true,attributeFilter:["class"]});
  /* practising all bookmarked questions needs room: open full screen on phones */
  document.addEventListener("click",ev=>{if(ev.target.closest&&ev.target.closest("#practiceAllBtn")&&matchMedia("(max-width:880px)").matches)sb.classList.add("sb-full")});
}}
/* Sidebar Back button: on phones it only closes the drawer; on PC it goes back to the quizzes page. */
document.addEventListener("click",ev=>{
  const b=ev.target.closest&&ev.target.closest("#switchQuizBtn");if(!b)return;
  if(!matchMedia("(max-width:880px)").matches)return;
  ev.preventDefault();ev.stopImmediatePropagation();
  __sbClose(true);try{e()}catch(_){}
},true);
/* Browse-by-category and Bookmarked live INSIDE the sidebar: the main sidebar content slides away and the panel slides in. */
const __SBP={
  cats:{id:"sbCats",title:"Browse by category",btn:"#openCategoryOverlay",overlay:"categoryOverlay",close:"closeCategoryOverlay",move:["categoryListWrap"]},
  bm:{id:"sbBm",title:"Bookmarked questions",btn:"#openBookmarks",overlay:"bmOverlay",close:"closeOverlay",move:["practiceAllBtn","bmListWrap"]},
  rel:{id:"sbRel",title:"Related videos & books",btn:"#openRelated",move:[],render:__relRender}
};
function __sbPanel(k){
  const cfg=__SBP[k],sb=document.getElementById("sidebar");if(!sb)return null;
  let p=document.getElementById(cfg.id);
  if(!p){
    p=document.createElement("div");p.id=cfg.id;p.className="sb-cats";p.setAttribute("aria-hidden","true");
    p.innerHTML='<div class="sbc-head"><button type="button" class="sbc-back" aria-label="Back to sidebar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button><div class="sbc-title"></div></div><div class="sbc-body"></div>';
    p.querySelector(".sbc-title").textContent=cfg.title;
    sb.appendChild(p);
    p.querySelector(".sbc-back").addEventListener("click",()=>__sbClose());
    const body=p.querySelector(".sbc-body");
    cfg.move.forEach(i=>{let e=document.getElementById(i);if(!e)return;if(i==="practiceAllBtn")e=e.closest(".overlay-actions")||e;body.appendChild(e)});
  }
  return p;
}
let __sbSaved=0;
function __sbOpen(k){
  const sb=document.getElementById("sidebar"),p=__sbPanel(k);if(!sb||!p)return;
  document.querySelectorAll(".sb-cats.on").forEach(x=>{if(x!==p){x.classList.remove("on");x.setAttribute("aria-hidden","true")}});
  if(!sb.classList.contains("sb-cat-open")){__sbSaved=sb.scrollTop;sb.scrollTop=0}
  const key=__getCat();
  p.querySelectorAll("[data-ovl-scrollto]").forEach(h=>{const a=!!key&&h.dataset.ovlScrollto==="cat-"+key;h.closest(".cat-item")?.classList.toggle("sbc-active",a)});
  __SBP[k].render&&__SBP[k].render(p.querySelector(".sbc-body"));p.querySelectorAll(".cat-item,.bm-row,.rel-row").forEach((it,i)=>it.style.setProperty("--i",i));
  sb.classList.add("sb-cat-open");p.classList.add("on");p.setAttribute("aria-hidden","false");
  const b=p.querySelector(".sbc-body");b&&(b.scrollTop=0);
}
function __sbClose(instant){
  const sb=document.getElementById("sidebar");if(!sb||!sb.classList.contains("sb-cat-open"))return;
  if(instant)sb.classList.add("sb-no-anim");
  sb.classList.remove("sb-cat-open");
  document.querySelectorAll(".sb-cats.on").forEach(x=>{x.classList.remove("on");x.setAttribute("aria-hidden","true")});
  sb.scrollTop=__sbSaved;
  if(instant)requestAnimationFrame(()=>requestAnimationFrame(()=>sb.classList.remove("sb-no-anim")));
}
/* runs after the original handler has filled the list and shown the modal; closes the modal again before it paints */
document.addEventListener("click",ev=>{
  for(const k in __SBP){
    const cfg=__SBP[k],b=ev.target.closest&&ev.target.closest(cfg.btn);if(!b)continue;
    const ov=cfg.overlay&&document.getElementById(cfg.overlay);
    if(ov&&ov.classList.contains("show")){const c=document.getElementById(cfg.close);c&&c.click();ov.classList.remove("show")}
    __sbOpen(k);return;
  }
});
{const __sb=document.getElementById("sidebar");__sb&&new MutationObserver(()=>{if(!__sb.classList.contains("open")&&matchMedia("(max-width:880px)").matches)__sbClose(true)}).observe(__sb,{attributes:true,attributeFilter:["class"]})}
/* tapping a bookmarked question jumps to it and returns the sidebar to normal */
document.addEventListener("click",ev=>{const r=ev.target.closest&&ev.target.closest("#sbBm .bm-row");if(r&&!ev.target.closest(".bm-remove"))__sbClose(matchMedia("(max-width:880px)").matches)});
document.addEventListener("click",ev=>{
  const el=ev.target.closest&&ev.target.closest('[data-scrollto^="cat-"],[data-ovl-scrollto^="cat-"]');
  if(!el)return;
  ev.preventDefault();ev.stopImmediatePropagation();
  const key=(el.dataset.scrollto||el.dataset.ovlScrollto).slice(4);
  const ov=document.getElementById("categoryOverlay");ov&&ov.classList.remove("show");__sbClose(matchMedia("(max-width:880px)").matches);
  try{e()}catch(_){}
  __applyCat(__getCat()===key?null:key);
},true);
import{SUBJECTS_CACHE as __SC,moduleNameFor as __mn}from"./picker-screen.js";
/* Breadcrumb Module › Subject › Quiz: lives in the sidebar under the "Alif Med" title (not on the question page). */
function __crumb(subject,quiz,subjectId){
  const el=document.getElementById("sidebarCrumb");if(!el)return;
  let mod="";try{const sub=(__SC||[]).find(x=>x.id===subjectId);mod=sub&&sub.moduleId?__mn(sub.moduleId):""}catch(_){}
  const parts=[mod,subject,quiz].filter((v,i,a)=>v&&a.indexOf(v)===i);
  el.textContent="";
  parts.forEach((t,i)=>{
    if(i)el.appendChild(Object.assign(document.createElement("i"),{className:"crumb-sep",textContent:"›"}));
    el.appendChild(Object.assign(document.createElement("span"),{className:i===parts.length-1?"crumb-cur":"",textContent:t}));
  });
}
/* Universal sidebar close button (top-right of the sidebar header): closes the drawer on phones, tucks the sidebar away on PC. */
document.addEventListener("click",ev=>{
  const b=ev.target.closest&&ev.target.closest("#sidebarCloseBtn");if(!b)return;
  ev.preventDefault();
  if(matchMedia("(max-width:880px)").matches){__sbClose(true);try{e()}catch(_){}}
  else{const t=document.getElementById("sidebarEdgeToggle");t&&t.click()}
},true);
import{closeSidebarMobile as e,observeDividers as t,openSidebarMobile as s,renderRelatedSidebar as n,renderSidebar as o,sidebar as a,updateOverall as r}from"./ask-ai.js";import{getAuthUser as V,getStoredStudent as i,shouldSyncToFirebase as d}from"./auth.js";import{updateBottomNavVisibility as c}from"./bottom-nav.js";import{LSC as l,setCacheBadge as u,forceUnlockBodyScroll as __fu}from"./cache.js";import{closeChatScreen as m}from"./class-chat.js";import{db as g}from"./cloud-sync.js";import{appScreen as p,gateScreen as y,homeScreen as h,pickerScreen as E}from"./gate-screen.js";import{LEARN_MODE as b,buildFeed as I,startLearnMode as f}from"./learn-mode.js";import{hasTourBeenSeen as v,startTour as S}from"./onboarding-tour.js";import{modulesScreenEl as x,subjectsScreenEl as w}from"./picker-screen.js";import{progressScreen as _}from"./progress-page.js";import{pushAppState as D}from"./progress-rings.js";import{renderInline as B,renderRich as L}from"./text-render.js";import{escapeHtml as QIMG_esc}from"./loaders.js";import{deleteField as N,doc as T,serverTimestamp as k,setDoc as R}from"./runtime-ext.js";export const PALETTE=["--c0","--c1","--c2","--c3","--c4","--c5","--c6","--c7","--c8","--c9","--c10","--c11"];const C=["I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII","XIII","XIV","XV"];export let QUESTIONS=[];export let byCategory={};export let byId={};export let CATEGORY_META=[];let A="";export let state={answers:{},bookmarks:{},completed:!1,total:0};export let CURRENT_SUBJECT_ID=null,CURRENT_QUIZ_ID=null,CURRENT_SUBJECT_NAME="",CURRENT_QUIZ_NAME="";const z="atlas_focus_mode";export let FOCUS_MODE=!1;try{FOCUS_MODE="1"===localStorage.getItem(z)}catch(Q){}function q(){p.classList.toggle("focus-mode",FOCUS_MODE);const e=document.getElementById("focusTitle"),t=document.getElementById("heroTitle");e&&t&&(e.textContent=t.textContent),updateFocusProgressMini()}export function updateFocusProgressMini(){const e=document.getElementById("focusProgressMini");if(!e)return;const t=QUESTIONS.length,s=Object.keys(state.answers||{}).length;e.textContent=`${s}/${t}`}export function setFocusMode(s){FOCUS_MODE=s;try{localStorage.setItem(z,s?"1":"0")}catch(e){}q(),e(),QUESTIONS.length&&(I(document.getElementById("searchInput").value),t())}const O="atlas_sidebar_hidden";export let SIDEBAR_HIDDEN=!1;try{SIDEBAR_HIDDEN="1"===localStorage.getItem(O)}catch(F){}function M(){p.classList.toggle("left-collapsed",SIDEBAR_HIDDEN);const e=document.getElementById("sidebarEdgeToggle"),t=document.getElementById("sidebarEdgeToggleIcon");t&&(t.className=SIDEBAR_HIDDEN?"fa-solid fa-angles-right":"fa-solid fa-angles-left"),e&&(e.title=SIDEBAR_HIDDEN?"Show sidebar":"Hide sidebar")}export function setSidebarHidden(e){SIDEBAR_HIDDEN=e;try{localStorage.setItem(O,e?"1":"0")}catch(e){}M(),e||RELATED_SIDEBAR_HIDDEN||setRelatedSidebarHidden(!0)}const $="atlas_related_sidebar_hidden";export let RELATED_SIDEBAR_HIDDEN=!1;try{RELATED_SIDEBAR_HIDDEN="1"===localStorage.getItem($)}catch(P){}export function applyRelatedSidebarVisibilityUI(){p.classList.toggle("related-hidden",RELATED_SIDEBAR_HIDDEN);const e=document.getElementById("relatedSidebarEdgeToggleIcon"),t=document.getElementById("relatedSidebarEdgeToggle");e&&(e.className=RELATED_SIDEBAR_HIDDEN?"fa-solid fa-angles-left":"fa-solid fa-angles-right"),t&&(t.title=RELATED_SIDEBAR_HIDDEN?"Show related quizzes":"Hide related quizzes")}export function setRelatedSidebarHidden(e){RELATED_SIDEBAR_HIDDEN=e;try{localStorage.setItem($,e?"1":"0")}catch(e){}applyRelatedSidebarVisibilityUI(),e||SIDEBAR_HIDDEN||setSidebarHidden(!0)}const j="atlas_related_sidebar_width",U="atlas_related_sidebar_split";export function applyStoredRelatedSidebarSizing(){let e=null,t=null;try{e=parseFloat(localStorage.getItem(j))}catch(e){}try{t=parseFloat(localStorage.getItem(U))}catch(e){}e&&!isNaN(e)&&(e=Math.min(560,Math.max(300,e)),p.style.setProperty("--related-sidebar-w",e+"px")),t&&!isNaN(t)&&(t=Math.min(2.4,Math.max(.6,t)),p.style.setProperty("--rs-quizzes-flex",String(t)),p.style.setProperty("--rs-subjects-flex",String(3-t)))}export function initRelatedSidebarResize(){const e=document.getElementById("relatedSidebar"),t=document.getElementById("relatedSidebarHResize"),s=document.getElementById("relatedSidebarVResize");if(!e||!t||!s)return;let n=!1,o=0,a=0;function r(e){if(!n)return;const t=e.touches?e.touches[0].clientX:e.clientX,s=o-t,r=Math.min(560,Math.max(300,a+s));p.style.setProperty("--related-sidebar-w",r+"px")}function i(){if(!n)return;n=!1,t.classList.remove("dragging"),document.body.style.userSelect="",document.body.style.cursor="";const e=getComputedStyle(p).getPropertyValue("--related-sidebar-w");try{localStorage.setItem(j,parseFloat(e)||300)}catch(e){}document.removeEventListener("mousemove",r),document.removeEventListener("mouseup",i),document.removeEventListener("touchmove",r),document.removeEventListener("touchend",i)}function d(s){n=!0,o=s.touches?s.touches[0].clientX:s.clientX,a=e.getBoundingClientRect().width,t.classList.add("dragging"),document.body.style.userSelect="none",document.body.style.cursor="col-resize",document.addEventListener("mousemove",r),document.addEventListener("mouseup",i),document.addEventListener("touchmove",r,{passive:!1}),document.addEventListener("touchend",i),s.preventDefault()}t.addEventListener("mousedown",d),t.addEventListener("touchstart",d,{passive:!1});let c=!1,l=0,u=1.3,m=1;function g(e){if(!c)return;const t=((e.touches?e.touches[0].clientY:e.clientY)-l)/m*3,s=Math.min(2.4,Math.max(.6,u+t));p.style.setProperty("--rs-quizzes-flex",String(s)),p.style.setProperty("--rs-subjects-flex",String(3-s))}function y(){if(!c)return;c=!1,s.classList.remove("dragging"),document.body.style.userSelect="",document.body.style.cursor="";const e=getComputedStyle(p).getPropertyValue("--rs-quizzes-flex");try{localStorage.setItem(U,parseFloat(e)||1.3)}catch(e){}document.removeEventListener("mousemove",g),document.removeEventListener("mouseup",y),document.removeEventListener("touchmove",g),document.removeEventListener("touchend",y)}function h(t){c=!0,l=t.touches?t.touches[0].clientY:t.clientY;const n=parseFloat(getComputedStyle(p).getPropertyValue("--rs-quizzes-flex"));u=isNaN(n)?1.3:n,m=Math.max(1,e.getBoundingClientRect().height-140),s.classList.add("dragging"),document.body.style.userSelect="none",document.body.style.cursor="row-resize",document.addEventListener("mousemove",g),document.addEventListener("mouseup",y),document.addEventListener("touchmove",g,{passive:!1}),document.addEventListener("touchend",y),t.preventDefault()}s.addEventListener("mousedown",h),s.addEventListener("touchstart",h,{passive:!1})}export function saveQuizState(){l.set(A,state)}export function letterOf(e){const t=[];let s=Number(e);for(;s>=0;)t.unshift(String.fromCharCode(65+s%26)),s=Math.floor(s/26)-1;return t.join("")}function H(e,t,s){return`${e.id}_${t}_${s}`.replace(/[^a-zA-Z0-9_-]/g,"_")}export async function syncAnswer({student:e,subjectId:t,quizId:s,q:n,selected:o,correct:a}){if(!await d()){u(!0);const e=document.getElementById("syncStatus");return void(e&&(e.classList.add("offline"),document.getElementById("syncStatusText").textContent="Sync disabled — local only"))}if(!g||!e)return;if(e.guest)return;const r=T(g,"results",H(e,t,s)),i=Object.keys(state.answers).length,c=Object.values(state.answers).filter(e=>e.correct).length,l=document.getElementById("syncStatus");l&&l.classList.add("syncing");try{await R(r,{uid:e.uid||((await V())?.uid)||"",studentId:e.id,answers:{[n.id]:{selected:o,correct:a,number:n.number,category:n.category,university:n.university}},answeredCount:i,correctCount:c,score:c,total:QUESTIONS.length,updatedAt:k()},{merge:!0}),u(!1)}catch(e){u(!0)}finally{l&&l.classList.remove("syncing")}}export async function syncCompletion({student:e,subjectId:t,quizId:s}){if(!await d())return;if(!g||!e)return;if(e.guest)return;const n=T(g,"results",H(e,t,s));try{await R(n,{uid:e.uid||((await V())?.uid)||"",studentId:e.id,completed:!0,completedAt:k(),updatedAt:k()},{merge:!0})}catch(e){}}export function launchQuiz({subjectId:u,quizId:B,subjectName:L,quizName:N,questions:z,embed:EMB=!1}){__fu(),document.body.classList.remove("auth-gate-open");QUESTIONS=z,byCategory={},byId={},QUESTIONS.forEach(e=>{(byCategory[e.category]=byCategory[e.category]||[]).push(e),byId[e.id]=e}),CATEGORY_META=Object.keys(byCategory).map((e,t)=>({key:e,plate:"Plate "+(C[t]||t+1),color:`var(${PALETTE[t%PALETTE.length]})`}));const O=i();CURRENT_SUBJECT_ID=u,CURRENT_QUIZ_ID=B,CURRENT_SUBJECT_NAME=L,CURRENT_QUIZ_NAME=N,A=`atlas_progress_${O.id}_${u}_${B}`,function(){const e=l.get(A);state=e||{answers:{},bookmarks:{},completed:!1,total:0}}(),state.total=QUESTIONS.length,saveQuizState(),EMB||(E.classList.add("hidden"),h.classList.add("hidden"),y.classList.add("hidden")),p.classList.remove("hidden"),EMB||D("quiz"),EMB||m(),_.classList.add("hidden"),x.classList.add("hidden"),w.classList.add("hidden"),c(),document.getElementById("sidebarSub").textContent=`${L} · ${O.name}`,document.getElementById("topbarSub").textContent=`0 / ${QUESTIONS.length}`,(__resetCat(),__crumb(L,N,u),__ctx(u)),document.getElementById("heroTitle").textContent=N;const $=document.getElementById("submitQuizBtn");$.disabled=!1,state.completed?($.classList.add("done"),$.innerHTML='<i class="fa-solid fa-check"></i> Submitted'):($.classList.remove("done"),$.innerHTML='<i class="fa-solid fa-paper-plane"></i> Submit quiz'),document.getElementById("searchInput").value="",q(),M();const j=document.getElementById("learnModeToggle");j&&(j.checked=b),b?f():I(""),o(),n(),r(),t(),window.__alifQuizCtx={subjectId:u,quizId:B,subjectName:L,quizName:N},async function({student:e,subjectId:t,quizId:s,subjectName:n,quizName:o,total:a}){if(!g||!e)return;if(!await d())return;const r=T(g,"results",H(e,t,s));try{await R(r,{uid:e.uid||((await V())?.uid)||"",studentId:e.id,name:e.name||"",batch:e.batch||"",subjectId:t,subjectName:n,quizId:s,quizName:o,total:a,answeredCount:state.answers?Object.keys(state.answers).length:0,correctCount:state.answers?Object.values(state.answers).filter(e=>e.correct).length:0,score:state.answers?Object.values(state.answers).filter(e=>e.correct).length:0,completed:!!state.completed,startedAt:k(),updatedAt:k()},{merge:!0})}catch(e){}}({student:O,subjectId:u,quizId:B,subjectName:L,quizName:N,total:QUESTIONS.length}),async function(){const e=await d(),t=document.getElementById("syncStatus"),s=document.getElementById("syncStatusText");t&&(e?(t.classList.remove("offline"),s.textContent=""):(t.classList.add("offline"),s.textContent=""))}();let U=null;if(!EMB&&!v("quiz")){const t=FOCUS_MODE,n=SIDEBAR_HIDDEN,o=a.classList.contains("open");FOCUS_MODE&&setFocusMode(!1),SIDEBAR_HIDDEN&&setSidebarHidden(!1),o||s(),U=()=>{o||e(),n&&setSidebarHidden(!0),t&&setFocusMode(!0)}}EMB||setTimeout(()=>S("quiz",[{selector:"#searchInput",title:"Search questions",text:"Quickly find a question by typing a keyword."},{selector:"#openCategoryOverlay",title:"Browse by category",text:"Jump straight to a specific category within this quiz."},{selector:"#openBookmarks",title:"Bookmarks",text:"Save tricky questions here to come back to them later."},{selector:".learn-mode-row",title:"Learn mode",text:"Missed questions keep resurfacing at random until you get every one right."},{selector:"#openSharedFromQuiz",title:"Shared questions",text:"Practice only the questions your classmates have shared in class chat."},{selector:"#submitQuizBtn",title:"Submit quiz",text:"When you're done, submit to save your final results."},{selector:"#clearAnswersBtn",title:"Clear answers only",text:"Wipes your selected answers but keeps your bookmarks."},{selector:"#resetBtn",title:"Reset everything",text:"Clears your answers, bookmarks, and completion status for this quiz on this device."},{selector:"#collapseSidebarBtn, #topbarFocusBtn",title:"Focus mode",text:"Hide the sidebar for a clean, distraction-free practice session."},{selector:"#sidebarEdgeToggle",title:"Hide this sidebar",text:"On a bigger screen, tap this « arrow any time to tuck the sidebar away for more reading room."},{selector:"#relatedSidebarEdgeToggle",title:"Related quizzes",text:"Toggle this sidebar to browse other quizzes without leaving this one."}]),600)}export const feed=document.getElementById("feed");export function renderQuestionCard(e,t){t=t||{};const s=CATEGORY_META.find(t=>t.key===e.category),n=void 0!==t.ansOverride?t.ansOverride:state.answers[e.id],o=!!n,a=!!state.bookmarks[e.id],r=document.createElement("div");r.className="qcard"+(o?" answered "+(n.correct?"correct":"incorrect"):"")+(t.learn?" learn-card":"")+(o&&window.__alifQC&&window.__alifQC.flagged(e)?" qc-flagged":""),r.dataset.qid=e.id,t.instanceId&&(r.dataset.instanceId=t.instanceId);let i="";e.options.forEach((t,s)=>{let a="opt";o&&(s===e.answerIndex?a+=" reveal-correct":window.__alifQC&&window.__alifQC.flagged(e)&&s===e.complaintProp?a+=" reveal-claim":s===n.selected?a+=" reveal-wrong":a+=" dim"),i+=`<button class="${a}" data-idx="${s}" ${o?"disabled":""}><span class="letter">${letterOf(s)}</span><span class="markdown-body">${B(t)}</span></button>`});let d="";o&&e.options.forEach((t,s)=>{if(s!==e.answerIndex){const n=e.whyNot&&e.whyNot[String(s)]||"";d+=`<div class="why-item"><b>${letterOf(s)} — ${B(t)}</b><div class="markdown-body">${L(n)}</div></div>`}});let c="";return e.related&&e.related.length&&(c=e.related.map(e=>{const t=QUESTIONS.find(t=>t.number===e);return t?`<button class="rel-chip" data-jump="${t.id}">Q${e}</button>`:""}).join("")),r.innerHTML=`\n        <div class="node"></div>\n        <div class="card-inner" style="border-left-color:${s.color}">\n          <div class="card-top">\n            <span class="q-num">Q${e.number}</span>\n            <span class="q-tag" style="background:color-mix(in srgb, ${s.color} 16%, var(--card)); color:${s.color}">${e.categoryLabel}</span>${o&&window.__alifQC?window.__alifQC.pill(e):""}\n            <div class="card-actions">\n              <button class="bookmark-btn share-btn" data-share="${e.id}" title="Share to class chat">\n                <i class="fa-solid fa-share-nodes"></i>\n              </button>\n              <button class="bookmark-btn ${a?"on":""}" data-bookmark="${e.id}" title="Bookmark">\n                <svg viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 011 1v17l-7-4-7 4V4a1 1 0 011-1z"/></svg>\n              </button>\n            </div>\n          </div>\n          ${e.image?`<img src="${QIMG_esc(e.image)}" alt="" class="q-stem-image" loading="lazy" onerror="this.remove()">`:""}<div class="q-stem markdown-body">${L(e.question)}</div>\n          ${o&&window.__alifQC?window.__alifQC.notice(e):""}<div class="options">${i}</div>\n          <div class="result-line ${o?n.correct?"ok":"no":""}">\n            ${o?n.correct?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg> Correct':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg> Incorrect — correct answer is '+letterOf(e.answerIndex):""}\n          </div>\n          <div class="toggles">\n            <button class="toggle-btn" data-toggle="exp">Explanation</button>\n            <button class="toggle-btn" data-toggle="why">Why not the others</button>\n            ${o?`<button class="toggle-btn clean-btn" data-clean="${e.id}" title="Clear my answer for this question"><i class="fa-solid fa-eraser"></i> Clean answer</button>`:""}\n            <button class="toggle-btn qc-btn" data-complain="${e.id}" title="Report a wrong answer"><i class="fa-solid fa-flag"></i> Complain</button>\n          </div>\n          <div class="panel" data-panel="exp"><h4>Explanation</h4>${window.__alifQC?window.__alifQC.expl(e):""}<div class="markdown-body">${L(e.explanation)}</div></div>\n          <div class="panel" data-panel="why"><h4>Why not the others</h4>${d}</div>\n          \n          <div class="related-row">${c?'<span class="lbl">Related</span>'+c:""}</div>\n        </div>\n      `,r}export function setstate(e){return state=e,state}
{const mob=()=>matchMedia("(max-width:880px)").matches;
document.addEventListener("click",ev=>{
  const t=ev.target.closest&&ev.target.closest("#sbRel .rel-tab");
  if(t){__relTab=t.dataset.rt;__relRender(document.querySelector("#sbRel .sbc-body"));return}
  const r=ev.target.closest&&ev.target.closest("#sbRel .rel-row");if(!r||!window.__alifRes)return;
  const m=mob();if(m){__sbClose(true);try{e()}catch(_){}}
  window.__alifRes[r.dataset.ro==="videos"?"openVideo":"openBook"](r.dataset.id);
});
const f=()=>{__relCount();const b=document.querySelector("#sbRel.on .sbc-body");b&&__relRender(b)};
const iv=setInterval(()=>{if(window.__alifRes){window.__alifRes.subscribe(f);clearInterval(iv)}},500);}
