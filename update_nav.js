const fs = require('fs');
const path = require('path');

// Update Student sidebars
const studentDir = path.join(__dirname, 'student');
const studentFiles = fs.readdirSync(studentDir).filter(f => f.endsWith('.html'));

for (const file of studentFiles) {
  const filePath = path.join(studentDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  const navStart = content.indexOf('<nav style="padding:8px 0;">');
  const navEnd = content.indexOf('</nav>', navStart);
  if (navStart === -1 || navEnd === -1) continue;

  let newNav = `<nav style="padding:8px 0;">
    <div class="eyebrow" style="padding:14px 22px 8px;">Main</div>
    <a href="evaluate.html" class="sidebar-link"><i class="fas fa-clipboard-check" style="width:18px"></i> Evaluate Sheet</a>
    <a href="notes.html" class="sidebar-link"><i class="fas fa-sticky-note" style="width:18px"></i> Notes</a>
    <a href="predictor.html" class="sidebar-link"><i class="fas fa-graduation-cap" style="width:18px"></i> College Predictor</a>
    <div class="eyebrow" style="padding:14px 22px 8px;">Account</div>
    <a href="profile.html" class="sidebar-link"><i class="fas fa-user" style="width:18px"></i> Profile</a>
    <a href="#" class="sidebar-link" onclick="logout()"><i class="fas fa-sign-out-alt" style="width:18px"></i> Logout</a>
  </nav>`;

  if (file === 'evaluate.html') newNav = newNav.replace('href="evaluate.html" class="sidebar-link"', 'href="evaluate.html" class="sidebar-link active"');
  if (file === 'notes.html') newNav = newNav.replace('href="notes.html" class="sidebar-link"', 'href="notes.html" class="sidebar-link active"');
  if (file === 'predictor.html') newNav = newNav.replace('href="predictor.html" class="sidebar-link"', 'href="predictor.html" class="sidebar-link active"');
  if (file === 'profile.html') newNav = newNav.replace('href="profile.html" class="sidebar-link"', 'href="profile.html" class="sidebar-link active"');

  content = content.substring(0, navStart) + newNav + content.substring(navEnd + 6);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Updated ' + file);
}

// Remove "content.html" link from admin sidebars
const adminDir = path.join(__dirname, 'admin');
const adminFiles = ['evaluators.html', 'sub-admins.html', 'tests.html', 'notes.html'];

for (const file of adminFiles) {
  const filePath = path.join(adminDir, file);
  if (!fs.existsSync(filePath)) continue;
  let content = fs.readFileSync(filePath, 'utf8');

  // Replace content link
  const regex = /<a href="content\.html" class="sidebar-link">.*?<\/a>\s*/g;
  content = content.replace(regex, '');
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Updated admin/' + file);
}
