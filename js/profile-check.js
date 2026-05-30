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
    homeState: 'Home State Status',
    wbjeeYear: 'WBJEE Target Year',
  };

  const CACHE_TTL_MS = 60000; // 60 seconds

  function getCachedItem(key) {
    try {
      const dataStr = sessionStorage.getItem(key);
      if (!dataStr) return null;
      const cached = JSON.parse(dataStr);
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.value;
      }
      sessionStorage.removeItem(key);
    } catch (e) {
      console.warn('Failed to parse cache for key:', key, e);
    }
    return null;
  }

  function setCachedItem(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify({
        value,
        timestamp: Date.now()
      }));
    } catch (e) {
      console.warn('Failed to set cache for key:', key, e);
    }
  }

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

    // use absolute path for student profile

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
      <a class="pc-link" href="/student/profile.html">Complete Now</a>
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
    const mfCacheKey = `__sankalp_mf_${user.uid}__`;
    const profileCacheKey = `__sankalp_profile_${user.uid}__`;

    let settings = getCachedItem(mfCacheKey);
    if (!settings) {
      const settingsSnap = await db.collection('settings').doc('mandatory_fields').get();
      settings = settingsSnap.exists ? settingsSnap.data() : {};
      setCachedItem(mfCacheKey, settings);
    }

    if (!Object.values(settings).some(Boolean)) return; // nothing mandatory

    let profile = getCachedItem(profileCacheKey);
    if (!profile) {
      const profileSnap = await db.collection('users').doc(user.uid).get();
      profile = profileSnap.exists ? profileSnap.data() : {};
      setCachedItem(profileCacheKey, profile);
    }

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

  function hidePredictorLinks() {
    const links = document.querySelectorAll('a[href*="predictor.html"]');
    if (links.length > 0) {
      links.forEach(l => {
        l.style.display = 'none';
      });
      return true;
    }
    return false;
  }

  async function checkPredictorFeature(user) {
    try {
      const cpCacheKey = `__sankalp_cp_${user.uid}__`;
      let settings = getCachedItem(cpCacheKey);
      if (!settings) {
        const snap = await db.collection('settings').doc('college_predictor').get();
        settings = snap.exists ? snap.data() : { enabled: true };
        setCachedItem(cpCacheKey, settings);
      }
      const isEnabled = settings.enabled !== false; // defaults to true

      if (!isEnabled) {
        // Hide sidebar link on ALL student pages
        const hidden = hidePredictorLinks();
        if (!hidden) {
          document.addEventListener('DOMContentLoaded', hidePredictorLinks);
          setTimeout(hidePredictorLinks, 100);
          setTimeout(hidePredictorLinks, 500);
          setTimeout(hidePredictorLinks, 1000);
        }

        // If currently on predictor.html, force block screen
        if (window.location.pathname.endsWith('predictor.html')) {
          const blockBody = () => {
            document.body.innerHTML = `
              <div style="background:#020617; color:#E2E8F0; font-family:'Inter',sans-serif; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px; text-align:center;">
                <div style="width:72px; height:72px; border-radius:50%; background:rgba(239, 68, 68, 0.1); border:2px solid #EF4444; display:flex; align-items:center; justify-content:center; font-size:32px; color:#EF4444; margin-bottom:20px; box-shadow:0 0 20px rgba(239,68,68,0.2);">
                  <i class="fas fa-exclamation-triangle"></i>
                </div>
                <h1 style="font-size:24px; font-weight:800; color:white; margin-bottom:8px; font-family:'Poppins',sans-serif;">Feature Disabled</h1>
                <p style="color:#94A3B8; font-size:14px; max-width:400px; line-height:1.6; margin-bottom:24px;">The College Predictor tool has been temporarily disabled by the administrator. Please check back later.</p>
                <a href="dashboard.html" style="background:#EADBC0; color:#C94E1F; padding:10px 24px; border-radius:6px; font-weight:700; font-size:13px; text-decoration:none; display:inline-block; font-family:inherit; transition: all 0.2s;">Go to Dashboard</a>
              </div>
            `;
          };
          if (document.body) {
            blockBody();
          } else {
            document.addEventListener('DOMContentLoaded', blockBody);
          }
        }
      }
    } catch (e) {
      console.warn('[profile-check] Failed checking predictor feature state via Firestore:', e.message);
      // Fall back to REST API
      try {
        const token = await user.getIdToken();
        const res = await fetch(`${API_BASE}/api/predictor/status`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const statusData = await res.json();
          if (statusData.enabled === false) {
            const hidden = hidePredictorLinks();
            if (!hidden) {
              document.addEventListener('DOMContentLoaded', hidePredictorLinks);
              setTimeout(hidePredictorLinks, 100);
              setTimeout(hidePredictorLinks, 500);
              setTimeout(hidePredictorLinks, 1000);
            }
            if (window.location.pathname.endsWith('predictor.html')) {
              const blockBody = () => {
                document.body.innerHTML = `
                  <div style="background:#020617; color:#E2E8F0; font-family:'Inter',sans-serif; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px; text-align:center;">
                    <div style="width:72px; height:72px; border-radius:50%; background:rgba(239, 68, 68, 0.1); border:2px solid #EF4444; display:flex; align-items:center; justify-content:center; font-size:32px; color:#EF4444; margin-bottom:20px; box-shadow:0 0 20px rgba(239,68,68,0.2);">
                      <i class="fas fa-exclamation-triangle"></i>
                    </div>
                    <h1 style="font-size:24px; font-weight:800; color:white; margin-bottom:8px; font-family:'Poppins',sans-serif;">Feature Disabled</h1>
                    <p style="color:#94A3B8; font-size:14px; max-width:400px; line-height:1.6; margin-bottom:24px;">The College Predictor tool has been temporarily disabled by the administrator. Please check back later.</p>
                    <a href="dashboard.html" style="background:#EADBC0; color:#C94E1F; padding:10px 24px; border-radius:6px; font-weight:700; font-size:13px; text-decoration:none; display:inline-block; font-family:inherit; transition: all 0.2s;">Go to Dashboard</a>
                  </div>
                `;
              };
              if (document.body) {
                blockBody();
              } else {
                document.addEventListener('DOMContentLoaded', blockBody);
              }
            }
          }
        }
      } catch (errApi) {
        console.warn('[profile-check] Failed checking predictor feature state via API fallback:', errApi.message);
      }
    }
  }

  /* ── main ──────────────────────────────────────────────────────────── */
  function run() {
    if (typeof auth === 'undefined' || typeof db === 'undefined') return;

    // Do not show the warning banner on the profile page itself to avoid redundant alerts and stale views
    if (window.location.pathname.endsWith('profile.html')) return;

    auth.onAuthStateChanged(async user => {
      if (!user) return;

      // Proactively run the predictor enable check
      checkPredictorFeature(user);

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
