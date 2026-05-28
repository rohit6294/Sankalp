/**
 * profile-check.js — Sankalp WBJEE
 * Reads mandatory-field settings from Firestore and checks the logged-in
 * student's profile. If any required field is empty, injects a
 * prominent warning banner at the top of the page.
 *
 * Include this script AFTER firebase-config.js on every student page.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  CSS injected once                                                    */
  /* ------------------------------------------------------------------ */
  const BANNER_ID = '__profile_warning_banner__';

  function injectStyles() {
    if (document.getElementById('__profile_check_styles__')) return;
    const style = document.createElement('style');
    style.id = '__profile_check_styles__';
    style.textContent = `
      #${BANNER_ID} {
        position: fixed;
        top: 0; left: 0; right: 0;
        z-index: 99999;
        background: #C94E1F;
        color: #EADBC0;
        font-family: 'Inter', sans-serif;
        font-size: 13px;
        font-weight: 600;
        padding: 10px 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        box-shadow: 0 2px 12px rgba(0,0,0,0.35);
        animation: __pcSlideDown__ 0.3s ease;
      }
      @keyframes __pcSlideDown__ {
        from { transform: translateY(-100%); opacity: 0; }
        to   { transform: translateY(0);    opacity: 1; }
      }
      #${BANNER_ID} .pc-left {
        display: flex;
        align-items: center;
        gap: 10px;
        flex: 1;
        min-width: 0;
      }
      #${BANNER_ID} .pc-icon {
        font-size: 18px;
        flex-shrink: 0;
      }
      #${BANNER_ID} .pc-text {
        flex: 1;
        min-width: 0;
      }
      #${BANNER_ID} .pc-link {
        background: #EADBC0;
        color: #C94E1F;
        border: none;
        padding: 6px 14px;
        border-radius: 4px;
        font-weight: 700;
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
        text-decoration: none;
        display: inline-block;
        flex-shrink: 0;
        font-family: inherit;
      }
      #${BANNER_ID} .pc-close {
        background: transparent;
        border: none;
        color: #EADBC0;
        font-size: 18px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        flex-shrink: 0;
        opacity: 0.8;
      }
      #${BANNER_ID} .pc-close:hover { opacity: 1; }
      /* Push body content down so banner doesn't cover it */
      body.has-profile-warning { padding-top: 46px !important; }
      body.has-profile-warning .menu-toggle { top: 54px !important; }
    `;
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------------ */
  /*  Banner helpers                                                       */
  /* ------------------------------------------------------------------ */
  function showBanner(missingLabels) {
    if (document.getElementById(BANNER_ID)) return; // already shown

    injectStyles();

    const missingText = missingLabels.join(', ');
    const profileUrl  = (window.location.pathname.includes('/student/') ? '' : 'student/') + 'profile.html';

    // Detect relative path depth
    const depth = window.location.pathname.split('/').filter(Boolean).length;
    const prefix = depth >= 2 ? '../' : '';

    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.innerHTML = `
      <div class="pc-left">
        <span class="pc-icon">⚠️</span>
        <span class="pc-text">
          <strong>Profile incomplete!</strong> Please fill in: <span style="font-weight:400;">${missingText}</span>
        </span>
      </div>
      <a class="pc-link" href="${prefix}profile.html">Complete Profile</a>
      <button class="pc-close" onclick="document.getElementById('${BANNER_ID}').remove(); document.body.classList.remove('has-profile-warning');" title="Dismiss">✕</button>
    `;

    document.body.insertBefore(banner, document.body.firstChild);
    document.body.classList.add('has-profile-warning');
  }

  /* ------------------------------------------------------------------ */
  /*  Field label map                                                      */
  /* ------------------------------------------------------------------ */
  const FIELD_LABELS = {
    name:      'Full Name',
    phone:     'Phone Number',
    gender:    'Gender',
    caste:     'Caste / Category',
    tfw:       'TFW Status',
    wbjeeYear: 'WBJEE Target Year',
  };

  /* ------------------------------------------------------------------ */
  /*  Main check — runs after Firebase auth is ready                      */
  /* ------------------------------------------------------------------ */
  function runCheck(user) {
    // Load settings and profile in parallel
    Promise.all([
      db.collection('settings').doc('mandatory_fields').get(),
      db.collection('users').doc(user.uid).get(),
    ])
    .then(function([settingsDoc, profileDoc]) {
      const settings = settingsDoc.exists ? settingsDoc.data() : {};
      const profile  = profileDoc.exists  ? profileDoc.data()  : {};

      // Also check Firebase Auth displayName as a fallback for "name"
      const profileName = profile.name || profile.firstName || (user.displayName || '').trim();

      const effectiveProfile = Object.assign({}, profile, { name: profileName });

      const missingLabels = [];

      Object.keys(FIELD_LABELS).forEach(function(field) {
        if (!settings[field]) return; // not mandatory
        const val = effectiveProfile[field];
        if (!val || (typeof val === 'string' && val.trim() === '')) {
          missingLabels.push(FIELD_LABELS[field]);
        }
      });

      if (missingLabels.length > 0) {
        showBanner(missingLabels);
      }
    })
    .catch(function(err) {
      console.warn('[profile-check] Could not load settings:', err.message);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Entry point — wait for Firebase Auth                                */
  /* ------------------------------------------------------------------ */
  function init() {
    // auth is set up globally by firebase-config.js
    if (typeof auth === 'undefined') {
      console.warn('[profile-check] Firebase auth not found. Skipping.');
      return;
    }

    auth.onAuthStateChanged(function(user) {
      if (!user) return; // not logged in — other scripts handle redirect
      runCheck(user);
    });
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
