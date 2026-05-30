const ADMIN_SECTIONS = [
  { key: 'dashboard', label: 'Dashboard', editable: false },
  { key: 'students', label: 'Students', editable: true },
  { key: 'content', label: 'Content', editable: true },
  { key: 'tests', label: 'Tests', editable: true },
  { key: 'evaluators', label: 'Evaluators', editable: true },
  { key: 'bookings', label: 'Bookings', editable: true },
  { key: 'announcements', label: 'Announcements', editable: true },
  { key: 'payments', label: 'Payments', editable: false, extras: ['transactions'] },
  { key: 'analytics', label: 'Analytics', editable: false },
  { key: 'settings', label: 'Settings', editable: true },
  { key: 'subAdmins', label: 'Sub Admins', editable: true, superOnly: true },
];

const SECTION_KEYS = new Set(ADMIN_SECTIONS.map((section) => section.key));

function defaultSectionPermission(section) {
  const permission = { view: section.key === 'dashboard' };
  if (section.editable) permission.edit = false;
  if (section.extras) {
    section.extras.forEach((extra) => {
      permission[extra] = false;
    });
  }
  return permission;
}

function defaultPermissions() {
  return ADMIN_SECTIONS.reduce((acc, section) => {
    acc[section.key] = defaultSectionPermission(section);
    return acc;
  }, {});
}

function allPermissions() {
  return ADMIN_SECTIONS.reduce((acc, section) => {
    acc[section.key] = { view: true };
    if (section.editable) acc[section.key].edit = true;
    if (section.extras) {
      section.extras.forEach((extra) => {
        acc[section.key][extra] = true;
      });
    }
    return acc;
  }, {});
}

function normalizePermissions(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const normalized = defaultPermissions();

  ADMIN_SECTIONS.forEach((section) => {
    const incoming = source[section.key];
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return;

    normalized[section.key].view = incoming.view === true;

    if (section.editable) {
      normalized[section.key].edit = normalized[section.key].view && incoming.edit === true;
    }

    if (section.extras) {
      section.extras.forEach((extra) => {
        normalized[section.key][extra] = normalized[section.key].view && incoming[extra] === true;
      });
    }
  });

  // Payments transaction log is always behind the payments page view right.
  if (!normalized.payments.view) {
    normalized.payments.transactions = false;
  }

  return normalized;
}

function hasPermission(permissions, section, action = 'view') {
  if (!SECTION_KEYS.has(section)) return false;
  const normalized = normalizePermissions(permissions);
  const sectionPermissions = normalized[section] || {};

  if (action === 'edit') {
    return sectionPermissions.view === true && sectionPermissions.edit === true;
  }

  if (action === 'transactions') {
    return section === 'payments'
      && sectionPermissions.view === true
      && sectionPermissions.transactions === true;
  }

  return sectionPermissions[action] === true;
}

module.exports = {
  ADMIN_SECTIONS,
  defaultPermissions,
  allPermissions,
  normalizePermissions,
  hasPermission,
};
