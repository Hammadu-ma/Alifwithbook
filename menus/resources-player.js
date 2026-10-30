/* ========================================================================
   ALIF Med — AResources video player
   ------------------------------------------------------------------------
   * One themed control layer (progress bar, play/pause, ±10s, volume, speed,
     fullscreen) drawn by us over three engines:
        file    <video>              uploaded / direct MP4, WebM
        youtube YouTube IFrame API   (native YouTube controls hidden)
        vimeo   Vimeo Player API     (native Vimeo controls hidden)
     Sources that expose no JavaScript API (Google Drive, unknown sites) are
     shown in a plain embed — they can't be driven by our controls.
   * Under the video: tabs for Related videos / books / quizzes. A book or a
     quiz opens right there in the panel while the video keeps playing.
   ======================================================================== */
import { mountEmbeddedQuiz } from './resources-quizembed.js';
import { mountReader, SANDBOX } from './resources-reader.js';
import { loadCategoryQuestions, loadQuizQuestions, lockMessage, mountQuiz, resolveQuizLinks } from './resources-quiz.js';
import { driveId, esc, plural, safeUrl, thumbSrc, videoThumb, vimeoParts, ytId, fileExt } from './resources-util.js';

/* ------------------------------------------------------------------ icons */
const I = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5Z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4.2" height="14" rx="1.4" fill="currentColor"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.4" fill="currentColor"/></svg>',
  replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4.8h4.8"/></svg>',
  back10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.2v4.4h4.4"/><text x="12" y="15.4" text-anchor="middle" font-size="7.4" font-weight="800" fill="currentColor" stroke="none" font-family="sans-serif">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.2v4.4h-4.4"/><text x="12" y="15.4" text-anchor="middle" font-size="7.4" font-weight="800" fill="currentColor" stroke="none" font-family="sans-serif">10</text></svg>',
  vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.6L12 18.5v-13L7.6 9.5H4Z" fill="currentColor"/><path d="M15.6 9a4.2 4.2 0 0 1 0 6"/><path d="M18.2 6.4a8 8 0 0 1 0 11.2"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.6L12 18.5v-13L7.6 9.5H4Z" fill="currentColor"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>',
  fs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  fsx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'
};
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const fmt = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};

/* ---------------------------------------------------------- source parsing */
export function parseVideo(v) {
  const url = safeUrl(v.videoUrl);
  if (!url) return { kind: 'none' };
  const y = ytId(url);
  if (y) return { kind: 'youtube', id: y, url };
  const vm = vimeoParts(url);
  if (vm) return { kind: 'vimeo', id: vm.id, h: vm.h, url };
  const d = driveId(url);
  if (d) return { kind: 'frame', src: `https://drive.google.com/file/d/${d}/preview`, url };
  if (v.sourceType === 'upload' || /^(mp4|webm|ogg|ogv|mov|m4v)$/.test(fileExt(url))) return { kind: 'file', src: url, url };
  return { kind: 'frame', src: url, url, loose: true };
}

/* ----------------------------------------------------------------- engines */
function emitter() {
  const h = {};
  return { on: (e, f) => ((h[e] = h[e] || []).push(f)), emit: (e, a) => (h[e] || []).forEach(f => f(a)) };
}
const loadOnce = (() => {
  const m = {};
  return (key, src, ready) => m[key] || (m[key] = new Promise((res, rej) => {
    if (ready()) return res();
    const s = document.createElement('script');
    s.src = src; s.async = true;
    const t = setTimeout(() => { delete m[key]; rej(new Error('timeout')); }, 12000);
    s.onload = () => { clearTimeout(t); ready() ? res() : (window.onYouTubeIframeAPIReady = res); };
    s.onerror = () => { clearTimeout(t); delete m[key]; rej(new Error('load')); };
    document.head.appendChild(s);
  }));
})();

function htmlEngine(stage, src, poster) {
  const el = document.createElement('video');
  el.playsInline = true; el.preload = 'metadata'; el.src = src;
  if (poster) el.poster = poster;
  el.setAttribute('controlsList', 'nodownload noplaybackrate');
  el.disablePictureInPicture = true;
  stage.prepend(el);
  const ev = emitter();
  const st = s => ev.emit('state', s);
  el.addEventListener('play', () => st('playing'));
  el.addEventListener('playing', () => st('playing'));
  el.addEventListener('pause', () => { if (!el.ended) st('paused'); });
  el.addEventListener('waiting', () => st('buffering'));
  el.addEventListener('ended', () => st('ended'));
  el.addEventListener('error', () => ev.emit('error'));
  return {
    kind: 'file', ev, el,
    play: () => el.play().catch(() => {}), pause: () => el.pause(),
    seek: t => { el.currentTime = t; },
    time: () => el.currentTime || 0, dur: () => (isFinite(el.duration) ? el.duration : 0),
    buffered: () => { const b = el.buffered; return b.length ? b.end(b.length - 1) : 0; },
    setRate: r => { el.playbackRate = r; }, setVol: v => { el.volume = v; el.muted = v === 0; },
    setMuted: m => { el.muted = m; }, destroy: () => { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); }
  };
}

async function youtubeEngine(stage, id) {
  await loadOnce('yt', 'https://www.youtube.com/iframe_api', () => window.YT && window.YT.Player);
  // our own iframe, so it can be sandboxed (no pop-outs / "Watch on YouTube" navigation) before it loads
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', SANDBOX);
  f.allow = 'autoplay; encrypted-media; picture-in-picture';
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  f.src = `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&autoplay=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&origin=${encodeURIComponent(location.origin)}`;
  stage.prepend(f);
  stage.classList.add('yt');
  const ev = emitter();
  return new Promise((res, rej) => {
    let ready = false;
    const tmo = setTimeout(() => { if (!ready) rej(new Error('yt timeout')); }, 12000);
    const p = new window.YT.Player(f, {
      events: {
        onReady: () => {
          ready = true; clearTimeout(tmo);
          res({
            kind: 'youtube', ev,
            play: () => p.playVideo(), pause: () => p.pauseVideo(), seek: t => p.seekTo(t, true),
            time: () => p.getCurrentTime() || 0, dur: () => p.getDuration() || 0,
            buffered: () => (p.getVideoLoadedFraction() || 0) * (p.getDuration() || 0),
            setRate: r => p.setPlaybackRate(r), setVol: v => { p.setVolume(v * 100); v === 0 ? p.mute() : p.unMute(); },
            setMuted: m => (m ? p.mute() : p.unMute()),
            destroy: () => { try { p.destroy(); } catch (_) {} f.remove(); }
          });
        },
        onStateChange: e => ev.emit('state', { 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering' }[e.data] || 'idle'),
        onError: () => ev.emit('error')
      }
    });
  });
}

async function vimeoEngine(stage, id, h) {
  await loadOnce('vimeo', 'https://player.vimeo.com/api/player.js', () => window.Vimeo && window.Vimeo.Player);
  const f = document.createElement('iframe');
  f.src = `https://player.vimeo.com/video/${id}?controls=0&playsinline=1&title=0&byline=0&portrait=0&dnt=1&autoplay=1${h ? '&h=' + h : ''}`;
  f.allow = 'autoplay; fullscreen; picture-in-picture';
  f.setAttribute('sandbox', SANDBOX);
  stage.prepend(f);
  const p = new window.Vimeo.Player(f);
  const ev = emitter();
  let t = 0, d = 0, b = 0;
  p.on('play', () => ev.emit('state', 'playing'));
  p.on('pause', () => ev.emit('state', 'paused'));
  p.on('ended', () => ev.emit('state', 'ended'));
  p.on('bufferstart', () => ev.emit('state', 'buffering'));
  p.on('bufferend', () => ev.emit('state', 'playing'));
  p.on('timeupdate', e => { t = e.seconds; d = e.duration; });
  p.on('progress', e => { b = e.seconds; });
  p.on('error', () => ev.emit('error'));
  await p.ready();
  d = await p.getDuration().catch(() => 0);
  return {
    kind: 'vimeo', ev,
    play: () => p.play().catch(() => {}), pause: () => p.pause(), seek: x => { t = x; p.setCurrentTime(x); },
    time: () => t, dur: () => d, buffered: () => b,
    setRate: r => p.setPlaybackRate(r), setVol: v => p.setVolume(v), setMuted: m => p.setMuted(m),
    destroy: () => { try { p.destroy(); } catch (_) {} f.remove(); }
  };
}

/* ------------------------------------------------------------------ player */
export function mountPlayer(host, first, ctx) {
  let video = null, engine = null, tab = 'videos', panelHandle = null, dead = false;
  let timers = [], offs = [];
  let quizP = null;                       // resolved quiz groups for the current video
  let ui = null;                          // control state
  const touch = !window.matchMedia('(hover: hover)').matches;

  const on = (t, e, f, o) => { t.addEventListener(e, f, o); offs.push(() => t.removeEventListener(e, f, o)); };
  const every = (f, ms) => { const id = setInterval(f, ms); timers.push(id); return id; };

  /* ---------- related-content resolution ---------- */
  function related(v) {
    const { BOOKS, VIDEOS } = ctx.data();
    const r = v.related || {};
    const byId = (list, ids) => (ids || []).map(id => list.find(x => x.id === id)).filter(Boolean);
    let vids = byId(VIDEOS, r.videos).filter(x => x.id !== v.id);
    let auto = false;
    if (!vids.length) {   // nothing linked by the admin: suggest the same subject, then the same module
      const same = VIDEOS.filter(x => x.id !== v.id && x.moduleId === v.moduleId);
      vids = same.filter(x => v.subjectId && x.subjectId === v.subjectId).concat(same.filter(x => !(v.subjectId && x.subjectId === v.subjectId))).slice(0, 10);
      auto = true;
    }
    const books = [...new Map([...byId(BOOKS, r.books), ...BOOKS.filter(b => (b.linkedVideoIds || []).includes(v.id))].map(b => [b.id, b])).values()];
    return { vids, auto, books, links: Array.isArray(r.quizzes) ? r.quizzes : [] };
  }

  /* ---------- load / render a video ---------- */
  function teardownVideo() {
    timers.forEach(clearInterval); timers = [];
    offs.forEach(f => f()); offs = [];
    if (panelHandle) { panelHandle.destroy(); panelHandle = null; }
    if (engine) { try { engine.destroy(); } catch (_) {} engine = null; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function load(v) {
    teardownVideo();
    video = v;
    const rel = related(v);
    quizP = null;
    tab = rel.vids.length ? 'videos' : rel.books.length ? 'books' : rel.links.length ? 'quizzes' : 'videos';
    const sub = ctx.subjectName(v.subjectId);
    const info = parseVideo(v);
    host.innerHTML = `
      <div class="res-pl">
        <div class="res-pl-bar"><div class="res-player-name">${esc(v.title || 'Video')}</div>
          <button type="button" class="res-sheet-x static" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="res-pl-body">
          <div class="res-pl-left">
            <div class="res-pl-stage" data-stage></div>
            <div class="res-pl-meta">
              <h3>${esc(v.title || 'Untitled')}</h3>
              <div class="res-player-meta">
                ${v.lecturer ? `<span class="res-vid-lect"><span class="res-av sm">${safeUrl(v.lecturerPhoto) ? `<img src="${esc(thumbSrc(v.lecturerPhoto))}" alt="" referrerpolicy="no-referrer">` : esc(ctx.initials(v.lecturer))}</span><span>${esc(v.lecturer)}</span></span>` : ''}
                ${sub ? `<span class="res-chip"><i class="fa-solid fa-tag"></i>${esc(sub)}</span>` : ''}
                ${v.duration ? `<span class="res-chip"><i class="fa-solid fa-clock"></i>${esc(v.duration)}</span>` : ''}
              </div>
              ${v.description ? `<p class="res-sheet-desc">${esc(v.description)}</p>` : ''}
            </div>
          </div>
          <div class="res-pl-split" data-split role="separator" tabindex="0" aria-label="Resize video and panel (drag, or use arrow keys; double-tap to reset)"><i></i></div>
          <div class="res-pl-right">
            <div class="res-pl-tabs" data-tabs></div>
            <div class="res-pl-panel" data-panel></div>
          </div>
        </div>
      </div>`;
    host.scrollTop = 0;
    initSplit();
    renderTabs(rel);
    renderPanel(rel);
    startStage(host.querySelector('[data-stage]'), info, v);
    // resolve quiz links in the background, then refresh the tab count
    if (rel.links.length) {
      quizP = resolveQuizLinks(rel.links, { subjects: ctx.data().SUBJ, student: ctx.student() }).catch(() => []);
      const mine = quizP;
      mine.then(groups => {
        mine.__n = groups.reduce((n, g) => n + g.items.length, 0);
        if (!dead && video === v) { renderTabs(related(v)); if (tab === 'quizzes' && !panelHandle) renderPanel(related(v)); }
      });
    }
  }

  /* ---------- stage + engine ---------- */
  async function startStage(stage, info, v) {
    if (info.kind === 'none') { stage.innerHTML = '<div class="res-pl-msg"><i class="fa-solid fa-play"></i><p>This video’s link isn’t available yet.</p></div>'; return; }
    const frame = (src, loose) => {
      stage.classList.remove('yt'); stage.classList.add('plain');
      stage.innerHTML = `<iframe src="${esc(src)}" title="${esc(v.title || 'Video')}" sandbox="${SANDBOX}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe><div class="rd-frame-guard"></div>
        <div class="res-pl-note">${loose ? 'If the video stays blank, this host doesn’t allow playing inside the app.' : 'Basic player for this source.'}</div>`;
    };
    if (info.kind === 'frame') { frame(info.src, info.loose); return; }
    stage.insertAdjacentHTML('beforeend', controlsHtml());
    const poster = videoThumb(v);
    stage.style.setProperty('--poster', poster ? `url("${poster.replace(/"/g, '%22')}")` : 'none');
    stage.classList.add('loading');
    try {
      engine = info.kind === 'file' ? htmlEngine(stage, info.src, poster)
        : info.kind === 'youtube' ? await youtubeEngine(stage, info.id)
        : await vimeoEngine(stage, info.id, info.h);
    } catch (_) {
      if (dead || video !== v) return;
      // the API could not be loaded (offline / blocked): fall back to a plain embed
      stage.querySelectorAll('.res-pl-shield,.res-pl-ui,.pl-spin').forEach(n => n.remove());
      if (info.kind === 'youtube') frame(`https://www.youtube-nocookie.com/embed/${info.id}?autoplay=1&rel=0&playsinline=1`);
      else if (info.kind === 'vimeo') frame(`https://player.vimeo.com/video/${info.id}?autoplay=1${info.h ? '&h=' + info.h : ''}`);
      else stage.innerHTML = '<div class="res-pl-msg"><i class="fa-solid fa-play"></i><p>This video couldn’t be played.</p></div>';
      return;
    }
    if (dead || video !== v) { engine && engine.destroy(); return; }
    wireControls(stage);
  }

  const controlsHtml = () => `
    <div class="res-pl-shield" data-shield></div>
    <div class="pl-spin hidden"><i class="fa-solid fa-spinner fa-spin"></i></div>
    <div class="pl-ripple l hidden">−10s</div><div class="pl-ripple r hidden">+10s</div>
    <div class="res-pl-ui" data-ui>
      <div class="pl-mid">
        <button type="button" class="pl-skip" data-a="back" aria-label="Back 10 seconds">${I.back10}</button>
        <button type="button" class="pl-big" data-a="toggle" aria-label="Play or pause"></button>
        <button type="button" class="pl-skip" data-a="fwd" aria-label="Forward 10 seconds">${I.fwd10}</button>
      </div>
      <div class="pl-bottom">
        <div class="pl-seek" data-seek role="slider" aria-label="Seek" tabindex="0"><div class="pl-track"><i class="pl-buf"></i><i class="pl-fill"></i></div><span class="pl-knob"></span><span class="pl-tip">0:00</span></div>
        <div class="pl-row">
          <button type="button" class="pl-btn" data-a="toggle" aria-label="Play or pause"></button>
          <span class="pl-time" data-time>0:00 / 0:00</span>
          <span class="pl-sp"></span>
          <button type="button" class="pl-btn" data-a="mute" aria-label="Mute"></button>
          <div class="pl-menu-wrap"><button type="button" class="pl-btn txt" data-a="speed" aria-label="Playback speed">1×</button>
            <div class="pl-menu hidden" data-menu>${SPEEDS.map(s => `<button type="button" data-rate="${s}" class="${s === 1 ? 'on' : ''}">${s}×</button>`).join('')}</div></div>
          <button type="button" class="pl-btn" data-a="fs" aria-label="Fullscreen"></button>
        </div>
      </div>
    </div>`;

  function wireControls(stage) {
    const q = s => stage.querySelector(s);
    const uiEl = q('[data-ui]'), shield = q('[data-shield]'), seek = q('[data-seek]'), tip = q('.pl-tip');
    const fill = q('.pl-fill'), buf = q('.pl-buf'), knob = q('.pl-knob'), timeEl = q('[data-time]'), spin = q('.pl-spin'), menu = q('[data-menu]');
    ui = { state: 'idle', rate: 1, muted: false, scrub: false, shown: true, hideT: 0, last: 0 };
    stage.classList.remove('loading');

    const paintIcons = () => {
      const pl = ui.state === 'playing' || ui.state === 'buffering';
      const ended = ui.state === 'ended';
      stage.querySelectorAll('[data-a=toggle]').forEach(b => { b.innerHTML = ended ? I.replay : pl ? I.pause : I.play; });
      stage.querySelector('[data-a=mute]').innerHTML = ui.muted ? I.mute : I.vol;
      stage.querySelector('[data-a=fs]').innerHTML = isFs() ? I.fsx : I.fs;
      stage.classList.toggle('is-playing', pl);
      spin.classList.toggle('hidden', ui.state !== 'buffering');
    };
    const isFs = () => document.fullscreenElement === stage || stage.classList.contains('fs');
    const showUi = () => {
      ui.shown = true; uiEl.classList.remove('off'); stage.classList.remove('hide-cursor');
      clearTimeout(ui.hideT);
      if (ui.state === 'playing' && !ui.scrub) ui.hideT = setTimeout(hideUi, 2800);
    };
    const hideUi = () => { if (ui.state !== 'playing' || ui.scrub || !menu.classList.contains('hidden')) return; ui.shown = false; uiEl.classList.add('off'); if (!touch) stage.classList.add('hide-cursor'); };
    const toggle = () => { if (!engine) return; if (ui.state === 'ended') { engine.seek(0); engine.play(); } else if (ui.state === 'playing' || ui.state === 'buffering') engine.pause(); else engine.play(); };
    const skip = d => { if (!engine) return; const t = Math.min(Math.max(0, engine.time() + d), engine.dur() || 1e9); engine.seek(t); ripple(d < 0 ? 'l' : 'r'); paint(); showUi(); };
    const ripple = side => { const r = q('.pl-ripple.' + side); r.classList.remove('hidden'); r.style.animation = 'none'; void r.offsetWidth; r.style.animation = ''; setTimeout(() => r.classList.add('hidden'), 650); };
    const setFs = async () => {
      if (isFs()) { if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); stage.classList.remove('fs'); }
      else {
        const rq = stage.requestFullscreen || stage.webkitRequestFullscreen;
        try { if (!rq) throw 0; await rq.call(stage); } catch (_) { stage.classList.add('fs'); }
      }
      paintIcons();
    };
    const setRate = r => { ui.rate = r; engine.setRate(r); q('[data-a=speed]').textContent = r + '×'; menu.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.rate === r)); menu.classList.add('hidden'); };
    const setMuted = m => { ui.muted = m; engine.setMuted(m); paintIcons(); };

    const paint = () => {
      if (!engine) return;
      const d = engine.dur(), t = ui.scrub ? ui.scrubT : engine.time();
      const p = d ? Math.min(100, (t / d) * 100) : 0;
      fill.style.width = p + '%'; knob.style.left = p + '%';
      buf.style.width = (d ? Math.min(100, (engine.buffered() / d) * 100) : 0) + '%';
      timeEl.textContent = `${fmt(t)} / ${fmt(d)}`;
      seek.setAttribute('aria-valuenow', Math.round(p));
    };

    engine.ev.on('state', s => { ui.state = s; paintIcons(); if (s === 'playing') showUi(); else { showUi(); clearTimeout(ui.hideT); } });
    engine.ev.on('error', () => { stage.insertAdjacentHTML('beforeend', '<div class="res-pl-msg over"><i class="fa-solid fa-play"></i><p>This video couldn’t be played.</p></div>'); });
    every(paint, 200);
    paintIcons(); paint();

    // taps on the shield: desktop click = play/pause; touch tap = toggle controls, double-tap sides = ±10s
    let lastTap = 0, tapT = 0;
    on(shield, 'click', e => {
      const r = shield.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, now = Date.now();
      if (!touch) { toggle(); showUi(); return; }
      if (now - lastTap < 300) {
        clearTimeout(tapT); lastTap = 0;
        if (x < 0.4) skip(-10); else if (x > 0.6) skip(10); else toggle();
        return;
      }
      lastTap = now;
      tapT = setTimeout(() => { ui.shown && ui.state === 'playing' ? hideUi() : showUi(); }, 300);
    });
    on(stage, 'mousemove', showUi);
    on(stage, 'click', e => {
      const a = e.target.closest('[data-a]'), r = e.target.closest('[data-rate]');
      if (r) { setRate(+r.dataset.rate); return; }
      if (!a) { if (!e.target.closest('.pl-menu-wrap')) menu.classList.add('hidden'); return; }
      const k = a.dataset.a;
      if (k === 'toggle') toggle(); else if (k === 'back') skip(-10); else if (k === 'fwd') skip(10);
      else if (k === 'mute') setMuted(!ui.muted);
      else if (k === 'speed') menu.classList.toggle('hidden');
      else if (k === 'fs') setFs();
      showUi();
    });
    on(document, 'fullscreenchange', () => { if (!document.fullscreenElement) stage.classList.remove('fs'); paintIcons(); });

    // scrubbing on the themed progress bar
    const ratioOf = e => { const r = seek.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
    const tipAt = e => { const d = engine.dur(), p = ratioOf(e); tip.textContent = fmt(p * d); tip.style.left = p * 100 + '%'; return p * d; };
    on(seek, 'pointerdown', e => { ui.scrub = true; seek.setPointerCapture(e.pointerId); seek.classList.add('active'); ui.scrubT = tipAt(e); paint(); });
    on(seek, 'pointermove', e => { const t = tipAt(e); if (ui.scrub) { ui.scrubT = t; paint(); } });
    on(seek, 'pointerup', e => { if (!ui.scrub) return; ui.scrub = false; seek.classList.remove('active'); engine.seek(ui.scrubT); paint(); showUi(); });
    on(seek, 'pointercancel', () => { ui.scrub = false; seek.classList.remove('active'); });
    on(seek, 'keydown', e => { if (e.key === 'ArrowLeft') skip(-5); else if (e.key === 'ArrowRight') skip(5); });

    // keyboard (not while typing)
    on(document, 'keydown', e => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.closest('[data-seek]')) return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); showUi(); }
      else if (e.key === 'ArrowLeft') skip(-10); else if (e.key === 'ArrowRight') skip(10);
      else if (e.key === 'm') setMuted(!ui.muted); else if (e.key === 'f') setFs();
    });
    showUi();
  }


  /* ---------- resizable split (video ⇄ panel) ---------- */
  const SPLIT_KEY = 'alif_pl_split_v1';
  const wideNow = () => window.matchMedia('(min-width: 900px)').matches;
  const clampN = (v, a, b) => Math.min(Math.max(v, a), Math.max(a, b));
  function initSplit() {
    const body = host.querySelector('.res-pl-body'), bar = host.querySelector('[data-split]'), meta = host.querySelector('.res-pl-meta');
    if (!body || !bar) return;
    let pf = null;
    try { pf = JSON.parse(localStorage.getItem(SPLIT_KEY)); } catch (_) {}
    const save = () => { try { localStorage.setItem(SPLIT_KEY, JSON.stringify(pf)); } catch (_) {} };
    const limits = () => {
      const r = body.getBoundingClientRect();
      return wideNow()
        ? { r, min: 280, max: r.width * 0.62 }
        : { r, min: 110, max: r.height - meta.offsetHeight - bar.offsetHeight - 44 - 130 };   // keep tabs + a bit of panel visible
    };
    const defaults = () => {
      const r = body.getBoundingClientRect();
      return { h: Math.min((r.width * 9) / 16, r.height * 0.42) / r.height, w: 0.31 };
    };
    const apply = () => {
      const { r, min, max } = limits(), d = pf || defaults();
      bar.setAttribute('aria-orientation', wideNow() ? 'vertical' : 'horizontal');
      if (wideNow()) body.style.setProperty('--pl-w', clampN(d.w * r.width, min, max) + 'px');
      else body.style.setProperty('--pl-h', clampN(d.h * r.height, min, max) + 'px');
    };
    const set = px => {                                   // px = new stage height (stacked) or panel width (side by side)
      const { r, min, max } = limits(), v = clampN(px, min, max), d = pf || defaults();
      pf = { ...d, ...(wideNow() ? { w: v / r.width } : { h: v / r.height }) };
      body.style.setProperty(wideNow() ? '--pl-w' : '--pl-h', v + 'px');
      return v;
    };
    const current = () => parseFloat(getComputedStyle(body).getPropertyValue(wideNow() ? '--pl-w' : '--pl-h')) || 0;
    apply();

    let start = null;
    on(bar, 'pointerdown', e => {
      e.preventDefault(); bar.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, v: current() };
      bar.classList.add('drag'); host.classList.add('resizing');
    });
    on(bar, 'pointermove', e => {
      if (!start) return;
      set(wideNow() ? start.v - (e.clientX - start.x) : start.v + (e.clientY - start.y));
    });
    const end = () => { if (!start) return; start = null; bar.classList.remove('drag'); host.classList.remove('resizing'); save(); };
    on(bar, 'pointerup', end);
    on(bar, 'pointercancel', end);
    on(bar, 'dblclick', () => { pf = null; try { localStorage.removeItem(SPLIT_KEY); } catch (_) {} apply(); });
    on(bar, 'keydown', e => {
      const step = e.shiftKey ? 64 : 24, k = e.key;
      const grow = wideNow() ? (k === 'ArrowLeft' ? 1 : k === 'ArrowRight' ? -1 : 0) : (k === 'ArrowDown' ? 1 : k === 'ArrowUp' ? -1 : 0);
      if (!grow) return;
      e.preventDefault(); e.stopPropagation();
      set(current() + (wideNow() ? -grow : grow) * step); save();
    });
    on(window, 'resize', apply);
  }

  /* ---------- tabs + panel ---------- */
  function renderTabs(rel) {
    const quizN = quizP && quizP.__n != null ? quizP.__n : null;
    const items = [
      { key: 'videos', label: 'Videos', n: rel.vids.length },
      { key: 'books', label: 'Books', n: rel.books.length },
      { key: 'quizzes', label: 'Quizzes', n: quizN != null ? quizN : (rel.links.length ? '' : 0) }
    ];
    const idx = items.findIndex(t => t.key === tab);
    host.querySelector('[data-tabs]').innerHTML = `<div class="res-tabs-in" style="--n:3;--idx:${idx}">${items.map(t =>
      `<button type="button" class="res-tab${t.key === tab ? ' active' : ''}" data-ptab="${t.key}" role="tab"><span>${t.label}</span>${t.n !== '' ? `<em>${t.n}</em>` : ''}</button>`).join('')}<span class="res-tab-ind"></span></div>`;
  }

  const miniVideo = (x, cur) => {
    const t = videoThumb(x);
    return `<button type="button" class="res-rel${x.id === cur.id ? ' now' : ''}" data-pv="${esc(x.id)}">
      <span class="res-rel-thumb">${t ? `<img src="${esc(t)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<i class="fa-solid fa-play"></i>${x.duration ? `<em>${esc(x.duration)}</em>` : ''}</span>
      <span class="res-rel-txt"><b>${esc(x.title || 'Untitled')}</b><small>${esc(x.lecturer || '')}</small></span></button>`;
  };
  const miniBook = b => {
    const t = thumbSrc(b.thumbUrl);
    return `<button type="button" class="res-rel book" data-pb="${esc(b.id)}">
      <span class="res-rel-cover" style="--accent:${ctx.accent(b.moduleId)}">${t ? `<img src="${esc(t)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<i class="fa-solid fa-book-medical"></i>'}</span>
      <span class="res-rel-txt"><b>${esc(b.title || 'Untitled')}</b><small>${esc(b.author || '')}</small></span><i class="fa-solid fa-chevron-right res-rel-chev"></i></button>`;
  };

  async function renderPanel(rel) {
    if (panelHandle) { panelHandle.destroy(); panelHandle = null; }
    const panel = host.querySelector('[data-panel]');
    if (!panel) return;
    if (tab === 'videos') {
      panel.innerHTML = rel.vids.length
        ? `${rel.auto ? '<p class="res-rel-head">More from this subject</p>' : ''}<div class="res-rel-list">${rel.vids.map(x => miniVideo(x, video)).join('')}</div>`
        : '<div class="res-empty sm"><div class="res-empty-ico"><i class="fa-solid fa-play"></i></div><h4>No related videos</h4><p>Nothing has been linked to this video yet.</p></div>';
    } else if (tab === 'books') {
      panel.innerHTML = rel.books.length
        ? `<div class="res-rel-list">${rel.books.map(miniBook).join('')}</div>`
        : '<div class="res-empty sm"><div class="res-empty-ico"><i class="fa-solid fa-book"></i></div><h4>No related books</h4><p>No books are linked to this video.</p></div>';
    } else {
      if (!rel.links.length) { panel.innerHTML = '<div class="res-empty sm"><div class="res-empty-ico"><i class="fa-solid fa-bullseye"></i></div><h4>No related quizzes</h4><p>No quizzes are linked to this video.</p></div>'; return; }
      panel.innerHTML = '<div class="res-rel-load"><i class="fa-solid fa-spinner fa-spin"></i> Loading quizzes…</div>';
      const my = video;
      const groups = await quizP;
      if (dead || video !== my || tab !== 'quizzes' || panelHandle) return;
      panel.innerHTML = groups.length ? groups.map(g => `<p class="res-rel-head">${esc(g.subjectName)}</p><div class="res-rel-list">${g.items.map(it => quizRow(it)).join('')}</div>`).join('')
        : '<div class="res-empty sm"><div class="res-empty-ico"><i class="fa-solid fa-bullseye"></i></div><h4>No quizzes available</h4><p>The linked quizzes aren’t available right now.</p></div>';
      panel.__groups = groups;
    }
  }
  const quizRow = it => it.kind === 'category'
    ? `<button type="button" class="res-rel quiz" data-pq="${esc(it.key)}"><span class="res-rel-ico"><i class="fa-solid fa-tag"></i></span><span class="res-rel-txt"><b>Practice: ${esc(it.category)}</b><small>Mixed questions from ${esc(it.subjectName)}</small></span><i class="fa-solid fa-chevron-right res-rel-chev"></i></button>`
    : `<button type="button" class="res-rel quiz${it.locked ? ' locked' : ''}" data-pq="${esc(it.key)}"><span class="res-rel-ico"><i class="fa-solid ${it.locked ? 'fa-lock' : 'fa-bullseye'}"></i></span><span class="res-rel-txt"><b>${esc(it.quiz.name || 'Quiz')}</b><small>${it.locked ? 'Locked' : 'Tap to start'}</small></span><i class="fa-solid fa-chevron-right res-rel-chev"></i></button>`;

  const toList = () => { renderTabs(related(video)); renderPanel(related(video)); };

  async function startQuiz(btn, key) {
    const panel = host.querySelector('[data-panel]');
    const groups = panel.__groups || [];
    const item = groups.flatMap(g => g.items).find(i => i.key === key);
    if (!item) return;
    const student = ctx.student();
    if (item.kind === 'quiz' && item.locked) { ctx.lock(btn, lockMessage(item, student)); return; }
    panel.innerHTML = `<div class="res-rel-load"><i class="fa-solid fa-spinner fa-spin"></i> <span data-msg>Loading questions…</span></div>`;
    const my = video;
    try {
      const qs = item.kind === 'category'
        ? await loadCategoryQuestions(item, student, (d, n) => { const m = panel.querySelector('[data-msg]'); if (m) m.textContent = `Gathering questions… ${d}/${n}`; })
        : await loadQuizQuestions(item);
      if (dead || video !== my) return;
      if (!qs.length) throw new Error('empty');
      const back = () => { panelHandle && panelHandle.destroy(); panelHandle = null; toList(); };
      if (item.kind === 'quiz') {
        // the app's real quiz screen, embedded here without its sidebar
        panelHandle = mountEmbeddedQuiz(panel, { subjectId: item.subjectId, quizId: item.quiz.id, subjectName: item.subjectName, quizName: item.quiz.name, questions: qs }, {
          onBack: back,
          onFull: () => {            // continue the same quiz in the normal full-screen quiz screen
            const h = panelHandle; panelHandle = null;
            if (h) h.release();
            ctx.close();
            setTimeout(() => ctx.fullQuizState && ctx.fullQuizState(), 180);
          }
        });
      } else {
        // category practice has no quiz of its own: mixed questions in the light runner
        panelHandle = mountQuiz(panel, { title: `Practice: ${item.category}`, sub: item.subjectName, questions: qs }, { onBack: back });
      }
    } catch (e) {
      if (dead || video !== my) return;
      const denied = /permission|insufficient/i.test(String(e && (e.code || e.message)));
      panel.innerHTML = `<div class="res-empty sm"><div class="res-empty-ico"><i class="fa-solid fa-${denied ? 'lock' : 'bullseye'}"></i></div><h4>${denied ? 'Quiz locked' : 'No questions found'}</h4><p>${denied ? 'This quiz is locked for you.' : 'There are no questions to practise yet.'}</p><button type="button" class="rq-nav" data-ptab="${'quizzes'}">Back</button></div>`;
    }
  }

  /* host-level delegation (survives re-renders) */
  const onHostClick = e => {
    if (e.target.closest('.res-pl-bar [data-close]')) { ctx.close(); return; }
    const t = e.target.closest('[data-ptab]');
    if (t) { tab = t.dataset.ptab; toList(); return; }
    const pv = e.target.closest('[data-pv]');
    if (pv) { const nv = ctx.data().VIDEOS.find(x => x.id === pv.dataset.pv); if (nv && nv.id !== video.id) load(nv); return; }
    const pb = e.target.closest('[data-pb]');
    if (pb) {
      const b = ctx.data().BOOKS.find(x => x.id === pb.dataset.pb); if (!b) return;
      const panel = host.querySelector('[data-panel]');
      panelHandle = mountReader(panel, b, { back: true, onClose: () => { panelHandle && panelHandle.destroy(); panelHandle = null; toList(); } });
      return;
    }
    const pq = e.target.closest('[data-pq]');
    if (pq) startQuiz(pq, pq.dataset.pq);
  };
  host.addEventListener('click', onHostClick);

  load(first);
  return {
    destroy() { dead = true; host.removeEventListener('click', onHostClick); teardownVideo(); }
  };
}
