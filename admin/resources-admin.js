/* ========================================================================
   ALIF Med — Admin: AResources (Books + Videos)
   ------------------------------------------------------------------------
   Adds / edits / deletes books/{id} and videos/{id}.
   Every file can be given either as an EXTERNAL LINK or as an UPLOAD
   (Firebase Storage, path resources/...): the book file, the video file,
   the thumbnail, and the lecturer photo.

   Permission key: "resources" (owner always has it). Enforced by
   firestore.rules and storage.rules, not just by this UI.
   ======================================================================== */
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getFirestore, collection, doc, getDocs, setDoc, deleteDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  getStorage, ref as sRef, uploadBytesResumable, getDownloadURL, deleteObject
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';

const app = getApp();
const db = getFirestore(app);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = (m, t = 'info') => window.toast ? window.toast(m, t) : console.log(m);
const safeUrl = u => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '');

const LIMITS = { image: 8 * 1024 * 1024, book: 200 * 1024 * 1024, video: 500 * 1024 * 1024 };

let S = { kind: 'books', mods: [], subs: [], books: [], videos: [], loaded: false, q: '', mod: '', editing: null, qz: {}, cats: {} };
let F = null;          // form state while the modal is open
let inited = false;
let storage = null;
const getStor = () => storage || (storage = getStorage(app));

/* ------------------------------------------------------------- styles / UI */
function ensureUi() {
  if (inited) return;
  inited = true;
  const css = document.createElement('style');
  css.textContent = `
  #tab-resources .rs-head{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;align-items:center}
  #tab-resources .rs-note{font-size:12.5px;color:var(--ink-faint);margin:6px 0 14px}
  #tab-resources .rs-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
  #tab-resources .rs-bar .search-box{flex:1;min-width:180px}
  #tab-resources .rs-thumb{width:48px;height:48px;border-radius:10px;background:var(--paper-2);object-fit:cover;display:flex;align-items:center;justify-content:center;color:var(--ink-faint);overflow:hidden;flex:none}
  #tab-resources .rs-thumb img{width:100%;height:100%;object-fit:cover}
  #tab-resources .rs-title{font-weight:700}
  #tab-resources .rs-sub{font-size:11.5px;color:var(--ink-faint);margin-top:2px}
  #tab-resources .rs-pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:10.5px;font-weight:700;background:var(--paper-2);color:var(--ink-soft)}
  #tab-resources .rs-pill.off{background:var(--wrong-soft);color:var(--wrong)}
  #tab-resources .rs-pill.up{background:var(--right-soft);color:var(--right)}
  #resAdmModal .rs-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:620px){#resAdmModal .rs-grid2{grid-template-columns:1fr}}
  #resAdmModal .rs-src{margin-bottom:8px}
  #resAdmModal .rs-prev{display:flex;gap:10px;align-items:center;margin-top:8px;font-size:12px;color:var(--ink-faint)}
  #resAdmModal .rs-prev img{width:56px;height:56px;border-radius:10px;object-fit:cover;background:var(--paper-2)}
  #resAdmModal .rs-prog{height:6px;border-radius:6px;background:var(--paper-2);overflow:hidden;margin-top:8px;display:none}
  #resAdmModal .rs-prog i{display:block;height:100%;width:0;background:var(--artery);transition:width .2s}
  #resAdmModal .rs-sec{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);margin:20px 0 10px;padding-top:14px;border-top:1px solid var(--card-border)}
  #resAdmModal .rs-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
  #resAdmModal .rs-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:5px 6px 5px 11px;border-radius:99px;background:var(--paper-2);border:1px solid var(--card-border);font-size:12px;font-weight:600}
  #resAdmModal .rs-chip span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px}
  #resAdmModal .rs-chip button{border:0;background:var(--card);width:20px;height:20px;border-radius:50%;line-height:1;cursor:pointer;color:var(--ink-soft)}
  #resAdmModal .rs-qb{border:1px dashed var(--card-border);border-radius:12px;padding:12px;margin-top:6px;display:grid;gap:10px}
  #resAdmModal .rs-qb .rs-grid2{gap:10px}
  #resAdmModal .rs-err{color:var(--wrong);font-size:12.5px;font-weight:600;margin-top:10px;min-height:16px}
  `;
  document.head.appendChild(css);

  $('tab-resources').innerHTML = `
    <div class="rs-head">
      <h2 class="page-title">AResources</h2>
      <button class="btn btn-primary" id="rsAdd"><i class="fa-solid fa-plus"></i> <span id="rsAddLbl">Add book</span></button>
    </div>
    <p class="rs-note">Books and videos shown in the student app's <b>AResources</b> tab. Add each file as an external link or upload it. Students see changes after their next content refresh.</p>
    <div class="rs-bar">
      <div class="ac-seg" id="rsKind"><button type="button" data-k="books" class="on"><i class="fa-solid fa-book"></i> Books</button><button type="button" data-k="videos"><i class="fa-solid fa-play"></i> Videos</button></div>
      <div class="search-box"><i class="fa-solid fa-magnifying-glass"></i><input type="text" id="rsSearch" placeholder="Search title, author or lecturer…" /></div>
      <select id="rsModFilter" class="form-control" style="max-width:220px"><option value="">All modules</option></select>
    </div>
    <div class="table-wrap"><table>
      <thead id="rsHead"></thead><tbody id="rsBody"></tbody>
    </table></div>`;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'resAdmModal';
  modal.innerHTML = `<div class="modal-panel"><div class="modal-head"><h2 id="rsMTitle">Add book</h2>
    <button class="modal-close" type="button" id="rsMClose"><i class="fa-solid fa-xmark"></i></button></div>
    <form id="rsForm" autocomplete="off"></form></div>`;
  document.body.appendChild(modal);

  $('rsAdd').addEventListener('click', () => openForm(null));
  $('rsMClose').addEventListener('click', closeForm);
  modal.addEventListener('mousedown', e => { if (e.target === modal && !F?.busy) closeForm(); });
  $('rsKind').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]'); if (!b) return;
    S.kind = b.dataset.k;
    $('rsKind').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    $('rsAddLbl').textContent = S.kind === 'books' ? 'Add book' : 'Add video';
    renderTable();
  });
  $('rsSearch').addEventListener('input', e => { S.q = e.target.value.trim().toLowerCase(); renderTable(); });
  $('rsModFilter').addEventListener('change', e => { S.mod = e.target.value; renderTable(); });
  $('rsBody').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const list = S[S.kind], it = list.find(x => x.id === b.dataset.id); if (!it) return;
    if (b.dataset.act === 'edit') openForm(it); else removeItem(it);
  });
}

/* --------------------------------------------------------------- loading */
async function load(force) {
  if (S.loaded && !force) return;
  const read = async n => (await getDocs(collection(db, n))).docs.map(d => ({ id: d.id, ...d.data() }));
  try {
    const [mods, subs, books, videos] = await Promise.all([read('modules'), read('subjects'), read('books'), read('videos')]);
    const ord = (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0);
    S.mods = mods.sort(ord); S.subs = subs.sort(ord); S.books = books.sort(ord); S.videos = videos.sort(ord);
    S.loaded = true;
  } catch (e) {
    console.error(e);
    toast('Could not load resources: ' + (e.message || e), 'error');
  }
  const sel = $('rsModFilter');
  sel.innerHTML = '<option value="">All modules</option>' + S.mods.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  sel.value = S.mod;
  renderTable();
}

const modName = id => (S.mods.find(m => m.id === id) || {}).name || '— module removed —';
const subName = id => (S.subs.find(s => s.id === id) || {}).name || '';

function renderTable() {
  const books = S.kind === 'books';
  $('rsHead').innerHTML = books
    ? '<tr><th></th><th>Book</th><th>Module / subject</th><th>Source</th><th>Order</th><th>Status</th><th style="width:110px">Actions</th></tr>'
    : '<tr><th></th><th>Video</th><th>Lecturer</th><th>Module / subject</th><th>Source</th><th>Order</th><th>Status</th><th style="width:110px">Actions</th></tr>';
  let rows = S[S.kind];
  if (S.mod) rows = rows.filter(r => r.moduleId === S.mod);
  if (S.q) rows = rows.filter(r => [r.title, r.author, r.lecturer, r.description].some(v => String(v || '').toLowerCase().includes(S.q)));
  const cols = books ? 7 : 8;
  if (!rows.length) { $('rsBody').innerHTML = `<tr><td colspan="${cols}" style="text-align:center;padding:30px;color:var(--ink-faint)">No ${S.kind} yet.</td></tr>`; return; }
  $('rsBody').innerHTML = rows.map(r => {
    const t = safeUrl(r.thumbUrl);
    const src = (books ? r.sourceType : r.sourceType) === 'upload' ? '<span class="rs-pill up">Uploaded</span>' : '<span class="rs-pill">Link</span>';
    return `<tr>
      <td><div class="rs-thumb">${t ? `<img src="${esc(t)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : `<i class="fa-solid ${books ? 'fa-book' : 'fa-play'}"></i>`}</div></td>
      <td><div class="rs-title">${esc(r.title)}</div>${books && r.author ? `<div class="rs-sub">${esc(r.author)}</div>` : ''}</td>
      ${books ? '' : `<td>${esc(r.lecturer || '')}</td>`}
      <td>${esc(modName(r.moduleId))}${r.subjectId ? `<div class="rs-sub">${esc(subName(r.subjectId))}</div>` : ''}</td>
      <td>${src}</td><td>${esc(r.order ?? '')}</td>
      <td>${r.active === false ? '<span class="rs-pill off">Hidden</span>' : '<span class="rs-pill up">Live</span>'}</td>
      <td><button class="btn btn-sm" data-act="edit" data-id="${esc(r.id)}" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm btn-danger" data-act="del" data-id="${esc(r.id)}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
  }).join('');
}

/* ------------------------------------------------------------------ form */
function srcField(key, label, opts) {
  // key: file | thumb | photo ; opts.required, opts.accept, opts.help, opts.noneOk
  const mode = F.m[key];
  const seg = [`${opts.noneOk ? '<button type="button" data-m="none">None</button>' : ''}`,
    '<button type="button" data-m="link"><i class="fa-solid fa-link"></i> Link</button>',
    '<button type="button" data-m="upload"><i class="fa-solid fa-cloud-arrow-up"></i> Upload</button>'].join('');
  return `<div class="form-group" data-field="${key}">
    <label>${label}${opts.required ? ' *' : ''}</label>
    <div class="ac-seg rs-src" data-seg="${key}">${seg}</div>
    <div data-pane="link"><input class="form-control" type="url" data-in="${key}Url" placeholder="https://…" value="${esc(F.url[key] || '')}" /></div>
    <div data-pane="upload"><input class="form-control" type="file" data-in="${key}File" accept="${opts.accept}" /></div>
    <div class="rs-prev" data-prev="${key}"></div>
    <div class="rs-prog" data-prog="${key}"><i></i></div>
    ${opts.help ? `<div class="help">${opts.help}</div>` : ''}
  </div>`;
}

function openForm(item) {
  const books = S.kind === 'books';
  S.editing = item;
  const it = item || {};
  F = {
    id: it.id || doc(collection(db, S.kind)).id,
    isNew: !item, busy: false,
    m: {
      file: it.sourceType === 'upload' ? 'upload' : 'link',
      thumb: it.thumbUrl ? (it.thumbPath ? 'upload' : 'link') : 'none',
      photo: it.lecturerPhoto ? (it.photoPath ? 'upload' : 'link') : 'none'
    },
    url: { file: books ? (it.sourceType === 'upload' ? '' : it.fileUrl || '') : (it.sourceType === 'upload' ? '' : it.videoUrl || ''), thumb: it.thumbPath ? '' : it.thumbUrl || '', photo: it.photoPath ? '' : it.lecturerPhoto || '' },
    keep: { file: it.sourceType === 'upload' ? { url: books ? it.fileUrl : it.videoUrl, path: it.filePath, name: it.fileName, size: it.fileSize } : null,
            thumb: it.thumbPath ? { url: it.thumbUrl, path: it.thumbPath } : null,
            photo: it.photoPath ? { url: it.lecturerPhoto, path: it.photoPath } : null },
    files: {}, oldPaths: [],
    rel: { videos: [...(it.related?.videos || [])], books: [...(it.related?.books || [])], quizzes: [...(it.related?.quizzes || [])] },
    linkedVideos: [...(it.linkedVideoIds || [])]
  };
  $('rsMTitle').textContent = `${item ? 'Edit' : 'Add'} ${books ? 'book' : 'video'}`;
  const defOrder = it.order ?? (Math.max(0, ...S[S.kind].map(x => Number(x.order) || 0)) + 1);
  const lecturers = [...new Set(S.videos.map(v => v.lecturer).filter(Boolean))];

  $('rsForm').innerHTML = `
    <div class="form-group"><label>Title *</label><input class="form-control" id="rsTitleIn" maxlength="200" value="${esc(it.title || '')}" /></div>
    ${books
      ? `<div class="form-group"><label>Author</label><input class="form-control" id="rsAuthor" maxlength="160" value="${esc(it.author || '')}" /></div>`
      : `<div class="rs-grid2">
          <div class="form-group"><label>Lecturer *</label><input class="form-control" id="rsLect" list="rsLectList" maxlength="120" value="${esc(it.lecturer || '')}" /><datalist id="rsLectList">${lecturers.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
            <div class="help">Pick an existing name so the same lecturer isn't split in two.</div></div>
          <div class="form-group"><label>Lecturer title</label><input class="form-control" id="rsLectTitle" maxlength="120" placeholder="e.g. Associate Professor of Physiology" value="${esc(it.lecturerTitle || '')}" /></div>
        </div>`}
    <div class="form-group"><label>Description</label><textarea class="form-control" id="rsDesc" rows="3" maxlength="1500">${esc(it.description || '')}</textarea></div>
    <div class="rs-grid2">
      <div class="form-group"><label>Module *</label><select class="form-control" id="rsMod"><option value="">Select module…</option>${S.mods.map(m => `<option value="${esc(m.id)}" ${m.id === it.moduleId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
      <div class="form-group"><label>Subject <span style="font-weight:400">(optional)</span></label><select class="form-control" id="rsSub"></select></div>
    </div>
    <div class="rs-sec">${books ? 'Book file' : 'Video'}</div>
    ${srcField('file', books ? 'Book (PDF, DOC, PPT, EPUB…)' : 'Video', {
      required: true, accept: books ? '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.epub,application/pdf' : 'video/mp4,video/webm,video/ogg,video/quicktime',
      help: books ? 'Everything opens inside the app. Best reading experience: upload the PDF (max 200 MB) or use a direct PDF link. Google Drive links and Word/PowerPoint/Excel files open in a simpler viewer.'
                  : 'Plays inside the app: YouTube, Vimeo, Google Drive, direct .mp4/.webm links, or an upload (max 500 MB). Other sites may refuse to play in-app.' })}
    <div class="rs-sec">Thumbnail</div>
    ${srcField('thumb', 'Cover / thumbnail', { noneOk: true, accept: 'image/*', help: books ? 'Without a thumbnail the app draws a coloured cover with the title.' : 'Optional — YouTube videos get their thumbnail automatically. Images up to 8 MB.' })}
    ${books ? '' : `<div class="rs-sec">Lecturer photo</div>${srcField('photo', 'Photo', { noneOk: true, accept: 'image/*', help: 'Optional. Shown on the Lecturers tab. Without it, initials are shown.' })}`}
    ${books ? relBooksSection() : relVideosSection()}
    <div class="rs-sec">Display</div>
    <div class="rs-grid2">
      <div class="form-group"><label>Order</label><input class="form-control" type="number" id="rsOrder" value="${esc(defOrder)}" /></div>
      <div class="form-group"><label>${books ? '' : 'Duration'}</label>${books ? '' : `<input class="form-control" id="rsDur" maxlength="12" placeholder="e.g. 42:10" value="${esc(it.duration || '')}" />`}</div>
    </div>
    <label class="adm-perm" style="margin:6px 0"><input type="checkbox" id="rsActive" ${it.active === false ? '' : 'checked'} /> <i class="fa-solid fa-eye"></i> Visible to students</label>
    <div class="rs-err" id="rsErr"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
      <button class="btn" type="button" id="rsCancel">Cancel</button>
      <button class="btn btn-primary" type="submit" id="rsSave"><i class="fa-solid fa-floppy-disk"></i> Save</button>
    </div>`;

  fillSubjects(it.subjectId || '');
  initRelated();
  $('rsMod').addEventListener('change', () => fillSubjects(''));
  ['file', 'thumb', 'photo'].forEach(k => { if ($('rsForm').querySelector(`[data-field="${k}"]`)) syncField(k); });
  $('rsCancel').addEventListener('click', closeForm);
  $('rsForm').onsubmit = e => { e.preventDefault(); save(); };
  $('rsForm').onclick = e => {
    if (relClick(e)) return;
    const b = e.target.closest('[data-seg] button'); if (!b || F.busy) return;
    const k = b.closest('[data-seg]').dataset.seg; F.m[k] = b.dataset.m; syncField(k);
  };
  $('rsForm').onchange = e => {
    const t = e.target;
    if (relChange(e)) return;
    if (t.matches('input[type=file]')) {
      const k = t.dataset.in.replace('File', ''); const f = t.files[0];
      const kind = k === 'file' ? (S.kind === 'books' ? 'book' : 'video') : 'image';
      if (f && f.size > LIMITS[kind]) { toast(`File too large (max ${Math.round(LIMITS[kind] / 1048576)} MB).`, 'error'); t.value = ''; F.files[k] = null; }
      else F.files[k] = f || null;
      syncField(k);
    }
  };
  $('rsForm').oninput = e => {
    const t = e.target;
    if (t.matches('input[type=url]')) { const k = t.dataset.in.replace('Url', ''); F.url[k] = t.value; syncField(k, true); }
  };
  $('resAdmModal').classList.add('show');
}

function fillSubjects(selected) {
  const mid = $('rsMod').value;
  const list = S.subs.filter(s => !mid || s.moduleId === mid);
  $('rsSub').innerHTML = '<option value="">None (whole module)</option>' + list.map(s => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}

function syncField(k, previewOnly) {
  const box = $('rsForm').querySelector(`[data-field="${k}"]`); if (!box) return;
  const m = F.m[k];
  box.querySelectorAll('[data-seg] button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  box.querySelector('[data-pane="link"]').style.display = m === 'link' ? '' : 'none';
  box.querySelector('[data-pane="upload"]').style.display = m === 'upload' ? '' : 'none';
  const prev = box.querySelector('[data-prev]');
  let html = '';
  const isImg = k !== 'file';
  if (m === 'link' && isImg && safeUrl(F.url[k])) html = `<img src="${esc(F.url[k])}" alt="" referrerpolicy="no-referrer" onerror="this.style.opacity=.25"><span>Preview</span>`;
  if (m === 'upload') {
    if (F.files[k]) html = (isImg ? `<img src="${URL.createObjectURL(F.files[k])}" alt="">` : '') + `<span>${esc(F.files[k].name)} · ${(F.files[k].size / 1048576).toFixed(1)} MB</span>`;
    else if (F.keep[k]) html = (isImg ? `<img src="${esc(F.keep[k].url)}" alt="">` : '') + `<span>Current upload kept${F.keep[k].name ? ': ' + esc(F.keep[k].name) : ''}. Choose a file to replace it.</span>`;
  }
  prev.innerHTML = html;
}

function closeForm() { if (F?.busy) return; $('resAdmModal').classList.remove('show'); F = null; }

/* ------------------------------------------------------------------ save */
function uploadFile(file, path, key) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(sRef(getStor(), path), file, { contentType: file.type || undefined });
    const bar = $('rsForm').querySelector(`[data-prog="${key}"]`);
    if (bar) bar.style.display = 'block';
    task.on('state_changed', s => { if (bar) bar.firstElementChild.style.width = Math.round(s.bytesTransferred / s.totalBytes * 100) + '%'; },
      reject, async () => resolve({ url: await getDownloadURL(task.snapshot.ref), path }));
  });
}
const safeName = n => String(n || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);

/* resolve one field to {url, path?} according to its mode */
async function resolveField(k, base, kindLabel) {
  const m = F.m[k];
  if (m === 'none') { if (F.keep[k]) F.oldPaths.push(F.keep[k].path); return { url: '' }; }
  if (m === 'link') {
    if (F.keep[k]) F.oldPaths.push(F.keep[k].path);
    const u = safeUrl(F.url[k]);
    if (!u) throw new Error(`${kindLabel}: enter a valid http(s) link.`);
    return { url: u };
  }
  if (F.files[k]) {
    if (F.keep[k]) F.oldPaths.push(F.keep[k].path);
    return uploadFile(F.files[k], `resources/${S.kind}/${F.id}/${k}_${Date.now()}_${safeName(F.files[k].name)}`, k);
  }
  if (F.keep[k]) return { url: F.keep[k].url, path: F.keep[k].path };
  throw new Error(`${kindLabel}: choose a file to upload.`);
}

async function save() {
  if (F.busy) return;
  const books = S.kind === 'books';
  const err = $('rsErr'); err.textContent = '';
  const title = $('rsTitleIn').value.trim(), moduleId = $('rsMod').value;
  try {
    if (!title) throw new Error('Title is required.');
    if (!moduleId) throw new Error('Choose a module.');
    const lecturer = books ? '' : $('rsLect').value.trim();
    if (!books && !lecturer) throw new Error('Lecturer is required.');
    F.busy = true; F.oldPaths = [];
    $('rsSave').disabled = true; $('rsSave').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

    const file = await resolveField('file', 'file', books ? 'Book' : 'Video');
    const thumb = await resolveField('thumb', 'thumb', 'Thumbnail');
    const photo = books ? { url: '' } : await resolveField('photo', 'photo', 'Lecturer photo');

    const mod = S.mods.find(m => m.id === moduleId);
    const data = {
      title, description: $('rsDesc').value.trim(), moduleId, subjectId: $('rsSub').value || '',
      universityId: (mod && mod.universityId) || 'jimma',
      sourceType: file.path ? 'upload' : 'link',
      thumbUrl: thumb.url || '', thumbPath: thumb.path || '',
      order: Number($('rsOrder').value) || 0, active: $('rsActive').checked,
      updatedAt: serverTimestamp()
    };
    if (F.isNew) data.createdAt = serverTimestamp();
    if (books) {
      Object.assign(data, { linkedVideoIds: F.linkedVideos, author: $('rsAuthor').value.trim(), fileUrl: file.url, filePath: file.path || '',
        fileName: F.files.file ? F.files.file.name : (file.path ? (F.keep.file?.name || '') : ''),
        fileSize: F.files.file ? F.files.file.size : (file.path ? (F.keep.file?.size || 0) : 0) });
    } else {
      Object.assign(data, { related: { videos: F.rel.videos, books: F.rel.books, quizzes: F.rel.quizzes }, lecturer, lecturerTitle: $('rsLectTitle').value.trim(), lecturerPhoto: photo.url || '', photoPath: photo.path || '',
        videoUrl: file.url, filePath: file.path || '', duration: $('rsDur').value.trim() });
    }
    await setDoc(doc(db, S.kind, F.id), data, { merge: true });
    // old uploads that were replaced/removed
    await Promise.all(F.oldPaths.filter(Boolean).map(p => deleteObject(sRef(getStor(), p)).catch(() => {})));
    window.__markContentChanged?.('v');
    toast(`${books ? 'Book' : 'Video'} saved.`, 'success');
    F.busy = false; closeForm();
    await load(true);
  } catch (e) {
    console.error(e);
    let msg = e.message || String(e);
    if (/storage\/unauthorized/.test(msg)) msg = 'Upload not allowed — deploy storage.rules and make sure your admin account has the “AResources” permission.';
    else if (/storage\/(unknown|retry-limit|bucket-not-found|project-not-found)|Blaze|billing/i.test(msg)) msg = 'Firebase Storage is not available for this project (it may need the Blaze plan). Use an external link instead.';
    err.textContent = msg;
    if (F) { F.busy = false; $('rsSave').disabled = false; $('rsSave').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save'; }
  }
}

async function removeItem(it) {
  if (!confirm(`Delete “${it.title}”? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, S.kind, it.id));
    await Promise.all([it.filePath, it.thumbPath, it.photoPath].filter(Boolean).map(p => deleteObject(sRef(getStor(), p)).catch(() => {})));
    window.__markContentChanged?.('v');
    S[S.kind] = S[S.kind].filter(x => x.id !== it.id);
    renderTable();
    toast('Deleted.', 'success');
  } catch (e) { toast('Delete failed: ' + (e.message || e), 'error'); }
}


/* ------------------------------------------------- related content (links) */
const relBooksSection = () => `<div class="rs-sec">Link to videos</div>
  <div class="help" style="margin:-4px 0 10px">This book will also appear under the “Books” tab of each video you choose here.</div>
  ${chipBox('lvideos', 'Show this book under these videos')}`;
const relVideosSection = () => `<div class="rs-sec">Related content</div>
  <div class="help" style="margin:-4px 0 10px">Shown in the tabs under the video in the app. Books and quizzes open right there while the video keeps playing. If you link no videos, the app suggests videos from the same subject.</div>
  ${chipBox('videos', 'Related videos')}${chipBox('books', 'Related books')}
  <div class="form-group"><label>Related quizzes</label><div class="rs-chips" data-quizchips></div>
    <div class="rs-qb">
      <select class="form-control" data-q="type">
        <option value="quiz">A specific quiz (e.g. a year’s paper)</option>
        <option value="subject">Every quiz of a subject</option>
        <option value="module">Every quiz of a module</option>
        <option value="category">A question category</option>
      </select>
      <div class="rs-grid2">
        <select class="form-control" data-q="mod"><option value="">Module…</option>${S.mods.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select>
        <select class="form-control" data-q="sub"><option value="">Subject…</option></select>
      </div>
      <select class="form-control" data-q="quiz" style="display:none"><option value="">Quiz…</option></select>
      <div data-q-catwrap style="display:none"><input class="form-control" data-q="cat" list="rsCatList" placeholder="Category (type or pick)…" /><datalist id="rsCatList"></datalist><div class="help" data-q-cathelp></div></div>
      <button type="button" class="btn" data-q-add><i class="fa-solid fa-plus"></i> Add quiz link</button>
    </div></div>`;
const chipBox = (kind, label) => `<div class="form-group" data-chipbox="${kind}"><label>${label}</label><div class="rs-chips"></div><select class="form-control" data-addsel="${kind}"></select></div>`;

const relList = k => (k === 'videos' ? F.rel.videos : k === 'books' ? F.rel.books : F.linkedVideos);
const relSource = k => (k === 'books' ? S.books : S.videos);
function renderChips(kind) {
  const box = $('rsForm').querySelector(`[data-chipbox="${kind}"]`); if (!box) return;
  const sel = relList(kind), src = relSource(kind);
  box.querySelector('.rs-chips').innerHTML = sel.length
    ? sel.map(id => { const x = src.find(y => y.id === id); return `<span class="rs-chip"><span>${esc(x ? x.title : '(deleted)')}</span><button type="button" data-rm="${kind}:${esc(id)}" aria-label="Remove">×</button></span>`; }).join('')
    : '<span class="help">Nothing linked yet</span>';
  box.querySelector('select').innerHTML = '<option value="">Add…</option>' + src.filter(x => x.id !== F.id && !sel.includes(x.id))
    .map(x => `<option value="${esc(x.id)}">${esc(modName(x.moduleId))} · ${esc(x.title)}</option>`).join('');
}
function renderQuizChips() {
  const el = $('rsForm').querySelector('[data-quizchips]'); if (!el) return;
  el.innerHTML = F.rel.quizzes.length
    ? F.rel.quizzes.map((l, i) => `<span class="rs-chip"><span>${esc(linkLabel(l))}</span><button type="button" data-rmq="${i}" aria-label="Remove">×</button></span>`).join('')
    : '<span class="help">No quizzes linked yet</span>';
}
function linkLabel(l) {
  if (l.label) return l.label;
  if (l.type === 'module') return `Module · ${modName(l.moduleId)}`;
  if (l.type === 'subject') return `Subject · ${subName(l.subjectId)}`;
  if (l.type === 'category') return `Category · ${l.category} (${subName(l.subjectId)})`;
  return `Quiz · ${subName(l.subjectId)}`;
}
function initRelated() {
  ['videos', 'books', 'lvideos'].forEach(renderChips);
  renderQuizChips();
  if ($('rsForm').querySelector('[data-q=type]')) qbSync();
}
const qb = k => $('rsForm').querySelector(`[data-q=${k}]`);
function qbSync() {
  const type = qb('type').value;
  qb('sub').style.display = type === 'module' ? 'none' : '';
  qb('quiz').style.display = type === 'quiz' ? '' : 'none';
  $('rsForm').querySelector('[data-q-catwrap]').style.display = type === 'category' ? '' : 'none';
  const mid = qb('mod').value, keep = qb('sub').value;
  qb('sub').innerHTML = '<option value="">Subject…</option>' + S.subs.filter(s => !mid || s.moduleId === mid).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  if (keep && [...qb('sub').options].some(o => o.value === keep)) qb('sub').value = keep;   // keep the choice when only the type changes
}
async function qbLoadSubject() {
  const type = qb('type').value, sid = qb('sub').value; if (!sid) return;
  try {
    if (type === 'quiz') {
      qb('quiz').innerHTML = '<option value="">Loading…</option>';
      if (!S.qz[sid]) S.qz[sid] = (await getDocs(collection(db, 'subjects', sid, 'quizzes'))).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
      qb('quiz').innerHTML = '<option value="">Quiz…</option>' + S.qz[sid].map(q => `<option value="${esc(q.id)}">${esc(q.name || q.id)}</option>`).join('');
    } else if (type === 'category') {
      const help = $('rsForm').querySelector('[data-q-cathelp]'); help.textContent = 'Loading categories…';
      if (!S.cats[sid]) {
        const quizzes = S.qz[sid] || (S.qz[sid] = (await getDocs(collection(db, 'subjects', sid, 'quizzes'))).docs.map(d => ({ id: d.id, ...d.data() })));
        const set = new Set();
        await Promise.all(quizzes.map(async q => (await getDocs(collection(db, 'subjects', sid, 'quizzes', q.id, 'questions'))).docs.forEach(d => { const x = d.data(); const c = x.categoryLabel || x.category; if (c) set.add(c); })));
        S.cats[sid] = [...set].sort();
      }
      $('rsCatList').innerHTML = S.cats[sid].map(c => `<option value="${esc(c)}">`).join('');
      help.textContent = S.cats[sid].length ? `${S.cats[sid].length} categories found in this subject.` : 'No categories found — type one exactly as in your questions.';
    }
  } catch (e) { toast('Could not load: ' + (e.message || e), 'error'); }
}
function qbAdd() {
  const type = qb('type').value, mid = qb('mod').value, sid = qb('sub').value, qid = qb('quiz').value, cat = qb('cat').value.trim();
  let link;
  if (type === 'module') { if (!mid) return toast('Choose a module.', 'error'); link = { type, moduleId: mid, label: `Module · ${modName(mid)}` }; }
  else if (!sid) return toast('Choose a subject.', 'error');
  else if (type === 'subject') link = { type, subjectId: sid, label: `Subject · ${subName(sid)}` };
  else if (type === 'quiz') { if (!qid) return toast('Choose a quiz.', 'error'); const q = (S.qz[sid] || []).find(x => x.id === qid); link = { type, subjectId: sid, quizId: qid, label: `Quiz · ${subName(sid)} → ${q ? q.name : qid}` }; }
  else { if (!cat) return toast('Enter a category.', 'error'); link = { type, subjectId: sid, category: cat, label: `Category · ${cat} (${subName(sid)})` }; }
  const key = JSON.stringify([link.type, link.moduleId, link.subjectId, link.quizId, (link.category || '').toLowerCase()]);
  if (F.rel.quizzes.some(l => JSON.stringify([l.type, l.moduleId, l.subjectId, l.quizId, (l.category || '').toLowerCase()]) === key)) return toast('Already linked.', 'info');
  F.rel.quizzes.push(link); renderQuizChips(); qb('cat').value = '';
}
function relClick(e) {
  const rm = e.target.closest('[data-rm]');
  if (rm) { const [k, id] = rm.dataset.rm.split(':'); const l = relList(k); l.splice(l.indexOf(id), 1); renderChips(k); return true; }
  const rq = e.target.closest('[data-rmq]');
  if (rq) { F.rel.quizzes.splice(+rq.dataset.rmq, 1); renderQuizChips(); return true; }
  if (e.target.closest('[data-q-add]')) { qbAdd(); return true; }
  return false;
}
function relChange(e) {
  const t = e.target;
  if (t.matches('[data-addsel]')) { if (t.value) { relList(t.dataset.addsel).push(t.value); renderChips(t.dataset.addsel); } return true; }
  if (t.matches('[data-q=type]')) { qbSync(); qbLoadSubject(); return true; }
  if (t.matches('[data-q=mod]')) { qbSync(); return true; }
  if (t.matches('[data-q=sub]')) { qbLoadSubject(); return true; }
  return false;
}

/* ------------------------------------------------------------ entry point */
window.__alifInitResourcesAdmin = () => {
  if (!$('tab-resources')) return;
  ensureUi();
  load(false);
};
