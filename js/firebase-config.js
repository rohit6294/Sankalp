const firebaseConfig = {
  apiKey: "AIzaSyCalURtPJ-TIIEvhTVcBQ373wkILxSSxVo",
  authDomain: "sankalp-learning-5442f.firebaseapp.com",
  projectId: "sankalp-learning-5442f",
  storageBucket: "sankalp-learning-5442f.firebasestorage.app",
  messagingSenderId: "60342126146",
  appId: "1:60342126146:web:50b2f53719da5de64e4fdb",
  measurementId: "G-NJBYC84GDR"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const storage = typeof firebase.storage === 'function' ? firebase.storage() : null;

// Evaluator API base URL (update after deploying to Render)
window.EVALUATOR_API = 'https://sankalp-1vt4.onrender.com';

// ===== Global Profile Validation Checker for Student Portal =====
(function() {
  const path = window.location.pathname;
  if (path.includes('/student/')) {
    const isProfilePage = path.includes('/student/profile.html');

    // Helper to render locking form
    function showProfileLockOverlay(missingFields, missingFieldKeys, uid, currentDisplayName) {
      if (document.getElementById('profile-lock-overlay')) return;

      const overlay = document.createElement('div');
      overlay.id = 'profile-lock-overlay';
      overlay.style.cssText = "position: fixed; inset: 0; background: rgba(2, 6, 23, 0.85); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); z-index: 999999; display: flex; align-items: center; justify-content: center; padding: 24px;";
      
      let fieldsHtml = '';
      
      if (missingFieldKeys.includes('name')) {
        const nameParts = (currentDisplayName || '').split(' ');
        const fName = nameParts[0] || '';
        const lName = nameParts.slice(1).join(' ') || '';
        fieldsHtml += `
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px;">
            <div>
              <label style="display:block; font-size:12px; font-weight:600; color:#94A3B8; margin-bottom:6px">First Name *</label>
              <input type="text" id="lock-firstName" class="input-field" style="width:100%; background: rgba(15,23,42,0.8); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 10px 14px; color: #E2E8F0; font-size: 13px;" placeholder="Arjun" value="${fName}" required>
            </div>
            <div>
              <label style="display:block; font-size:12px; font-weight:600; color:#94A3B8; margin-bottom:6px">Last Name *</label>
              <input type="text" id="lock-lastName" class="input-field" style="width:100%; background: rgba(15,23,42,0.8); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 10px 14px; color: #E2E8F0; font-size: 13px;" placeholder="Das" value="${lName}" required>
            </div>
          </div>
        `;
      }
      
      if (missingFieldKeys.includes('phone')) {
        fieldsHtml += `
          <div style="margin-bottom: 14px;">
            <label style="display:block; font-size:12px; font-weight:600; color:#94A3B8; margin-bottom:6px">Phone Number *</label>
            <input type="tel" id="lock-phone" class="input-field" style="width:100%; background: rgba(15,23,42,0.8); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 10px 14px; color: #E2E8F0; font-size: 13px;" placeholder="+91 98765 43210" required>
          </div>
        `;
      }
      
      if (missingFieldKeys.includes('gender')) {
        fieldsHtml += `
          <div style="margin-bottom: 14px;">
            <label style="display:block; font-size:12px; font-weight:600; color:#94A3B8; margin-bottom:6px">Gender *</label>
            <select id="lock-gender" class="input-field" style="width:100%; background: rgba(15,23,42,0.8); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 10px 14px; color: #E2E8F0; font-size: 13px;" required>
              <option value="">Select Gender</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
          </div>
        `;
      }
      
      if (missingFieldKeys.includes('caste')) {
        fieldsHtml += `
          <div style="margin-bottom: 14px;">
            <label style="display:block; font-size:12px; font-weight:600; color:#94A3B8; margin-bottom:6px">Caste / Category *</label>
            <select id="lock-caste" class="input-field" style="width:100%; background: rgba(15,23,42,0.8); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 10px 14px; color: #E2E8F0; font-size: 13px;" required>
              <option value="">Select Category</option>
              <option value="General">General</option>
              <option value="OBC-A">OBC-A</option>
              <option value="OBC-B">OBC-B</option>
              <option value="SC">SC</option>
              <option value="ST">ST</option>
              <option value="EWS">EWS</option>
            </select>
          </div>
        `;
      }
      
      if (missingFieldKeys.includes('tfw')) {
        fieldsHtml += `
          <div style="margin-bottom: 14px;">
            <label style="display:block; font-size:12px; font-weight:600; color:#94A3B8; margin-bottom:6px">TFW Status *</label>
            <select id="lock-tfw" class="input-field" style="width:100%; background: rgba(15,23,42,0.8); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 10px 14px; color: #E2E8F0; font-size: 13px;" required>
              <option value="">Select TFW Status</option>
              <option value="No">No (General Selection)</option>
              <option value="Yes">Yes (Tuition Fee Waiver Scheme)</option>
            </select>
          </div>
        `;
      }

      if (missingFieldKeys.includes('wbjeeYear')) {
        fieldsHtml += `
          <div style="margin-bottom: 20px;">
            <label style="display:block; font-size:12px; font-weight:600; color:#94A3B8; margin-bottom:6px">WBJEE Target Year *</label>
            <select id="lock-wbjeeYear" class="input-field" style="width:100%; background: rgba(15,23,42,0.8); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 10px 14px; color: #E2E8F0; font-size: 13px;" required>
              <option value="">Select Year</option>
              <option value="2025">WBJEE 2025</option>
              <option value="2026">WBJEE 2026</option>
              <option value="2027">WBJEE 2027</option>
            </select>
          </div>
        `;
      }

      overlay.innerHTML = `
        <div class="glass-card" style="background: rgba(15, 23, 42, 0.96); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 20px; padding: 32px; max-width: 480px; width: 100%; box-shadow: 0 12px 40px rgba(0,0,0,0.5); color: #E2E8F0; font-family: 'Inter', sans-serif;">
          <div style="text-align: center; margin-bottom: 20px;">
            <div style="width: 56px; height: 56px; border-radius: 16px; background: rgba(245,158,11,0.15); border: 1px solid rgba(245,158,11,0.3); display: flex; align-items: center; justify-content: center; color: #F59E0B; font-size: 24px; margin: 0 auto 12px;">
              <i class="fas fa-exclamation-triangle"></i>
            </div>
            <h2 style="font-size: 19px; font-weight: 700; color: white; font-family: 'Poppins', sans-serif; line-height: 1.2;">Complete Your Profile</h2>
            <p style="font-size: 12px; color: #94A3B8; margin-top: 6px; line-height: 1.5;">To unlock the Sankalp portal, please fill in the mandatory fields configured by the administrator.</p>
          </div>
          
          <form id="profile-lock-form">
            ${fieldsHtml}
            
            <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 20px;">
              <button type="submit" class="btn-primary" id="lock-submit-btn" style="width:100%; padding: 12px; justify-content: center; background: linear-gradient(135deg, #4F46E5, #7C3AED); color: white; border: none; border-radius: 10px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 13px;">
                <i class="fas fa-check-circle"></i> Save & Continue
              </button>
              <a href="#" onclick="auth.signOut()" style="text-align: center; font-size: 12px; color: #F87171; text-decoration: none; font-weight: 600; margin-top: 8px;"><i class="fas fa-sign-out-alt"></i> Logout</a>
            </div>
          </form>
        </div>
      `;
      
      document.body.appendChild(overlay);
      
      const form = document.getElementById('profile-lock-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('lock-submit-btn');
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;
        
        const updateData = {};
        
        if (missingFieldKeys.includes('name')) {
          const firstName = document.getElementById('lock-firstName').value.trim();
          const lastName = document.getElementById('lock-lastName').value.trim();
          updateData.firstName = firstName;
          updateData.lastName = lastName;
          updateData.name = `${firstName} ${lastName}`;
          try {
            await auth.currentUser.updateProfile({ displayName: `${firstName} ${lastName}` });
          } catch(e) {}
        }
        if (missingFieldKeys.includes('phone')) {
          updateData.phone = document.getElementById('lock-phone').value.trim();
        }
        if (missingFieldKeys.includes('gender')) {
          updateData.gender = document.getElementById('lock-gender').value;
        }
        if (missingFieldKeys.includes('caste')) {
          updateData.caste = document.getElementById('lock-caste').value;
        }
        if (missingFieldKeys.includes('wbjeeYear')) {
          updateData.wbjeeYear = document.getElementById('lock-wbjeeYear').value;
        }
        if (missingFieldKeys.includes('tfw')) {
          updateData.tfw = document.getElementById('lock-tfw').value;
        }
        
        try {
          await db.collection('users').doc(uid).update(updateData);
          overlay.remove();
          
          const toastEl = document.createElement('div');
          toastEl.style.cssText = "position: fixed; bottom: 24px; right: 24px; background: #0F172A; border: 1px solid rgba(16,185,129,0.3); border-radius: 12px; padding: 14px 20px; font-size: 13px; font-weight: 600; color: #34D399; z-index: 999999; display: flex; align-items: center; gap: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);";
          toastEl.innerHTML = '<i class="fas fa-check-circle"></i> Profile unlocked successfully!';
          document.body.appendChild(toastEl);
          setTimeout(() => toastEl.remove(), 3000);
          
          // Clear mandatory fields session cache to force re-fetch
          sessionStorage.removeItem('mandatory_profile_fields');
          
          // Reload page to reflect changes
          window.location.reload();
        } catch(err) {
          btn.innerHTML = '<i class="fas fa-check-circle"></i> Save & Continue';
          btn.disabled = false;
          alert('Failed to save profile: ' + err.message);
        }
      });
    }

    function showProfileWarningBanner(missingList) {
      if (document.getElementById('profile-warning-banner')) return;
      const container = document.querySelector('.main-content') || document.body;
      const banner = document.createElement('div');
      banner.id = 'profile-warning-banner';
      banner.style.cssText = "background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; display: flex; align-items: center; gap: 14px; color: #F59E0B; font-size: 13px; line-height: 1.5; font-family: 'Inter', sans-serif;";
      banner.innerHTML = `
        <i class="fas fa-exclamation-triangle" style="font-size: 18px; flex-shrink: 0;"></i>
        <div>
          <strong style="font-weight: 700;">Complete Your Profile:</strong> The administrator has configured these required fields: 
          <strong style="color: #FFF; font-weight: 700;">${missingList.join(', ')}</strong>. Please fill them out below and save.
        </div>
      `;
      container.insertBefore(banner, container.firstChild);
    }

    // Verify on DOM loaded & Auth state changed
    auth.onAuthStateChanged(async (user) => {
      if (!user) return;
      
      try {
        // 1. Fetch mandatory fields from settings
        let mandatoryFields = null;
        const cached = sessionStorage.getItem('mandatory_profile_fields');
        if (cached) {
          mandatoryFields = JSON.parse(cached);
        } else {
          const token = await user.getIdToken();
          const baseUrl = window.EVALUATOR_API || 'http://localhost:3000';
          const res = await fetch(`${baseUrl}/api/exams/settings/mandatory-fields`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (res.ok) {
            const data = await res.json();
            mandatoryFields = data.settings || {};
            sessionStorage.setItem('mandatory_profile_fields', JSON.stringify(mandatoryFields));
          }
        }
        
        if (!mandatoryFields) return;
        
        // 2. Fetch student document
        const userDoc = await db.collection('users').doc(user.uid).get();
        if (!userDoc.exists) return;
        const userData = userDoc.data() || {};
        
        // 3. Match missing fields
        const missingFields = [];
        const missingFieldKeys = [];
        
        if (mandatoryFields.name && (!userData.firstName || !userData.lastName || !userData.firstName.trim() || !userData.lastName.trim())) {
          missingFields.push('Full Name');
          missingFieldKeys.push('name');
        }
        if (mandatoryFields.phone && (!userData.phone || !userData.phone.trim())) {
          missingFields.push('Phone Number');
          missingFieldKeys.push('phone');
        }
        if (mandatoryFields.gender && (!userData.gender || !userData.gender.trim())) {
          missingFields.push('Gender');
          missingFieldKeys.push('gender');
        }
        if (mandatoryFields.caste && (!userData.caste || !userData.caste.trim())) {
          missingFields.push('Caste / Category');
          missingFieldKeys.push('caste');
        }
        if (mandatoryFields.wbjeeYear && (!userData.wbjeeYear || !userData.wbjeeYear.trim())) {
          missingFields.push('WBJEE Target Year');
          missingFieldKeys.push('wbjeeYear');
        }
        if (mandatoryFields.tfw && (!userData.tfw || !userData.tfw.trim())) {
          missingFields.push('TFW Status');
          missingFieldKeys.push('tfw');
        }

        if (missingFields.length > 0) {
          // Execute after document body is available
          const runBlock = () => {
            if (isProfilePage) {
              showProfileWarningBanner(missingFields);
            } else {
              showProfileLockOverlay(missingFields, missingFieldKeys, user.uid, user.displayName);
            }
          };

          if (document.body) {
            runBlock();
          } else {
            window.addEventListener('DOMContentLoaded', runBlock);
          }
        }
      } catch (err) {
        console.error("Profile validation check failed: ", err);
      }
    });
  }
})();
