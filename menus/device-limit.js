/* ========================================================================
   Device-limit screen: shown when a student signs in and every device slot
   of the account is taken. They see the devices that occupy the slots and
   can really log any of them out (the device doc is deleted, which frees
   the slot and signs that device out), then continue signing in here.
   ======================================================================== */
import { assertDeviceAllowed, listMyDevices, removeMyDevice } from './device-session.js';
import { signOutStudent } from './auth.js';

const ID = 'deviceLimitGate';

const CSS = `
#${ID}{position:fixed;inset:0;z-index:950;background:var(--paper);display:flex;align-items:flex-start;justify-content:center;
  padding:24px;padding-top:max(24px,env(safe-area-inset-top));padding-bottom:max(24px,env(safe-area-inset-bottom));overflow-y:auto;-webkit-overflow-scrolling:touch}
#${ID}.hidden{display:none!important}
#${ID} .dl-inner{max-width:460px;width:100%;margin:auto;text-align:center;animation:bfRise .55s var(--ease) both}
#${ID} .dl-icon{position:relative;width:88px;height:88px;border-radius:50%;background:color-mix(in srgb,var(--artery) 14%,transparent);color:var(--artery);
  display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 22px}
#${ID} .dl-icon::before,#${ID} .dl-icon::after{content:'';position:absolute;inset:0;border-radius:50%;border:2px solid var(--artery);opacity:0;animation:bfPulse 2.6s ease-out infinite}
#${ID} .dl-icon::after{animation-delay:1.3s}
#${ID} .dl-eyebrow{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;letter-spacing:.16em;color:var(--artery);margin-bottom:10px}
#${ID} h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(24px,6vw,31px);font-weight:700;line-height:1.15;margin:0 0 12px}
#${ID} .dl-sub{color:var(--ink-soft);font-size:14px;line-height:1.6;margin:0 auto 20px}
#${ID} .dl-list{display:flex;flex-direction:column;gap:10px;margin:0 0 18px;text-align:left}
#${ID} .dl-card{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--card-border);border-radius:16px;padding:12px 14px;box-shadow:var(--shadow);transition:opacity .25s,transform .25s}
#${ID} .dl-card.gone{opacity:0;transform:translateX(24px)}
#${ID} .dl-dev{flex:none;width:42px;height:42px;border-radius:12px;background:color-mix(in srgb,var(--artery) 10%,transparent);color:var(--artery);display:flex;align-items:center;justify-content:center;font-size:18px}
#${ID} .dl-meta{flex:1;min-width:0}
#${ID} .dl-name{font-weight:600;font-size:15px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${ID} .dl-time{font-size:12.5px;color:var(--ink-faint);margin-top:2px}
#${ID} .dl-out{flex:none;display:inline-flex;align-items:center;gap:7px;padding:10px 14px;border-radius:12px;border:1px solid var(--wrong);background:transparent;color:var(--wrong);
  font-family:inherit;font-size:13.5px;font-weight:600;cursor:pointer;transition:background .2s,color .2s,transform .15s}
#${ID} .dl-out:hover{background:var(--wrong);color:#fff}
#${ID} .dl-out:active{transform:scale(.97)}
#${ID} .dl-out:disabled{opacity:.6;cursor:default}
#${ID} .dl-msg{min-height:20px;font-size:13px;color:var(--wrong);margin:0 0 12px}
#${ID} .dl-msg.ok{color:var(--artery)}
@media (prefers-reduced-motion:reduce){#${ID} .dl-inner,#${ID} .dl-icon::before,#${ID} .dl-icon::after{animation:none}}
`;

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(ts) {
  const ms = ts && (ts.toMillis ? ts.toMillis() : ts.seconds ? ts.seconds * 1000 : 0);
  if (!ms) return 'Last active: unknown';
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 2) return 'Active just now';
  if (m < 60) return `Last active ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Last active ${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `Last active ${d} day${d === 1 ? '' : 's'} ago`;
}
function icon(dev) {
  const t = ((dev.model || '') + ' ' + (dev.ua || '')).toLowerCase();
  if (/iphone|android|mobile|phone|pixel|samsung|tecno|infinix|itel|xiaomi|redmi/.test(t)) return 'fa-mobile-screen';
  if (/ipad|tablet/.test(t)) return 'fa-tablet-screen-button';
  return 'fa-laptop';
}

/* Resolves true once a slot is free and this device is allowed in (the user stays signed in);
   resolves false if the user chose to sign out instead. */
export function showDeviceLimitGate(student, err) {
  return new Promise(resolve => {
    if (!document.getElementById(ID + '-css')) {
      const st = document.createElement('style'); st.id = ID + '-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    document.getElementById(ID)?.remove();
    const max = err?.maxDevices || student?.maxDevices || 1;
    let devices = (err?.devices || []).slice();
    const root = document.createElement('div');
    root.id = ID; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
    root.innerHTML = `
      <div class="dl-inner">
        <div class="dl-icon"><i class="fa-solid fa-mobile-screen-button"></i></div>
        <div class="dl-eyebrow">DEVICE LIMIT REACHED</div>
        <h1>Your account is in use on another device</h1>
        <p class="dl-sub">This account can be signed in on ${max} device${max === 1 ? '' : 's'} at a time. Log out one of the devices below to sign in here.</p>
        <div class="dl-list"></div>
        <div class="dl-msg" aria-live="polite"></div>
        <div class="bf-actions"><button class="bf-btn ghost" type="button" data-cancel><i class="fa-solid fa-right-from-bracket"></i> Cancel and sign out</button></div>
      </div>`;
    document.body.appendChild(root);
    const list = root.querySelector('.dl-list');
    const msg = root.querySelector('.dl-msg');
    const setMsg = (t, ok) => { msg.textContent = t || ''; msg.classList.toggle('ok', !!ok); };
    let done = false;
    const close = v => { if (done) return; done = true; root.remove(); resolve(v); };

    const render = () => {
      list.innerHTML = devices.length ? devices.map((d, i) => `
        <div class="dl-card" data-i="${i}">
          <div class="dl-dev"><i class="fa-solid ${icon(d)}"></i></div>
          <div class="dl-meta"><div class="dl-name">${esc(d.model || 'Unknown device')}</div><div class="dl-time">${esc(ago(d.lastSeen || d.lastLogin))}</div></div>
          <button class="dl-out" type="button" data-i="${i}"><i class="fa-solid fa-right-from-bracket"></i> Log out</button>
        </div>`).join('') : '<div class="dl-sub">Checking your devices…</div>';
    };
    render();

    // Make sure the list is fresh (the sign-in check may have been served partly from cache).
    listMyDevices(student).then(l => { if (!done && l.length) { devices = l; render(); } }).catch(() => {});

    list.addEventListener('click', async e => {
      const btn = e.target.closest('.dl-out'); if (!btn || btn.disabled) return;
      const dev = devices[Number(btn.dataset.i)]; if (!dev) return;
      root.querySelectorAll('.dl-out').forEach(b => { b.disabled = true; });
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Logging out…';
      setMsg('');
      try {
        await removeMyDevice(student, dev);
        btn.closest('.dl-card')?.classList.add('gone');
        devices = devices.filter(d => d !== dev);
        let allowed = false;
        try { await assertDeviceAllowed(student); allowed = true; } catch (er) {
          if (er?.limit) { devices = er.devices && er.devices.length ? er.devices : devices; }
          else if (er?.blocked) { setMsg('This device has been blocked.'); }
        }
        if (allowed) { setMsg('Device logged out. Signing you in…', true); setTimeout(() => close(true), 450); return; }
        setTimeout(render, 260);
        setMsg('That device was logged out. Your account allows more than one device in use, so log out another one.', false);
      } catch (er) {
        console.error('[device-limit] remove failed', er);
        setMsg('Could not log that device out. Check your connection and try again.');
        render();
        return;
      }
      root.querySelectorAll('.dl-out').forEach(b => { b.disabled = false; });
    });

    root.querySelector('[data-cancel]').addEventListener('click', async () => {
      try { await signOutStudent(); } catch (_) {}
      close(false);
    });
  });
}
