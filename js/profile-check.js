/**
 * profile-check.js — Sankalp WBJEE
 * Shows a sticky warning banner on every student page when the student
 * has not filled mandatory fields configured by the admin.
 *
 * Strategy (most reliable, no admin-role needed):
 *   1. Read settings/mandatory_fields from Firestore directly (allowed by rules)
 *   2. Read the student's own users/{uid} doc from Firestore
 *   3. Compare → show banner if anything is missing
 *
 * Fallback: if Firestore read fails, try the backend REST API.
 */
(function () {
  'use strict';

  const BANNER_ID  = '__pc_banner__';
  const API_BASE   = window.EVALUATOR_API || 'https://sankalp-1vt4.onrender.com';

  const FIELD_LABELS = {
    name:      'Full Name',
    email:     'Email Address',
    phone:     'Phone Number',
    gender:    'Gender',
    caste:     'Caste / Category',
    tfw:       'TFW Status',
    wbjeeYear: 'WBJEE Target Year',
  };

  /* ── inject banner CSS once ────────────────────────────────────────── */
  function injectCSS() {
    if (document.getElementById('__pc_css__')) return;
    const s = document.createElement('style');
    s.id = '__pc_css__';
    s.textContent = `
      #${BANNER_ID}{
        position:fixed;top:0;left:0;right:0;z-index:999990;
        background:#C94E1F;color:#EADBC0;
        font-family:'Inter',sans-serif;font-size:13px;font-weight:600;
        padding:10px 16px;display:flex;align-items:center;
        justify-content:space-between;gap:10px;
        box-shadow:0 2px 16px rgba(0,0,0,0.4);
        animation:__pcIn__ 0.35s ease;
      }
      @keyframes __pcIn__{ from{transform:translateY(-100%);opacity:0} to{transform:translateY(0);opacity:1} }
      #${BANNER_ID} .pc-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
      #${BANNER_ID} .pc-icon{font-size:17px;flex-shrink:0}
      #${BANNER_ID} .pc-text{flex:1;min-width:0;line-height:1.4}
      #${BANNER_ID} .pc-link{
        background:#EADBC0;color:#C94E1F;border:none;
        padding:5px 12px;border-radius:4px;font-weight:700;
        font-size:12px;cursor:pointer;white-space:nowrap;
        text-decoration:none;display:inline-block;flex-shrink:0;
        font-family:inherit;
      }
      #${BANNER_ID} .pc-close{
        background:transparent;border:none;color:#EADBC0;
        font-size:18px;cursor:pointer;padding:0 2px;line-height:1;
        flex-shrink:0;opacity:0.8;
      }
      #${BANNER_ID} .pc-close:hover{opacity:1}
      body.pc-offset .menu-toggle{top:54px!important}
      body.pc-offset{padding-top:44px!important}
    `;
    document.head.appendChild(s);
  }

  /* ── show banner ───────────────────────────────────────────────────── */
  function showBanner(missing) {
    if (document.getElementById(BANNER_ID)) return;
    injectCSS();

    // figure out relative path to profile.html
    const depth = window.location.pathname.replace(/\/$/, '').split('/').filter(Boolean).length;
    const prefix = depth >= 2 ? '../' : (depth === 1 ? '' : '');

    const b = document.createElement('div');
    b.id = BANNER_ID;
    b.innerHTML = `
      <div class="pc-left">
        <span class="pc-icon">⚠️</span>
        <span class="pc-text">
          <strong>Profile incomplete!</strong>
          Required fields missing: <span style="font-weight:400">${missing.join(', ')}</span>
        </span>
      </div>
      <a class="pc-link" href="${prefix}profile.html">Complete Now</a>
      <button class="pc-close"
        onclick="document.getElementById('${BANNER_ID}').remove();document.body.classList.remove('pc-offset');"
        title="Dismiss">✕</button>
    `;
    if (document.body) {
      document.body.insertBefore(b, document.body.firstChild);
      document.body.classList.add('pc-offset');
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.body.insertBefore(b, document.body.firstChild);
        document.body.classList.add('pc-offset');
      });
    }
  }

  /* ── compute missing fields ────────────────────────────────────────── */
  function getMissing(settings, profile) {
    const missing = [];
    
    // Always force name check regardless of admin settings if name is Unknown Student or invalid
    const nameVal = String(profile.name || profile.firstName || '').trim().toLowerCase();
    
    // A valid name must have at least 2 alphabet letters and cannot be "unknown student"
    const hasEnoughLetters = /[a-z].*[a-z]/i.test(nameVal);
    
    if (nameVal === 'unknown student' || nameVal === '' || !hasEnoughLetters) {
      missing.push(FIELD_LABELS['name']);
    }

    Object.keys(FIELD_LABELS).forEach(field => {
      if (field === 'name') return; // Handled above
      if (!settings[field]) return; // not mandatory
      const val = profile[field] || '';
      if (!String(val).trim()) missing.push(FIELD_LABELS[field]);
    });
    return missing;
  }

  /* ── primary: read from Firestore directly ─────────────────────────── */
  async function checkViaFirestore(user) {
    const [settingsSnap, profileSnap] = await Promise.all([
      db.collection('settings').doc('mandatory_fields').get(),
      db.collection('users').doc(user.uid).get(),
    ]);
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    if (!Object.values(settings).some(Boolean)) return; // nothing mandatory
    const profile = profileSnap.exists ? profileSnap.data() : {};
    // fallback name from Firebase Auth
    if (!profile.name && !profile.firstName) {
      profile.name = user.displayName || '';
    }
    const missing = getMissing(settings, profile);
    if (missing.length) showBanner(missing);
  }

  /* ── fallback: read from backend REST ─────────────────────────────── */
  async function checkViaAPI(user) {
    const token = await user.getIdToken();
    const res = await fetch(`${API_BASE}/api/settings/mandatory-fields`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return;
    const { settings } = await res.json();
    if (!Object.values(settings || {}).some(Boolean)) return;
    const profileSnap = await db.collection('users').doc(user.uid).get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    if (!profile.name && !profile.firstName) profile.name = user.displayName || '';
    const missing = getMissing(settings, profile);
    if (missing.length) showBanner(missing);
  }

  /* ── main ──────────────────────────────────────────────────────────── */
  function run() {
    if (typeof auth === 'undefined' || typeof db === 'undefined') return;

    auth.onAuthStateChanged(async user => {
      if (!user) return;
      try {
        await checkViaFirestore(user);
      } catch (e1) {
        console.warn('[profile-check] Firestore failed, trying API…', e1.message);
        try {
          await checkViaAPI(user);
        } catch (e2) {
          console.warn('[profile-check] API also failed:', e2.message);
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
