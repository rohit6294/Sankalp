const fs = require('fs');
const path = require('path');

const notesPath = path.join(__dirname, 'admin', 'notes.html');
let content = fs.readFileSync(notesPath, 'utf8');

// 1. Replace <head> and <style>
const styleStart = content.indexOf('<style>');
const styleEnd = content.indexOf('</style>') + 8;
const newStyle = `<style>
    .tbl { width: 100%; border-collapse: collapse; }
    .tbl th { padding: 12px 14px; font-size: 11px; font-weight: 700; color: var(--ink-mute); text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid var(--ink); text-align: left; }
    .tbl td { padding: 12px 14px; font-size: 13px; border-bottom: 1px solid var(--rule); vertical-align: middle; color: var(--ink-soft); }
    .tbl tr:hover td { background: var(--paper-soft); }
    .badge { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 100px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
    .badge-phy { background: rgba(59,130,246,0.1); color: #2563EB; }
    .badge-chem { background: rgba(168,85,247,0.1); color: #9333EA; }
    .badge-math { background: rgba(16,185,129,0.1); color: var(--forest); }
    .badge-free { background: rgba(16,185,129,0.1); color: var(--forest); }
    .badge-paid { background: rgba(245,158,11,0.1); color: #D97706; }
    .toast { position: fixed; top: 24px; right: 24px; padding: 12px 18px; background: var(--ink); color: var(--paper); font-size: 13px; font-weight: 700; z-index: 9999; opacity: 0; transition: opacity 0.2s; }
    .toast.show { opacity: 1; }
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(26,20,16,0.7); z-index: 1000; align-items: center; justify-content: center; padding: 24px; }
    .modal-box { background: var(--paper); border: 1px solid var(--ink); padding: 24px; width: 100%; max-height: 90vh; overflow-y: auto; }
    .empty-state { text-align: center; padding: 60px 20px; color: var(--ink-mute); font-size: 13px; }
    .empty-state i { font-size: 40px; margin-bottom: 12px; display: block; opacity: 0.5; }
    .radio-group { display: flex; gap: 12px; flex-wrap: wrap; }
    .radio-opt { display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 8px 14px; border: 1px solid var(--rule); transition: all 0.2s; font-size: 13px; font-family: var(--font-sans); }
    .radio-opt:hover { border-color: var(--ink); background: var(--paper-soft); }
    .form-grid { display: grid; gap: 16px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .progress-bar { height: 6px; background: var(--rule); border-radius: 3px; overflow: hidden; margin-top: 8px; }
    .progress-fill { height: 100%; background: var(--rust); border-radius: 3px; transition: width 0.3s; }
  </style>`;
content = content.substring(0, styleStart) + newStyle + content.substring(styleEnd);

// Replace head link to style.css
content = content.replace('</head>', '  <link rel="stylesheet" href="../css/style.css">\n</head>');

// Replace body start
content = content.replace('<body style="background:#020617;color:#E2E8F0;font-family:\'Inter\',sans-serif;min-height:100vh">', '<body>');

// 2. Replace Sidebar
const sidebarStart = content.indexOf('<aside class="admin-sidebar"');
const sidebarEnd = content.indexOf('</aside>') + 8;
const newSidebar = `<button class="menu-toggle" onclick="toggleSidebar()" style="z-index:60"><i class="fas fa-bars"></i></button>
<div class="sidebar-overlay" id="overlay" onclick="toggleSidebar()"></div>

<aside class="sidebar sidebar-ink" id="adminSidebar">
  <div class="sidebar-head">
    <a href="../index.html" class="brand">
      <span class="brand-mark">S</span>
      <span>
        <div class="brand-name">SANKALP</div>
        <div class="brand-sub">Admin Panel</div>
      </span>
    </a>
  </div>
  <nav style="padding:8px 0;">
    <div class="eyebrow" style="padding:14px 22px 8px; color:rgba(234,219,192,0.5);">Launch</div>
    <a href="evaluators.html" class="sidebar-link"><i class="fas fa-calculator" style="width:18px"></i> Evaluators</a>
    <a href="notes.html" class="sidebar-link active"><i class="fas fa-sticky-note" style="width:18px"></i> Notes</a>
    <div class="eyebrow" style="padding:14px 22px 8px; color:rgba(234,219,192,0.5);">Manage</div>
    <a href="students.html" class="sidebar-link"><i class="fas fa-users" style="width:18px"></i> Student List</a>
    <a href="sub-admins.html" class="sidebar-link"><i class="fas fa-user-shield" style="width:18px"></i> Sub Admins</a>
    <a href="../login.html" class="sidebar-link" onclick="logout()"><i class="fas fa-sign-out-alt" style="width:18px"></i> Logout</a>
  </nav>
</aside>`;
content = content.substring(0, sidebarStart) + newSidebar + content.substring(sidebarEnd);

// 3. Replace <main class="admin-main"...
content = content.replace(/<main class="admin-main".*?>/, '<main class="main-content" style="padding:28px 32px;">');

// 4. Update Header and buttons
content = content.replace(/<h1 style="font-size:22px;font-weight:700;color:white">Notes & Study Materials<\/h1>/, '<h1 class="display-lg">Notes & Study Materials</h1>');
content = content.replace(/<p style="font-size:13px;color:#64748B;margin-top:2px">/, '<p style="font-size:13px; color:var(--ink-mute); margin-top:4px;">');

// Buttons
content = content.replace(/class="btn-primary" onclick="openCategoryModal\(\)" style="background:rgba\(79,70,229,0\.15\);color:#818CF8;border:1px solid rgba\(79,70,229,0\.3\)"/g, 'class="btn-ghost" onclick="openCategoryModal()"');
content = content.replace(/class="btn-primary"/g, 'class="btn-rust"');
content = content.replace(/class="btn-cancel"/g, 'class="btn-ghost"');
content = content.replace(/class="btn-danger"/g, 'class="btn-ghost" style="color:#ef4444;"');
content = content.replace(/class="btn-edit"/g, 'class="btn-ghost"');

// Glass and inp
content = content.replace(/class="glass"/g, 'style="border:1px solid var(--ink); background:var(--paper-soft); padding:24px;"');
content = content.replace(/class="inp"/g, 'class="input-field"');

// Modals
content = content.replace(/id="notesModal" style="display:none"/g, 'id="notesModal"');
content = content.replace(/id="categoryModal" style="display:none"/g, 'id="categoryModal"');
content = content.replace(/id="logsModal" style="display:none"/g, 'id="logsModal"');
content = content.replace(/<h2 style="font-size:18px;font-weight:700;color:white"/g, '<h2 class="display-sm"');
content = content.replace(/<label>/g, '<label class="input-label">');
content = content.replace(/<label style="margin-bottom:0">/g, '<label class="input-label" style="margin-bottom:0">');

// Colors
content = content.replace(/color:white/g, 'color:var(--ink)');
content = content.replace(/color:#94A3B8/g, 'color:var(--ink-mute)');
content = content.replace(/color:#64748B/g, 'color:var(--ink-mute)');

fs.writeFileSync(notesPath, content, 'utf8');
console.log('Notes.html refactored!');
