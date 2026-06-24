(function () {
  if (!window.auth) return;

  const PAGE_SECTIONS = {
    'index.html': 'dashboard',
    'students.html': 'students',
    'content.html': 'content',
    'notes.html': 'content',
    'tests.html': 'tests',
    'evaluators.html': 'evaluators',
    'bookings.html': 'bookings',
    'announcements.html': 'announcements',
    'payments.html': 'payments',
    'analytics.html': 'analytics',
    'settings.html': 'settings',
    'sub-admins.html': 'subAdmins',
  };

  const SECTION_PAGES = {
    students: 'evaluators.html#studentList',
    content: 'content.html',
    tests: 'tests.html',
    evaluators: 'evaluators.html#exams',
    collegePredictor: 'evaluators.html#collegePredictor',
    settings: 'evaluators.html#settings',
    subAdmins: 'sub-admins.html',
  };

  const SECTION_ORDER = [
    'students',
    'content',
    'tests',
    'evaluators',
    'collegePredictor',
    'settings',
  ];

  const style = document.createElement('style');
  style.textContent = [
    'html.sankalp-admin-checking body{visibility:hidden}',
    'body.sankalp-admin-denied>*:not(#sankalpAccessDenied){filter:blur(7px);pointer-events:none;user-select:none}',
    '#sankalpAccessDenied{position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(2,6,23,.72);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);font-family:Inter,Arial,sans-serif;color:#e2e8f0}',
    '#sankalpAccessDenied .box{width:min(460px,100%);background:rgba(15,23,42,.96);border:1px solid rgba(248,113,113,.32);border-radius:16px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.45);text-align:center}',
    '#sankalpAccessDenied .icon{width:54px;height:54px;border-radius:14px;background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.28);color:#f87171;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:22px}',
    '.sankalp-readonly-disabled{opacity:.45!important;cursor:not-allowed!important;filter:saturate(.6);}',
    '.sankalp-admin-hidden{display:none!important}',
  ].join('\n');
  document.head.appendChild(style);
  document.documentElement.classList.add('sankalp-admin-checking');

  const originalOnAuthStateChanged = auth.onAuthStateChanged.bind(auth);
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const state = {
    profile: null,
    sections: [],
    blocked: false,
    currentSection: sectionForCurrentPage(),
  };

  function pageFileName() {
    let file = window.location.pathname.split('/').filter(Boolean).pop() || 'index.html';
    file = file.toLowerCase();
    if (!file.includes('.')) {
      file = file + '.html';
    }
    return file;
  }

  function sectionForCurrentPage() {
    const file = pageFileName();
    if (file === 'evaluators.html') {
      const hash = (window.location.hash || '').replace('#', '');
      if (hash === 'studentList') return 'students';
      if (hash === 'collegePredictor') return 'collegePredictor';
      if (hash === 'choiceFilling') return 'evaluators';
      if (hash === 'settings') return 'settings';
      return 'evaluators';
    }
    return PAGE_SECTIONS[file] || null;
  }

  function normalizeHref(href) {
    if (!href || href === '#') return '';
    let file = '';
    try {
      file = new URL(href, window.location.href).pathname.split('/').filter(Boolean).pop().toLowerCase();
    } catch (_err) {
      file = href.split('/').pop().toLowerCase();
    }
    if (file && !file.includes('.')) {
      file = file + '.html';
    }
    return file;
  }

  function sectionForLink(link) {
    if (!link) return null;
    if (link.id === 'sidebarStudentListBtn') return 'students';
    if (link.id === 'sidebarCollegePredictorBtn') return 'collegePredictor';
    if (link.id === 'sidebarChoiceFillingBtn') return 'evaluators';
    const file = normalizeHref(link.getAttribute('href'));
    return PAGE_SECTIONS[file] || null;
  }

  function sectionPermissions(section) {
    return (state.profile && state.profile.permissions && state.profile.permissions[section]) || {};
  }

  function can(section, action) {
    if (!state.profile || !section) return false;
    if (state.profile.isSuperAdmin === true) return true;
    const perms = sectionPermissions(section);
    const requestedAction = action || 'view';
    if (requestedAction === 'edit') return perms.view === true && perms.edit === true;
    if (requestedAction === 'transactions') {
      return section === 'payments' && perms.view === true && perms.transactions === true;
    }
    return perms[requestedAction] === true;
  }

  function firstAllowedPage() {
    for (const section of SECTION_ORDER) {
      if (can(section, 'view')) return SECTION_PAGES[section];
    }
    return '../login.html';
  }

  function canViewCurrentPage(currentSection) {
    if (!currentSection) return true;
    if (currentSection === 'subAdmins') return state.profile?.isSuperAdmin === true;
    if (pageFileName() === 'evaluators.html') {
      return can('evaluators', 'view')
        || can('students', 'view')
        || can('collegePredictor', 'view')
        || can('settings', 'view');
    }
    return can(currentSection, 'view');
  }

  function apiBase() {
    return window.EVALUATOR_API || (
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:3000'
        : 'https://sankalp-1vt4.onrender.com'
    );
  }

  async function fetchAdminProfile(user) {
    let token = await user.getIdToken();
    let response = await fetch(`${apiBase()}/api/admin/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401) {
      token = await user.getIdToken(true);
      response = await fetch(`${apiBase()}/api/admin/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (payload.admin && payload.admin.isSubAdmin === true) {
      await user.getIdToken(true).catch(() => {});
    }
    return payload;
  }

  function whenDomReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function removeCheckingState() {
    document.documentElement.classList.remove('sankalp-admin-checking');
  }

  function showAccessDenied(message, redirectHref) {
    state.blocked = true;
    removeCheckingState();
    whenDomReady(() => {
      document.body.classList.add('sankalp-admin-denied');
      if (document.getElementById('sankalpAccessDenied')) return;
      const overlay = document.createElement('div');
      overlay.id = 'sankalpAccessDenied';
      overlay.innerHTML = `
        <div class="box">
          <div class="icon"><i class="fas fa-lock"></i></div>
          <h1 style="font-size:22px;font-weight:800;margin:0 0 8px;color:white">Access Denied</h1>
          <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0">${message || 'You do not have permission to view this admin section.'}</p>
          <p style="font-size:12px;color:#64748b;margin:14px 0 0">Redirecting to an allowed section...</p>
        </div>
      `;
      document.body.appendChild(overlay);
    });

    if (redirectHref) {
      setTimeout(() => {
        window.location.href = redirectHref;
      }, 1800);
    }
  }

  function ensureSubAdminNavLink() {
    if (!state.profile || state.profile.isSuperAdmin !== true) return;
    const sidebar =
      document.querySelector('#adminSidebar nav')
      || document.querySelector('#adminSidebar > div')
      || document.querySelector('.admin-sidebar > div')
      || document.querySelector('.sidebar nav');
    if (!sidebar || sidebar.querySelector('a[href="sub-admins.html"]')) return;

    const sampleLink = sidebar.querySelector('a.anl, a.admin-nav-link, a.sidebar-link') || sidebar.querySelector('a');
    const link = document.createElement('a');
    link.href = 'sub-admins.html';
    link.className = sampleLink ? sampleLink.className : 'anl';
    if (pageFileName() === 'sub-admins.html') link.classList.add('active');
    link.innerHTML = '<i class="fas fa-user-shield" style="width:16px"></i> Sub Admins';

    const logout = Array.from(sidebar.querySelectorAll('a')).find((a) => {
      const text = (a.textContent || '').toLowerCase();
      const href = (a.getAttribute('href') || '').toLowerCase();
      return text.includes('logout') || href.includes('login.html');
    });
    sidebar.insertBefore(link, logout || null);
  }

  function filterSidebar() {
    ensureSubAdminNavLink();
    document.querySelectorAll('a.anl, a.admin-nav-link, a.sidebar-link').forEach((link) => {
      const text = (link.textContent || '').toLowerCase();
      const href = (link.getAttribute('href') || '').toLowerCase();
      if (text.includes('logout') || href.includes('login.html')) return;

      const section = sectionForLink(link);
      if (!section) return;

      const allowed = section === 'subAdmins'
        ? state.profile && state.profile.isSuperAdmin === true
        : can(section, 'view');
      link.classList.toggle('sankalp-admin-hidden', !allowed);
    });
  }

  function disableElement(el) {
    if (el.dataset.adminGuardDisabled === '1') return;
    el.dataset.adminGuardDisabled = '1';
    el.classList.add('sankalp-readonly-disabled');
    el.setAttribute('title', 'Read-only access: edit permission is not enabled.');
    el.setAttribute('aria-disabled', 'true');

    if ('disabled' in el) {
      el.disabled = true;
    } else {
      el.addEventListener('click', blockReadonlyClick, true);
      el.style.pointerEvents = 'none';
    }
  }

  function blockReadonlyClick(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return false;
  }

  function shouldDisableAction(el) {
    if (!el || el.closest('[data-admin-readonly-allow]')) return false;
    const href = (el.getAttribute && el.getAttribute('href') || '').toLowerCase();
    if (href.includes('login.html')) return false;

    const haystack = [
      el.textContent || '',
      el.getAttribute && el.getAttribute('title') || '',
      el.getAttribute && el.getAttribute('aria-label') || '',
      el.getAttribute && el.getAttribute('onclick') || '',
      el.className || '',
      el.id || '',
      el.type || '',
    ].join(' ').toLowerCase();

    const allowedViewActions = ['view', 'close', 'cancel', 'export', 'search', 'filter', 'predict colleges', 'open evaluators', 'logout', 'results'];
    if (allowedViewActions.some((word) => haystack.includes(word)) && !haystack.includes('edit')) {
      return false;
    }

    const editWords = [
      'save',
      'delete',
      'remove',
      'edit',
      'create',
      'add',
      'upload',
      'clear',
      'approve',
      'reject',
      'send',
      'confirm',
      'markcompleted',
      'mark completed',
      'done',
      'test email',
      'configure',
      'reset',
      'toggle',
      'openaddmodal',
      'opencreatemodal',
      'showcreate',
    ];

    return editWords.some((word) => haystack.includes(word));
  }

  function applyReadOnlyMode() {
    const section = state.currentSection;
    if (!section || can(section, 'edit')) return;
    document.body.dataset.adminReadonly = 'true';

    const apply = () => {
      document.querySelectorAll('button, a, input[type="button"], input[type="submit"]').forEach((el) => {
        if (shouldDisableAction(el)) disableElement(el);
      });
      document.querySelectorAll('input[type="file"], input[type="checkbox"][onchange], input[type="radio"][onchange], select[onchange*="save"], input[onchange*="save"]').forEach(disableElement);
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function applyPaymentsVisibility() {
    if (state.currentSection !== 'payments' || can('payments', 'transactions')) return;
    whenDomReady(() => {
      const tbody = document.getElementById('transactionRows');
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" style="padding:48px;text-align:center;color:#fbbf24">
              <i class="fas fa-lock" style="font-size:28px;margin-bottom:8px;display:block"></i>
              Transaction log permission is not enabled for this account.
            </td>
          </tr>
        `;
      }
      const badge = document.getElementById('transBadge');
      if (badge) badge.textContent = 'Restricted';
      ['statTotalRevenue', 'statMonthRevenue', 'statPremiumCount'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = 'Hidden';
      });
    });
  }

  function applyInlinePermissionBits() {
    if (!can('payments', 'transactions')) {
      document.getElementById('btnPredictorPurchases')?.classList.add('sankalp-admin-hidden');
      document.getElementById('predictorPurchasesView')?.classList.add('sankalp-admin-hidden');
    }
    if (!can('collegePredictor', 'edit')) {
      document.getElementById('btnPredictorImport')?.classList.add('sankalp-admin-hidden');
      document.getElementById('predictorImportView')?.classList.add('sankalp-admin-hidden');
      document.getElementById('btnPredictorPaywall')?.classList.add('sankalp-admin-hidden');
      document.getElementById('predictorPaywallView')?.classList.add('sankalp-admin-hidden');
    }
    if (!can('collegePredictor', 'view')) {
      document.getElementById('btnPredictorTool')?.classList.add('sankalp-admin-hidden');
      document.getElementById('predictorToolView')?.classList.add('sankalp-admin-hidden');
    }
    if (!can('settings', 'view') && !can('collegePredictor', 'edit')) {
      document.getElementById('btnPredictorPaywall')?.classList.add('sankalp-admin-hidden');
      document.getElementById('predictorPaywallView')?.classList.add('sankalp-admin-hidden');
    }
  }

  auth.onAuthStateChanged = function guardedOnAuthStateChanged(callback, error, completed) {
    return originalOnAuthStateChanged(async (user) => {
      try {
        await ready;
      } catch (_err) {
        // The guard itself handles redirects/overlays.
      }
      if (state.blocked && user) return;
      return callback(user);
    }, error, completed);
  };

  window.SankalpAdminGuard = {
    ready,
    get profile() {
      return state.profile;
    },
    get currentSection() {
      return state.currentSection;
    },
    can,
    isSuperAdmin() {
      return state.profile && state.profile.isSuperAdmin === true;
    },
  };

  originalOnAuthStateChanged(async (user) => {
    if (!user) {
      state.blocked = true;
      window.location.href = '../login.html';
      readyReject(new Error('not_authenticated'));
      return;
    }

    try {
      const payload = await fetchAdminProfile(user);
      state.profile = payload.admin || null;
      state.sections = payload.sections || [];

      const currentSection = state.currentSection;
      const currentAllowed = canViewCurrentPage(currentSection);

      if (!currentAllowed) {
        showAccessDenied('This account does not have permission to view this admin section.', firstAllowedPage());
        readyResolve(state.profile);
        return;
      }

      whenDomReady(() => {
        filterSidebar();
        applyInlinePermissionBits();
        applyReadOnlyMode();
        applyPaymentsVisibility();
      });
      removeCheckingState();
      readyResolve(state.profile);
    } catch (err) {
      console.error('Admin guard failed:', err);
      showAccessDenied('Your admin role could not be verified. Please sign in with an authorized admin account.', '../login.html');
      readyReject(err);
    }
  });

  window.addEventListener('hashchange', () => {
    state.currentSection = sectionForCurrentPage();
    const currentAllowed = canViewCurrentPage(state.currentSection);
    if (!currentAllowed) {
      showAccessDenied('This account does not have permission to view this admin section.', firstAllowedPage());
      return;
    }
    // Reset read-only styling blocks before applying fresh for the new section
    document.querySelectorAll('.sankalp-readonly-disabled').forEach((el) => {
      el.classList.remove('sankalp-readonly-disabled');
      el.removeAttribute('title');
      el.removeAttribute('aria-disabled');
      if (el.dataset.adminGuardDisabled === '1') {
        delete el.dataset.adminGuardDisabled;
        if ('disabled' in el) {
          el.disabled = false;
        } else {
          el.removeEventListener('click', blockReadonlyClick, true);
          el.style.pointerEvents = '';
        }
      }
    });
    document.body.removeAttribute('data-admin-readonly');
    
    // Apply read-only mode dynamically to the active section
    applyReadOnlyMode();
    applyInlinePermissionBits();
    if (typeof window.applyEvaluatorPermissions === 'function') {
      window.applyEvaluatorPermissions();
    }
  });
})();
