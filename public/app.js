// GVD LIVE Works Planner - Pure Firebase Firestore Real-Time Engine

const firebaseConfig = {
  projectId: "gvd-live",
  authDomain: "gvd-live.firebaseapp.com",
  storageBucket: "gvd-live.appspot.com"
};

let db = null;
if (typeof firebase !== 'undefined' && firebase.apps) {
  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }
  db = firebase.firestore();
}

const REST_FALLBACK_URL = 'https://api.restful-api.dev/objects/ff808181a09d98f701a0dea5e03e1f14';

let currentUser = null;
let appSettings = { app_name: 'GVD LIVE', logo_url: '/gvd-logo.png' };

let allUsers = [];
let allSites = [];
let allShifts = [];
let allPhotos = [];
let allPdfs = [];
let activeSiteId = null;
let siteFilterMode = 'active'; // 'active' | 'archived'
let isDraftPlanningMode = false;

let currentPlannerWeekOffset = 0; // 0 = current week
let currentLabourWeekOffset = 1;  // 1 = next week by default
let selectedMobileDayIndex = 0;   // 0 = Monday

let knownShiftIds = null;
let currentCustomerToken = null;

// Helper Role Validation Functions
function isManagementUser(user) {
  if (!user) return false;
  return user.role === 'Owner' || user.role === 'Admin' || user.role === 'Manager' || user.email === 'phil@gvdcontracts.com';
}

function isOwnerOrAdminUser(user) {
  if (!user) return false;
  return user.role === 'Owner' || user.role === 'Admin' || user.email === 'phil@gvdcontracts.com';
}

function formatSiteId(siteId) {
  const idNum = parseInt(siteId);
  if (isNaN(idNum)) return `Site #${siteId}`;
  if (idNum >= 10000) return `Site #${idNum}`;
  const formatted = 74000 + (idNum * 137);
  return `Site #${formatted}`;
}

// -------------------------------------------------------------------
// STANDARD CAMERA-SCANNABLE QR CODE GENERATOR (SVG Matrix + Image Fallback)
// -------------------------------------------------------------------
function generateQRCodeSVG(text) {
  if (!text) {
    return `<div style="text-align: center; color: #ef4444; font-size: 0.85rem; padding: 12px;">QR Code Generating...</div>`;
  }
  try {
    let qr = null;
    if (typeof qrcode === 'function') {
      qr = qrcode(0, 'L');
    } else if (typeof QRCode !== 'undefined') {
      qr = new QRCode(0, 1);
    }
    if (qr) {
      qr.addData(text);
      qr.make();
      var count = qr.getModuleCount();
      var cellSize = 6;
      var margin = 12;
      var size = count * cellSize + margin * 2;

      var svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="max-width: 220px; height: auto; display: block; margin: 0 auto; border-radius: 8px; border: 4px solid #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">`;
      svg += `<rect width="${size}" height="${size}" fill="#ffffff"/>`;
      for (var r = 0; r < count; r++) {
        for (var c = 0; c < count; c++) {
          if (qr.isDark(r, c)) {
            var x = margin + c * cellSize;
            var y = margin + r * cellSize;
            svg += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="#0f172a"/>`;
          }
        }
      }
      svg += `</svg>`;
      return svg;
    }
  } catch (e) {
    console.warn('QRCode matrix error, using high-res fallback API:', e);
  }
  const encodedUrl = encodeURIComponent(text);
  return `<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodedUrl}" alt="Customer QR Code" style="width: 220px; height: 220px; display: block; margin: 0 auto; border-radius: 8px; border: 4px solid #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />`;
}

function dataURLtoBlob(dataurl) {
  if (!dataurl || typeof dataurl !== 'string') return null;
  try {
    const arr = dataurl.split(',');
    if (arr.length < 2) return null;
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  } catch (err) {
    console.error('Error converting DataURL to Blob:', err);
    return null;
  }
}

function forceDownloadFile(filename, dataUrlOrBlob, mimeType = 'application/octet-stream') {
  try {
    let blob = null;
    if (dataUrlOrBlob instanceof Blob) {
      blob = dataUrlOrBlob;
    } else if (typeof dataUrlOrBlob === 'string' && dataUrlOrBlob.startsWith('data:')) {
      blob = dataURLtoBlob(dataUrlOrBlob);
    }

    if (!blob) {
      const a = document.createElement('a');
      a.href = dataUrlOrBlob;
      a.download = filename;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => document.body.removeChild(a), 1000);
      return;
    }

    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    }, 3000);
  } catch (err) {
    console.error('forceDownloadFile failed:', err);
    window.open(dataUrlOrBlob, '_blank');
  }
}

// -------------------------------------------------------------------
// FIRESTORE REAL-TIME LISTENERS & LOCAL STORAGE ENGINE
// -------------------------------------------------------------------
function deduplicateSites() {
  const map = new Map();
  allSites.forEach(s => {
    if (s && s.id != null) {
      map.set(String(s.id), s);
    }
  });
  allSites = Array.from(map.values());
}

function deduplicateShifts() {
  const map = new Map();
  allShifts.forEach(s => {
    if (s && s.id != null) {
      map.set(String(s.id), s);
    }
  });
  allShifts = Array.from(map.values());
}

function deduplicatePhotos() {
  const map = new Map();
  allPhotos.forEach(p => {
    if (p && p.id != null) {
      map.set(String(p.id), p);
    }
  });
  allPhotos = Array.from(map.values());
}

function loadLocalStorageData() {
  try {
    allUsers = JSON.parse(localStorage.getItem('gvd_users')) || [];
    allSites = JSON.parse(localStorage.getItem('gvd_sites')) || [];
    allShifts = JSON.parse(localStorage.getItem('gvd_shifts')) || [];
    allPhotos = JSON.parse(localStorage.getItem('gvd_photos')) || [];
    allPdfs = JSON.parse(localStorage.getItem('gvd_pdfs')) || [];
    deduplicateSites();
    deduplicateShifts();
    const settingsStr = localStorage.getItem('gvd_settings');
    if (settingsStr) appSettings = JSON.parse(settingsStr);
  } catch (e) {
    console.error('Error loading local storage:', e);
  }
}

function saveLocalStorageData() {
  try {
    deduplicateSites();
    deduplicateShifts();
    localStorage.setItem('gvd_users', JSON.stringify(allUsers));
    localStorage.setItem('gvd_sites', JSON.stringify(allSites));
    localStorage.setItem('gvd_shifts', JSON.stringify(allShifts));
    localStorage.setItem('gvd_photos', JSON.stringify(allPhotos));
    localStorage.setItem('gvd_pdfs', JSON.stringify(allPdfs));
    localStorage.setItem('gvd_settings', JSON.stringify(appSettings));
  } catch (e) {
    console.error('Error saving local storage:', e);
  }
}

function initFirestoreSync() {
  if (!db) {
    console.warn('Firestore SDK not loaded, using REST fallback');
    fetchRestFallback();
    return;
  }

  // Real-time Users Collection Sync & Auto-Approval Login
  db.collection('users').onSnapshot(snapshot => {
    allUsers = snapshot.docs.map(doc => {
      const d = doc.data();
      return { ...d, id: d.id || doc.id };
    });

    const storedUserId = localStorage.getItem('gvd_current_user_id');
    const activeUserId = currentUser ? currentUser.id : storedUserId;

    if (activeUserId) {
      const updated = allUsers.find(u => String(u.id) === String(activeUserId));
      if (updated) {
        if (updated.email === 'phil@gvdcontracts.com') {
          updated.role = 'Owner';
          updated.status = 'Active';
        }
        if (updated.status === 'Active') {
          const awaitingApprovalEl = document.getElementById('view-awaiting-approval');
          const isAwaitingView = awaitingApprovalEl && awaitingApprovalEl.style.display !== 'none';
          const wasPending = !currentUser || currentUser.status === 'Pending' || currentUser.status === 'Pending Approval';
          
          if (wasPending || isAwaitingView) {
            currentUser = updated;
            onUserAuthenticated(currentUser);
            showGreenToast('🎉 Account Approved! Welcome to Works Planner.');
          } else {
            currentUser = updated;
          }
        }
      }
    }

    saveLocalStorageData();
    updatePendingUsersBadge();
    renderActiveView();
  }, err => console.warn('Firestore users error:', err));

  // Real-time Sites Collection Sync (with deduplication)
  db.collection('sites').onSnapshot(snapshot => {
    allSites = snapshot.docs.map(doc => {
      const d = doc.data();
      return { ...d, id: parseInt(d.id || doc.id) };
    });
    deduplicateSites();
    saveLocalStorageData();
    if (currentCustomerToken) {
      loadCustomerPublicView(currentCustomerToken);
      return;
    }
    renderActiveView();
  }, err => console.warn('Firestore sites error:', err));


  // Real-time Shifts Collection Sync
  db.collection('shifts').onSnapshot(snapshot => {
    const newShifts = snapshot.docs.map(doc => {
      const d = doc.data();
      return { ...d, id: parseInt(d.id || doc.id) };
    });

    knownShiftIds = new Set(newShifts.map(s => parseInt(s.id)));
    allShifts = newShifts;
    deduplicateShifts();
    saveLocalStorageData();
    if (currentCustomerToken) {
      loadCustomerPublicView(currentCustomerToken);
      return;
    }
    renderActiveView();
    if (typeof refreshFinanceViews === 'function') refreshFinanceViews();
  }, err => console.warn('Firestore shifts error:', err));

  // Real-time Photos Collection Sync
  db.collection('photos').onSnapshot(snapshot => {
    allPhotos = snapshot.docs.map(doc => {
      const d = doc.data();
      return { ...d, id: String(d.id || doc.id) };
    });
    saveLocalStorageData();
    if (activeSiteId) loadProjectPage(activeSiteId);
  }, err => console.warn('Firestore photos error:', err));

  // Real-time PDFs Collection Sync
  db.collection('pdfs').onSnapshot(snapshot => {
    allPdfs = snapshot.docs.map(doc => {
      const d = doc.data();
      return { ...d, id: String(d.id || doc.id) };
    });
    saveLocalStorageData();
    if (activeSiteId) loadProjectPage(activeSiteId);
    const invView = document.getElementById('view-invoices');
    if (invView && invView.style.display !== 'none') renderInvoiceRegister();
  }, err => console.warn('Firestore pdfs error:', err));

  // Real-time App Settings Sync
  db.collection('settings').doc('app').onSnapshot(doc => {
    if (doc.exists) {
      appSettings = doc.data();
      saveLocalStorageData();
      updateBrandingUI();
    }
  }, err => console.warn('Firestore settings error:', err));
}

function triggerShiftNotification(shift, customTitle = '🚨 New Shift Assigned!') {
  if (!shift || !shift.operative_id) return;
  const targetUserId = String(shift.operative_id);
  const site = allSites.find(s => parseInt(s.id) === parseInt(shift.site_id));
  const siteName = site ? site.address : `Site #${shift.site_id}`;
  const title = customTitle;
  const msg = `Date: ${shift.shift_date}\nSite: ${siteName}\nTask: ${shift.task}`;

  // Target notification in Firestore so assigned operative phone receives push even in background
  if (db) {
    db.collection('notifications').add({
      target_user_id: targetUserId,
      title: title,
      body: msg,
      shift_id: shift.id,
      site_id: shift.site_id,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(err => console.warn('Failed to post target notification to Firestore:', err));
  }

  // Only trigger local browser notification if the logged-in user IS the assigned operative
  if (currentUser && String(currentUser.id) === targetUserId) {
    const isMuted = localStorage.getItem('gvd_push_muted') === 'true';
    if (!isMuted && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, { body: msg, icon: '/icon-192.png' });
      } catch (e) {}
    }
  }
}

async function fetchRestFallback() {
  try {
    const res = await fetch(REST_FALLBACK_URL);
    if (res.ok) {
      const json = await res.json();
      if (json && json.data) {
        allUsers = json.data.users || [];
        allSites = json.data.sites || [];
        allShifts = json.data.shifts || [];
        allPhotos = json.data.photos || [];
        allPdfs = json.data.pdfs || [];
        if (json.data.settings) appSettings = json.data.settings;
        saveLocalStorageData();
        renderActiveView();
      }
    }
  } catch (e) {
    loadLocalStorageData();
  }
}

// Simple hash for password check
function hashSimple(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

// -------------------------------------------------------------------
// INITIALIZATION & ROUTING
// -------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  loadLocalStorageData();
  setupEventListeners();
  registerServiceWorker();

  initFirestoreSync();

  // Check URL query for customer token (e.g. ?customer=TOKEN)
  const urlParams = new URLSearchParams(window.location.search);
  const custToken = urlParams.get('customer');
  if (custToken) {
    loadCustomerPublicView(custToken);
    return;
  }

  // Check logged-in session
  const storedUserId = localStorage.getItem('gvd_current_user_id');
  if (storedUserId) {
    const user = allUsers.find(u => String(u.id) === String(storedUserId));
    if (user && user.status === 'Active') {
      currentUser = user;
      onUserAuthenticated();
      return;
    }
  }

  showView('view-login');
});

function onUserAuthenticated() {
  if (!currentUser) return;

  if (currentUser.must_change_password) {
    document.getElementById('appHeader').style.display = 'none';
    showView('view-reset-password');
    return;
  }

  localStorage.setItem('gvd_current_user_id', currentUser.id);
  document.getElementById('appHeader').style.display = 'flex';
  document.getElementById('userNameText').textContent = currentUser.full_name;

  if ('Notification' in window && Notification.permission === 'granted') {
    const dot = document.getElementById('bellStatusDot');
    if (dot) dot.classList.add('active');
  }

  if (currentUser.email === 'phil@gvdcontracts.com') {
    currentUser.role = 'Owner';
    currentUser.status = 'Active';
  }

  const roleBadge = document.getElementById('userRoleBadge');
  roleBadge.textContent = currentUser.role;
  roleBadge.className = `badge-role ${currentUser.role.toLowerCase()}`;

  const isOwnerOrAdmin = isOwnerOrAdminUser(currentUser);
  const isManagerOrHigher = isManagementUser(currentUser);
  document.getElementById('appHeader').classList.toggle('nav-collapsible', isManagerOrHigher);

  // Role permissions UI visibility
  // Tab panels are shown/hidden by the tab buttons, so only ever force-hide them here
  const applyRoleVisibility = (el, allowed) => {
    if (allowed && el.classList.contains('project-tab-content')) return;
    el.style.display = allowed ? '' : 'none';
  };
  document.querySelectorAll('.admin-only').forEach(el => applyRoleVisibility(el, isOwnerOrAdmin));
  document.querySelectorAll('.manager-admin-only').forEach(el => applyRoleVisibility(el, isManagerOrHigher));
  document.querySelectorAll('.op-only').forEach(el => {
    el.style.display = (!isManagerOrHigher) ? '' : 'none';
  });

  // Tell the phone menu how many boxes this role has, so each row fills the full width
  const navMenuEl = document.getElementById('navMenu');
  navMenuEl.dataset.count = Array.from(navMenuEl.querySelectorAll('.nav-item')).filter(b => b.style.display !== 'none').length;

  updateBrandingUI();
  updatePendingUsersBadge();
  registerDevicePushSubscription(false);
  updateCleanPushUI();
  if (isManagerOrHigher) startDiarySync();
  startPOSync();
  if (isManagerOrHigher) startFinanceSync();

  if (isManagerOrHigher) {
    showView('view-planner');
  } else {
    showView('view-my-shifts');
  }

  // Check URL query parameters for notification tap target (e.g. ?openShift=101)
  const urlParams = new URLSearchParams(window.location.search);
  const openShiftId = urlParams.get('openShift');
  if (openShiftId) {
    const sId = parseInt(openShiftId);
    if (!isNaN(sId)) {
      setTimeout(() => openShiftDetailModal(sId), 300);
    }
  }
}

async function performVersionedResetMigration() {
  const RESET_VERSION = 'gvd_pwa_reset_v5';
  if (localStorage.getItem(RESET_VERSION) === 'completed') return;

  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        try {
          const sub = await reg.pushManager.getSubscription();
          if (sub) await sub.unsubscribe().catch(() => null);
        } catch (e) {}
        await reg.unregister().catch(() => null);
      }
    }
    localStorage.removeItem('gvd_push_subscribed');
    localStorage.removeItem('gvd_push_muted');
  } catch (err) {
    console.warn('Migration cleanup error:', err);
  }

  localStorage.setItem(RESET_VERSION, 'completed');
  console.log('Cleaned legacy PWA service workers and subscriptions (v4 reset)');
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    await performVersionedResetMigration();
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('SW failed:', err));
  }
}

function updateBrandingUI() {
  const appName = appSettings.app_name || 'GVD LIVE';
  document.title = appName;
  document.getElementById('appTitleText').textContent = appName;
  document.getElementById('loginTitleText').textContent = appName;
  document.getElementById('printAppName').textContent = appName;

  const logoUrl = appSettings.logo_url || '/gvd-logo.png';
  const logoImg = document.getElementById('appLogoImg');
  if (logoImg) logoImg.src = logoUrl;

  const printLogo = document.getElementById('printLogoImg');
  if (printLogo) printLogo.src = logoUrl;

  const custPubLogo = document.getElementById('custPubLogoImg');
  if (custPubLogo) custPubLogo.src = logoUrl;
}

// -------------------------------------------------------------------
// VIEW NAVIGATION
// -------------------------------------------------------------------
function showView(viewId) {
  document.querySelectorAll('.app-view, .auth-wrapper').forEach(el => {
    el.style.display = 'none';
  });

  const targetView = document.getElementById(viewId);
  if (targetView) targetView.style.display = 'block';
  if (viewId === 'view-my-shifts') myShiftsTab = 'today';
  updateMobileMenuLabel(viewId);

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.target === viewId);
  });

  renderActiveView();
}

function updateMobileMenuLabel(viewId) {
  const btn = document.getElementById('btnMobileMenu');
  if (!btn) return;
  const navBtn = Array.from(document.querySelectorAll('.nav-item')).find(b => b.dataset.target === viewId && b.offsetParent !== null) ||
    Array.from(document.querySelectorAll('.nav-item')).find(b => b.dataset.target === viewId);
  const lblEl = navBtn ? navBtn.querySelector('.nav-lbl') : null;
  const label = lblEl ? lblEl.textContent.trim() : '';
  btn.textContent = label ? `☰ ${label}` : '☰ Menu';
  document.getElementById('appHeader').classList.remove('menu-open');
}

function renderActiveView() {
  const activeViewEl = document.querySelector('.app-view:not([style*="display: none"])');
  if (!activeViewEl) return;

  const viewId = activeViewEl.id;
  if (viewId === 'view-planner') {
    renderPlannerView();
  } else if (viewId === 'view-my-shifts') {
    renderMyShiftsView();
  } else if (viewId === 'view-projects' || viewId === 'view-my-projects') {
    renderSitesList();
  } else if (viewId === 'view-labour-sheet') {
    renderLabourSheetView();
  } else if (viewId === 'view-admin') {
    renderAdminSettingsView();
  } else if (viewId === 'view-diary') {
    renderDiaryView();
  } else if (viewId === 'view-invoices') {
    renderInvoicesView();
  } else if (viewId === 'view-finance') {
    renderFinanceView();
  }
}

// Helper: Calculate Date Range
function getWeekDays(weekOffset = 0) {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diffToMon = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek) + (weekOffset * 7);

  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMon);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
}

const USER_COLOR_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#06b6d4', '#a855f7', '#eab308'];

// Colour chosen by an admin, otherwise a stable automatic one so everyone is distinguishable
function userColor(userOrId) {
  const u = typeof userOrId === 'object' && userOrId ? userOrId : allUsers.find(x => String(x.id) === String(userOrId));
  if (u && /^#[0-9a-fA-F]{6}$/.test(u.color || '')) return u.color;
  const key = String(u ? u.id : userOrId || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return USER_COLOR_PALETTE[h % USER_COLOR_PALETTE.length];
}

const SITE_INFO_FIELDS = [
  ['info_tiling', 'Tiling', '🔲'],
  ['info_flooring', 'Flooring', '🪵'],
  ['info_paint', 'Paint', '🎨']
];

// Read-only info boxes (only the ones that have been filled in) shown to operatives
function siteInfoHtml(site) {
  if (!site) return '';
  const rows = SITE_INFO_FIELDS.filter(([key]) => (site[key] || '').trim())
    .map(([key, label, icon]) => `<div style="padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--primary); border-left: 5px solid var(--primary); background-color: rgba(59, 130, 246, 0.08); margin-bottom: 8px;">
      <strong style="font-size: 0.85rem; color: var(--primary);">${icon} ${label.toUpperCase()}</strong>
      <div style="font-size: 1rem; margin-top: 3px; white-space: pre-wrap;">${diaryEsc(site[key])}</div>
    </div>`).join('');
  return rows ? `<div style="margin: 4px 0 12px;">${rows}</div>` : '';
}

// Editable info boxes in the planner's site column (managers/admins)
function siteInfoEditorHtml(site) {
  return `<div class="site-info-editor" style="margin-top: 10px;">${SITE_INFO_FIELDS.map(([key, label, icon]) => `
    <label style="display: block; font-size: 0.7rem; font-weight: 700; color: var(--text-muted); margin-top: 6px;">${icon} ${label.toUpperCase()}</label>
    <textarea class="form-control site-info-input" data-site-id="${site.id}" data-field="${key}" rows="2" placeholder="Not set" style="font-size: 0.8rem; padding: 4px 6px; min-height: 0; resize: vertical;">${diaryEsc(site[key] || '')}</textarea>`).join('')}</div>`;
}

async function saveSiteInfo(siteId, field, value) {
  const site = allSites.find(s => parseInt(s.id) === parseInt(siteId));
  if (!site || (site[field] || '') === value) return;
  site[field] = value;
  if (db) await db.collection('sites').doc(String(site.id)).update({ [field]: value }).catch(err => alert('Could not save: ' + err.message));
  saveLocalStorageData();
  showGreenToast(value ? 'Site info saved - operatives can now see it' : 'Site info cleared');
}

// Rolling 7-day window starting today (offset moves it 7 days at a time)
function getRollingDays(offset = 0) {
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function isWeekendDay(d) {
  return d.getDay() === 0 || d.getDay() === 6;
}

function formatDateISO(d) {
  return d.toISOString().split('T')[0];
}

function formatUKDate(dateInput) {
  if (!dateInput) return '';
  let d;
  if (dateInput instanceof Date) {
    d = dateInput;
  } else if (typeof dateInput === 'string') {
    if (dateInput.includes('T')) {
      d = new Date(dateInput);
    } else {
      const parts = dateInput.split('-');
      if (parts.length === 3) {
        const year = parseInt(parts[0]);
        const month = parseInt(parts[1]) - 1;
        const day = parseInt(parts[2]);
        d = new Date(year, month, day);
      } else {
        d = new Date(dateInput);
      }
    }
  } else {
    d = new Date(dateInput);
  }

  if (isNaN(d.getTime())) return String(dateInput);

  const dayStr = String(d.getDate()).padStart(2, '0');
  const monthStr = String(d.getMonth() + 1).padStart(2, '0');
  const yearStr = String(d.getFullYear());
  return `${dayStr}/${monthStr}/${yearStr}`;
}

function siteTypeBadgeHtml(site) {
  return site.construction_type ? `<span class="site-type-badge ${site.construction_type.toLowerCase()}">${site.construction_type}</span>` : '';
}

function formatShortUKDayDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return formatDateShort(new Date(y, m - 1, d));
}

function formatDateShort(d) {
  const dayName = d.toLocaleDateString('en-GB', { weekday: 'short' });
  return `${dayName} ${formatUKDate(d)}`;
}

function formatUKDateTime(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

// -------------------------------------------------------------------
// SYNC ALL & SITE PLANNING PUBLISH ENGINE
// -------------------------------------------------------------------
function showGreenToast(msg) {
  let toast = document.getElementById('greenToastNotification');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'greenToastNotification';
    toast.style.position = 'fixed';
    toast.style.bottom = '24px';
    toast.style.right = '24px';
    toast.style.backgroundColor = '#10b981';
    toast.style.color = '#ffffff';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '8px';
    toast.style.fontWeight = '700';
    toast.style.fontSize = '0.9rem';
    toast.style.boxShadow = '0 10px 25px -5px rgba(16, 185, 129, 0.4)';
    toast.style.zIndex = '99999';
    toast.style.transition = 'all 0.3s ease';
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    toast.style.gap = '8px';
    document.body.appendChild(toast);
  }
  toast.innerHTML = msg;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
  }, 2200);
}

// -------------------------------------------------------------------
// LIVE CLOUD PLANNING VS DRAFT LOGISTICS TOGGLE ENGINE
// -------------------------------------------------------------------
function updatePlanningModeToggleUI() {
  const btn = document.getElementById('btnTogglePlanningMode');
  if (!btn) return;

  if (isDraftPlanningMode) {
    btn.innerHTML = '🛠️ Draft Mode (Notifications Paused)';
    btn.className = 'btn btn-sm manager-admin-only';
    btn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
    btn.style.borderColor = '#f59e0b';
    btn.style.color = '#ffffff';
    btn.style.boxShadow = '0 4px 12px rgba(245, 158, 11, 0.35)';
  } else {
    btn.innerHTML = '⚡ Live Mode (Push Notifications ON)';
    btn.className = 'btn btn-sm manager-admin-only';
    btn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
    btn.style.borderColor = '#10b981';
    btn.style.color = '#ffffff';
    btn.style.boxShadow = '0 4px 12px rgba(16, 185, 129, 0.35)';
  }
}

async function handleTogglePlanningMode() {
  isDraftPlanningMode = !isDraftPlanningMode;
  localStorage.setItem('gvd_draft_planning_mode', isDraftPlanningMode ? 'true' : 'false');
  updatePlanningModeToggleUI();

  if (isDraftPlanningMode) {
    showGreenToast('🛠️ Draft Mode Active — Notifications Paused while logistically planning');
  } else {
    // Live mode activated! Push notifications for all pending/modified draft shifts
    const todayStr = new Date().toISOString().split('T')[0];
    const pendingShifts = allShifts.filter(s => s.draft_pending === true && s.shift_date >= todayStr);

    for (const shift of pendingShifts) {
      await triggerShiftNotification(shift, '📢 Works Schedule Updated', `Shift on ${shift.shift_date}: ${shift.task}`, true);
      shift.draft_pending = false;
      if (db) {
        try {
          await db.collection('shifts').doc(String(shift.id)).update({ draft_pending: false });
        } catch (e) {
          console.warn('Error clearing draft_pending in Firestore:', e);
        }
      }
    }

    saveLocalStorageData();
    renderActiveView();

    if (pendingShifts.length > 0) {
      showGreenToast(`✅ Live Mode Active — Notifications Sent for ${pendingShifts.length} Shift(s)!`);
    } else {
      showGreenToast('✅ Live Mode Active — Automatic Notifications ON!');
    }
  }
}

function updateHeaderBellUI() {
  const dot = document.getElementById('bellStatusDot');
  if (!dot) return;
  const isSubscribed = localStorage.getItem('gvd_push_subscribed') === 'true';
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';

  if (perm === 'granted' && isSubscribed) {
    dot.className = 'bell-dot active';
    dot.title = 'Push Notifications Active';
  } else if (perm === 'denied') {
    dot.className = 'bell-dot';
    dot.title = 'Push Permission Denied in Settings';
  } else {
    dot.className = 'bell-dot';
    dot.title = 'Tap to Enable Push Notifications';
  }
}

const VAPID_PUBLIC_KEY = 'BAxW9LYu7tAuFQvd30x8Gw1adQDV27hFKnf3DikRxr9SajdzXNUwKrzaMgZk32Qwta7YGr4qAVf7b6qAkShifPM';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function getOrCreateDeviceId() {
  let devId = localStorage.getItem('gvd_device_id');
  if (!devId) {
    devId = 'dev_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
    localStorage.setItem('gvd_device_id', devId);
  }
  return devId;
}

async function registerDevicePushSubscription(forceInteractive = false) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    updatePushDiagnosticsUI('Not Supported', 'Browser does not support WebPush', 'Failed');
    return null;
  }

  if (Notification.permission === 'denied') {
    updatePushDiagnosticsUI('Denied', 'Blocked in Settings', 'Failed');
    const guideEl = document.getElementById('iosRecoveryGuidePanel');
    if (guideEl && forceInteractive) guideEl.style.display = 'block';
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();

    // A subscription made with a different (old) VAPID key can never be delivered to: drop it and re-subscribe.
    if (sub && sub.options && sub.options.applicationServerKey) {
      const current = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      const existing = new Uint8Array(sub.options.applicationServerKey);
      const same = existing.length === current.length && existing.every((b, i) => b === current[i]);
      if (!same) {
        await sub.unsubscribe().catch(() => null);
        sub = null;
      }
    }

    if (!sub && (Notification.permission === 'granted' || forceInteractive)) {
      if (Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          updatePushDiagnosticsUI('Denied', 'Permission Denied', 'Failed');
          const guideEl = document.getElementById('iosRecoveryGuidePanel');
          if (guideEl) guideEl.style.display = 'block';
          return null;
        }
      }
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }

    if (sub && currentUser) {
      const devId = getOrCreateDeviceId();
      const subJson = sub.toJSON();
      const deviceDoc = {
        device_id: devId,
        user_id: String(currentUser.id),
        user_name: currentUser.full_name,
        endpoint: subJson.endpoint,
        keys: subJson.keys,
        user_agent: navigator.userAgent,
        updated_at: new Date().toISOString()
      };

      if (db) {
        // Prune old / duplicate subscription documents for this user endpoint
        const existingSubsSnap = await db.collection('users').doc(String(currentUser.id)).collection('subscriptions').get();
        for (const doc of existingSubsSnap.docs) {
          const d = doc.data();
          if (doc.id !== devId && (d.endpoint === subJson.endpoint || d.device_id === devId)) {
            await db.collection('users').doc(String(currentUser.id)).collection('subscriptions').doc(doc.id).delete().catch(console.warn);
          }
        }
        await db.collection('users').doc(String(currentUser.id)).collection('subscriptions').doc(devId).set(deviceDoc);
      }

      localStorage.setItem('gvd_push_subscribed', 'true');
      updateHeaderBellUI();
      updateCleanPushUI();
      if (forceInteractive) showGreenToast('🔔 Device push subscription registered successfully!');
      return sub;
    }
  } catch (err) {
    console.warn('Push subscription error:', err);
    updateCleanPushUI();
  }
  return null;
}

async function unsubscribeDevicePushSubscription() {
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
      }
    }
    if (db && currentUser) {
      const devId = getOrCreateDeviceId();
      await db.collection('users').doc(String(currentUser.id)).collection('subscriptions').doc(devId).delete().catch(console.warn);
    }
  } catch (e) {
    console.warn('Error unsubscribing:', e);
  }
  localStorage.removeItem('gvd_push_subscribed');
  updateHeaderBellUI();
  showGreenToast('🔕 Push Notifications Disabled');
}

function updateCleanPushUI() {
  const badgeEl = document.getElementById('cleanPushStatusBadge');
  const isSubscribed = localStorage.getItem('gvd_push_subscribed') === 'true';
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';

  if (badgeEl) {
    if (perm === 'granted' && isSubscribed) {
      badgeEl.innerHTML = '🟢 <span style="color: #10b981;">Push Notifications Active & Subscribed</span>';
    } else if (perm === 'denied') {
      badgeEl.innerHTML = '🔴 <span style="color: #ef4444;">Push Notifications Blocked in Settings</span>';
    } else {
      badgeEl.innerHTML = '🟡 <span style="color: #f59e0b;">Push Permission Pending</span>';
    }
  }

  const toggleBtn = document.getElementById('btnToggleCleanPush');
  if (toggleBtn) {
    toggleBtn.onclick = async () => {
      toggleBtn.disabled = true;
      toggleBtn.textContent = '⏳ Updating...';
      await registerDevicePushSubscription(true);
      updateCleanPushUI();
      toggleBtn.disabled = false;
      toggleBtn.textContent = '🔔 Enable / Re-sync Push Notifications';
    };
  }
}

function updatePushDiagnosticsUI(permStatus = null, devStatus = null, lastResult = null) {
  const permEl = document.getElementById('diagPermissionStatus');
  const devEl = document.getElementById('diagDeviceStatus');
  const resultEl = document.getElementById('diagLastTestResult');
  const guideEl = document.getElementById('iosRecoveryGuidePanel');

  if (permEl) {
    const perm = permStatus || (('Notification' in window) ? Notification.permission : 'not_supported');
    if (perm === 'granted') {
      permEl.innerHTML = '✅ <span style="color:#10b981;">Granted (Push Active)</span>';
      if (guideEl) guideEl.style.display = 'none';
    } else if (perm === 'denied') {
      permEl.innerHTML = '❌ <span style="color:#ef4444;">Denied (Blocked in Settings)</span>';
      if (guideEl) guideEl.style.display = 'block';
    } else {
      permEl.innerHTML = '⚠️ <span style="color:#f59e0b;">Not Requested (Tap 🔔 or Re-register to prompt)</span>';
      if (guideEl) guideEl.style.display = 'none';
    }
  }

  if (devEl) {
    const isSubscribed = localStorage.getItem('gvd_push_subscribed') === 'true';
    if (devStatus) {
      devEl.textContent = devStatus;
    } else if (isSubscribed) {
      devEl.innerHTML = '✅ <span style="color:#10b981;">Device Registered in Firestore</span>';
    } else {
      devEl.innerHTML = '⚠️ <span style="color:#64748b;">Not Registered</span>';
    }
  }

  if (resultEl && lastResult) {
    resultEl.textContent = lastResult;
  }
}

async function sendTestPushNotification() {
  if (!currentUser) return;
  const resultEl = document.getElementById('diagLastTestResult');
  if (resultEl) resultEl.textContent = '⏳ Backend 10s Timer Active... Lock phone screen now!';

  showGreenToast('⏳ 10-Second Push Timer Started! Lock your phone screen now.');

  const logId = 'log_' + Date.now();
  const eventId = 'evt_' + Math.random().toString(36).substring(2, 8);

  const logDoc = {
    id: logId,
    event_id: eventId,
    event_type: 'TEST_PUSH',
    target_user_id: String(currentUser.id),
    target_user_name: currentUser.full_name,
    title: '🔔 GVD LIVE Test Notification',
    body: 'Genuine server push delivered! (10s backend timer)',
    status: 'queued',
    attempts: 1,
    provider_response: 'Queued on backend timer',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (db) {
    await db.collection('notification_logs').doc(logId).set(logDoc).catch(console.warn);
  }

  setTimeout(async () => {
    const result = await dispatchServerPush({
      logId: logId,
      targetUserId: String(currentUser.id),
      title: '🔔 GVD LIVE Test Notification',
      body: 'Server push delivered to your device! (10s backend timer test)',
      url: '/'
    });

    if (resultEl) {
      resultEl.innerHTML = result.success ? `✅ Accepted by Push Service (${result.acceptedCount} device(s))` : `❌ Delivery Failed: ${result.error}`;
    }
  }, 10000);
}

async function dispatchServerPush({ logId = null, targetUserId, title, body, shiftId = null, siteId = null, url = '/', queueViaFirestore = true }) {
  if (!db) return { success: false, error: 'Firestore not loaded' };

  const correlationId = 'corr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const targetOp = allUsers.find(u => String(u.id) === String(targetUserId));
  const targetName = targetOp ? targetOp.full_name : 'User #' + targetUserId;

  try {
    const subsSnap = await db.collection('users').doc(String(targetUserId)).collection('subscriptions').get();
    const subs = subsSnap.docs.map(doc => doc.data());

    if (subs.length === 0) {
      if (logId) {
        await db.collection('notification_logs').doc(logId).set({
          id: logId,
          correlation_id: correlationId,
          target_user_id: String(targetUserId),
          target_user_name: targetName,
          title: title,
          body: body,
          status: 'failed',
          provider_response: 'No registered device subscriptions found for target user',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }).catch(console.warn);
      }
      renderAdminPushLogs();
      return { success: false, error: 'No device subscriptions found for target user' };
    }

    let apiSuccess = false;
    let providerRespText = '';
    let acceptedCount = 0;

    // 1. Attempt backend push endpoint (if running Node server API)
    try {
      const resp = await fetch('/api/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUserId: String(targetUserId),
          title: title,
          body: body,
          shiftId: shiftId,
          siteId: siteId,
          correlationId: correlationId,
          subscriptions: subs
        })
      });

      if (resp.ok) {
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await resp.json();
          apiSuccess = data.success;
          acceptedCount = data.acceptedCount || subs.length;
          providerRespText = data.providerResponse || 'Accepted by Push Service (201 Created)';
        }
      }
    } catch (apiErr) {
      console.warn('Backend /api/push/send fetch error:', apiErr);
    }

    // 2. No Node backend (e.g. Firebase Hosting rewrites /api/* to index.html): hand off to the
    // Firestore `notifications` trigger (Cloud Function / push_worker.js), which does the real
    // encrypted Web Push. Browsers cannot push directly (CORS + payload encryption + private key).
    let queued = false;
    if (!apiSuccess) {
      if (queueViaFirestore) {
        await db.collection('notifications').add({
          target_user_id: String(targetUserId),
          title,
          body,
          site_id: siteId,
          shift_id: shiftId,
          created_at: new Date().toISOString()
        });
      }
      queued = true;
      acceptedCount = subs.length;
      providerRespText = 'Queued for server push via Firestore trigger (delivery not yet confirmed)';
    }

    if (logId) {
      await db.collection('notification_logs').doc(logId).set({
        id: logId,
        correlation_id: correlationId,
        target_user_id: String(targetUserId),
        target_user_name: targetName,
        title: title,
        body: body,
        status: apiSuccess ? 'accepted by push service' : (queued ? 'queued' : 'failed'),
        provider_response: providerRespText || (apiSuccess ? 'Accepted by Push Service (201 Created)' : 'Push Endpoint Failed'),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).catch(console.warn);
    }

    updateCleanPushUI();
    return { success: apiSuccess || queued, queued, acceptedCount, error: (apiSuccess || queued) ? null : providerRespText };
  } catch (e) {
    console.error('Error dispatching server push:', e);
    return { success: false, error: e.message };
  }
}

async function renderAdminPushLogs() {
  const tableBody = document.getElementById('adminPushLogTableBody');
  if (!tableBody || !db) return;

  try {
    const snap = await db.collection('notification_logs').get();
    const logs = snap.docs.map(d => d.data());
    logs.sort((a, b) => b.created_at.localeCompare(a.created_at));

    if (logs.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">No push logs recorded yet. Click 'Send Test Notification' above to run diagnostics.</td></tr>`;
      return;
    }

    tableBody.innerHTML = logs.slice(0, 15).map(l => {
      const statusColor = l.status === 'accepted by push service' ? '#10b981' : (l.status === 'queued' ? '#f59e0b' : '#ef4444');
      const timeStr = formatUKDateTime(l.created_at);
      return `
        <tr>
          <td style="font-size: 0.85rem; font-weight: 600; white-space: nowrap;">${timeStr}</td>
          <td style="font-weight: 600;">👤 ${l.target_user_name || 'User #' + l.target_user_id}</td>
          <td><strong style="color: #0284c7;">${l.title}</strong></td>
          <td><span style="background: ${statusColor}22; color: ${statusColor}; padding: 2px 8px; border-radius: 9999px; font-weight: 700; font-size: 0.8rem; text-transform: uppercase;">${l.status}</span></td>
          <td style="font-size: 0.85rem; color: var(--text-muted);">${l.provider_response || '—'}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.warn('Error loading push logs:', e);
  }
}

async function toggleHeaderNotificationBell() {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;

  if (isIos && !isStandalone) {
    alert('To receive push notifications on iPhone, tap the Safari Share button (box with arrow), select "Add to Home Screen", then open GVD LIVE from your home screen.');
    return;
  }

  if (!('Notification' in window)) {
    alert('This browser does not support push notifications.');
    return;
  }

  if (Notification.permission === 'denied') {
    alert('Push notifications are blocked in your browser or phone settings. Please allow notifications in Settings for GVD LIVE.');
    updateHeaderBellUI();
    return;
  }

  const isSubscribed = localStorage.getItem('gvd_push_subscribed') === 'true';
  if (isSubscribed) {
    await unsubscribeDevicePushSubscription();
  } else {
    const sub = await registerDevicePushSubscription(true);
    if (sub) {
      showGreenToast('🔔 Push Notifications Enabled & Active');
    }
  }
}

async function triggerShiftNotification(shift, title, body = null, forcePublish = false) {
  if (!shift || !shift.operative_id) return;

  if (isDraftPlanningMode && !forcePublish) {
    shift.draft_pending = true;
    if (db) {
      db.collection('shifts').doc(String(shift.id)).update({ draft_pending: true }).catch(console.warn);
    }
    console.log(`[DRAFT MODE] Shift #${shift.id} marked as draft_pending. Notification suppressed.`);
    return;
  }
  const op = allUsers.find(u => String(u.id) === String(shift.operative_id));
  const site = allSites.find(s => parseInt(s.id) === parseInt(shift.site_id));
  const opName = op ? op.full_name : 'Operative';
  const siteAddress = site ? site.address : formatSiteId(shift.site_id);
  const ukDate = formatUKDate(shift.shift_date);
  const periodStr = shift.shift_period === 'am' ? '🌅 AM' : (shift.shift_period === 'pm' ? '🌙 PM' : '☀️ All Day');

  const messageBody = body || `${opName}: ${shift.task} at ${siteAddress} (${ukDate} - ${periodStr})`;
  const logId = 'log_' + Date.now();

  // 1. Post real-time cloud notification payload to Firestore for targeted operative
  if (db) {
    try {
      await db.collection('notifications').add({
        target_user_id: String(shift.operative_id),
        title: title,
        body: messageBody,
        site_id: shift.site_id,
        shift_id: shift.id,
        created_at: new Date().toISOString()
      });

      await db.collection('notification_logs').doc(logId).set({
        id: logId,
        event_id: 'shift_evt_' + shift.id,
        shift_id: shift.id,
        target_user_id: String(shift.operative_id),
        target_user_name: opName,
        title: title,
        body: messageBody,
        status: 'queued',
        attempts: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    } catch (e) {
      console.warn('Error pushing notification payload to Firestore:', e);
    }
  }

  // 2. Dispatch genuine server push to target operative's registered devices
  await dispatchServerPush({
    logId: logId,
    targetUserId: String(shift.operative_id),
    title: title,
    body: messageBody,
    shiftId: shift.id,
    siteId: shift.site_id,
    url: '/',
    queueViaFirestore: false
  });

  shift.last_notified_at = new Date().toISOString();
  shift.draft_pending = false;
  if (db) {
    db.collection('shifts').doc(String(shift.id)).update({
      last_notified_at: shift.last_notified_at,
      draft_pending: false
    }).catch(console.warn);
  }
}

// -------------------------------------------------------------------
// SITE FINISH DATE + PLANNER ORDERING
// Finish = the last Fixtures & Fittings shift, or the Decoration shift that falls the day after
// a Fixtures & Fittings shift. Sites with no such ending shift have no finish date.
// -------------------------------------------------------------------
// Typo-tolerant: "Fictures and Fittings", "fixtures/fitting", "F&F" and "Decorating" all count
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

function hasWordLike(text, targets, maxDist) {
  return String(text || '').toLowerCase().split(/[^a-z]+/).some(w => w.length >= 4 && targets.some(t => editDistance(w, t) <= maxDist));
}

function isFixturesShift(task) {
  const t = String(task || '');
  return /\bf\s*(&|and|\/|\+)\s*f\b/i.test(t) || (hasWordLike(t, ['fixtures', 'fixture'], 2) && hasWordLike(t, ['fittings', 'fitting'], 2));
}

function isDecorationShift(task) {
  return hasWordLike(task, ['decoration', 'decorating', 'decorate', 'decorations'], 2);
}

function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return diaryDateKey(new Date(y, m - 1, d + n));
}

function getSiteFinish(siteId) {
  const shifts = allShifts.filter(sh => parseInt(sh.site_id) === parseInt(siteId));
  const fixtures = shifts.filter(sh => sh.is_finish || isFixturesShift(sh.task)).map(sh => sh.shift_date).filter(Boolean);
  if (fixtures.length === 0) return null;
  const decorations = new Set(shifts.filter(sh => isDecorationShift(sh.task)).map(sh => sh.shift_date));
  const candidates = [...fixtures];
  fixtures.forEach(f => { const next = addDaysISO(f, 1); if (decorations.has(next)) candidates.push(next); });
  const date = candidates.sort().pop();
  return { date, completed: date < diaryDateKey(new Date()) };
}

// Sites finishing soonest first, then sites with no finish date yet, then completed sites last
function getPlannerSites() {
  const sites = allSites.filter(site => !site.is_archived);
  const info = new Map(sites.map(site => [site.id, getSiteFinish(site.id)]));
  const rank = site => { const f = info.get(site.id); return !f ? 1 : f.completed ? 2 : 0; };
  return sites
    .map((site, i) => ({ site, i, f: info.get(site.id), r: rank(site) }))
    .sort((a, b) => a.r - b.r || (a.r === 0 || a.r === 2 ? a.f.date.localeCompare(b.f.date) : 0) || a.i - b.i)
    .map(x => x.site);
}

// -------------------------------------------------------------------
// DESKTOP & PHONE PLANNER VIEWS
// -------------------------------------------------------------------
function getAssignableOperatives() {
  const includeManagement = appSettings.include_management_in_planning === true;
  const activeUsers = allUsers.filter(u => u.status === 'Active');
  if (includeManagement) {
    return activeUsers;
  }
  return activeUsers.filter(u => u.role === 'Operative');
}

function renderPlannerView() {
  if (isTypingIn('plannerTableBody')) { uiRefreshPending = true; return; }
  const weekDays = getRollingDays(currentPlannerWeekOffset);
  const startDateStr = formatDateShort(weekDays[0]);
  const endDateStr = formatDateShort(weekDays[6]);
  document.getElementById('plannerWeekRangeLabel').textContent = `${startDateStr} — ${endDateStr}`;

  const dock = document.getElementById('activeOperativesDock');
  const activeStaff = getAssignableOperatives();

  dock.innerHTML = `<div class="op-chip drying-chip" draggable="true" data-drying="1" style="border-left: 6px solid #f59e0b;">⏳ Drying Day</div>` + activeStaff.map(op => `
    <div class="op-chip" draggable="true" data-op-id="${op.id}" data-op-name="${op.full_name}" style="border-left: 6px solid ${userColor(op)};">
      👤 ${op.full_name}${op.role && op.role !== 'Operative' ? ` (${op.role})` : ''}
    </div>
  `).join('');

  dock.querySelectorAll('.op-chip').forEach(chip => {
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('type', chip.dataset.drying ? 'NEW_DRYING_DAY' : 'NEW_OPERATIVE');
      e.dataTransfer.setData('opId', chip.dataset.opId || '');
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
  });

  const todayISO = formatDateISO(new Date());

  // Weekend days stay thin unless someone is working that day
  const activeSiteIds = new Set(allSites.filter(site => !site.is_archived).map(site => parseInt(site.id)));
  const isNarrowWeekendDay = (d) => isWeekendDay(d) &&
    !allShifts.some(sh => sh.shift_date === formatDateISO(d) && activeSiteIds.has(parseInt(sh.site_id)));

  const headerRow = document.getElementById('plannerTableHeaderRow');
  headerRow.innerHTML = `
    <th class="site-col">Site / Property</th>
    ${weekDays.map(d => {
      const dStr = formatDateISO(d);
      const isToday = dStr === todayISO;
      const narrow = isNarrowWeekendDay(d);
      const label = narrow ? `${d.toLocaleDateString('en-GB', { weekday: 'short' })}<br>${formatUKDate(d).slice(0, 5)}` : formatDateShort(d);
      return `<th class="date-col ${isWeekendDay(d) ? 'weekend-col-header' : ''} ${narrow ? 'weekend-narrow' : ''} ${isToday ? 'today-col-header' : ''}">${label}</th>`;
    }).join('')}
  `;

  const tbody = document.getElementById('plannerTableBody');
  const activeSites = getPlannerSites();
  if (activeSites.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 30px;">No active sites available. Go to Sites & Projects to create a site.</td></tr>`;
    return;
  }

  updatePlanningModeToggleUI();

  tbody.innerHTML = activeSites.map(site => {
    const cellsHtml = weekDays.map(day => {
      const dateStr = formatDateISO(day);
      const isToday = dateStr === todayISO;
      const dayShifts = allShifts.filter(s => parseInt(s.site_id) === parseInt(site.id) && s.shift_date === dateStr);

      const cardsHtml = dayShifts.map(s => {
        const op = allUsers.find(u => String(u.id) === String(s.operative_id));
        const opName = op ? op.full_name : 'Operative';
        const seenText = s.seen_at ? `Seen — ${formatUKDateTime(s.seen_at)}` : 'Not seen';

        const periodBadge = formatShiftPeriodBadge(s.shift_period);
        if (s.is_drying_day) return dryingCardHtml(s);
        return `
          <div class="shift-card" draggable="true" data-shift-id="${s.id}" style="border-left-color: ${userColor(s.operative_id)}; background-color: ${userColor(s.operative_id)}30;">
            <div class="shift-op-name" style="display:flex; justify-content:space-between; align-items:center;">
              <span>👤 ${opName}</span>
              ${periodBadge}
            </div>
            <div class="shift-task-desc">${s.task}</div>
            <div class="shift-seen-status ${s.seen_at ? 'seen' : 'not-seen'}">${seenText}</div>
            <div class="shift-card-actions no-print">
              <button class="btn btn-outline btn-sm edit-shift-btn" data-shift-id="${s.id}" style="padding: 2px 6px; font-size: 0.7rem;">Edit</button>
            </div>
          </div>
        `;
      }).join('');

      return `
        <td class="planner-day-cell ${isWeekendDay(day) ? 'weekend-day-cell' : ''} ${isNarrowWeekendDay(day) ? 'weekend-narrow' : ''} ${isToday ? 'today-day-cell' : ''}" data-site-id="${site.id}" data-date="${dateStr}">
          ${cardsHtml}
        </td>
      `;
    }).join('');

    const finish = getSiteFinish(site.id);
    const finishHtml = finish
      ? (finish.completed
        ? `<div class="site-completed-badge">✅ COMPLETED - finished ${formatShortUKDayDate(finish.date)}</div>${isOwnerOrAdminUser(currentUser) ? `<button type="button" class="btn btn-outline btn-sm archive-site-btn" data-site-id="${site.id}" style="margin-top: 4px;">📦 Archive site</button>` : ''}`
        : `<div class="site-finish-badge">🏁 Finishes ${formatShortUKDayDate(finish.date)}</div>`)
      : '';
    return `
      <tr class="${finish && finish.completed ? 'site-completed' : ''}">
        <td class="site-cell-header">
          <span class="site-badge">${formatSiteId(site.id)}</span>
          <strong>${site.address}</strong>
          ${finishHtml}
          ${siteTypeBadgeHtml(site)}
          ${siteInfoEditorHtml(site)}
        </td>
        ${cellsHtml}
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.archive-site-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Archive this completed site? It will move to the archive list.')) handleArchiveSite(parseInt(btn.dataset.siteId));
    });
  });

  tbody.querySelectorAll('.site-info-input').forEach(input => {
    const save = () => saveSiteInfo(input.dataset.siteId, input.dataset.field, input.value.trim());
    input.addEventListener('change', save);
    // Also save a moment after typing stops, so nothing is lost if the page refreshes
    input.addEventListener('input', () => { clearTimeout(input._saveTimer); input._saveTimer = setTimeout(save, 800); });
  });

  setupPlannerTableDragAndDrop();
  setupPlannerClickHandlers();
  renderMobilePlannerView(weekDays);
}

function setupPlannerTableDragAndDrop() {
  document.querySelectorAll('.shift-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('type', 'EXISTING_SHIFT');
      e.dataTransfer.setData('shiftId', card.dataset.shiftId);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  document.querySelectorAll('.planner-day-cell').forEach(cell => {
    cell.addEventListener('dragover', (e) => {
      e.preventDefault();
      cell.classList.add('drag-over');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
    cell.addEventListener('drop', async (e) => {
      e.preventDefault();
      cell.classList.remove('drag-over');

      const targetSiteId = parseInt(cell.dataset.siteId);
      const targetDate = cell.dataset.date;
      const type = e.dataTransfer.getData('type');

      if (type === 'NEW_DRYING_DAY') {
        await createDryingDay(targetSiteId, targetDate);
      } else if (type === 'NEW_OPERATIVE') {
        const opId = e.dataTransfer.getData('opId');
        openCreateShiftModal(targetSiteId, opId, targetDate);
      } else if (type === 'EXISTING_SHIFT') {
        const shiftId = parseInt(e.dataTransfer.getData('shiftId'));
        const shift = allShifts.find(s => parseInt(s.id) === shiftId);
        if (shift && !(parseInt(shift.site_id) === targetSiteId && shift.shift_date === targetDate)) {
          openShiftDropChoice(shift, targetSiteId, targetDate);
        }
      }
    });
  });
}

let pendingShiftDrop = null;

function openShiftDropChoice(shift, siteId, date) {
  pendingShiftDrop = { shiftId: shift.id, siteId, date };
  const fromSite = allSites.find(x => parseInt(x.id) === parseInt(shift.site_id));
  const toSite = allSites.find(x => parseInt(x.id) === parseInt(siteId));
  const op = allUsers.find(u => String(u.id) === String(shift.operative_id));
  const who = shift.is_drying_day ? '⏳ Drying Day' : (op ? op.full_name : 'Operative');
  document.getElementById('shiftDropSummary').innerHTML =
    `<strong>${diaryEsc(who)}</strong>${shift.task && !shift.is_drying_day ? ' - ' + diaryEsc(shift.task) : ''}<br>` +
    `From: ${diaryEsc(fromSite ? fromSite.address : 'site')}, ${diaryEsc(formatUKDate(shift.shift_date))}<br>` +
    `To: <strong>${diaryEsc(toSite ? toSite.address : 'site')}, ${diaryEsc(formatUKDate(date))}</strong>` +
    (parseInt(shift.site_id) !== parseInt(siteId) ? '<br><span style="color: var(--text-muted);">It takes on the new site.</span>' : '');
  openModal('modalShiftDrop');
}

async function applyShiftDrop(mode) {
  const drop = pendingShiftDrop;
  pendingShiftDrop = null;
  closeModal('modalShiftDrop');
  if (!drop) return;
  const shift = allShifts.find(s => parseInt(s.id) === parseInt(drop.shiftId));
  if (!shift) return;
  const todayStr = diaryDateKey(new Date());
  let target = shift;

  if (mode === 'copy') {
    const newId = allShifts.length > 0 ? Math.max(...allShifts.map(s => parseInt(s.id) || 0)) + 1 : 1;
    target = { ...shift, id: newId, site_id: drop.siteId, shift_date: drop.date, seen_at: null, last_notified_at: null,
      draft_pending: isDraftPlanningMode, created_at: new Date().toISOString() };
    allShifts.push(target);
  } else {
    shift.site_id = drop.siteId;
    shift.shift_date = drop.date;
    shift.seen_at = null; // Reset seen status
    shift.draft_pending = isDraftPlanningMode;
  }

  if (db) await db.collection('shifts').doc(String(target.id)).set(target);
  deduplicateShifts();
  saveLocalStorageData();
  renderActiveView();

  const verb = mode === 'copy' ? 'Duplicated' : 'Moved';
  if (drop.date >= todayStr && target.operative_id) {
    if (isDraftPlanningMode) {
      showGreenToast(`🛠️ Shift ${verb} (Draft Mode - Notifications Paused)`);
    } else {
      triggerShiftNotification(target, mode === 'copy' ? '⚡ Live Shift Assigned' : `📅 Shift Date Changed to ${drop.date}`);
      showGreenToast(`⚡ Shift ${verb} - Operative Notified!`);
    }
  } else {
    showGreenToast(target.is_drying_day ? `⏳ Drying Day ${verb}` : `Shift ${verb}`);
  }
}

function dryingCardHtml(s) {
  return `<div class="shift-card drying-card" draggable="true" data-shift-id="${s.id}">
    <div class="shift-op-name">⏳ Drying Day</div>
    <div class="shift-card-actions no-print">
      <button class="btn btn-outline btn-sm remove-drying-btn" data-shift-id="${s.id}" style="padding: 2px 6px; font-size: 0.7rem;">Remove</button>
    </div>
  </div>`;
}

async function createDryingDay(siteId, dateStr) {
  const id = allShifts.length > 0 ? Math.max(...allShifts.map(x => parseInt(x.id) || 0)) + 1 : 1;
  const shift = {
    id, site_id: siteId, operative_id: null, shift_date: dateStr,
    task: '⏳ Drying Day', shift_period: 'all_day', is_drying_day: true,
    seen_at: null, draft_pending: false, created_at: new Date().toISOString()
  };
  if (db) await db.collection('shifts').doc(String(id)).set(shift).catch(err => alert('Could not save: ' + err.message));
  allShifts.push(shift);
  deduplicateShifts();
  saveLocalStorageData();
  renderActiveView();
  showGreenToast('⏳ Drying Day added');
}

async function removeDryingDay(shiftId) {
  if (!confirm('Remove this drying day?')) return;
  if (db) await db.collection('shifts').doc(String(shiftId)).delete().catch(console.warn);
  allShifts = allShifts.filter(x => parseInt(x.id) !== parseInt(shiftId));
  saveLocalStorageData();
  renderActiveView();
}

function setupPlannerClickHandlers() {
  document.querySelectorAll('.remove-drying-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeDryingDay(btn.dataset.shiftId);
    });
  });

  document.querySelectorAll('.edit-shift-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditShiftModal(parseInt(btn.dataset.shiftId));
    });
  });
}

function renderMobilePlannerView(weekDays) {
  const selector = document.getElementById('mobileDaySelector');
  selector.innerHTML = weekDays.map((d, index) => `
    <button class="mobile-day-btn ${isWeekendDay(d) ? 'weekend' : ''} ${index === selectedMobileDayIndex ? 'active' : ''}" data-day-index="${index}">
      ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}
    </button>
  `).join('');

  selector.querySelectorAll('.mobile-day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedMobileDayIndex = parseInt(btn.dataset.dayIndex);
      renderMobilePlannerView(weekDays);
    });
  });

  const selectedDay = weekDays[selectedMobileDayIndex];
  const dateStr = formatDateISO(selectedDay);
  const container = document.getElementById('mobilePlannerContainer');
  const dayShifts = allShifts.filter(s => s.shift_date === dateStr);

  const activeSites = getPlannerSites();
  let html = `<h3 style="margin-bottom: 16px;">Schedule for ${formatDateShort(selectedDay)}</h3>`;

  if (activeSites.length === 0) {
    html += `<p style="color: var(--text-muted);">No active sites found.</p>`;
  } else {
    html += activeSites.map(site => {
      const siteShifts = dayShifts.filter(s => parseInt(s.site_id) === parseInt(site.id));

      return `
        <div class="site-card" style="margin-bottom: 16px;">
          <div class="site-card-header">
            <div>
              <span class="site-badge">${formatSiteId(site.id)}</span>
              <strong style="display: block; margin-top: 4px;">${site.address}</strong>
              ${(() => { const f = getSiteFinish(site.id); return f ? `<div class="${f.completed ? 'site-completed-badge' : 'site-finish-badge'}">${f.completed ? '✅ COMPLETED' : '🏁 Finishes'} ${formatShortUKDayDate(f.date)}</div>` : ''; })()}
            </div>
            <div>
              <button class="btn btn-primary btn-sm mobile-add-shift-btn" data-site-id="${site.id}" data-date="${dateStr}">+ Shift</button>
            </div>
          </div>
          <div>
            ${siteShifts.length === 0 ? `<p style="font-size: 0.85rem; color: var(--text-muted);">No operatives assigned on this day.</p>` : ''}
            ${siteShifts.map(s => {
              const op = allUsers.find(u => String(u.id) === String(s.operative_id));
              const seenText = s.seen_at ? `Seen — ${formatUKDateTime(s.seen_at)}` : 'Not seen';
              const periodBadge = formatShiftPeriodBadge(s.shift_period);
              if (s.is_drying_day) return dryingCardHtml(s);
              return `
                <div class="shift-card" style="margin-top: 8px; border-left-color: ${userColor(s.operative_id)}; background-color: ${userColor(s.operative_id)}30;">
                  <div class="shift-op-name" style="display:flex; justify-content:space-between; align-items:center;">
                    <span>👤 ${op ? op.full_name : 'Operative'}</span>
                    ${periodBadge}
                  </div>
                  <div class="shift-task-desc">${s.task}</div>
                  <div class="shift-seen-status ${s.seen_at ? 'seen' : 'not-seen'}">${seenText}</div>
                  <div style="margin-top: 8px; display: flex; gap: 8px;">
                    <button class="btn btn-outline btn-sm edit-shift-btn" data-shift-id="${s.id}">Edit / Move</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');
  }

  container.innerHTML = html;

  container.querySelectorAll('.mobile-add-shift-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openCreateShiftModal(parseInt(btn.dataset.siteId), null, btn.dataset.date);
    });
  });

  container.querySelectorAll('.edit-shift-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openEditShiftModal(parseInt(btn.dataset.shiftId));
    });
  });
}

function formatShiftPeriodBadge(period) {
  if (period === 'am') {
    return `<span class="badge-period am" style="background:#f59e0b; color:#ffffff; font-size:0.75rem; font-weight:700; padding:2px 6px; border-radius:4px; margin-left:4px;">🌅 AM</span>`;
  } else if (period === 'pm') {
    return `<span class="badge-period pm" style="background:#8b5cf6; color:#ffffff; font-size:0.75rem; font-weight:700; padding:2px 6px; border-radius:4px; margin-left:4px;">🌙 PM</span>`;
  }
  return `<span class="badge-period allday" style="background:#0284c7; color:#ffffff; font-size:0.75rem; font-weight:700; padding:2px 6px; border-radius:4px; margin-left:4px;">☀️ All Day</span>`;
}

// -------------------------------------------------------------------
// OPERATIVE "MY SHIFTS" VIEW & AUTOMATIC SEEN TIMESTAMP ON APP OPEN
// -------------------------------------------------------------------
let myShiftsTab = 'today'; // always starts on today's work

function renderMyShiftsView() {
  const container = document.getElementById('myShiftsContainer');
  if (!currentUser) return;
  const todayKey = diaryDateKey(new Date());
  const periodRank = { am: 0, all_day: 1, pm: 2 };
  const upcoming = allShifts
    .filter(s => String(s.operative_id) === String(currentUser.id) && (s.shift_date || '') >= todayKey)
    .sort((a, b) => (a.shift_date || '').localeCompare(b.shift_date || '') || (periodRank[a.shift_period] ?? 1) - (periodRank[b.shift_period] ?? 1));
  const myShifts = myShiftsTab === 'today' ? upcoming.filter(s => s.shift_date === todayKey) : upcoming;

  // Tabs + headings
  document.querySelectorAll('.my-shifts-tab').forEach(btn => {
    const active = btn.dataset.tab === myShiftsTab;
    btn.className = `btn ${active ? 'btn-primary' : 'btn-outline'} my-shifts-tab`;
    btn.onclick = () => { myShiftsTab = btn.dataset.tab; renderMyShiftsView(); };
  });
  document.getElementById('myShiftsTitle').textContent = myShiftsTab === 'today' ? "Today's Work" : 'All My Jobs';
  document.getElementById('myShiftsSubtitle').textContent = myShiftsTab === 'today'
    ? formatDateShort(new Date()) : `${upcoming.length} upcoming shift${upcoming.length === 1 ? '' : 's'} in date order`;

  // Automatically mark the shifts on screen as SEEN (not ones hidden on the other tab)
  const nowIso = new Date().toISOString();
  myShifts.forEach(async (s) => {
    if (!s.seen_at || (s.updated_at && s.seen_at < s.updated_at)) {
      s.seen_at = nowIso;
      if (db) {
        await db.collection('shifts').doc(String(s.id)).update({ seen_at: nowIso }).catch(console.warn);
      }
    }
  });
  saveLocalStorageData();

  if (myShifts.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);" class="site-card">
        <h3>${myShiftsTab === 'today' ? 'No work scheduled for today' : 'No Upcoming Shifts'}</h3>
        <p>${myShiftsTab === 'today' ? (upcoming.length ? `You have ${upcoming.length} upcoming shift${upcoming.length === 1 ? '' : 's'}. Tap All My Jobs to see them.` : 'You have no assigned shifts at this time.') : 'You have no assigned shifts at this time.'}</p>
      </div>
    `;
  } else {
    let lastDate = null;
    container.innerHTML = myShifts.map(s => {
      let heading = '';
      if (myShiftsTab === 'all' && s.shift_date !== lastDate) {
        lastDate = s.shift_date;
        const label = s.shift_date === todayKey ? 'Today' : s.shift_date === addDaysISO(todayKey, 1) ? 'Tomorrow' : '';
        heading = `<h3 style="grid-column: 1 / -1; margin: 8px 0 -4px;">${label ? label + ' - ' : ''}${formatShortUKDayDate(s.shift_date)}</h3>`;
      }
      const site = allSites.find(st => parseInt(st.id) === parseInt(s.site_id));
      const periodBadge = formatShiftPeriodBadge(s.shift_period);
      const isSeen = s.seen_at && s.updated_at && s.seen_at >= s.updated_at;
      return heading + `
        <div class="site-card shift-op-card" data-shift-id="${s.id}" data-site-id="${s.site_id}" style="cursor: pointer;">
          <div class="site-card-header">
            <div>
              <span class="site-badge">${formatSiteId(s.site_id)}</span>
              ${periodBadge}
            </div>
          </div>
          <h3 style="font-size: 1.1rem; font-weight: 700; margin-bottom: 6px;">${site ? site.address : 'Site Address'}</h3>
          <p style="color: var(--primary); font-weight: 600; font-size: 0.95rem; margin-bottom: 10px;">📅 ${formatUKDate(s.shift_date)}</p>
          ${siteInfoHtml(site)}
          <div style="background-color: var(--bg-primary); padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); margin-bottom: 10px;">
            <strong style="font-size: 0.8rem; color: var(--text-muted);">TASK:</strong>
            <p style="margin-top: 2px; font-size: 0.9rem;">${s.task}</p>
          </div>
          <button class="btn btn-primary btn-sm po-request-btn" data-site-id="${s.site_id}" style="width: 100%; margin-bottom: 8px;">🧾 Request PO number</button>
          <button class="btn btn-secondary btn-sm" style="width: 100%;">View Shift Details & Site Documents →</button>
        </div>
      `;
    }).join('');
  }

  const toggleBtn = document.getElementById('btnMyShiftsPushToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      toggleBtn.disabled = true;
      toggleBtn.textContent = '⏳ Registering Device...';
      await registerDevicePushSubscription(true);
      renderMyShiftsView();
    });
  }

  container.querySelectorAll('.po-request-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openPOModal(parseInt(btn.dataset.siteId));
    });
  });

  container.querySelectorAll('.shift-op-card').forEach(card => {
    card.addEventListener('click', () => {
      const shiftId = parseInt(card.dataset.shiftId);
      openShiftDetailModal(shiftId);
    });
  });
}

async function openShiftDetailModal(shiftId) {
  const shift = allShifts.find(s => parseInt(s.id) === shiftId);
  if (!shift) return;

  const site = allSites.find(st => parseInt(st.id) === parseInt(shift.site_id));

  document.getElementById('detailSiteId').textContent = formatSiteId(shift.site_id);
  document.getElementById('detailAddress').textContent = site ? site.address : 'Site Address';
  document.getElementById('detailDate').textContent = `Date: ${formatUKDate(shift.shift_date)}`;
  document.getElementById('detailTask').textContent = shift.task;
  document.getElementById('detailSiteInfo').innerHTML = siteInfoHtml(site);

  // Only set seen_at when the authenticated operative explicitly opens and views details
  const isOperativeOwner = currentUser && currentUser.role === 'Operative' && String(shift.operative_id) === String(currentUser.id);
  if (isOperativeOwner) {
    const nowIso = new Date().toISOString();
    shift.seen_at = nowIso;
    if (db) {
      await db.collection('shifts').doc(String(shift.id)).update({ seen_at: nowIso }).catch(console.warn);
    }
    saveLocalStorageData();
  }

  const seenBadge = document.getElementById('detailSeenBadge');
  if (seenBadge) {
    if (isManagementUser(currentUser)) {
      const isSeen = shift.seen_at && shift.updated_at && shift.seen_at >= shift.updated_at;
      const seenText = isSeen ? `Seen — ${formatUKDateTime(shift.seen_at)}` : 'Not seen';
      seenBadge.textContent = seenText;
      seenBadge.className = `shift-seen-status ${isSeen ? 'seen' : 'not-seen'}`;
      seenBadge.style.display = 'inline-block';
    } else {
      seenBadge.style.display = 'none';
    }
  }

  const btnPO = document.getElementById('btnRequestPOFromShift');
  if (btnPO) {
    btnPO.onclick = () => {
      closeModal('modalShiftDetail');
      openPOModal(parseInt(shift.site_id));
    };
  }

  const btnProjPage = document.getElementById('btnGoToProjectPage');
  if (btnProjPage) {
    btnProjPage.onclick = () => {
      closeModal('modalShiftDetail');
      showView('view-projects');
      loadProjectPage(parseInt(shift.site_id));
    };
  }

  openModal('modalShiftDetail');
}

// -------------------------------------------------------------------
// SITES LIST & PROJECT PAGE
// -------------------------------------------------------------------
function renderSitesList() {
  const container = document.getElementById('sitesListContainer');
  const projectPage = document.getElementById('projectPageContainer');

  if (activeSiteId) {
    container.style.display = 'none';
    projectPage.style.display = 'block';
    return;
  }

  container.style.display = 'grid';
  projectPage.style.display = 'none';

  // Toggle filter button styles
  const btnActive = document.getElementById('btnFilterActiveSites');
  const btnArchived = document.getElementById('btnFilterArchivedSites');
  if (btnActive && btnArchived) {
    if (siteFilterMode === 'active') {
      btnActive.className = 'btn btn-primary btn-sm';
      btnArchived.className = 'btn btn-outline btn-sm';
    } else {
      btnActive.className = 'btn btn-outline btn-sm';
      btnArchived.className = 'btn btn-primary btn-sm';
    }
  }

  // Filter sites by archived state
  let sitesToDisplay = allSites;
  if (siteFilterMode === 'archived') {
    sitesToDisplay = sitesToDisplay.filter(st => st.is_archived === true);
  } else {
    sitesToDisplay = sitesToDisplay.filter(st => !st.is_archived);
  }

  // Management roles see all filtered sites; operatives see assigned sites
  if (!isManagementUser(currentUser)) {
    const assignedSiteIds = allShifts.filter(s => String(s.operative_id) === String(currentUser.id)).map(s => parseInt(s.site_id));
    sitesToDisplay = sitesToDisplay.filter(st => assignedSiteIds.includes(parseInt(st.id)));
  }

  if (sitesToDisplay.length === 0) {
    const emptyTitle = siteFilterMode === 'archived' ? 'No Archived Sites' : 'No Sites Available';
    const emptyDesc = siteFilterMode === 'archived'
      ? 'No archived projects found in database.'
      : 'Create a site to start managing project tasks, photos and documents.';
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px;" class="site-card">
        <h3>${emptyTitle}</h3>
        <p style="color: var(--text-muted); margin-bottom: 16px;">${emptyDesc}</p>
      </div>
    `;
    return;
  }

  const isMgmt = isManagementUser(currentUser);

  container.innerHTML = sitesToDisplay.map(site => {
    const archiveBtn = site.is_archived
      ? `<button class="btn btn-secondary btn-sm restore-site-card-btn" data-site-id="${site.id}" style="flex: 1; justify-content: center; font-size: 0.85rem; padding: 8px 12px; display: inline-flex; align-items: center; gap: 6px;">↩️ Restore</button>`
      : `<button class="btn btn-warning btn-sm archive-site-card-btn" data-site-id="${site.id}" style="flex: 1; justify-content: center; font-size: 0.85rem; padding: 8px 12px; background-color: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.5); color: #fbbf24; display: inline-flex; align-items: center; gap: 6px;">📦 Archive</button>`;

    const deleteBtn = `<button class="btn btn-danger btn-sm delete-site-card-btn" data-site-id="${site.id}" style="flex: 1; justify-content: center; font-size: 0.85rem; padding: 8px 12px; display: inline-flex; align-items: center; gap: 6px;">🗑️ Delete</button>`;

    return `
      <div class="site-card" data-site-id="${site.id}">
        <div>
          <div class="site-card-header">
            <span class="site-badge">${formatSiteId(site.id)} ${site.is_archived ? '(Archived)' : ''}</span>
            ${siteTypeBadgeHtml(site)}
          </div>
          <h3 class="site-card-address">${site.address}</h3>
        </div>
        ${isMgmt ? `
          <div style="margin-top: 18px; display: flex; gap: 10px; width: 100%;" class="no-print">
            ${archiveBtn}
            ${deleteBtn}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.site-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.archive-site-card-btn') || e.target.closest('.restore-site-card-btn') || e.target.closest('.delete-site-card-btn')) {
        return;
      }
      activeSiteId = parseInt(card.dataset.siteId);
      loadProjectPage(activeSiteId);
    });
  });

  container.querySelectorAll('.archive-site-card-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleArchiveSite(parseInt(btn.dataset.siteId));
    });
  });

  container.querySelectorAll('.restore-site-card-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleRestoreSite(parseInt(btn.dataset.siteId));
    });
  });

  container.querySelectorAll('.delete-site-card-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteSite(parseInt(btn.dataset.siteId));
    });
  });
}

function loadProjectPage(siteId) {
  activeSiteId = siteId;
  const site = allSites.find(s => parseInt(s.id) === siteId);
  if (!site) return;

  document.getElementById('sitesListContainer').style.display = 'none';
  document.getElementById('projectPageContainer').style.display = 'block';

  document.getElementById('projSiteIdBadge').textContent = `${formatSiteId(site.id)}${site.is_archived ? ' (Archived)' : ''}`;
  document.getElementById('projSiteAddress').textContent = site.address;
  const projTypeBadge = document.getElementById('projSiteTypeBadge');
  const canEditType = isManagementUser(currentUser);
  projTypeBadge.textContent = site.construction_type || (canEditType ? '+ Set type' : '');
  projTypeBadge.className = `site-type-badge ${(site.construction_type || '').toLowerCase()}`;
  projTypeBadge.style.display = (site.construction_type || canEditType) ? '' : 'none';
  projTypeBadge.style.cursor = canEditType ? 'pointer' : '';
  projTypeBadge.title = canEditType ? 'Click to change: Concrete, Timber or none' : '';
  projTypeBadge.onclick = canEditType ? async () => {
    const order = ['', 'Concrete', 'Timber'];
    site.construction_type = order[(order.indexOf(site.construction_type || '') + 1) % order.length];
    if (db) await db.collection('sites').doc(String(site.id)).update({ construction_type: site.construction_type }).catch(console.warn);
    saveLocalStorageData();
    loadProjectPage(parseInt(site.id));
  } : null;

  const actionsContainer = document.getElementById('projectPageActions');
  if (actionsContainer) {
    if (isManagementUser(currentUser)) {
      const archiveRestoreHtml = site.is_archived
        ? `<button class="btn btn-secondary btn-sm" id="btnRestoreProject">↩️ Restore Project</button>`
        : `<button class="btn btn-warning btn-sm" id="btnArchiveProject" style="background-color: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.5); color: #fbbf24;">📦 Archive Project</button>`;

      actionsContainer.innerHTML = `${archiveRestoreHtml} <button class="btn btn-danger btn-sm" id="btnDeleteProject">🗑️ Delete Project</button>`;
      actionsContainer.style.display = 'flex';

      const arcBtn = document.getElementById('btnArchiveProject');
      if (arcBtn) arcBtn.onclick = () => handleArchiveSite(site.id);

      const resBtn = document.getElementById('btnRestoreProject');
      if (resBtn) resBtn.onclick = () => handleRestoreSite(site.id);

      const delBtn = document.getElementById('btnDeleteProject');
      if (delBtn) delBtn.onclick = () => handleDeleteSite(site.id);
    } else {
      actionsContainer.style.display = 'none';
    }
  }

  const infoHost = document.getElementById('projSiteAddress').parentElement;
  let infoEl = document.getElementById('projSiteInfo');
  if (!infoEl) {
    infoEl = document.createElement('div');
    infoEl.id = 'projSiteInfo';
    infoEl.style.marginTop = '12px';
    infoHost.appendChild(infoEl);
  }
  infoEl.innerHTML = siteInfoHtml(site);

  renderProjectTabContent(site);
  renderPlasterCalc(site);
  renderPOTab(site);
  renderSiteFinance(site);
}

async function handleArchiveSite(siteId) {
  const site = allSites.find(s => parseInt(s.id) === parseInt(siteId));
  if (!site) return;

  site.is_archived = true;
  if (db) {
    try {
      await db.collection('sites').doc(String(site.id)).update({ is_archived: true });
    } catch (e) {
      console.error('Error archiving site in Firestore:', e);
    }
  }
  saveLocalStorageData();
  showGreenToast(`📦 Site #${site.id} moved to database archive`);
  if (activeSiteId === siteId) {
    activeSiteId = null;
  }
  renderActiveView();
}

async function handleRestoreSite(siteId) {
  const site = allSites.find(s => parseInt(s.id) === parseInt(siteId));
  if (!site) return;

  site.is_archived = false;
  if (db) {
    try {
      await db.collection('sites').doc(String(site.id)).update({ is_archived: false });
    } catch (e) {
      console.error('Error restoring site in Firestore:', e);
    }
  }
  saveLocalStorageData();
  showGreenToast(`↩️ Site #${site.id} restored to active projects`);
  renderActiveView();
}

async function handleDeleteSite(siteId) {
  const site = allSites.find(s => parseInt(s.id) === parseInt(siteId));
  if (!site) return;

  if (!confirm(`Are you sure you want to PERMANENTLY DELETE Site #${site.id} (${site.address})?\n\nThis will remove the site and all its associated shifts, photos and documents from the database. This action cannot be undone.`)) {
    return;
  }

  if (db) {
    try {
      await db.collection('sites').doc(String(site.id)).delete();

      const relatedShifts = allShifts.filter(s => parseInt(s.site_id) === parseInt(site.id));
      for (const s of relatedShifts) {
        await db.collection('shifts').doc(String(s.id)).delete();
      }

      const relatedPhotos = allPhotos.filter(p => parseInt(p.site_id) === parseInt(site.id));
      for (const p of relatedPhotos) {
        await db.collection('photos').doc(String(p.id)).delete();
      }

      const relatedPdfs = allPdfs.filter(pdf => parseInt(pdf.site_id) === parseInt(site.id));
      for (const pdf of relatedPdfs) {
        await db.collection('pdfs').doc(String(pdf.id)).delete();
      }
    } catch (e) {
      console.error('Error deleting site and records from Firestore:', e);
    }
  }

  allSites = allSites.filter(s => parseInt(s.id) !== parseInt(siteId));
  allShifts = allShifts.filter(s => parseInt(s.site_id) !== parseInt(siteId));
  allPhotos = allPhotos.filter(p => parseInt(p.site_id) !== parseInt(siteId));
  allPdfs = allPdfs.filter(p => parseInt(p.site_id) !== parseInt(siteId));

  saveLocalStorageData();
  showGreenToast(`🗑️ Site #${siteId} permanently deleted`);
  if (activeSiteId === siteId) {
    activeSiteId = null;
  }
  renderActiveView();
}

function renderProjectTabContent(site) {
  // Tab 1: Shifts
  const siteShifts = allShifts.filter(s => parseInt(s.site_id) === parseInt(site.id));
  const plannerContainer = document.getElementById('sitePlannerShiftsList');
  if (siteShifts.length === 0) {
    plannerContainer.innerHTML = `<p style="color: var(--text-muted); grid-column: 1 / -1;">No shifts assigned for this site.</p>`;
  } else {
    plannerContainer.innerHTML = siteShifts.map(s => {
      const op = allUsers.find(u => String(u.id) === String(s.operative_id));
      if (s.is_drying_day) {
        return `<div class="site-card"><div class="site-card-header"><strong>⏳ Drying Day</strong></div><p style="color: var(--primary); font-weight: 600;">📅 ${formatUKDate(s.shift_date)}</p></div>`;
      }
      const seenText = s.seen_at ? `Seen — ${formatUKDateTime(s.seen_at)}` : 'Not seen';
      const seenBadgeHtml = isManagementUser(currentUser) ? `<span class="shift-seen-status ${s.seen_at ? 'seen' : 'not-seen'}">${seenText}</span>` : '';
      return `
        <div class="site-card">
          <div class="site-card-header">
            <strong>👤 ${op ? op.full_name : 'Operative'}</strong>
            ${seenBadgeHtml}
          </div>
          <p style="color: var(--primary); font-weight: 600; margin-bottom: 8px;">📅 ${formatUKDate(s.shift_date)}</p>
          <p style="font-size: 0.9rem;">${s.task}</p>
        </div>
      `;
    }).join('');
  }

  // Tab 2: Photos Gallery
  deduplicatePhotos();
  const sitePhotos = allPhotos.filter(p => String(p.site_id) === String(site.id));
  const gallery = document.getElementById('photoGalleryContainer');
  if (sitePhotos.length === 0) {
    gallery.innerHTML = `<p style="color: var(--text-muted); grid-column: 1 / -1;">No photos uploaded yet.</p>`;
  } else {
    gallery.innerHTML = sitePhotos.map(p => {
      const canDelete = isManagementUser(currentUser) || String(p.uploader_id) === String(currentUser.id);
      return `
        <div class="photo-card" data-photo-id="${p.id}" style="cursor: pointer;">
          <img src="${p.file_url || p.data_url}" class="photo-img" loading="lazy" alt="Project Photo" title="Click to enlarge & download">
          <div class="photo-meta">
            <div>
              <strong>${p.uploader_name || 'Operative'}</strong><br>
              <span style="font-size: 0.75rem;">${formatUKDate(p.created_at)}</span>
            </div>
            ${canDelete ? `<button class="btn btn-danger btn-sm delete-photo-btn" data-photo-id="${p.id}" style="padding: 2px 8px; font-size: 0.75rem;">Delete</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    gallery.querySelectorAll('.photo-card').forEach(card => {
      const photoId = String(card.dataset.photoId);
      const photo = allPhotos.find(p => String(p.id) === photoId);
      if (!photo) return;

      card.querySelector('.photo-img').addEventListener('click', (e) => {
        e.stopPropagation();
        openPhotoLightbox(photo);
      });

      const delBtn = card.querySelector('.delete-photo-btn');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm('Delete this photo permanently?')) {
            if (photo.storage_path && typeof firebase.storage === 'function') {
              await getStorageForBucket(photo.storage_bucket || STORAGE_BUCKETS[0]).ref(photo.storage_path).delete().catch(console.warn);
            }
            if (db) await db.collection('photos').doc(photoId).delete();
            allPhotos = allPhotos.filter(p => String(p.id) !== photoId);
            deduplicatePhotos();
            saveLocalStorageData();
            loadProjectPage(site.id);
          }
        });
      }
    });
  }

function openPhotoLightbox(photo) {
  if (!photo) return;

  const imgEl = document.getElementById('lightboxImg');
  const metaEl = document.getElementById('lightboxMeta');
  const dlBtn = document.getElementById('lightboxDownloadBtn');
  const delBtn = document.getElementById('lightboxDeleteBtn');

  imgEl.src = photo.file_url || photo.data_url;
  const filename = photo.original_name || photo.filename || `Site_Photo_${photo.id}.png`;
  
  dlBtn.onclick = (e) => {
    e.preventDefault();
    if (photo.storage_path) {
      const link = document.createElement('a');
      link.href = `/files/${encodeURIComponent(photo.id)}?dl=1`;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => link.remove(), 1000);
    } else {
      forceDownloadFile(filename, photo.data_url, 'image/png');
    }
  };

  metaEl.innerHTML = `Uploaded by <strong>${photo.uploader_name || 'Operative'}</strong> on ${formatUKDate(photo.created_at)}`;

  const canDelete = isManagementUser(currentUser) || String(photo.uploader_id) === String(currentUser.id);
  if (canDelete) {
    delBtn.style.display = 'inline-flex';
    delBtn.onclick = async () => {
      if (confirm('Delete this photo permanently?')) {
        closeModal('modalPhotoLightbox');
        if (photo.storage_path && typeof firebase.storage === 'function') {
          await getStorageForBucket(photo.storage_bucket || STORAGE_BUCKETS[0]).ref(photo.storage_path).delete().catch(console.warn);
        }
        if (db) await db.collection('photos').doc(String(photo.id)).delete();
        allPhotos = allPhotos.filter(p => String(p.id) !== String(photo.id));
        deduplicatePhotos();
        saveLocalStorageData();
        if (activeSiteId) loadProjectPage(activeSiteId);
      }
    };
  } else {
    delBtn.style.display = 'none';
  }

  openModal('modalPhotoLightbox');
}

  // Tab 3: PDF Files
  const sitePdfs = allPdfs.filter(pdf => String(pdf.site_id) === String(site.id));
  const pdfList = document.getElementById('pdfListContainer');
  if (sitePdfs.length === 0) {
    pdfList.innerHTML = `<p style="color: var(--text-muted);">No PDF documents uploaded yet.</p>`;
  } else {
    pdfList.innerHTML = sitePdfs.map(pdf => {
      const canDelete = isManagementUser(currentUser) || String(pdf.uploader_id) === String(currentUser.id);
      const isExcelFile = pdf.file_type === 'excel' || /\.(xlsx|xlsm|xls|csv)$/i.test(pdf.filename || '');
      return `
        <div class="pdf-item">
          <div class="pdf-info">
            <span class="pdf-icon">${isExcelFile ? '📊' : '📄'}</span>
            <div>
              <div class="pdf-name">${pdf.filename}</div>
              <div class="pdf-meta-details">Uploaded by ${pdf.uploader_name || 'Staff'} on ${formatUKDate(pdf.created_at)}${pdf.invoice_net != null && isManagementUser(currentUser) ? ` · Invoice ${diaryEsc(pdf.po_number || '')} ${diaryEsc(formatPounds(pdf.invoice_net))} ex VAT` : ''}</div>
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary btn-sm download-pdf-btn" data-pdf-id="${pdf.id}">${isExcelFile ? 'Download Excel' : 'View / Download PDF'}</button>
            ${canDelete ? `<button class="btn btn-danger btn-sm delete-pdf-btn" data-pdf-id="${pdf.id}">Delete</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    pdfList.querySelectorAll('.download-pdf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pdfId = String(btn.dataset.pdfId);
        const pdf = allPdfs.find(p => String(p.id) === pdfId);
        if (pdf && pdf.storage_path) {
          // Served from our own domain via the siteFile function so phones download it normally
          const link = document.createElement('a');
          link.href = `/files/${encodeURIComponent(pdf.id)}`;
          if (!/\.pdf$/i.test(pdf.filename || '')) link.download = pdf.filename || 'file';
          else link.target = '_blank';
          document.body.appendChild(link);
          link.click();
          setTimeout(() => link.remove(), 1000);
        } else if (pdf && pdf.file_url) {
          const win = window.open(pdf.file_url, '_blank');
          if (!win) window.location.href = pdf.file_url;
        } else if (pdf) {
          forceDownloadFile(pdf.filename, pdf.data_url, /\.pdf$/i.test(pdf.filename || '') ? 'application/pdf' : 'application/octet-stream');
        }
      });
    });

    pdfList.querySelectorAll('.delete-pdf-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Delete this file?')) {
          const pdfId = String(btn.dataset.pdfId);
          const doomed = allPdfs.find(p => String(p.id) === pdfId);
          if (doomed && doomed.storage_path && typeof firebase.storage === 'function') {
            await getStorageForBucket(doomed.storage_bucket || STORAGE_BUCKETS[0]).ref(doomed.storage_path).delete().catch(console.warn);
          }
          if (db) await db.collection('pdfs').doc(pdfId).delete();
          allPdfs = allPdfs.filter(pdf => String(pdf.id) !== pdfId);
          saveLocalStorageData();
          loadProjectPage(site.id);
        }
      });
    });
  }

  // Tab 4: Customer Tab (Management roles)
  if (isManagementUser(currentUser)) {
    // Ensure site has a customer_token
    if (!site.customer_token) {
      site.customer_token = 'token_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      if (db) db.collection('sites').doc(String(site.id)).update({ customer_token: site.customer_token });
      saveLocalStorageData();
    }

    const activeAdmins = allUsers.filter(u => isManagementUser(u) && (!u.status || u.status.toLowerCase() === 'active'));
    let contactIds = [];
    if (Array.isArray(site.customer_contacts)) {
      contactIds = site.customer_contacts.map(String);
    } else if (Array.isArray(appSettings.default_customer_contacts)) {
      contactIds = appSettings.default_customer_contacts.map(String);
    } else {
      contactIds = activeAdmins.map(a => String(a.id));
    }

    const checklist = document.getElementById('adminContactsChecklist');
    if (checklist) {
      checklist.innerHTML = activeAdmins.map(admin => {
        const title = admin.job_title || (admin.email === 'phil@gvdcontracts.com' ? 'Managing Director' : admin.role);
        return `
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 0.9rem;">
            <input type="checkbox" class="admin-contact-chk" value="${admin.id}" ${contactIds.map(String).includes(String(admin.id)) ? 'checked' : ''}>
            <strong>${admin.full_name}</strong> (${title}) — ${admin.phone || admin.email}
          </label>
        `;
      }).join('');

      checklist.querySelectorAll('.admin-contact-chk').forEach(chk => {
        chk.addEventListener('change', async () => {
          const selectedIds = Array.from(checklist.querySelectorAll('.admin-contact-chk:checked')).map(c => c.value);
          site.customer_contacts = selectedIds;
          if (db) await db.collection('sites').doc(String(site.id)).update({ customer_contacts: selectedIds });
          saveLocalStorageData();
          loadProjectPage(site.id);
        });
      });
    }

    const printBadge = document.getElementById('printSiteIdBadge');
    if (printBadge) printBadge.textContent = formatSiteId(site.id);
    document.getElementById('printSiteAddress').textContent = site.address;
    const printAppNameEl = document.getElementById('printAppName');
    if (printAppNameEl) printAppNameEl.textContent = appSettings.app_name || 'GVD LIVE';
    if (appSettings.logo_url) {
      const printLogo = document.getElementById('printLogoImg');
      if (printLogo) printLogo.src = appSettings.logo_url;
    }

    // Direct Camera-Scannable Live URL
    const customerUrl = `https://gvd-live.web.app/?customer=${site.customer_token}`;
    document.getElementById('qrCodeContainer').innerHTML = generateQRCodeSVG(customerUrl);

    const printContactsGrid = document.getElementById('printContactsGrid');
    const selectedContacts = activeAdmins.filter(a => contactIds.map(String).includes(String(a.id)));
    if (selectedContacts.length === 0) {
      printContactsGrid.innerHTML = `<p style="color: #64748b; font-size: 0.85rem;">No contact assigned.</p>`;
    } else {
      printContactsGrid.innerHTML = selectedContacts.map(c => {
        const jobTitle = c.job_title || (c.email === 'phil@gvdcontracts.com' ? 'Managing Director' : c.role);
        return `
          <div class="print-contact-card">
            <div class="print-contact-name">${c.full_name} (${jobTitle})</div>
            <div class="print-contact-details">📞 ${c.phone || 'N/A'}</div>
            <div class="print-contact-details">✉️ ${c.email}</div>
          </div>
        `;
      }).join('');
    }
  }
}

// -------------------------------------------------------------------
// LABOUR SHEET VIEW (MANAGEMENT ROLES)
// -------------------------------------------------------------------
function renderLabourSheetView() {
  const weekDays = getWeekDays(currentLabourWeekOffset);
  const startDateStr = formatDateShort(weekDays[0]);
  const endDateStr = formatDateShort(weekDays[6]);
  document.getElementById('labourWeekRangeLabel').textContent = `${startDateStr} — ${endDateStr}`;

  const headerRow = document.getElementById('labourHeaderRow');
  headerRow.innerHTML = `
    <th class="op-name-col">Operative / Manager</th>
    ${weekDays.map(d => `<th style="text-align: center;">${formatDateShort(d)}</th>`).join('')}
  `;

  const tbody = document.getElementById('labourTableBody');
  const activeStaff = getAssignableOperatives();

  if (activeStaff.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 30px;">No active operatives or managers in system.</td></tr>`;
    return;
  }

  tbody.innerHTML = activeStaff.map(op => {
    const cellsHtml = weekDays.map(day => {
      const dateStr = formatDateISO(day);
      const opShifts = allShifts.filter(s => String(s.operative_id) === String(op.id) && s.shift_date === dateStr);

      const badgesHtml = opShifts.map(s => {
        const site = allSites.find(st => parseInt(st.id) === parseInt(s.site_id));
        return `
          <div class="labour-assignment-badge">
            <strong>Site #${s.site_id}</strong>: ${site ? site.address : ''}<br>
            <span style="color: var(--text-muted); font-size: 0.72rem;">${s.task}</span>
          </div>
        `;
      }).join('');

      return `
        <td class="labour-cell${opShifts.length ? '' : ' empty-cell'}" data-label="${formatDateShort(day)}">
          ${badgesHtml || '<span style="color: var(--border-color); font-size: 0.75rem;">—</span>'}
        </td>
      `;
    }).join('');

    return `
      <tr>
        <td style="font-weight: 700;">👤 ${op.full_name} <span style="font-size: 0.75rem; color: var(--text-muted);">(${op.role})</span>${weekDays.some(day => allShifts.some(s => String(s.operative_id) === String(op.id) && s.shift_date === formatDateISO(day))) ? '' : '<span class="no-shifts-note">No shifts this week</span>'}</td>
        ${cellsHtml}
      </tr>
    `;
  }).join('');
}

// -------------------------------------------------------------------
// ADMIN SETTINGS & USER MANAGEMENT
// -------------------------------------------------------------------
function updatePendingUsersBadge() {
  const pendingCount = allUsers.filter(u => u.status === 'Pending').length;
  const badgeEl = document.getElementById('pendingBadge');
  if (badgeEl) {
    if (pendingCount > 0) {
      badgeEl.textContent = pendingCount;
      badgeEl.style.display = 'inline-block';
    } else {
      badgeEl.style.display = 'none';
    }
  }
}

function renderAdminSettingsView() {
  updatePendingUsersBadge();
  document.getElementById('settingsAppNameInput').value = appSettings.app_name || 'GVD LIVE';
  const includeInput = document.getElementById('settingsIncludeManagementInput');
  if (includeInput) {
    includeInput.checked = appSettings.include_management_in_planning === true;
  }

  // Populate Default Customer QR Admin Contacts checklist
  const activeAdmins = allUsers.filter(u => isManagementUser(u) && (!u.status || u.status.toLowerCase() === 'active'));
  const defaultChecklist = document.getElementById('defaultAdminContactsChecklist');
  if (defaultChecklist) {
    let selectedDefaults = [];
    if (Array.isArray(appSettings.default_customer_contacts)) {
      selectedDefaults = appSettings.default_customer_contacts.map(String);
    } else {
      selectedDefaults = activeAdmins.map(a => String(a.id));
    }
    defaultChecklist.innerHTML = activeAdmins.map(admin => {
      const title = admin.job_title || (admin.email === 'phil@gvdcontracts.com' ? 'Managing Director' : admin.role);
      const isChecked = selectedDefaults.map(String).includes(String(admin.id));
      return `
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 0.9rem;">
          <input type="checkbox" class="default-admin-chk" value="${admin.id}" ${isChecked ? 'checked' : ''}>
          <strong>${admin.full_name}</strong> (${title}) — ${admin.phone || admin.email}
        </label>
      `;
    }).join('');

    defaultChecklist.querySelectorAll('.default-admin-chk').forEach(chk => {
      chk.addEventListener('change', async () => {
        const selectedIds = Array.from(defaultChecklist.querySelectorAll('.default-admin-chk:checked')).map(c => c.value);
        appSettings.default_customer_contacts = selectedIds;
        if (db) await db.collection('settings').doc('app').set(appSettings);
        saveLocalStorageData();
        showGreenToast('Updated default Customer QR admin contacts');
      });
    });
  }

  const chipsEl = document.getElementById('adminUserChips');
  if (allUsers.length === 0) {
    chipsEl.innerHTML = '<p style="color: var(--text-muted);">No registered users found.</p>';
    renderAdminUserPushMonitor();
    return;
  }

  const groups = [
    ['Awaiting approval', u => u.status === 'Pending'],
    ['Owners', u => u.status !== 'Pending' && u.role === 'Owner'],
    ['Admins', u => u.status !== 'Pending' && u.role === 'Admin'],
    ['Managers', u => u.status !== 'Pending' && u.role === 'Manager'],
    ['Operatives', u => u.status !== 'Pending' && !['Owner', 'Admin', 'Manager'].includes(u.role)]
  ];
  chipsEl.innerHTML = groups.map(([title, test]) => {
    const list = allUsers.filter(test).sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
    if (list.length === 0) return '';
    return `<div class="user-group-title">${title} (${list.length})</div><div class="user-chip-row">${list.map(u =>
      `<button type="button" class="user-chip${u.status === 'Pending' ? ' pending' : ''}${u.status === 'Restricted' ? ' restricted' : ''}" data-user-id="${diaryEsc(u.id)}"><span style="width: 14px; height: 14px; border-radius: 50%; background: ${userColor(u)}; display: inline-block;"></span> ${diaryEsc(u.full_name)}${!hasUsedApp(u) && u.status === 'Active' ? ' <small style="color: var(--warning);">· not logged in yet</small>' : ''}</button>`).join('')}</div>`;
  }).join('');
  chipsEl.querySelectorAll('.user-chip').forEach(chip => {
    chip.addEventListener('click', () => openUserModal(chip.dataset.userId));
  });

  renderAdminUserPushMonitor();
}

async function renderAdminUserPushMonitor() {
  const container = document.getElementById('adminUserPushMonitorBody');
  if (!container) return;
  if (allUsers.length === 0) {
    container.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 16px;">No users found in database.</td></tr>`;
    return;
  }

  container.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 16px;">⏳ Querying registered push devices in Firestore...</td></tr>`;

  let html = '';
  for (const user of allUsers) {
    let subDocs = [];
    if (db) {
      try {
        const snap = await db.collection('users').doc(String(user.id)).collection('subscriptions').get();
        subDocs = snap.docs.map(d => d.data());
      } catch (e) {}
    }

    const deviceCount = subDocs.length;
    let deviceBadgeHtml = '';
    let lastActiveStr = 'Never Subscribed';

    if (deviceCount > 0) {
      const deviceTypes = subDocs.map(s => {
        const isApple = s.endpoint && s.endpoint.includes('apple');
        return isApple ? '📱 iPhone (APNs)' : '💻 Web/Android (FCM)';
      }).join(', ');

      const latestTime = subDocs.map(s => s.updated_at || s.created_at).filter(Boolean).sort().pop();
      if (latestTime) lastActiveStr = formatUKDateTime(latestTime);

      deviceBadgeHtml = `<span style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); padding: 4px 10px; border-radius: 6px; font-weight: 700; font-size: 0.8rem;">✅ ${deviceCount} Device(s) (${deviceTypes})</span>`;
    } else {
      deviceBadgeHtml = `<span style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); padding: 4px 10px; border-radius: 6px; font-weight: 600; font-size: 0.8rem;">⚠️ No Devices Registered</span>`;
    }

    html += `
      <tr>
        <td style="padding: 12px 14px; border-bottom: 1px solid var(--border-color);">
          <strong style="font-size: 0.92rem;">${user.full_name}</strong>
          <span style="font-size: 0.75rem; color: var(--text-muted); display: block;">${user.email} • <strong>${user.role}</strong></span>
        </td>
        <td style="padding: 12px 14px; border-bottom: 1px solid var(--border-color);">${deviceBadgeHtml}</td>
        <td style="padding: 12px 14px; border-bottom: 1px solid var(--border-color); font-size: 0.82rem; color: var(--text-muted);">${lastActiveStr}</td>
        <td style="padding: 12px 14px; border-bottom: 1px solid var(--border-color);">
          <button class="btn btn-primary btn-sm send-user-test-push-btn" data-user-id="${user.id}" data-user-name="${user.full_name}" style="font-size: 0.78rem; padding: 5px 12px;">
            ⚡ Send Test Push to ${user.full_name.split(' ')[0]}
          </button>
        </td>
      </tr>
    `;
  }

  container.innerHTML = html;

  container.querySelectorAll('.send-user-test-push-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uId = btn.dataset.userId;
      const uName = btn.dataset.userName;
      btn.disabled = true;
      btn.textContent = '⏳ Dispatching Push...';
      
      const res = await dispatchServerPush({
        logId: 'log_' + Date.now(),
        targetUserId: String(uId),
        title: '🔔 Priority Test Push from Management',
        body: `Direct server test notification sent by Admin to ${uName}'s mobile phone.`,
        url: '/'
      });

      if (res.success) {
        showGreenToast(`✅ Test Push Delivered to ${uName}'s phone (${res.acceptedCount} device(s))`);
      } else {
        alert(`❌ Push Delivery Failed for ${uName}: ${res.error}`);
      }
      renderAdminUserPushMonitor();
    });
  });
}

// -------------------------------------------------------------------
// PUBLIC CUSTOMER SCHEDULE VIEW (NO ACCOUNT REQUIRED)
// -------------------------------------------------------------------
function loadCustomerPublicView(token) {
  if (!token) return;
  currentCustomerToken = token;
  document.getElementById('appHeader').style.display = 'none';
  document.querySelectorAll('.app-view, .auth-wrapper').forEach(el => el.style.display = 'none');

  const customerView = document.getElementById('view-customer-public');
  customerView.style.display = 'block';

  const site = allSites.find(s => s.customer_token === token);
  if (!site) {
    if (allSites.length === 0) {
      customerView.innerHTML = `<div style="text-align: center; margin-top: 60px; color: #64748b; font-size: 1.1rem;">⏳ Loading live project schedule...</div>`;
    } else {
      customerView.innerHTML = `<div class="alert-box alert-error" style="text-align: center; margin-top: 40px;">Invalid or expired customer schedule link.</div>`;
    }
    return;
  }

  // Restore public view HTML structure if it was replaced by loading placeholder
  if (!document.getElementById('custPubAppName')) {
    customerView.innerHTML = `
      <div class="customer-print-preview" style="box-shadow: var(--shadow-lg);">
        <div class="print-header">
          <div>
            <img id="custPubLogoImg" src="/gvd-logo.png" alt="Company Logo" style="max-height: 44px; max-width: 160px; object-fit: contain; display: block; margin-bottom: 6px;">
            <div class="print-app-title" id="custPubAppName">Works Planner</div>
            <div style="font-size: 0.85rem; color: #64748b;">Live Schedule Portal</div>
          </div>
          <div class="print-site-badge" id="custPubSiteId">Site #1</div>
        </div>
        <div style="margin-bottom: 20px;">
          <h2 style="font-size: 1.4rem; font-weight: 700;" id="custPubAddress">Property Address</h2>
          <span class="site-type-badge" id="custPubTypeBadge">Concrete</span>
        </div>
        <h4 style="margin-bottom: 12px; color: #334155; font-size: 0.95rem; text-transform: uppercase;">Live Works Schedule</h4>
        <div class="card-grid" id="custPubShiftsContainer"></div>
      </div>
    `;
  }

  if (appSettings.logo_url) {
    const pubLogo = document.getElementById('custPubLogoImg');
    if (pubLogo) pubLogo.src = appSettings.logo_url;
  }

  document.getElementById('custPubAppName').textContent = appSettings.app_name || 'GVD LIVE';
  document.getElementById('custPubSiteId').textContent = formatSiteId(site.id);
  document.getElementById('custPubAddress').textContent = site.address;
  document.getElementById('custPubTypeBadge').textContent = site.construction_type || '';
  document.getElementById('custPubTypeBadge').className = `site-type-badge ${(site.construction_type || '').toLowerCase()}`;
  document.getElementById('custPubTypeBadge').style.display = site.construction_type ? '' : 'none';

  const siteShifts = allShifts.filter(s => parseInt(s.site_id) === parseInt(site.id));
  const container = document.getElementById('custPubShiftsContainer');

  if (siteShifts.length === 0) {
    container.innerHTML = `<p style="color: #64748b; padding: 20px;">No current works scheduled for this property.</p>`;
  } else {
    container.innerHTML = siteShifts.map(s => {
      const op = allUsers.find(u => String(u.id) === String(s.operative_id));
      const periodBadge = s.shift_period === 'am' ? 'AM' : (s.shift_period === 'pm' ? 'PM' : 'All Day');
      if (s.is_drying_day) {
        return `<div class="site-card" style="background-color: #f8fafc; border-color: #e2e8f0; color: #0f172a;"><strong style="color: #2563eb; font-size: 1rem;">📅 ${formatUKDate(s.shift_date)}</strong><div style="margin-top: 6px; font-weight: 600;">⏳ Drying Day</div></div>`;
      }
      return `
        <div class="site-card" style="background-color: #f8fafc; border-color: #e2e8f0; color: #0f172a;">
          <strong style="color: #2563eb; font-size: 1rem;">📅 ${formatUKDate(s.shift_date)} (${periodBadge})</strong>
          <div style="margin-top: 6px; font-weight: 600;">Operative: ${op ? op.full_name : 'Operative'}</div>
          <div style="margin-top: 4px; color: #475569;">Task: ${s.task}</div>
        </div>
      `;
    }).join('');
  }
}

// -------------------------------------------------------------------
// EVENT HANDLERS & AUTH LOGIC
// -------------------------------------------------------------------
function setupEventListeners() {
  const mobileMenuBtn = document.getElementById('btnMobileMenu');
  if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', () => document.getElementById('appHeader').classList.toggle('menu-open'));

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('appHeader').classList.remove('menu-open');
      if (!btn.dataset.target) return;
      activeSiteId = null;
      showView(btn.dataset.target);
    });
  });

  document.getElementById('linkRegister').addEventListener('click', (e) => { e.preventDefault(); showView('view-register'); });
  document.getElementById('linkBackToLogin').addEventListener('click', (e) => { e.preventDefault(); showView('view-login'); });
  document.getElementById('linkForgotPassword').addEventListener('click', (e) => { e.preventDefault(); showView('view-forgot-password'); });
  document.getElementById('linkBackToLoginFromForgot').addEventListener('click', (e) => { e.preventDefault(); showView('view-login'); });
  document.getElementById('btnBackToLoginFromApproval').addEventListener('click', () => showView('view-login'));
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);

  document.getElementById('btnCheckApproval').addEventListener('click', async () => {
    if (db) {
      try {
        const snap = await db.collection('users').get();
        allUsers = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } catch (e) {}
    }
    const storedUserId = localStorage.getItem('gvd_current_user_id');
    if (storedUserId) {
      const user = allUsers.find(u => String(u.id) === String(storedUserId));
      if (user && user.status === 'Active') {
        currentUser = user;
        onUserAuthenticated();
        return;
      }
    }
    alert('Your account is still awaiting approval by an administrator.');
  });

  const bellBtn = document.getElementById('btnHeaderNotificationBell');
  if (bellBtn) {
    bellBtn.addEventListener('click', toggleHeaderNotificationBell);
  }

  const btnPlannerPdf = document.getElementById('btnPlannerDownloadPdf');
  if (btnPlannerPdf) {
    btnPlannerPdf.addEventListener('click', () => exportShiftsPDF(false));
  }

  const btnMyShiftsPdf = document.getElementById('btnMyShiftsDownloadPdf');
  if (btnMyShiftsPdf) {
    btnMyShiftsPdf.addEventListener('click', () => exportShiftsPDF(true));
  }

  const btnTestPush = document.getElementById('btnTestPushNotification');
  if (btnTestPush) {
    btnTestPush.addEventListener('click', sendTestPushNotification);
  }

  const btnReRegPush = document.getElementById('btnReRegisterPushDevice');
  if (btnReRegPush) {
    btnReRegPush.addEventListener('click', () => registerDevicePushSubscription(true));
  }

  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('registerForm').addEventListener('submit', handleRegister);
  document.getElementById('forgotForm').addEventListener('submit', handleForgotPassword);
  document.getElementById('createSiteForm').addEventListener('submit', handleCreateSite);
  document.getElementById('shiftForm').addEventListener('submit', handleSaveShift);

  const chkDuplicate = document.getElementById('shiftDuplicateChk');
  const containerDuplicate = document.getElementById('shiftDuplicateDaysContainer');
  const inputDays = document.getElementById('shiftDuplicateDaysInput');
  const labelDays = document.getElementById('shiftDuplicateDaysLabel');

  if (chkDuplicate) {
    chkDuplicate.addEventListener('change', () => {
      containerDuplicate.style.display = chkDuplicate.checked ? 'block' : 'none';
    });
  }

  if (inputDays) {
    inputDays.addEventListener('input', () => {
      const val = parseInt(inputDays.value) || 2;
      if (labelDays) {
        labelDays.textContent = `${val} consecutive days`;
      }
    });
  }
  document.getElementById('settingsBrandingForm').addEventListener('submit', handleSaveBranding);

  document.getElementById('plannerPrevWeekBtn').addEventListener('click', () => { currentPlannerWeekOffset--; renderPlannerView(); });
  document.getElementById('plannerNextWeekBtn').addEventListener('click', () => { currentPlannerWeekOffset++; renderPlannerView(); });
  document.getElementById('plannerCurrentWeekBtn').addEventListener('click', () => { currentPlannerWeekOffset = 0; renderPlannerView(); });
  const btnToggleMode = document.getElementById('btnTogglePlanningMode');
  if (btnToggleMode) {
    btnToggleMode.addEventListener('click', handleTogglePlanningMode);
  }

  document.getElementById('labourPrevWeekBtn').addEventListener('click', () => { currentLabourWeekOffset--; renderLabourSheetView(); });
  document.getElementById('labourNextWeekBtn').addEventListener('click', () => { currentLabourWeekOffset++; renderLabourSheetView(); });
  document.getElementById('labourNextWeekNavBtn').addEventListener('click', () => { currentLabourWeekOffset = 1; renderLabourSheetView(); });

  document.getElementById('btnBackToSites').addEventListener('click', () => {
    activeSiteId = null;
    showView('view-projects');
  });

  const btnFilterActive = document.getElementById('btnFilterActiveSites');
  if (btnFilterActive) {
    btnFilterActive.addEventListener('click', () => {
      siteFilterMode = 'active';
      renderSitesList();
    });
  }

  const btnFilterArchived = document.getElementById('btnFilterArchivedSites');
  if (btnFilterArchived) {
    btnFilterArchived.addEventListener('click', () => {
      siteFilterMode = 'archived';
      renderSitesList();
    });
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.project-tab-content').forEach(c => c.style.display = 'none');
      btn.classList.add('active');
      const targetTab = document.getElementById(btn.dataset.tab);
      if (targetTab) targetTab.style.display = 'block';
      if (activeSiteId) {
        const site = allSites.find(s => parseInt(s.id) === parseInt(activeSiteId));
        if (site) renderProjectTabContent(site);
      }
    });
  });

  document.getElementById('photoFileInput').addEventListener('change', handlePhotoUpload);
  document.getElementById('pdfFileInput').addEventListener('change', handlePdfUpload);
  document.getElementById('btnOpenCreateSiteModal').addEventListener('click', () => {
    document.querySelectorAll('input[name="constructionType"]').forEach(c => { c.checked = false; });
    openModal('modalCreateSite');
  });
  // Tick boxes act like radio buttons but can be unticked
  document.querySelectorAll('input[name="constructionType"]').forEach(box => {
    box.addEventListener('change', () => {
      if (box.checked) document.querySelectorAll('input[name="constructionType"]').forEach(o => { if (o !== box) o.checked = false; });
    });
  });
  document.getElementById('btnPrintA4').addEventListener('click', () => window.print());

  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  setupDiaryListeners();
  document.getElementById('poForm').addEventListener('submit', handleRequestPO);
  setupInvoiceListeners();
  document.getElementById('btnShiftDropMove').addEventListener('click', () => applyShiftDrop('move'));
  document.getElementById('btnShiftDropCopy').addEventListener('click', () => applyShiftDrop('copy'));
  setupFinanceListeners();
  document.getElementById('btnCopyPO').addEventListener('click', copyPONumber);
  const resetFormEl = document.getElementById('resetForm');
  if (resetFormEl) resetFormEl.addEventListener('submit', handleSetNewPassword);
  document.getElementById('plasterRoomForm').addEventListener('submit', handleSavePlasterRoom);
  document.getElementById('btnDeletePlasterRoom').addEventListener('click', handleDeletePlasterRoom);
  document.getElementById('btnEmailLogin').addEventListener('click', () => userModalShareLogin('email'));
  document.getElementById('btnCopyLogin').addEventListener('click', () => userModalShareLogin('copy'));
  document.getElementById('btnSaveUser').addEventListener('click', handleSaveUserModal);
  document.getElementById('btnRemoveUser').addEventListener('click', handleRemoveUserModal);
}

// REGISTER HANDLER (FIRESTORE: FIRST USER EVER REGISTERED OR phil@gvdcontracts.com = ACTIVE OWNER)
async function handleRegister(e) {
  e.preventDefault();
  const alertEl = document.getElementById('registerAlert');
  alertEl.style.display = 'none';

  const full_name = document.getElementById('regFullName').value.trim();
  const email = document.getElementById('regEmail').value.trim().toLowerCase();
  const phone = document.getElementById('regPhone').value.trim();
  const regRoleSelect = document.getElementById('regRole').value;
  const password = document.getElementById('regPassword').value;

  if (!full_name || !email || !phone || !password) {
    alertEl.textContent = 'Please fill in all fields.';
    alertEl.style.display = 'block';
    return;
  }

  if (db) {
    try {
      const snap = await db.collection('users').get();
      allUsers = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
      console.warn('Firestore fetch error, using local/REST state:', err);
    }
  }

  const existing = allUsers.find(u => u.email === email);
  if (existing) {
    alertEl.textContent = 'An account with this email address already exists.';
    alertEl.style.display = 'block';
    return;
  }

  const isOwnerEmail = email === 'phil@gvdcontracts.com';
  const isFirstUser = allUsers.length === 0;
  const isOwner = isFirstUser || isOwnerEmail;

  const role = isOwner ? 'Owner' : regRoleSelect;
  const status = isOwner ? 'Active' : 'Pending';

  const newUserId = 'user_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

  const newUser = {
    id: newUserId,
    full_name,
    email,
    phone,
    password_hash: hashSimple(password),
    role,
    status,
    created_at: new Date().toISOString()
  };

  if (db) {
    try {
      await db.collection('users').doc(newUserId).set(newUser);
    } catch (err) {
      console.warn('Firestore write error:', err);
    }
  }
  allUsers.push(newUser);
  saveLocalStorageData();

  if (isOwner) {
    currentUser = newUser;
    alert('Registration successful! Your account has been registered and activated as the Owner.');
    onUserAuthenticated();
  } else {
    localStorage.setItem('gvd_current_user_id', newUserId);
    showView('view-awaiting-approval');
  }
}

// LOGIN HANDLER
async function handleLogin(e) {
  e.preventDefault();
  const alertEl = document.getElementById('loginAlert');
  alertEl.style.display = 'none';

  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;

  if (db) {
    try {
      const snap = await db.collection('users').get();
      allUsers = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
      console.warn('Firestore login fetch warning:', err);
    }
  }

  const user = allUsers.find(u => u.email === email && u.password_hash === hashSimple(password));
  if (!user) {
    alertEl.textContent = 'Invalid email address or password.';
    alertEl.style.display = 'block';
    return;
  }

  if (user.status === 'Pending' || user.status === 'Pending Approval') {
    currentUser = user;
    localStorage.setItem('gvd_current_user_id', user.id);
    showView('view-awaiting-approval');

    if (db) {
      db.collection('users').doc(String(user.id)).onSnapshot(docSnap => {
        if (docSnap.exists) {
          const u = docSnap.data();
          if (u.status === 'Active') {
            currentUser = { ...u, id: docSnap.id };
            onUserAuthenticated(currentUser);
            showGreenToast('🎉 Account Approved! Welcome to Works Planner.');
          }
        }
      });
    }
    return;
  }

  if (user.status === 'Restricted') {
    alertEl.textContent = 'Your account access has been restricted by an administrator.';
    alertEl.style.display = 'block';
    return;
  }

  currentUser = user;
  user.last_login_at = new Date().toISOString();
  if (db) db.collection('users').doc(String(user.id)).update({ last_login_at: user.last_login_at }).catch(console.warn);
  onUserAuthenticated();
}

async function handleSetNewPassword(e) {
  e.preventDefault();
  const alertEl = document.getElementById('resetAlert');
  alertEl.style.display = 'none';
  const pw = document.getElementById('resetNewPassword').value;
  const pw2 = document.getElementById('resetConfirmPassword').value;
  const problem = pw.length < 6 ? 'Password must be at least 6 characters.'
    : pw !== pw2 ? 'The two passwords do not match.'
    : hashSimple(pw) === currentUser.password_hash ? 'Please choose a different password to your temporary one.' : '';
  if (problem) {
    alertEl.textContent = problem;
    alertEl.style.display = 'block';
    return;
  }
  const updates = { password_hash: hashSimple(pw), must_change_password: false };
  Object.assign(currentUser, updates);
  if (db) await db.collection('users').doc(String(currentUser.id)).update(updates).catch(err => alert('Could not save: ' + err.message));
  saveLocalStorageData();
  document.getElementById('resetNewPassword').value = '';
  document.getElementById('resetConfirmPassword').value = '';
  onUserAuthenticated();
}

function handleForgotPassword(e) {
  e.preventDefault();
  const alertEl = document.getElementById('forgotAlert');
  alertEl.textContent = 'Password reset request received. If an account exists with that email, instructions have been sent.';
  alertEl.style.display = 'block';
}

async function handleLogout() {
  if (currentUser && db) {
    const devId = localStorage.getItem('gvd_device_id');
    if (devId) {
      await db.collection('users').doc(String(currentUser.id)).collection('subscriptions').doc(devId).delete().catch(console.warn);
    }
  }
  stopDiarySync();
  stopPOSync();
  stopFinanceSync();
  currentUser = null;
  localStorage.removeItem('gvd_current_user_id');
  localStorage.removeItem('gvd_push_subscribed');
  document.getElementById('appHeader').style.display = 'none';
  showView('view-login');
}

function getLogoBase64() {
  return new Promise((resolve) => {
    const src = appSettings.logo_url || '/gvd-logo.png';
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width || 400;
        canvas.height = img.naturalHeight || img.height || 150;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRect(ctx, x, y, width, height, radius, fill = true, stroke = false) {
  let r;
  if (typeof radius === 'number') {
    r = { tl: radius, tr: radius, br: radius, bl: radius };
  } else {
    r = Object.assign({ tl: 0, tr: 0, br: 0, bl: 0 }, radius);
  }
  ctx.beginPath();
  ctx.moveTo(x + r.tl, y);
  ctx.lineTo(x + width - r.tr, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r.tr);
  ctx.lineTo(x + width, y + height - r.br);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r.br, y + height);
  ctx.lineTo(x + r.bl, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r.bl);
  ctx.lineTo(x, y + r.tl);
  ctx.quadraticCurveTo(x, y, x + r.tl, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

async function exportOperativeShiftsImage() {
  if (!currentUser) return;

  const shiftsToExport = allShifts
    .filter(s => String(s.operative_id) === String(currentUser.id))
    .sort((a, b) => a.shift_date.localeCompare(b.shift_date));

  const logoDataUrl = await getLogoBase64();

  let logoImg = null;
  if (logoDataUrl) {
    logoImg = await new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = logoDataUrl;
    });
  }

  const width = 800; // High-DPI mobile retina width
  const cardHeight = 140;
  const headerHeight = 220;
  const footerHeight = 70;
  const padding = 24;

  const contentHeight = shiftsToExport.length === 0 ? 120 : (shiftsToExport.length * (cardHeight + 16));
  const height = headerHeight + contentHeight + footerHeight + (padding * 2);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Background (#0f172a navy)
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  // Top Header Banner Card
  ctx.fillStyle = '#1e293b';
  roundRect(ctx, padding, padding, width - (padding * 2), headerHeight - 20, 16, true, false);

  let textY = padding + 40;
  if (logoImg) {
    const maxW = 240;
    const maxH = 65;
    let logoW = logoImg.width || 200;
    let logoH = logoImg.height || 60;
    const scale = Math.min(maxW / logoW, maxH / logoH);
    logoW *= scale;
    logoH *= scale;
    ctx.drawImage(logoImg, padding + 24, padding + 20, logoW, logoH);
    textY = padding + 20 + logoH + 34;
  } else {
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(appSettings.app_name || 'GVD LIVE', padding + 24, textY);
    textY += 36;
  }

  // Operative Header Name
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(`${currentUser.full_name.toUpperCase()}`, padding + 24, textY);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '18px sans-serif';
  ctx.fillText(`OFFICIAL WORK SCHEDULE • ${formatUKDate(new Date())}`, padding + 24, textY + 28);

  // Shift Cards
  let currentY = padding + headerHeight;

  if (shiftsToExport.length === 0) {
    ctx.fillStyle = '#1e293b';
    roundRect(ctx, padding, currentY, width - (padding * 2), 100, 14, true, false);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No upcoming shifts scheduled.', width / 2, currentY + 58);
    ctx.textAlign = 'left';
  } else {
    shiftsToExport.forEach(s => {
      const site = allSites.find(st => parseInt(st.id) === parseInt(s.site_id));
      const periodBadge = s.shift_period === 'am' ? '🌅 AM Shift' : (s.shift_period === 'pm' ? '🌙 PM Shift' : '☀️ All Day');

      // Card Background
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 2;
      roundRect(ctx, padding, currentY, width - (padding * 2), cardHeight, 14, true, true);

      // Left Accent Strip
      ctx.fillStyle = '#2563eb';
      roundRect(ctx, padding, currentY, 10, cardHeight, { tl: 14, bl: 14, tr: 0, br: 0 }, true, false);

      // Date & Timing
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(`📅 ${formatUKDate(s.shift_date)}  (${periodBadge})`, padding + 30, currentY + 38);

      // Site ID & Address
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 20px sans-serif';
      const addressText = `${formatSiteId(s.site_id)} - ${site ? site.address : 'Site Address'}`;
      ctx.fillText(addressText, padding + 30, currentY + 74);

      // Task Description
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '18px sans-serif';
      ctx.fillText(`Task: ${s.task || 'General Works'}`, padding + 30, currentY + 106);

      currentY += cardHeight + 16;
    });
  }

  // Footer
  ctx.fillStyle = '#64748b';
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('GVD LIVE • Live Works Schedule', width / 2, height - 26);

  // Export & Download PNG
  canvas.toBlob((blob) => {
    if (blob) {
      const filename = `${currentUser.full_name.replace(/[^a-z0-9]/gi, '_')}_Work_Schedule.png`;
      forceDownloadFile(filename, blob, 'image/png');
      showGreenToast('📱 Mobile shift schedule image downloaded!');
    } else {
      alert('Could not generate shift image.');
    }
  }, 'image/png');
}

async function exportShiftsPDF(operativeOnly = false) {
  if (operativeOnly || (currentUser && currentUser.role === 'Operative')) {
    return exportOperativeShiftsImage();
  }

  let shiftsToExport = [...allShifts];
  let docTitle = `${appSettings.app_name || 'GVD LIVE'} - Work Schedule`;
  shiftsToExport.sort((a, b) => a.shift_date.localeCompare(b.shift_date));

  if (typeof window.jspdf === 'undefined' || typeof window.jspdf.jsPDF === 'undefined') {
    alert('PDF export library is loading. Please try again in a moment.');
    return;
  }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    const logoDataUrl = await getLogoBase64();

    // Executive Brand Header Banner (#0f172a Navy)
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 297, 34, 'F');

    let startX = 14;
    if (logoDataUrl) {
      try {
        doc.addImage(logoDataUrl, 'PNG', 14, 4, 45, 24, undefined, 'FAST');
        startX = 64;
      } catch (e) {
        console.warn('Could not render logo in PDF:', e);
      }
    }

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text(appSettings.app_name || 'GVD CONTRACTS LTD', startX, 16);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    doc.text('OFFICIAL WORKS SCHEDULE REPORT', startX, 24);

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text(`Generated: ${formatUKDate(new Date())}`, 283, 16, { align: 'right' });
    doc.text(`Total Assigned Shifts: ${shiftsToExport.length}`, 283, 24, { align: 'right' });

    const startY = 40;

    const headers = ['Date', 'Site ID & Address', 'Operative', 'Timing', 'Task Description', 'Status'];
    let bodyRows = shiftsToExport.map(s => {
      const site = allSites.find(st => parseInt(st.id) === parseInt(s.site_id));
      const op = allUsers.find(u => String(u.id) === String(s.operative_id));
      const periodBadge = s.shift_period === 'am' ? 'AM' : (s.shift_period === 'pm' ? 'PM' : 'All Day');
      const isSeen = s.seen_at && s.updated_at && s.seen_at >= s.updated_at;
      const seenStr = isSeen ? `Seen (${formatUKDate(s.seen_at)})` : 'Not seen';
      return [
        formatUKDate(s.shift_date),
        `${formatSiteId(s.site_id)} - ${site ? site.address : 'Site Address'}`,
        op ? op.full_name : (s.is_drying_day ? 'Drying Day' : 'Unassigned'),
        periodBadge,
        s.task || 'General Works',
        seenStr
      ];
    });

    if (bodyRows.length === 0) {
      bodyRows = [['—', 'No assigned shifts found for this selection.', '—', '—', '—', '—']];
    }

    doc.autoTable({
      startY: startY,
      head: [headers],
      body: bodyRows,
      theme: 'grid',
      headStyles: {
        fillColor: [15, 23, 42],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 9.5,
        cellPadding: 4
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      styles: {
        fontSize: 8.5,
        cellPadding: 4,
        overflow: 'linebreak',
        textColor: [51, 65, 85],
        lineColor: [226, 232, 240],
        lineWidth: 0.1
      },
      columnStyles: {
        0: { cellWidth: 26, fontStyle: 'bold', textColor: [15, 23, 42] },
        1: { cellWidth: 70, fontStyle: 'bold' },
        2: { cellWidth: 42 },
        3: { cellWidth: 24 },
        4: { cellWidth: 75 },
        5: { cellWidth: 32 }
      },
      didDrawPage: (data) => {
        const pageCount = doc.internal.getNumberOfPages();
        doc.setFontSize(8);
        doc.setTextColor(148, 163, 184);
        doc.setFont('helvetica', 'normal');
        doc.text(`GVD Contracts Ltd — Official Schedule Report`, 14, 204);
        doc.text(`Page ${data.pageNumber} of ${pageCount}`, 283, 204, { align: 'right' });
      }
    });

    const filename = `${docTitle.replace(/[^a-z0-9]/gi, '_')}.pdf`;
    const pdfBlob = doc.output('blob');
    forceDownloadFile(filename, pdfBlob, 'application/pdf');
    showGreenToast(`📥 ${filename} downloaded!`);
  } catch (pdfErr) {
    console.error('jsPDF generation error:', pdfErr);
    alert('Could not generate PDF: ' + pdfErr.message);
  }
}

async function handleCreateSite(e) {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const address = document.getElementById('siteAddressInput').value.trim();
    if (!address) return;

    const typeTick = document.querySelector('input[name="constructionType"]:checked');
    const construction_type = typeTick ? typeTick.value : '';
    const nextSiteId = Math.floor(10000 + Math.random() * 90000);
    const customer_token = 'token_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

    const newSite = {
      id: nextSiteId,
      address,
      construction_type,
      customer_token,
      created_at: new Date().toISOString()
    };

    if (db) {
      await db.collection('sites').doc(String(nextSiteId)).set(newSite);
    }
    
    const existingIndex = allSites.findIndex(s => parseInt(s.id) === nextSiteId);
    if (existingIndex >= 0) {
      allSites[existingIndex] = newSite;
    } else {
      allSites.push(newSite);
    }
    deduplicateSites();
    saveLocalStorageData();
    closeModal('modalCreateSite');
    document.getElementById('createSiteForm').reset();
    renderActiveView();
  } catch (err) {
    console.error('Error creating site:', err);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function openCreateShiftModal(siteId, opId = null, dateStr = null) {
  document.getElementById('modalShiftTitle').textContent = 'Assign New Shift';
  document.getElementById('shiftIdInput').value = '';
  document.getElementById('btnDeleteShift').style.display = 'none';

  populateShiftSelects(siteId, opId);
  document.getElementById('shiftDateInput').value = dateStr || formatDateISO(new Date());
  document.getElementById('shiftTaskInput').value = '';
  document.getElementById('shiftFinishChk').checked = false;

  const periodRadios = document.querySelectorAll('input[name="shiftPeriod"]');
  periodRadios.forEach(r => { r.checked = (r.value === 'all_day'); });

  const groupDuplicate = document.getElementById('shiftDuplicateGroup');
  const chkDuplicate = document.getElementById('shiftDuplicateChk');
  const containerDuplicate = document.getElementById('shiftDuplicateDaysContainer');
  const inputDays = document.getElementById('shiftDuplicateDaysInput');
  const labelDays = document.getElementById('shiftDuplicateDaysLabel');

  if (groupDuplicate) groupDuplicate.style.display = 'block';
  if (chkDuplicate) chkDuplicate.checked = false;
  if (containerDuplicate) containerDuplicate.style.display = 'none';
  if (inputDays) inputDays.value = 2;
  if (labelDays) labelDays.textContent = '2 consecutive days';

  openModal('modalShift');
}

function openEditShiftModal(shiftId) {
  const shift = allShifts.find(s => parseInt(s.id) === shiftId);
  if (!shift) return;

  document.getElementById('modalShiftTitle').textContent = 'Edit Shift';
  document.getElementById('shiftIdInput').value = shift.id;
  document.getElementById('btnDeleteShift').style.display = 'block';

  const groupDuplicate = document.getElementById('shiftDuplicateGroup');
  if (groupDuplicate) groupDuplicate.style.display = 'none';

  populateShiftSelects(shift.site_id, shift.operative_id);
  document.getElementById('shiftDateInput').value = shift.shift_date;
  document.getElementById('shiftTaskInput').value = shift.task;
  document.getElementById('shiftFinishChk').checked = !!shift.is_finish;

  const targetPeriod = shift.shift_period || 'all_day';
  const periodRadios = document.querySelectorAll('input[name="shiftPeriod"]');
  periodRadios.forEach(r => { r.checked = (r.value === targetPeriod); });

  const btnDelete = document.getElementById('btnDeleteShift');
  btnDelete.type = 'button';
  btnDelete.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm('Remove this shift?')) {
      const todayStr = new Date().toISOString().split('T')[0];
      if (shift.shift_date >= todayStr) {
        triggerShiftNotification(shift, `❌ Shift Cancelled (${shift.shift_date})`);
      }

      if (db) await db.collection('shifts').doc(String(shift.id)).delete();
      allShifts = allShifts.filter(s => parseInt(s.id) !== shift.id);
      document.getElementById('shiftIdInput').value = '';
      saveLocalStorageData();
      closeModal('modalShift');
      renderActiveView();
      showGreenToast('🗑️ Shift removed successfully');
    }
  };

  openModal('modalShift');
}

function populateShiftSelects(selectedSiteId, selectedOpId) {
  const siteSelect = document.getElementById('shiftSiteSelect');
  const activeSites = allSites.filter(s => !s.is_archived);
  siteSelect.innerHTML = activeSites.map(s => `<option value="${s.id}" ${parseInt(s.id) === parseInt(selectedSiteId) ? 'selected' : ''}>${formatSiteId(s.id)} - ${s.address}</option>`).join('');

  const opSelect = document.getElementById('shiftOpSelect');
  const includeManagement = appSettings.include_management_in_planning === true;
  let availableOps = allUsers.filter(u => u.status === 'Active');
  if (!includeManagement) {
    availableOps = availableOps.filter(u => u.role === 'Operative');
  }
  opSelect.innerHTML = availableOps.map(op => `<option value="${op.id}" ${String(op.id) === String(selectedOpId) ? 'selected' : ''}>${op.full_name} (${op.role})</option>`).join('');
}

async function handleSaveShift(e) {
  e.preventDefault();
  const shiftId = document.getElementById('shiftIdInput').value;
  const site_id = parseInt(document.getElementById('shiftSiteSelect').value);
  const operative_id = document.getElementById('shiftOpSelect').value;
  const shift_date = document.getElementById('shiftDateInput').value;
  const task = document.getElementById('shiftTaskInput').value.trim();
  const isFinish = document.getElementById('shiftFinishChk').checked;
  const shift_period = document.querySelector('input[name="shiftPeriod"]:checked')?.value || 'all_day';
  const todayStr = new Date().toISOString().split('T')[0];

  let targetShift = null;

  if (shiftId) {
    const shift = allShifts.find(s => parseInt(s.id) === parseInt(shiftId));
    if (shift) {
      shift.site_id = site_id;
      shift.operative_id = operative_id;
      shift.shift_date = shift_date;
      shift.task = task;
      shift.is_finish = isFinish;
      shift.shift_period = shift_period;
      shift.seen_at = null; // Resets seen timestamp on update!
      shift.draft_pending = isDraftPlanningMode;
      if (db) await db.collection('shifts').doc(String(shift.id)).set(shift);
      targetShift = shift;
    }

    deduplicateShifts();
    saveLocalStorageData();
    closeModal('modalShift');
    renderActiveView();

    if (targetShift && shift_date >= todayStr && !isDraftPlanningMode) {
      await triggerShiftNotification(targetShift, '⚡ Live Shift Assigned');
      showGreenToast('⚡ Live Shift Saved & Operative Notified!');
    }
  } else {
    // Creating Shift(s)
    const isDuplicate = document.getElementById('shiftDuplicateChk')?.checked;
    const numDays = isDuplicate ? Math.max(1, parseInt(document.getElementById('shiftDuplicateDaysInput')?.value) || 1) : 1;

    const [year, month, day] = shift_date.split('-').map(Number);
    let createdCount = 0;

    for (let i = 0; i < numDays; i++) {
      const d = new Date(year, month - 1, day + i);
      const currentDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      
      const nextShiftId = allShifts.length > 0 ? Math.max(...allShifts.map(s => parseInt(s.id) || 0)) + 1 : 1;
      const newShift = {
        id: nextShiftId,
        site_id,
        operative_id,
        shift_date: currentDateStr,
        task,
        is_finish: isFinish,
        shift_period,
        seen_at: null,
        draft_pending: isDraftPlanningMode,
        created_at: new Date().toISOString()
      };

      if (db) await db.collection('shifts').doc(String(nextShiftId)).set(newShift);
      allShifts.push(newShift);
      createdCount++;

      if (!isDraftPlanningMode && currentDateStr >= todayStr) {
        await triggerShiftNotification(newShift, '⚡ Live Shift Assigned');
      }
    }

    deduplicateShifts();
    saveLocalStorageData();
    closeModal('modalShift');
    renderActiveView();

    if (createdCount > 1) {
      showGreenToast(`⚡ ${createdCount} consecutive shifts assigned!`);
    } else if (!isDraftPlanningMode && shift_date >= todayStr) {
      showGreenToast('⚡ Live Shift Saved & Operative Notified!');
    } else if (isDraftPlanningMode) {
      showGreenToast('📝 Draft Shift Saved (Silent)');
    }
  }
}

// Shrinks big phone photos (typically 3-8MB) to a sensible size before uploading
async function compressImage(file, maxDim = 1800, quality = 0.82) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    return blob && blob.size < file.size ? blob : file;
  } catch (err) {
    return file; // e.g. a format the browser cannot decode - upload as it is
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function uploadOnePhoto(file, index, siteId) {
  const blob = await compressImage(file);
  const id = 'photo_' + Date.now() + '_' + index + '_' + Math.floor(Math.random() * 1000);
  const baseName = (file.name || 'photo').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'photo';
  const filename = blob === file ? file.name : baseName + '.jpg';
  const photo = {
    id, site_id: String(siteId), uploader_id: currentUser.id, uploader_name: currentUser.full_name,
    filename, created_at: new Date().toISOString()
  };
  try {
    if (typeof firebase === 'undefined' || typeof firebase.storage !== 'function') throw new Error('Storage not loaded');
    const path = `site_files/${siteId}/${id}_${baseName}.jpg`;
    const up = await uploadSiteFile(path, blob);
    photo.file_url = up.url;
    photo.storage_bucket = up.bucket;
    photo.storage_path = path;
  } catch (err) {
    // Storage unavailable: keep a smaller copy in the database instead
    let small = await compressImage(file, 1200, 0.6);
    let dataUrl = await blobToDataURL(small);
    if (dataUrl.length > 950000) { small = await compressImage(file, 900, 0.5); dataUrl = await blobToDataURL(small); }
    if (dataUrl.length > 950000) throw new Error('Photo is too large to store');
    photo.data_url = dataUrl;
  }
  if (db) await db.collection('photos').doc(id).set(photo);
  if (!allPhotos.some(p => String(p.id) === id)) allPhotos.push(photo);
  return photo;
}

async function handlePhotoUpload(e) {
  const input = e.target;
  const files = Array.from(input.files || []).filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(f.name));
  if (!files.length || !activeSiteId) { input.value = ''; return; }
  const siteId = activeSiteId;
  let done = 0, failed = 0, next = 0;
  showGreenToast(`⏳ Uploading ${files.length} photo${files.length > 1 ? 's' : ''}...`);

  // A few at a time so a big batch does not swamp the phone
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      try {
        await uploadOnePhoto(files[i], i, siteId);
        done++;
      } catch (err) {
        console.warn('Photo upload failed:', err);
        failed++;
      }
      showGreenToast(`⏳ Uploading photos ${done + failed} of ${files.length}...`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  input.value = '';
  deduplicatePhotos();
  saveLocalStorageData();
  showGreenToast(failed ? `📷 ${done} uploaded, ${failed} failed` : `📷 ${done} photo${done > 1 ? 's' : ''} uploaded`);
  if (failed) alert(`${failed} photo${failed > 1 ? 's' : ''} could not be uploaded. Please try those again.`);
  loadProjectPage(siteId);
}

const STORAGE_BUCKETS = ['gs://gvd-live.firebasestorage.app', 'gs://gvd-live.appspot.com'];
const MAX_SITE_FILE_MB = 30;

function getStorageForBucket(bucketUrl) {
  return firebase.app().storage(bucketUrl);
}

// Uploads to Firebase Storage, trying the project's possible default buckets in turn
async function uploadSiteFile(path, file) {
  let lastErr = null;
  for (const bucket of STORAGE_BUCKETS) {
    try {
      const ref = getStorageForBucket(bucket).ref(path);
      await ref.put(file);
      return { bucket, url: await ref.getDownloadURL() };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function handlePdfUpload(e) {
  const input = e.target;
  const file = input.files[0];
  if (!file || !activeSiteId) return;

  const lowerName = file.name.toLowerCase();
  const isPdf = lowerName.endsWith('.pdf') || file.type === 'application/pdf';
  const isExcel = /\.(xlsx|xlsm|xls|csv)$/.test(lowerName);
  if (!isPdf && !isExcel) {
    alert('Only PDF or Excel (.xlsx, .xls, .csv) files are accepted.');
    input.value = '';
    return;
  }
  if (file.size > MAX_SITE_FILE_MB * 1024 * 1024) {
    alert(`This file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_SITE_FILE_MB}MB.`);
    input.value = '';
    return;
  }

  const nextPdfId = 'pdf_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const newPdf = {
    id: nextPdfId,
    site_id: String(activeSiteId),
    uploader_id: currentUser.id,
    uploader_name: currentUser.full_name,
    filename: file.name,
    file_type: isPdf ? 'pdf' : 'excel',
    created_at: new Date().toISOString()
  };

  showGreenToast(`⏳ Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)...`);
  let storageError = null;
  try {
    if (typeof firebase === 'undefined' || typeof firebase.storage !== 'function') throw new Error('Firebase Storage is not loaded');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const up = await uploadSiteFile(`site_files/${activeSiteId}/${nextPdfId}_${safeName}`, file);
    newPdf.file_url = up.url;
    newPdf.storage_bucket = up.bucket;
    newPdf.storage_path = `site_files/${activeSiteId}/${nextPdfId}_${safeName}`;
  } catch (err) {
    storageError = err;
  }

  if (storageError) {
    // Fall back to storing small files directly in the database
    if (file.size > 700 * 1024) {
      alert('Could not upload this file: ' + storageError.message + '\n\nFirebase Storage may not be switched on yet.');
      input.value = '';
      return;
    }
    newPdf.data_url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = evt => resolve(evt.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  if (db) {
    try {
      await db.collection('pdfs').doc(nextPdfId).set(newPdf);
    } catch (err) {
      alert('Could not save the file: ' + err.message);
      input.value = '';
      return;
    }
  }
  // The live database listener may already have added this file, so only add it if it is missing
  if (!allPdfs.some(p => String(p.id) === String(newPdf.id))) allPdfs.push(newPdf);
  saveLocalStorageData();
  input.value = '';
  showGreenToast(isPdf ? '📄 PDF document uploaded successfully!' : '📊 Excel file uploaded successfully!');
  loadProjectPage(activeSiteId);
}

async function handleSaveBranding(e) {
  e.preventDefault();
  const app_name = document.getElementById('settingsAppNameInput').value.trim();
  const logoFile = document.getElementById('settingsLogoInput').files[0];
  const includeManagement = document.getElementById('settingsIncludeManagementInput').checked;

  if (app_name) appSettings.app_name = app_name;
  appSettings.include_management_in_planning = includeManagement;

  if (logoFile) {
    const reader = new FileReader();
    reader.onload = async (evt) => {
      appSettings.logo_url = evt.target.result;
      if (db) await db.collection('settings').doc('app').set(appSettings);
      saveLocalStorageData();
      updateBrandingUI();
      alert('Settings & Branding updated successfully.');
    };
    reader.readAsDataURL(logoFile);
  } else {
    if (db) await db.collection('settings').doc('app').set(appSettings);
    saveLocalStorageData();
    updateBrandingUI();
    alert('Settings & Branding updated successfully.');
  }
}



function requestPushNotificationPermission() {
  if (!('Notification' in window)) {
    alert('This browser does not support notifications.');
    return;
  }

  Notification.requestPermission().then(permission => {
    if (permission === 'granted') {
      document.getElementById('pushStatusText').textContent = '✅ Push notifications active on this device.';
      document.getElementById('btnEnablePush').style.display = 'none';
      alert('Push notifications enabled successfully!');
    }
  });
}

function openModal(id) {
  document.getElementById(id).classList.add('active');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}


// -------------------------------------------------------------------
// DIARY (Owner / Admin / Manager, not operatives). Entries live in Firestore `diary`.
// Assignees are notified on save via the `notifications` collection; a scheduled
// Cloud Function (functions/index.js) sends the 7am reminder on the day.
// -------------------------------------------------------------------
let allDiary = [];
let diaryUnsub = null;
let diaryMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

function diaryEsc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function diaryWindowLabel(t) {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(t || '');
  if (!m) return t || '';
  const h = n => { const x = parseInt(n, 10); return (x % 12 || 12) + (x >= 12 ? 'pm' : 'am'); };
  return `${h(m[1])}-${h(m[3])}`;
}

function diaryAssigneeNames(entry, firstNameOnly) {
  return (entry.assignee_ids || []).map(id => {
    const u = allUsers.find(x => String(x.id) === String(id));
    if (!u) return 'Unknown';
    return firstNameOnly ? String(u.full_name || '').split(' ')[0] : u.full_name;
  }).join(', ');
}

function diaryDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startDiarySync() {
  if (diaryUnsub || !db || !currentUser || !isManagementUser(currentUser)) return;
  diaryUnsub = db.collection('diary').onSnapshot(snapshot => {
    allDiary = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    const el = document.getElementById('view-diary');
    if (el && el.style.display !== 'none') renderDiaryView();
  }, err => console.warn('Firestore diary error:', err));
}

function stopDiarySync() {
  if (diaryUnsub) diaryUnsub();
  diaryUnsub = null;
  allDiary = [];
}

function renderDiaryView() {
  if (!currentUser || !isManagementUser(currentUser)) return;
  const year = diaryMonth.getFullYear();
  const month = diaryMonth.getMonth();
  document.getElementById('diaryMonthLabel').textContent = diaryMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const todayKey = diaryDateKey(new Date());
  const byDate = {};
  allDiary.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });
  Object.values(byDate).forEach(list => list.sort((a, b) => (a.time || '').localeCompare(b.time || '')));

  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday first
  let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="diary-dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - startOffset + i);
    const key = diaryDateKey(d);
    const chips = (byDate[key] || []).map(e =>
      `<span class="diary-chip" data-entry="${diaryEsc(e.id)}" style="background: ${userColor((e.assignee_ids || [])[0] || '')};"><strong class="dc-who">${diaryEsc(diaryAssigneeNames(e, true) || 'Unassigned')}</strong> <span class="dc-win">${diaryEsc(diaryWindowLabel(e.time))}</span> <span class="dc-title">${diaryEsc(e.title)}</span></span>`).join('');
    html += `<div class="diary-cell${d.getMonth() !== month ? ' other-month' : ''}${key === todayKey ? ' today' : ''}" data-date="${key}"><div class="diary-daynum">${d.getDate()}</div>${chips}</div>`;
  }
  const grid = document.getElementById('diaryGrid');
  grid.innerHTML = html;
  grid.querySelectorAll('.diary-cell').forEach(cell => {
    cell.addEventListener('click', (ev) => {
      const chip = ev.target.closest('.diary-chip');
      if (chip) openDiaryModal(chip.dataset.entry);
      else openDiaryModal(null, cell.dataset.date);
    });
  });

  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  const monthEntries = allDiary.filter(e => (e.date || '').startsWith(prefix))
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const agenda = document.getElementById('diaryAgenda');
  if (monthEntries.length === 0) {
    agenda.innerHTML = '<p style="color: var(--text-muted);">Nothing in the diary this month.</p>';
    return;
  }
  agenda.innerHTML = monthEntries.map(e => {
    const site = allSites.find(s => String(s.id) === String(e.site_id));
    const names = diaryAssigneeNames(e, false);
    return `<div class="diary-agenda-item" data-entry="${diaryEsc(e.id)}">
      <strong>${diaryEsc(formatUKDate(e.date))}${e.time ? ' · ' + diaryEsc(diaryWindowLabel(e.time)) : ''} - ${diaryEsc(e.title)}</strong>
      <div style="font-size: 0.9rem; margin-top: 2px;">👤 <strong>${names ? diaryEsc(names) : 'No one assigned'}</strong></div>
      <div style="font-size: 0.85rem; color: var(--text-muted);">${site ? '🏗️ ' + diaryEsc(site.address) : ''}${site && e.reminder_7am ? ' · ' : ''}${e.reminder_7am ? '⏰ 7am reminder' : ''}</div>
      ${e.notes ? `<div style="font-size: 0.85rem; margin-top: 4px;">${diaryEsc(e.notes)}</div>` : ''}
    </div>`;
  }).join('');
  agenda.querySelectorAll('.diary-agenda-item').forEach(el => {
    el.addEventListener('click', () => openDiaryModal(el.dataset.entry));
  });
}

function openDiaryModal(entryId, presetDate = null) {
  const entry = entryId ? allDiary.find(e => e.id === entryId) : null;
  document.getElementById('modalDiaryTitle').textContent = entry ? 'Edit Diary Entry' : 'Add Diary Entry';
  document.getElementById('diaryIdInput').value = entry ? entry.id : '';
  document.getElementById('diaryTitleInput').value = entry ? entry.title : '';
  document.getElementById('diaryDateInput').value = entry ? entry.date : (presetDate || diaryDateKey(new Date()));
  const timeSel = document.getElementById('diaryTimeInput');
  Array.from(timeSel.options).filter(o => o.dataset.legacy).forEach(o => o.remove());
  if (entry && entry.time && !Array.from(timeSel.options).some(o => o.value === entry.time)) {
    const legacy = document.createElement('option');
    legacy.value = entry.time; legacy.textContent = entry.time; legacy.dataset.legacy = '1';
    timeSel.appendChild(legacy);
  }
  timeSel.value = entry ? (entry.time || '') : '';
  document.getElementById('diaryNotesInput').value = entry ? (entry.notes || '') : '';
  document.getElementById('diaryReminderChk').checked = entry ? entry.reminder_7am !== false : true;

  const siteSel = document.getElementById('diarySiteSelect');
  siteSel.innerHTML = '<option value="">No site</option>' + allSites
    .filter(s => !s.is_archived)
    .map(s => `<option value="${diaryEsc(s.id)}">${diaryEsc(s.address)}</option>`).join('');
  siteSel.value = entry && entry.site_id != null ? String(entry.site_id) : '';

  const selected = new Set((entry ? entry.assignee_ids || [] : []).map(String));
  document.getElementById('diaryAssigneeList').innerHTML = allUsers
    .filter(u => u.status === 'Active' && (isManagementUser(u) || selected.has(String(u.id))))
    .map(u => `<label style="display: flex; align-items: center; gap: 8px; font-size: 0.9rem; cursor: pointer;">
      <input type="checkbox" class="diary-assignee" value="${diaryEsc(u.id)}"${selected.has(String(u.id)) ? ' checked' : ''}> ${diaryEsc(u.full_name)} <span style="color: var(--text-muted);">(${diaryEsc(u.role)})</span></label>`).join('');

  document.getElementById('btnDeleteDiary').style.display = entry ? '' : 'none';
  openModal('modalDiary');
}

async function handleSaveDiary(e) {
  e.preventDefault();
  if (!db || !currentUser || !isManagementUser(currentUser)) return;

  const existingId = document.getElementById('diaryIdInput').value;
  const previous = existingId ? allDiary.find(x => x.id === existingId) : null;
  const assignee_ids = Array.from(document.querySelectorAll('.diary-assignee:checked')).map(c => String(c.value));
  const siteVal = document.getElementById('diarySiteSelect').value;
  const entry = {
    title: document.getElementById('diaryTitleInput').value.trim(),
    date: document.getElementById('diaryDateInput').value,
    time: document.getElementById('diaryTimeInput').value || '',
    site_id: siteVal || null,
    notes: document.getElementById('diaryNotesInput').value.trim(),
    assignee_ids,
    reminder_7am: document.getElementById('diaryReminderChk').checked,
    created_by: previous ? previous.created_by : String(currentUser.id),
    updated_at: new Date().toISOString()
  };
  const id = existingId || 'diary_' + Date.now();

  try {
    await db.collection('diary').doc(id).set({ id, ...entry });
  } catch (err) {
    alert('Could not save diary entry: ' + err.message);
    return;
  }

  // Push to anyone newly added, or everyone if the date/time changed
  const changed = !previous || previous.date !== entry.date || previous.time !== entry.time;
  const already = new Set(previous ? (previous.assignee_ids || []).map(String) : []);
  const toNotify = assignee_ids.filter(uid => changed || !already.has(uid));
  const site = allSites.find(s => String(s.id) === String(entry.site_id));
  const body = `${formatUKDate(entry.date)}${entry.time ? ' (' + diaryWindowLabel(entry.time) + ')' : ''}${site ? '\nSite: ' + site.address : ''}${entry.notes ? '\n' + entry.notes : ''}`;
  await Promise.all(toNotify.map(uid => db.collection('notifications').add({
    target_user_id: uid,
    title: (previous ? '📖 Diary updated: ' : '📖 Diary: ') + entry.title,
    body,
    created_at: new Date().toISOString()
  }).catch(err => console.warn('Diary notification failed:', err))));

  closeModal('modalDiary');
  showGreenToast(toNotify.length ? `📖 Diary saved - ${toNotify.length} notified` : '📖 Diary saved');
}

async function handleDeleteDiary() {
  const id = document.getElementById('diaryIdInput').value;
  if (!id || !db || !confirm('Delete this diary entry?')) return;
  await db.collection('diary').doc(id).delete().catch(err => alert('Delete failed: ' + err.message));
  closeModal('modalDiary');
}

function setupDiaryListeners() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('diaryPrevMonthBtn', () => { diaryMonth = new Date(diaryMonth.getFullYear(), diaryMonth.getMonth() - 1, 1); renderDiaryView(); });
  on('diaryNextMonthBtn', () => { diaryMonth = new Date(diaryMonth.getFullYear(), diaryMonth.getMonth() + 1, 1); renderDiaryView(); });
  on('diaryTodayBtn', () => { const n = new Date(); diaryMonth = new Date(n.getFullYear(), n.getMonth(), 1); renderDiaryView(); });
  on('diaryAddBtn', () => openDiaryModal(null));
  on('btnDeleteDiary', handleDeleteDiary);
  const form = document.getElementById('diaryForm');
  if (form) form.addEventListener('submit', handleSaveDiary);
}


// -------------------------------------------------------------------
// USER ACCOUNT MODAL (Admin Settings)
// -------------------------------------------------------------------
function openUserModal(userId) {
  const user = allUsers.find(u => String(u.id) === String(userId));
  if (!user) return;
  document.getElementById('userModalId').value = user.id;
  document.getElementById('modalUserName').textContent = user.full_name;
  const contact = [];
  if (user.phone) contact.push(`<a href="tel:${diaryEsc(user.phone)}" style="color: var(--primary);">📞 ${diaryEsc(user.phone)}</a>`);
  if (user.email) contact.push(`<a href="mailto:${diaryEsc(user.email)}" style="color: var(--primary); word-break: break-all;">✉️ ${diaryEsc(user.email)}</a>`);
  document.getElementById('userModalContact').innerHTML = contact.join('');
  const emailInput = document.getElementById('userModalEmail');
  emailInput.value = user.email || '';
  emailInput.disabled = user.email === 'phil@gvdcontracts.com'; // the Owner account is recognised by this address
  document.getElementById('userModalPhone').value = user.phone || '';
  document.getElementById('userModalJob').value = user.job_title || (user.email === 'phil@gvdcontracts.com' ? 'Managing Director' : '');
  document.getElementById('userModalRole').value = user.role || 'Operative';
  document.getElementById('userModalStatus').value = user.status || 'Pending';
  document.getElementById('btnRemoveUser').disabled = String(user.id) === String(currentUser.id);
  document.getElementById('userModalColor').value = userColor(user);
  const rateGroup = document.getElementById('userModalRateGroup');
  rateGroup.style.display = isOwnerOrAdminUser(currentUser) ? '' : 'none';
  document.getElementById('userModalDayRate').value = financeRates[String(user.id)] != null ? financeRates[String(user.id)] : '';
  document.getElementById('userModalPayType').value = financePay[String(user.id)] === 'price' ? 'price' : 'day';

  // Login sharing is only offered for people who have never used the app
  const loginBox = document.getElementById('userModalLoginBox');
  const neverUsed = !hasUsedApp(user);
  loginBox.style.display = neverUsed ? '' : 'none';
  document.getElementById('userModalTempPw').value = String(user.full_name || '').trim();
  document.getElementById('userModalLoginState').textContent = user.must_change_password
    ? 'Temporary login is set. They will be asked to choose a new password when they first log in.'
    : 'Not set up yet.';
  openModal('modalUser');
}

async function handleSaveUserModal() {
  const user = allUsers.find(u => String(u.id) === document.getElementById('userModalId').value);
  if (!user) return;
  const newEmail = document.getElementById('userModalEmail').value.trim().toLowerCase();
  if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) { alert('Please enter a valid email address.'); return; }
  if (newEmail && allUsers.some(u => String(u.id) !== String(user.id) && String(u.email || '').toLowerCase() === newEmail)) {
    alert('Another account already uses that email address.');
    return;
  }
  const updates = {
    ...(newEmail ? { email: newEmail } : {}),
    phone: document.getElementById('userModalPhone').value.trim(),
    job_title: document.getElementById('userModalJob').value.trim(),
    role: document.getElementById('userModalRole').value,
    status: document.getElementById('userModalStatus').value,
    color: document.getElementById('userModalColor').value
  };
  Object.assign(user, updates);
  if (db) await db.collection('users').doc(String(user.id)).update(updates).catch(err => alert('Save failed: ' + err.message));
  if (db && isOwnerOrAdminUser(currentUser)) {
    const rateRaw = document.getElementById('userModalDayRate').value;
    const rate = rateRaw === '' ? null : parseFloat(rateRaw);
    await db.collection('finance_rates').doc(String(user.id)).set({
      user_id: String(user.id), day_rate: isNaN(rate) ? null : rate, pay_type: document.getElementById('userModalPayType').value
    }, { merge: true }).catch(console.warn);
  }
  saveLocalStorageData();
  closeModal('modalUser');
  showGreenToast(`Saved ${user.full_name}`);
  renderActiveView();
}

async function handleRemoveUserModal() {
  const userId = document.getElementById('userModalId').value;
  if (!confirm('Remove this user account? Historical shifts will be preserved.')) return;
  if (db) await db.collection('users').doc(String(userId)).delete();
  allUsers = allUsers.filter(u => String(u.id) !== String(userId));
  saveLocalStorageData();
  closeModal('modalUser');
  renderActiveView();
}


// -------------------------------------------------------------------
// PLASTERING MATERIALS CALCULATOR (per site, managers/admins/owners)
// Rooms + rates are stored on the site doc (plaster_rooms / plaster_settings).
// Openings are NOT deducted. Contingency is added on top of every material.
// Tiled (green line) area = moisture board only, no skim. Other walls + ceiling = board and skim.
// -------------------------------------------------------------------
const PLASTER_DEFAULTS = {
  contingency: 10,   // % added to every material
  sheet_area: 2.88,  // m2 per board (2.4 x 1.2)
  skim_cover: 12,    // m2 per 25kg bag of multi-finish at ~2mm
  screws_per_sheet: 30,
  dab_cover: 8,      // m2 of board fixed per 25kg bag of adhesive
  pva_cover: 6       // m2 per litre of bonding agent (skim-only areas)
};

function plasterSettings(site) {
  return { ...PLASTER_DEFAULTS, ...(site.plaster_settings || {}) };
}

function calcPlaster(rooms, cfg) {
  const t = { stdBoard: 0, moistBoard: 0, skim: 0, dab: 0, screwSheets: 0, pva: 0, tape: 0 };
  const perRoom = rooms.map(r => {
    const L = +r.length || 0, W = +r.width || 0, H = +r.height || 0;
    const wallArea = 2 * (L + W) * H;
    const tiled = Math.min((+r.tiled_len || 0) * (+r.tiled_h || 0), wallArea);
    const plainWall = wallArea - tiled;
    const ceil = L * W;
    const ceilBoard = r.ceiling === 'board_skim' ? ceil : 0;
    const ceilSkim = r.ceiling === 'board_skim' || r.ceiling === 'skim_only' ? ceil : 0;
    const ceilPva = r.ceiling === 'skim_only' ? ceil : 0;
    const std = plainWall + ceilBoard;
    const wallBoard = plainWall + tiled;
    const room = {
      wallArea, tiled, plainWall, ceil,
      std, moist: tiled, skim: plainWall + ceilSkim,
      dab: r.wall_type === 'brick' ? wallBoard : 0,
      screwArea: (r.wall_type === 'brick' ? 0 : wallBoard) + ceilBoard,
      pva: ceilPva
    };
    t.stdBoard += room.std; t.moistBoard += room.moist; t.skim += room.skim;
    t.dab += room.dab; t.screwSheets += room.screwArea / cfg.sheet_area; t.pva += room.pva;
    t.tape += room.std + room.moist;
    return room;
  });
  const k = 1 + (cfg.contingency || 0) / 100;
  const items = [
    ['Standard plasterboard 12.5mm (2.4 x 1.2m)', Math.ceil(t.stdBoard * k / cfg.sheet_area), 'sheets', `${t.stdBoard.toFixed(1)} m2`],
    ['Moisture resistant board 12.5mm (2.4 x 1.2m)', Math.ceil(t.moistBoard * k / cfg.sheet_area), 'sheets', `${t.moistBoard.toFixed(1)} m2`],
    ['Multi-finish plaster 25kg', Math.ceil(t.skim * k / cfg.skim_cover), 'bags', `${t.skim.toFixed(1)} m2 skimmed`],
    ['Plasterboard screws (box of 1000)', Math.ceil(t.screwSheets * k * cfg.screws_per_sheet / 1000), 'boxes', `${Math.round(t.screwSheets * cfg.screws_per_sheet)} screws`],
    ['Board adhesive / dab 25kg', Math.ceil(t.dab * k / cfg.dab_cover), 'bags', `${t.dab.toFixed(1)} m2 on brick`],
    ['Bonding agent / PVA (5 litre)', Math.ceil(t.pva * k / cfg.pva_cover / 5), 'tubs', `${t.pva.toFixed(1)} m2 skim only`],
    ['Jointing tape (90m roll)', Math.ceil(t.tape * k / 90), 'rolls', `${t.tape.toFixed(0)} m approx`]
  ].filter(i => i[1] > 0);
  return { perRoom, items };
}

function renderPlasterCalc(site) {
  const host = document.getElementById('plasterCalcContainer');
  if (!host) return;
  if (!currentUser || !isManagementUser(currentUser)) { host.innerHTML = ''; return; }
  const rooms = site.plaster_rooms || [];
  const cfg = plasterSettings(site);
  const { perRoom, items } = calcPlaster(rooms, cfg);
  const wallLabel = { stud: 'Stud', brick: 'Brick' };
  const ceilLabel = { board_skim: 'Board & skim', skim_only: 'Skim only', none: 'No ceiling work' };

  const roomsHtml = rooms.length === 0
    ? '<p style="color: var(--text-muted);">No rooms yet. Add a room using the sizes from the Existing / Proposed drawing.</p>'
    : rooms.map((r, i) => `<div class="diary-agenda-item" data-room="${diaryEsc(r.id)}">
        <strong>${diaryEsc(r.name)}</strong> - ${r.length} x ${r.width} x ${r.height}m high
        <div style="font-size: 0.85rem; color: var(--text-muted);">${wallLabel[r.wall_type] || ''} walls · ${ceilLabel[r.ceiling] || ''} · tiled ${perRoom[i].tiled.toFixed(1)} m2 (moisture board only) · board & skim walls ${perRoom[i].plainWall.toFixed(1)} m2</div>
      </div>`).join('');

  const itemsHtml = items.length === 0 ? '' : `
    <h4 style="margin: 16px 0 8px;">Materials to order (incl. ${cfg.contingency}% contingency)</h4>
    <table class="planner-table" style="min-width: 0;"><tbody>${items.map(i =>
      `<tr><td>${diaryEsc(i[0])}<div style="font-size: 0.75rem; color: var(--text-muted);">${diaryEsc(i[3])}</div></td><td style="white-space: nowrap;"><strong>${i[1]}</strong> ${i[2]}</td></tr>`).join('')}</tbody></table>
    <button type="button" class="btn btn-outline btn-sm" id="btnCopyPlasterList" style="margin-top: 10px;">Copy list</button>`;

  const rateInput = (key, label) => `<label style="font-size: 0.8rem; display: block;">${label}<input type="text" inputmode="decimal" autocomplete="off" step="0.01" min="0" class="form-control plaster-setting" data-key="${key}" value="${cfg[key]}" style="min-height: 32px; padding: 4px 8px;"></label>`;

  host.innerHTML = `<div class="site-card">
    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
      <h3>🧮 Plastering Materials Calculator</h3>
      <button type="button" class="btn btn-primary btn-sm" id="btnAddPlasterRoom">+ Add Room</button>
    </div>
    <p style="color: var(--text-muted); font-size: 0.85rem; margin: 6px 0 12px;">Green-line tiled walls get moisture board only. All other walls and the ceiling get board and skim. Openings are not deducted.</p>
    ${roomsHtml}
    ${itemsHtml}
    <details style="margin-top: 14px;"><summary style="cursor: pointer; font-size: 0.9rem;">Rates and contingency</summary>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 10px;">
        ${rateInput('contingency', 'Contingency %')}
        ${rateInput('sheet_area', 'Board sheet m2')}
        ${rateInput('skim_cover', 'Skim m2 per 25kg bag')}
        ${rateInput('screws_per_sheet', 'Screws per sheet')}
        ${rateInput('dab_cover', 'Dab m2 per bag')}
        ${rateInput('pva_cover', 'Bonding m2 per litre')}
      </div>
    </details>
  </div>`;

  host.querySelector('#btnAddPlasterRoom').onclick = () => openPlasterRoomModal(site.id, null);
  host.querySelectorAll('[data-room]').forEach(el => el.onclick = () => openPlasterRoomModal(site.id, el.dataset.room));
  host.querySelectorAll('.plaster-setting').forEach(inp => inp.addEventListener('change', async () => {
    const v = parseFloat(inp.value);
    if (!(v >= 0)) return;
    site.plaster_settings = { ...plasterSettings(site), [inp.dataset.key]: v };
    if (db) await db.collection('sites').doc(String(site.id)).update({ plaster_settings: site.plaster_settings }).catch(console.warn);
    saveLocalStorageData();
    renderPlasterCalc(site);
  }));
  const copyBtn = host.querySelector('#btnCopyPlasterList');
  if (copyBtn) copyBtn.onclick = () => {
    const text = `Plastering materials - ${site.address} (incl. ${cfg.contingency}% contingency)\n` + items.map(i => `${i[1]} ${i[2]} - ${i[0]}`).join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => showGreenToast('List copied')).catch(() => alert(text));
    else alert(text);
  };
}

let plasterRoomSiteId = null;

function openPlasterRoomModal(siteId, roomId) {
  plasterRoomSiteId = siteId;
  const site = allSites.find(s => parseInt(s.id) === parseInt(siteId));
  const r = roomId ? (site.plaster_rooms || []).find(x => x.id === roomId) : null;
  document.getElementById('modalPlasterRoomTitle').textContent = r ? 'Edit Room' : 'Add Room';
  document.getElementById('plRoomId').value = r ? r.id : '';
  document.getElementById('plName').value = r ? r.name : '';
  document.getElementById('plLength').value = r ? r.length : '';
  document.getElementById('plWidth').value = r ? r.width : '';
  document.getElementById('plHeight').value = r ? r.height : 2.4;
  document.getElementById('plTiledLen').value = r ? r.tiled_len : 0;
  document.getElementById('plTiledHeight').value = r ? r.tiled_h : 2.4;
  document.getElementById('plWallType').value = r ? r.wall_type : 'stud';
  document.getElementById('plCeiling').value = r ? r.ceiling : 'board_skim';
  document.getElementById('btnDeletePlasterRoom').style.display = r ? '' : 'none';
  openModal('modalPlasterRoom');
}

async function savePlasterRooms(site, rooms) {
  site.plaster_rooms = rooms;
  if (db) await db.collection('sites').doc(String(site.id)).update({ plaster_rooms: rooms }).catch(err => alert('Could not save: ' + err.message));
  saveLocalStorageData();
  renderPlasterCalc(site);
}

async function handleSavePlasterRoom(e) {
  e.preventDefault();
  const site = allSites.find(s => parseInt(s.id) === parseInt(plasterRoomSiteId));
  if (!site) return;
  const id = document.getElementById('plRoomId').value || 'room_' + Date.now();
  const room = {
    id,
    name: document.getElementById('plName').value.trim(),
    length: parseFloat(document.getElementById('plLength').value) || 0,
    width: parseFloat(document.getElementById('plWidth').value) || 0,
    height: parseFloat(document.getElementById('plHeight').value) || 0,
    tiled_len: parseFloat(document.getElementById('plTiledLen').value) || 0,
    tiled_h: parseFloat(document.getElementById('plTiledHeight').value) || 0,
    wall_type: document.getElementById('plWallType').value,
    ceiling: document.getElementById('plCeiling').value
  };
  const rooms = (site.plaster_rooms || []).filter(r => r.id !== id);
  rooms.push(room);
  closeModal('modalPlasterRoom');
  await savePlasterRooms(site, rooms);
}

async function handleDeletePlasterRoom() {
  const site = allSites.find(s => parseInt(s.id) === parseInt(plasterRoomSiteId));
  const id = document.getElementById('plRoomId').value;
  if (!site || !id || !confirm('Delete this room?')) return;
  closeModal('modalPlasterRoom');
  await savePlasterRooms(site, (site.plaster_rooms || []).filter(r => r.id !== id));
}


// -------------------------------------------------------------------
// LOGIN SHARING for people who have never used the app
// -------------------------------------------------------------------
function hasUsedApp(user) {
  if (user.last_login_at) return true;
  return allShifts.some(sh => String(sh.operative_id) === String(user.id) && sh.seen_at);
}

function buildLoginMessage(user, tempPw) {
  const first = String(user.full_name || '').split(' ')[0];
  return `Hi ${first},\n\nYour GVD LIVE login:\nWebsite: ${window.location.origin}\nEmail: ${user.email}\nTemporary password: ${tempPw}\n\nThe first time you log in you will be asked to choose your own password.`;
}

async function applyTempLogin(user, tempPw) {
  if (user.must_change_password && user.password_hash === hashSimple(tempPw)) return;
  const updates = { password_hash: hashSimple(tempPw), must_change_password: true };
  Object.assign(user, updates);
  if (db) await db.collection('users').doc(String(user.id)).update(updates).catch(err => alert('Save failed: ' + err.message));
  saveLocalStorageData();
}

async function userModalShareLogin(mode) {
  const user = allUsers.find(u => String(u.id) === document.getElementById('userModalId').value);
  if (!user) return;
  const tempPw = document.getElementById('userModalTempPw').value.trim();
  if (tempPw.length < 3) { alert('Enter a temporary password (at least 3 characters).'); return; }
  if (hasUsedApp(user)) { alert('This person has already used the app, so their password was not changed.'); return; }
  if (!user.must_change_password && !confirm(`This will set ${user.full_name}'s password to "${tempPw}" and make them choose a new one at first login. Continue?`)) return;
  await applyTempLogin(user, tempPw);
  document.getElementById('userModalLoginState').textContent = 'Temporary login is set. They will be asked to choose a new password when they first log in.';
  const msg = buildLoginMessage(user, tempPw);
  if (mode === 'email') {
    window.location.href = `mailto:${encodeURIComponent(user.email)}?subject=${encodeURIComponent('Your GVD LIVE login')}&body=${encodeURIComponent(msg)}`;
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(msg).then(() => showGreenToast('Login details copied')).catch(() => prompt('Copy these login details:', msg));
  } else {
    prompt('Copy these login details:', msg);
  }
}


// -------------------------------------------------------------------
// PURCHASE ORDERS (merchant PO numbers, logged against the site)
// Numbers look like PO-38392-004 (site number + running count for that site).
// Operatives see only their own POs; Owners/Admins/Managers see all and track status.
// -------------------------------------------------------------------
let allPOs = [];
let poUnsub = null;
let poModalSiteId = null;
let lastPONumber = '';

function startPOSync() {
  if (poUnsub || !db || !currentUser) return;
  const col = db.collection('purchase_orders');
  const query = isManagementUser(currentUser) ? col : col.where('requested_by_id', '==', String(currentUser.id));
  poUnsub = query.onSnapshot(snapshot => {
    allPOs = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    if (activeSiteId) {
      const site = allSites.find(s => parseInt(s.id) === parseInt(activeSiteId));
      if (site) { renderPOTab(site); renderSiteFinance(site); }
    }
    refreshFinanceViews();
  }, err => console.warn('Firestore purchase_orders error:', err));
}

function stopPOSync() {
  if (poUnsub) poUnsub();
  poUnsub = null;
  allPOs = [];
}

function formatPounds(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '' : '£' + n.toFixed(2);
}

function renderPOTab(site) {
  const host = document.getElementById('poTabContainer');
  if (!host || !currentUser) return;
  if (isTypingIn('poTabContainer')) { uiRefreshPending = true; return; }
  const isMgr = isManagementUser(currentUser);
  const list = allPOs
    .filter(po => String(po.site_id) === String(site.id))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const liveTotal = key => list.filter(po => po.status !== 'Cancelled').reduce((sum, po) => sum + (parseFloat(po[key]) || 0), 0);
  const totalsHtml = isMgr && list.length
    ? `<p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 12px;">${list.filter(po => po.status !== 'Cancelled').length} active POs · Estimated ${formatPounds(liveTotal('est_value')) || '£0.00'} · Invoiced ${formatPounds(liveTotal('invoice_value')) || '£0.00'}</p>`
    : '';

  const itemsHtml = list.length === 0
    ? '<p style="color: var(--text-muted);">No purchase orders for this site yet.</p>'
    : list.map(po => {
        const cancelled = po.status === 'Cancelled';
        const mgrControls = isMgr ? `
          <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; align-items: center;">
            <select class="form-control po-status" data-po="${diaryEsc(po.id)}" style="width: auto; min-height: 32px; padding: 2px 8px; font-size: 0.85rem;">
              ${['Requested', 'Collected', 'Invoiced', 'Cancelled'].map(st => `<option value="${st}"${po.status === st ? ' selected' : ''}>${st}</option>`).join('')}
            </select>
            <input type="text" inputmode="decimal" autocomplete="off" step="0.01" min="0" class="form-control po-invoice" data-po="${diaryEsc(po.id)}" value="${po.invoice_value != null ? po.invoice_value : ''}" placeholder="Invoice £" style="width: 120px; min-height: 32px; padding: 2px 8px; font-size: 0.85rem;">
          </div>` : `<div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">Status: ${diaryEsc(po.status || 'Requested')}</div>`;
        return `<div class="diary-agenda-item" style="cursor: default;${cancelled ? ' opacity: 0.55;' : ''}">
          <div style="display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
            <strong style="font-size: 1.05rem;">${diaryEsc(po.po_number)}</strong>
            <span style="color: var(--text-muted); font-size: 0.85rem;">${diaryEsc(formatUKDateTime(po.created_at) || '')}</span>
          </div>
          <div style="margin-top: 2px;"><strong>${diaryEsc(po.merchant)}</strong>${po.est_value != null ? ' · est. ' + diaryEsc(formatPounds(po.est_value)) : ''}</div>
          <div style="font-size: 0.9rem; margin-top: 2px;">${diaryEsc(po.description)}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">Requested by ${diaryEsc(po.requested_by_name || 'Unknown')}</div>
          ${po.invoice_no ? `<div style="font-size: 0.8rem; margin-top: 2px;">🧾 Invoice ${diaryEsc(po.invoice_no)}${po.invoice_value != null ? ' · ' + diaryEsc(formatPounds(po.invoice_value)) + ' ex VAT' : ''}${po.invoice_gross != null ? ' (' + diaryEsc(formatPounds(po.invoice_gross)) + ' inc VAT)' : ''}</div>` : ''}
          ${mgrControls}
        </div>`;
      }).join('');

  host.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
      <p style="color: var(--text-muted);">${isMgr ? 'All purchase orders raised for this site' : 'Your purchase orders for this site'}</p>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button type="button" class="btn btn-primary btn-sm" id="btnNewPO">🧾 Request PO number</button>
      </div>
    </div>
    ${totalsHtml}
    ${itemsHtml}`;

  host.querySelector('#btnNewPO').onclick = () => openPOModal(parseInt(site.id));
  host.querySelectorAll('.po-status').forEach(sel => sel.addEventListener('change', () => updatePO(sel.dataset.po, { status: sel.value })));
  host.querySelectorAll('.po-invoice').forEach(inp => inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    updatePO(inp.dataset.po, { invoice_value: isNaN(v) ? null : v });
  }));
}

async function updatePO(id, fields) {
  if (!db || !isManagementUser(currentUser)) return;
  await db.collection('purchase_orders').doc(String(id)).update(fields).catch(err => alert('Could not save: ' + err.message));
}

function openPOModal(siteId) {
  const site = allSites.find(s => parseInt(s.id) === parseInt(siteId));
  if (!site) return;
  poModalSiteId = siteId;
  document.getElementById('poSiteLine').textContent = `${formatSiteId(site.id)} - ${site.address}`;
  document.getElementById('poForm').style.display = '';
  document.getElementById('poResult').style.display = 'none';
  document.getElementById('poMerchantInput').value = '';
  document.getElementById('poDescInput').value = '';
  document.getElementById('poValueInput').value = '';
  document.getElementById('btnSubmitPO').disabled = false;
  document.getElementById('btnSubmitPO').textContent = 'Get PO Number';
  const merchants = Array.from(new Set(allPOs.map(po => po.merchant).filter(Boolean)));
  document.getElementById('poMerchantList').innerHTML = merchants.map(m => `<option value="${diaryEsc(m)}"></option>`).join('');
  openModal('modalPO');
}

async function handleRequestPO(e) {
  e.preventDefault();
  const site = allSites.find(s => parseInt(s.id) === parseInt(poModalSiteId));
  if (!site || !db || !currentUser) { alert('Not connected - please try again.'); return; }
  const btn = document.getElementById('btnSubmitPO');
  btn.disabled = true;
  btn.textContent = 'Getting number...';
  try {
    // A per-site counter in a transaction so two people can never get the same number
    const counterRef = db.collection('po_counters').doc(String(site.id));
    const seq = await db.runTransaction(async tx => {
      const snap = await tx.get(counterRef);
      const n = snap.exists ? (snap.data().next || 1) : 1;
      tx.set(counterRef, { next: n + 1 });
      return n;
    });
    const poNumber = `PO-${site.id}-${String(seq).padStart(3, '0')}`;
    const value = parseFloat(document.getElementById('poValueInput').value);
    const po = {
      po_number: poNumber,
      seq,
      site_id: String(site.id),
      site_address: site.address,
      requested_by_id: String(currentUser.id),
      requested_by_name: currentUser.full_name,
      merchant: document.getElementById('poMerchantInput').value.trim(),
      description: document.getElementById('poDescInput').value.trim(),
      est_value: isNaN(value) ? null : value,
      invoice_value: null,
      status: 'Requested',
      created_at: new Date().toISOString()
    };
    await db.collection('purchase_orders').doc(poNumber).set(po);
    lastPONumber = poNumber;
    document.getElementById('poForm').style.display = 'none';
    document.getElementById('poResult').style.display = '';
    document.getElementById('poResultNumber').textContent = poNumber;
    document.getElementById('poResultDetail').textContent = `${po.merchant} · ${site.address}`;
  } catch (err) {
    alert('Could not create the PO: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Get PO Number';
  }
}

function copyPONumber() {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(lastPONumber).then(() => showGreenToast('PO number copied')).catch(() => prompt('Copy this PO number:', lastPONumber));
  } else {
    prompt('Copy this PO number:', lastPONumber);
  }
}


// -------------------------------------------------------------------
// INVOICE IMPORT (Owner / Admin / Manager). Reads a text PDF in the browser (pdf.js, free),
// finds the PO reference or delivery address, and the price excluding VAT, then the person confirms.
// -------------------------------------------------------------------
let pdfJsPromise = null;

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfJsPromise) {
    pdfJsPromise = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = '/pdf.min.js';
      el.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      el.onerror = () => reject(new Error('Could not load the PDF reader'));
      document.head.appendChild(el);
    });
  }
  return pdfJsPromise;
}

async function extractPdfLines(file) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const rows = {};
    content.items.forEach(it => {
      const y = Math.round(it.transform[5]);
      (rows[y] = rows[y] || []).push([it.transform[4], it.str]);
    });
    Object.keys(rows).map(Number).sort((a, b) => b - a).forEach(y => {
      const text = rows[y].sort((a, b) => a[0] - b[0]).map(x => x[1]).join(' ').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    });
  }
  return lines;
}

function parseInvoiceText(lines) {
  const money = /(?:£\s*)?(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\b/g;
  const lastAmount = line => {
    const found = [...line.matchAll(money)];
    return found.length ? parseFloat(found[found.length - 1][1].replace(/,/g, '')) : null;
  };
  const findAmount = patterns => {
    for (const pat of patterns) {
      for (const line of lines) {
        if (pat.test(line)) {
          const v = lastAmount(line);
          if (v != null) return v;
        }
      }
    }
    return null;
  };

  let net = findAmount([/total goods/i, /total\s*(ex|excl)/i, /sub\s*-?\s*total/i, /net\s*(total|amount|value)/i, /goods\s*(value|total)?\s*:/i]);
  let vat = findAmount([/total vat/i, /vat\s*(total|amount)/i, /^vat\s*:/i]);
  let gross = findAmount([/inv(oice)?\s*total/i, /total\s*(inc|incl)/i, /amount due/i, /balance due/i, /total due/i, /grand total/i, /^total\s*:?\s*£/i]);
  let netEstimated = false;
  if (net == null && gross != null && vat != null) net = Math.round((gross - vat) * 100) / 100;
  if (net == null && gross != null) {
    const rateLine = lines.find(l => /rate\s*%\s*:/i.test(l));
    const rate = rateLine ? parseFloat((rateLine.match(/(\d+(?:\.\d+)?)\s*$/) || [])[1]) : 20;
    net = Math.round(gross / (1 + (rate || 20) / 100) * 100) / 100;
    netEstimated = true;
  }
  if (vat == null && net != null && gross != null) vat = Math.round((gross - net) * 100) / 100;
  const totalsAgree = net != null && vat != null && gross != null && Math.abs(net + vat - gross) < 0.02;

  const text = lines.join('\n');
  const po = (text.match(/\bPO-\d{4,6}-\d{3,4}\b/i) || [])[0] || null;
  const invNo = ((text.match(/invoice\s*(?:no|number|#)\.?\s*:?\s*([A-Z0-9][A-Z0-9\/\-]{2,})/i)) || [])[1] || null;
  const dateMatch = text.match(/invoice\s*date[^0-9\n]*(\d{2})\/(\d{2})\/(\d{4})/i);
  const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null;
  let merchant = ((text.match(/Account Name:\s*(.+?)\s*\.?\s*$/im)) || [])[1] || null;
  if (!merchant) merchant = ((text.match(/([A-Z][A-Za-z&' ]+(?:Limited|Ltd|LLP|PLC))\.?\s*Registered/)) || [])[1] || null;

  // Delivery block text used for matching the job by address
  const deliverIdx = lines.findIndex(l => /deliver(y)?\s*to/i.test(l));
  const deliverText = deliverIdx >= 0 ? lines.slice(deliverIdx, deliverIdx + 8).join(' ') : text;

  return { net, vat, gross, netEstimated, totalsAgree, po: po ? po.toUpperCase() : null, invNo, date, merchant, deliverText, hasText: text.length > 40 };
}

function matchSiteByAddress(text, sites) {
  const hay = ' ' + text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ') + ' ';
  let best = null;
  sites.forEach(site => {
    const tokens = Array.from(new Set(String(site.address || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 1)));
    if (tokens.length < 3) return;
    const hit = tokens.filter(t => hay.includes(' ' + t + ' ')).length;
    const score = hit / tokens.length;
    if (score >= 0.7 && (!best || score > best.score)) best = { site, score };
  });
  return best ? best.site : null;
}

// ---- Batch import ----
let invBatch = [];

function invSiteOptions(selectedId) {
  return `<option value="">Choose job...</option>` + allSites.filter(x => !x.is_archived || String(x.id) === String(selectedId))
    .map(x => `<option value="${diaryEsc(x.id)}"${String(x.id) === String(selectedId) ? ' selected' : ''}>${diaryEsc(x.address)}</option>`).join('');
}

function invPoOptions(siteId, selectedPo) {
  const pos = allPOs.filter(po => String(po.site_id) === String(siteId) && po.status !== 'Cancelled')
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return `<option value="">➕ No PO - record as new invoice</option>` + pos.map(po =>
    `<option value="${diaryEsc(po.po_number)}"${po.po_number === selectedPo ? ' selected' : ''}>${diaryEsc(po.po_number)} - ${diaryEsc(po.merchant)} - ${diaryEsc(String(po.description || '').slice(0, 30))}</option>`).join('');
}

function analyseInvoice(parsed) {
  const matchedPo = parsed.po ? allPOs.find(po => String(po.po_number).toUpperCase() === parsed.po) : null;
  let site = matchedPo ? allSites.find(s => String(s.id) === String(matchedPo.site_id)) : null;
  let how = matchedPo ? `✅ PO ${matchedPo.po_number} found on the invoice` : '';
  if (!site) {
    site = matchSiteByAddress(parsed.deliverText, allSites.filter(s => !s.is_archived));
    if (site) how = `📍 No PO number found - matched from the delivery address`;
  }
  if (!site) how = parsed.po ? `⚠️ ${parsed.po} is on the invoice but not in the app - choose the job` : '⚠️ No PO number or matching address found - choose the job';
  const duplicate = parsed.invNo && allPdfs.some(f => f.file_type === 'invoice' && f.invoice_no === parsed.invNo);
  const priceOk = parsed.net != null && parsed.hasText;
  const confident = !!site && priceOk && parsed.totalsAgree && !parsed.netEstimated && !duplicate;
  return { matchedPo, site, how, duplicate, confident };
}

function suggestContractor(merchant) {
  const m = String(merchant || '').toLowerCase();
  if (!m) return '';
  const hit = priceWorkUsers().find(u => {
    const tokens = String(u.full_name).toLowerCase().split(/\s+/).filter(t => t.length > 2);
    return tokens.length && tokens.every(t => m.includes(t));
  });
  return hit ? String(hit.id) : '';
}

async function handleInvoiceBatchPicked(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  document.getElementById('invBatchReading').style.display = '';
  invBatch = [];
  for (const file of files) {
    const item = { key: 'b' + Date.now() + Math.random().toString(36).slice(2, 6), file, status: 'ready', message: '' };
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      item.status = 'error'; item.message = 'Not a PDF';
    } else if (file.size > MAX_SITE_FILE_MB * 1024 * 1024) {
      item.status = 'error'; item.message = `Over ${MAX_SITE_FILE_MB}MB`;
    } else {
      let parsed;
      try { parsed = parseInvoiceText(await extractPdfLines(file)); }
      catch (err) { parsed = { net: null, vat: null, gross: null, po: null, invNo: null, merchant: null, date: null, deliverText: '', hasText: false }; }
      const a = analyseInvoice(parsed);
      Object.assign(item, {
        parsed, how: a.how, duplicate: a.duplicate, confident: a.confident,
        siteId: a.site ? String(a.site.id) : '', poNumber: a.matchedPo ? a.matchedPo.po_number : '',
        net: parsed.net, vat: parsed.vat, gross: parsed.gross, invNo: parsed.invNo || '',
        merchant: parsed.merchant || (a.matchedPo ? a.matchedPo.merchant : '') || '', date: parsed.date || '',
        selected: a.confident,
        contractorId: suggestContractor(parsed.merchant),
        priceNote: !parsed.hasText ? 'Looks like a scan/photo - type the price in.' : parsed.net == null ? 'Price not found - type it in.'
          : parsed.netEstimated ? 'Net price estimated from the total - check it.' : parsed.totalsAgree ? '' : 'Check the amounts.'
      });
    }
    invBatch.push(item);
  }
  document.getElementById('invBatchReading').style.display = 'none';
  e.target.value = '';
  renderInvBatch();
}

function renderInvBatch() {
  const host = document.getElementById('invBatchList');
  const btn = document.getElementById('btnInvImportSelected');
  if (!invBatch.length) { host.innerHTML = ''; btn.style.display = 'none'; return; }
  host.innerHTML = invBatch.map(it => {
    if (it.status === 'error') return `<div class="diary-agenda-item" style="cursor: default; border-color: var(--danger);">❌ ${diaryEsc(it.file.name)} - ${diaryEsc(it.message)}</div>`;
    if (it.status === 'done') return `<div class="diary-agenda-item" style="cursor: default; border-color: var(--success);">✅ ${diaryEsc(it.file.name)} - ${diaryEsc(it.message)}</div>`;
    return `<div class="diary-agenda-item" data-key="${it.key}" style="cursor: default;${it.confident ? ' border-color: var(--success);' : ' border-color: var(--warning);'}">
      <label style="display: flex; gap: 8px; align-items: center; font-weight: 700;"><input type="checkbox" class="inv-select"${it.selected ? ' checked' : ''}> ${diaryEsc(it.file.name)}</label>
      <div style="font-size: 0.8rem; margin: 4px 0;">${diaryEsc(it.how)}${it.duplicate ? ' · ⚠️ invoice number already imported' : ''}${it.priceNote ? ' · ' + diaryEsc(it.priceNote) : ''}</div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px;">
        <select class="form-control inv-site" style="min-height: 34px; padding: 4px 8px;">${invSiteOptions(it.siteId)}</select>
        <select class="form-control inv-po" style="min-height: 34px; padding: 4px 8px;">${invPoOptions(it.siteId, it.poNumber)}</select>
        <select class="form-control inv-contractor" style="min-height: 34px; padding: 4px 8px;">${contractorOptionsHtml(it.contractorId)}</select>
        <input class="form-control inv-merchant" placeholder="Merchant" value="${diaryEsc(it.merchant)}" style="min-height: 34px; padding: 4px 8px;">
        <input class="form-control inv-no" placeholder="Invoice no." value="${diaryEsc(it.invNo)}" style="min-height: 34px; padding: 4px 8px;">
        <input type="text" inputmode="decimal" autocomplete="off" step="0.01" min="0" class="form-control inv-net" placeholder="Net £ ex VAT" value="${it.net != null ? Number(it.net).toFixed(2) : ''}" style="min-height: 34px; padding: 4px 8px;">
        <input type="text" inputmode="decimal" autocomplete="off" step="0.01" min="0" class="form-control inv-vat" placeholder="VAT £" value="${it.vat != null ? Number(it.vat).toFixed(2) : ''}" style="min-height: 34px; padding: 4px 8px;">
        <input type="text" inputmode="decimal" autocomplete="off" step="0.01" min="0" class="form-control inv-gross" placeholder="Total £" value="${it.gross != null ? Number(it.gross).toFixed(2) : ''}" style="min-height: 34px; padding: 4px 8px;">
      </div>
    </div>`;
  }).join('');
  btn.style.display = invBatch.some(i => i.status === 'ready') ? '' : 'none';

  host.querySelectorAll('[data-key]').forEach(row => {
    const it = invBatch.find(x => x.key === row.dataset.key);
    const bind = (sel, fn) => row.querySelector(sel).addEventListener('change', fn);
    bind('.inv-select', ev => { it.selected = ev.target.checked; });
    bind('.inv-site', ev => { it.siteId = ev.target.value; it.poNumber = ''; row.querySelector('.inv-po').innerHTML = invPoOptions(it.siteId, ''); });
    bind('.inv-po', ev => { it.poNumber = ev.target.value; });
    bind('.inv-contractor', ev => { it.contractorId = ev.target.value; });
    bind('.inv-merchant', ev => { it.merchant = ev.target.value.trim(); });
    bind('.inv-no', ev => { it.invNo = ev.target.value.trim(); });
    bind('.inv-net', ev => { it.net = ev.target.value === '' ? null : parseFloat(ev.target.value); });
    bind('.inv-vat', ev => { it.vat = ev.target.value === '' ? null : parseFloat(ev.target.value); });
    bind('.inv-gross', ev => { it.gross = ev.target.value === '' ? null : parseFloat(ev.target.value); });
  });
}

async function recalcPoFromInvoices(poNumber, extraFiles = []) {
  const files = allPdfs.filter(f => f.file_type === 'invoice' && f.po_number === poNumber && !extraFiles.some(x => x.id === f.id)).concat(extraFiles);
  const sum = key => Math.round(files.reduce((t, f) => t + (parseFloat(f[key]) || 0), 0) * 100) / 100;
  if (!files.length) return { status: 'Requested', invoice_value: null, invoice_vat: null, invoice_gross: null, invoice_no: null, invoice_file_id: null };
  return {
    status: 'Invoiced', invoice_value: sum('invoice_net'), invoice_vat: sum('invoice_vat'), invoice_gross: sum('invoice_gross'),
    invoice_no: files.map(f => f.invoice_no).filter(Boolean).join(', ') || null, invoice_file_id: files[files.length - 1].id,
    invoiced_at: new Date().toISOString()
  };
}

async function importInvoiceItem(it) {
  const site = allSites.find(s => String(s.id) === String(it.siteId));
  if (!site) throw new Error('Choose the job');
  if (it.net == null || isNaN(it.net)) throw new Error('Enter the net price');
  const fileId = 'pdf_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const safeName = it.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `site_files/${site.id}/${fileId}_${safeName}`;
  const up = await uploadSiteFile(path, it.file);
  const net = Math.round(it.net * 100) / 100;
  const poNumber = it.poNumber || `INV-${String(it.invNo || Date.now()).replace(/[^A-Za-z0-9]/g, '')}`;
  const record = {
    id: fileId, site_id: String(site.id), uploader_id: currentUser.id, uploader_name: currentUser.full_name,
    filename: it.file.name, file_type: 'invoice', file_url: up.url, storage_bucket: up.bucket, storage_path: path,
    po_number: poNumber, invoice_no: it.invNo || '', merchant: it.merchant || '', invoice_date: it.date || '', contractor_id: it.contractorId || null,
    invoice_net: net, invoice_vat: it.vat == null || isNaN(it.vat) ? null : it.vat, invoice_gross: it.gross == null || isNaN(it.gross) ? null : it.gross,
    created_at: new Date().toISOString()
  };
  await db.collection('pdfs').doc(fileId).set(record);
  const fields = await recalcPoFromInvoices(poNumber, [record]);
  if (it.poNumber) {
    await db.collection('purchase_orders').doc(poNumber).update(fields);
  } else {
    await db.collection('purchase_orders').doc(poNumber).set({
      po_number: poNumber, seq: null, site_id: String(site.id), site_address: site.address,
      requested_by_id: String(currentUser.id), requested_by_name: currentUser.full_name,
      merchant: it.merchant || 'Unknown merchant', description: `Invoice ${it.invNo || ''} (no PO)`.trim(), est_value: null,
      created_at: new Date().toISOString(), ...fields
    });
  }
  return `${formatPounds(net)} ex VAT added to ${site.address}`;
}

async function handleImportSelectedInvoices() {
  if (!db || !isManagementUser(currentUser)) return;
  const todo = invBatch.filter(i => i.status === 'ready' && i.selected);
  if (!todo.length) { alert('Tick the invoices you want to import.'); return; }
  const btn = document.getElementById('btnInvImportSelected');
  btn.disabled = true;
  let ok = 0;
  for (const it of todo) {
    btn.textContent = `Importing ${ok + 1} of ${todo.length}...`;
    try {
      it.message = await importInvoiceItem(it);
      it.status = 'done';
      ok++;
    } catch (err) {
      alert(`${it.file.name}: ${err.message}`);
    }
  }
  btn.disabled = false;
  btn.textContent = 'Import ticked invoices';
  renderInvBatch();
  if (ok) showGreenToast(`🧾 ${ok} invoice${ok > 1 ? 's' : ''} imported and costed to the job`);
}

// ---- Register ----
function renderInvoicesView() {
  if (!currentUser || !isManagementUser(currentUser)) return;
  const siteSel = document.getElementById('invFilterSite');
  const merchSel = document.getElementById('invFilterMerchant');
  const invoices = allPdfs.filter(f => f.file_type === 'invoice');
  const prevSite = siteSel.value, prevMerch = merchSel.value;
  siteSel.innerHTML = '<option value="">All jobs</option>' + allSites.map(s => `<option value="${diaryEsc(s.id)}">${diaryEsc(s.address)}</option>`).join('');
  const merchants = Array.from(new Set(invoices.map(f => invMerchantOf(f)).filter(Boolean))).sort();
  merchSel.innerHTML = '<option value="">All merchants</option>' + merchants.map(m => `<option value="${diaryEsc(m)}">${diaryEsc(m)}</option>`).join('');
  siteSel.value = prevSite; merchSel.value = prevMerch;
  renderInvoiceRegister();
}

function invMerchantOf(f) {
  if (f.merchant) return f.merchant;
  const po = allPOs.find(p => p.po_number === f.po_number);
  return po ? po.merchant : '';
}

function renderInvoiceRegister() {
  const body = document.getElementById('invRegisterBody');
  if (!body) return;
  const q = (document.getElementById('invSearch').value || '').toLowerCase();
  const siteF = document.getElementById('invFilterSite').value;
  const merchF = document.getElementById('invFilterMerchant').value;
  const rows = allPdfs.filter(f => f.file_type === 'invoice')
    .filter(f => !siteF || String(f.site_id) === siteF)
    .filter(f => !merchF || invMerchantOf(f) === merchF)
    .filter(f => !q || [f.invoice_no, f.po_number, invMerchantOf(f), f.filename].join(' ').toLowerCase().includes(q))
    .sort((a, b) => String(b.invoice_date || b.created_at).localeCompare(String(a.invoice_date || a.created_at)));
  const sum = key => rows.reduce((t, f) => t + (parseFloat(f[key]) || 0), 0);
  document.getElementById('invRegisterSummary').textContent = rows.length
    ? `${rows.length} invoice${rows.length > 1 ? 's' : ''} · Net ${formatPounds(sum('invoice_net'))} · VAT ${formatPounds(sum('invoice_vat'))} · Total ${formatPounds(sum('invoice_gross'))}`
    : 'No invoices found.';
  const canDelete = isOwnerOrAdminUser(currentUser);
  body.innerHTML = rows.map(f => {
    const site = allSites.find(s => String(s.id) === String(f.site_id));
    return `<tr>
      <td>${diaryEsc(formatUKDate(f.invoice_date || f.created_at))}</td>
      <td data-label="Invoice">${diaryEsc(f.invoice_no || '-')}</td>
      <td data-label="Merchant">${diaryEsc(invMerchantOf(f) || '-')}</td>
      <td data-label="PO">${diaryEsc(String(f.po_number || '').startsWith('INV-') ? 'No PO' : f.po_number)}</td>
      <td data-label="Job">${diaryEsc(site ? site.address : 'Unknown job')}</td>
      <td data-label="Net £"><strong>${diaryEsc(formatPounds(f.invoice_net) || '-')}</strong></td>
      <td data-label="VAT £">${diaryEsc(formatPounds(f.invoice_vat) || '-')}</td>
      <td data-label="Total £">${diaryEsc(formatPounds(f.invoice_gross) || '-')}</td>
      <td style="white-space: nowrap;"><a class="btn btn-outline btn-sm" href="/files/${encodeURIComponent(f.id)}" target="_blank">Open</a>${canDelete ? ` <button type="button" class="btn btn-danger btn-sm inv-delete" data-id="${diaryEsc(f.id)}">Delete</button>` : ''}</td>
    </tr>`;
  }).join('');
  body.querySelectorAll('.inv-delete').forEach(b => b.addEventListener('click', () => deleteInvoice(b.dataset.id)));
}

async function deleteInvoice(fileId) {
  const f = allPdfs.find(x => String(x.id) === String(fileId));
  if (!f || !isOwnerOrAdminUser(currentUser) || !confirm('Delete this invoice and take its cost off the job?')) return;
  if (f.storage_path && typeof firebase.storage === 'function') {
    await getStorageForBucket(f.storage_bucket || STORAGE_BUCKETS[0]).ref(f.storage_path).delete().catch(console.warn);
  }
  await db.collection('pdfs').doc(String(f.id)).delete();
  allPdfs = allPdfs.filter(x => String(x.id) !== String(f.id));
  const po = allPOs.find(p => p.po_number === f.po_number);
  if (po) {
    const remaining = allPdfs.filter(x => x.file_type === 'invoice' && x.po_number === po.po_number);
    if (String(po.po_number).startsWith('INV-') && remaining.length === 0) {
      await db.collection('purchase_orders').doc(po.po_number).delete().catch(console.warn);
    } else {
      await db.collection('purchase_orders').doc(po.po_number).update(await recalcPoFromInvoices(po.po_number)).catch(console.warn);
    }
  }
  renderInvoiceRegister();
}

function setupInvoiceListeners() {
  document.getElementById('invBatchInput').addEventListener('change', handleInvoiceBatchPicked);
  document.getElementById('btnInvImportSelected').addEventListener('click', handleImportSelectedInvoices);
  ['invSearch', 'invFilterSite', 'invFilterMerchant'].forEach(id => {
    document.getElementById(id).addEventListener(id === 'invSearch' ? 'input' : 'change', renderInvoiceRegister);
  });
}


// -------------------------------------------------------------------
// FINANCE (Owner / Admin / Manager only)
// Stored in finance_jobs / finance_costs / finance_rates, which are only ever loaded for management
// logins, never for operatives. Day rates are kept out of the users collection for the same reason.
// -------------------------------------------------------------------
let financeJobs = {};
let financeCosts = [];
let financeRates = {};
let financePay = {};
let financeUnsubs = [];

function startFinanceSync() {
  if (financeUnsubs.length || !db || !currentUser || !isManagementUser(currentUser)) return;
  const warn = name => err => console.warn(`Firestore ${name} error:`, err);
  financeUnsubs.push(db.collection('finance_jobs').onSnapshot(snap => {
    financeJobs = {};
    snap.docs.forEach(d => { financeJobs[d.id] = d.data(); });
    refreshFinanceViews();
  }, warn('finance_jobs')));
  financeUnsubs.push(db.collection('finance_costs').onSnapshot(snap => {
    financeCosts = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    refreshFinanceViews();
  }, warn('finance_costs')));
  financeUnsubs.push(db.collection('finance_rates').onSnapshot(snap => {
    financeRates = {};
    financePay = {};
    snap.docs.forEach(d => {
      const v = parseFloat(d.data().day_rate);
      if (!isNaN(v)) financeRates[d.id] = v;
      financePay[d.id] = d.data().pay_type === 'price' ? 'price' : 'day';
    });
    refreshFinanceViews();
  }, warn('finance_rates')));
}

function stopFinanceSync() {
  financeUnsubs.forEach(u => u());
  financeUnsubs = [];
  financeJobs = {};
  financeCosts = [];
  financeRates = {};
  financePay = {};
}

let uiRefreshPending = false;

// True while the user is typing in a box inside this container (so we don't redraw it under them)
function isTypingIn(containerId) {
  const a = document.activeElement;
  const box = document.getElementById(containerId);
  return !!(a && box && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && box.contains(a));
}

function refreshFinanceViews() {
  if (!currentUser || !isManagementUser(currentUser)) return;
  const v = document.getElementById('view-finance');
  if (v && v.style.display !== 'none') renderFinanceView();
  if (activeSiteId) {
    const site = allSites.find(x => parseInt(x.id) === parseInt(activeSiteId));
    if (site) renderSiteFinance(site);
  }
}

function money(v) {
  const n = parseFloat(v) || 0;
  return (n < 0 ? '-£' : '£') + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function computeSiteFinance(site) {
  const sid = String(site.id);
  const pos = allPOs.filter(po => String(po.site_id) === sid && po.status !== 'Cancelled');
  const invoiced = pos.filter(po => po.invoice_value != null).reduce((t, po) => t + (parseFloat(po.invoice_value) || 0), 0);
  const onOrder = pos.filter(po => po.invoice_value == null && po.est_value != null).reduce((t, po) => t + (parseFloat(po.est_value) || 0), 0);
  const extrasList = financeCosts.filter(c => String(c.site_id) === sid);
  const extras = extrasList.reduce((t, c) => t + (parseFloat(c.amount) || 0), 0);

  // Only shifts up to and including today count. Future (planned) shifts are shown separately and not costed.
  const todayKey = diaryDateKey(new Date());
  const byOp = {};
  let labour = 0, labourPlanned = 0;
  const noRate = new Set();
  allShifts.filter(sh => String(sh.site_id) === sid && sh.operative_id && !sh.is_drying_day).forEach(sh => {
    const frac = sh.shift_period === 'am' || sh.shift_period === 'pm' ? 0.5 : 1;
    const rate = financeRates[String(sh.operative_id)];
    const priceWork = financePay[String(sh.operative_id)] === 'price';
    const isFuture = (sh.shift_date || '') > todayKey;
    const cost = priceWork ? 0 : (rate || 0) * frac;
    if (isFuture) { labourPlanned += cost; return; }
    const u = allUsers.find(x => String(x.id) === String(sh.operative_id));
    const name = u ? u.full_name : 'Unknown';
    if (rate == null && !priceWork) noRate.add(name);
    const row = byOp[sh.operative_id] = byOp[sh.operative_id] || { name, days: 0, cost: 0, priceWork };
    row.days += frac;
    row.cost += cost;
    labour += cost;
  });

  const value = financeJobs[sid] && financeJobs[sid].job_value != null ? parseFloat(financeJobs[sid].job_value) : null;
  const totalCost = invoiced + onOrder + labour + extras;
  const profit = value != null ? value - totalCost : null;
  const margin = value ? (profit / value) * 100 : null;
  // Price-work people: what has been invoiced or logged against them on this job (already inside the totals above)
  const contractorTotals = {};
  allPdfs.filter(f => f.file_type === 'invoice' && String(f.site_id) === sid && f.contractor_id).forEach(f => {
    contractorTotals[f.contractor_id] = (contractorTotals[f.contractor_id] || 0) + (parseFloat(f.invoice_net) || 0);
  });
  extrasList.filter(c => c.contractor_id).forEach(c => {
    contractorTotals[c.contractor_id] = (contractorTotals[c.contractor_id] || 0) + (parseFloat(c.amount) || 0);
  });
  const contractors = Object.keys(contractorTotals).map(id => {
    const u = allUsers.find(x => String(x.id) === String(id));
    return { name: u ? u.full_name : 'Unknown', total: contractorTotals[id] };
  });
  return { contractors, value, invoiced, onOrder, labour, labourPlanned, extras, extrasList, byOp: Object.values(byOp), noRate: Array.from(noRate), totalCost, profit, margin };
}

function profitColor(v) {
  return v == null ? 'var(--text-muted)' : v < 0 ? '#ef4444' : '#10b981';
}

function marginText(m) {
  return m == null || isNaN(m) ? '-' : m.toFixed(1) + '%';
}

// ---- Per-site Finance tab ----
function renderSiteFinance(site) {
  const host = document.getElementById('financeTabContainer');
  if (!host) return;
  if (isTypingIn('financeTabContainer')) { uiRefreshPending = true; return; }
  if (!currentUser || !isManagementUser(currentUser)) { host.innerHTML = ''; return; }
  const f = computeSiteFinance(site);

  const row = (label, val, sub) => `<tr><td>${label}${sub ? `<div style="font-size: 0.75rem; color: var(--text-muted);">${sub}</div>` : ''}</td><td style="text-align: right; white-space: nowrap;">${val}</td></tr>`;
  const labourRows = f.byOp.map(o => `<tr><td>${diaryEsc(o.name)}</td><td>${o.days} day${o.days === 1 ? '' : 's'}</td><td style="text-align: right;">${o.priceWork ? '<span style="color: var(--text-muted);">Price work - see invoices</span>' : money(o.cost)}</td></tr>`).join('');
  const contractorRows = f.contractors.map(c => `<tr><td>${diaryEsc(c.name)}</td><td style="text-align: right;">${money(c.total)}</td></tr>`).join('');
  const costRows = f.extrasList.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.created_at || '').localeCompare(String(a.created_at || ''))).map(c => `<tr>
      <td>${diaryEsc(formatUKDate(c.date))}</td><td>${diaryEsc(c.description)}<div style="font-size: 0.75rem; color: var(--text-muted);">${diaryEsc(c.category || '')}</div></td>
      <td style="text-align: right;">${money(c.amount)}</td>
      <td style="white-space: nowrap;"><button type="button" class="btn btn-outline btn-sm fin-edit-cost" data-id="${diaryEsc(c.id)}" style="padding: 2px 8px;">Edit</button> <button type="button" class="btn btn-danger btn-sm fin-del-cost" data-id="${diaryEsc(c.id)}" style="padding: 2px 8px;">Delete</button></td></tr>`).join('');

  host.innerHTML = `
    <div class="site-card" style="margin-bottom: 16px;">
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <label for="finJobValue" style="font-weight: 700;">Job value (quote) £ ex VAT</label>
        <input type="text" inputmode="decimal" autocomplete="off" id="finJobValue" class="form-control" step="0.01" min="0" value="${f.value != null ? f.value : ''}" placeholder="e.g. 10000" style="width: 180px;">
      </div>
      ${f.value == null ? '<p style="color: var(--warning); font-size: 0.85rem; margin-top: 8px;">Enter the job value to see profit and margin.</p>' : ''}
    </div>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 16px;">
      <div class="site-card"><div style="font-size: 0.75rem; color: var(--text-muted);">JOB VALUE</div><div style="font-size: 1.3rem; font-weight: 800;">${f.value != null ? money(f.value) : '-'}</div></div>
      <div class="site-card"><div style="font-size: 0.75rem; color: var(--text-muted);">TOTAL COST</div><div style="font-size: 1.3rem; font-weight: 800;">${money(f.totalCost)}</div></div>
      <div class="site-card"><div style="font-size: 0.75rem; color: var(--text-muted);">${f.profit != null && f.profit < 0 ? 'LOSS' : 'PROFIT'}</div><div style="font-size: 1.3rem; font-weight: 800; color: ${profitColor(f.profit)};">${f.profit != null ? money(f.profit) : '-'}</div></div>
      <div class="site-card"><div style="font-size: 0.75rem; color: var(--text-muted);">MARGIN</div><div style="font-size: 1.3rem; font-weight: 800; color: ${profitColor(f.profit)};">${marginText(f.margin)}</div></div>
    </div>

    <div class="site-card" style="margin-bottom: 16px;">
      <h4 style="margin-bottom: 8px;">Where the money goes</h4>
      <table class="planner-table" style="min-width: 0;"><tbody>
        ${row('Materials invoiced', money(f.invoiced), 'From imported invoices (ex VAT)')}
        ${row('Materials on order', money(f.onOrder), 'POs raised but not yet invoiced (estimates)')}
        ${row('Labour', money(f.labour), f.labourPlanned > 0 ? `Shifts up to today only. ${money(f.labourPlanned)} of future shifts not counted yet` : 'Shifts up to and including today')}
        ${row('Extra costs', money(f.extras))}
        ${row('<strong>Total cost</strong>', '<strong>' + money(f.totalCost) + '</strong>')}
      </tbody></table>
      ${f.noRate.length ? `<p style="color: var(--warning); font-size: 0.85rem; margin-top: 8px;">⚠️ No day rate set for: ${diaryEsc(f.noRate.join(', '))}. Their shifts cost £0 until a rate is added (Admin Settings, or the Finance page).</p>` : ''}
    </div>

    ${contractorRows ? `<div class="site-card" style="margin-bottom: 16px;"><h4 style="margin-bottom: 8px;">Price work paid (ex VAT)</h4><table class="planner-table" style="min-width: 0;"><tbody>${contractorRows}</tbody></table><p style="color: var(--text-muted); font-size: 0.75rem; margin-top: 6px;">Already included in materials / extra costs above.</p></div>` : ''}
    <div class="site-card" style="margin-bottom: 16px;">
      <h4 style="margin-bottom: 8px;">Labour on this job</h4>
      ${labourRows ? `<table class="planner-table" style="min-width: 0;"><tbody>${labourRows}</tbody></table>` : '<p style="color: var(--text-muted);">No shifts with a day rate yet.</p>'}
    </div>

    <div class="site-card">
      <h4 style="margin-bottom: 8px;">Extra costs</h4>
      <form id="finSiteCostForm" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 10px;">
        <input type="text" id="finSiteCostDesc" class="form-control" placeholder="Description" required>
        <select id="finSiteCostContractor" class="form-control">${contractorOptionsHtml('')}</select>
        <select id="finSiteCostCategory" class="form-control"><option>Materials</option><option>Plant / equipment hire</option><option>Subcontractor</option><option>Waste / skips</option><option>Travel / fuel</option><option>Other</option></select>
        <input type="text" inputmode="decimal" autocomplete="off" id="finSiteCostAmount" class="form-control" step="0.01" min="0" placeholder="£ ex VAT" required>
        <input type="date" id="finSiteCostDate" class="form-control" value="${diaryDateKey(new Date())}" required>
        <button type="submit" class="btn btn-primary">+ Add cost</button>
      </form>
      ${costRows ? `<div style="overflow: auto; max-height: 300px; border: 1px solid var(--border-color); border-radius: var(--radius-sm);"><table class="planner-table" style="min-width: 0;"><tbody>${costRows}</tbody></table></div>` : '<p style="color: var(--text-muted);">No extra costs logged.</p>'}
    </div>`;

  host.querySelector('#finJobValue').addEventListener('change', ev => saveJobValue(site.id, ev.target.value));
  host.querySelector('#finSiteCostForm').addEventListener('submit', ev => {
    ev.preventDefault();
    addFinanceCost(site.id, host.querySelector('#finSiteCostDesc').value, host.querySelector('#finSiteCostCategory').value,
      host.querySelector('#finSiteCostAmount').value, host.querySelector('#finSiteCostDate').value, host.querySelector('#finSiteCostContractor').value);
  });
  host.querySelectorAll('.fin-del-cost').forEach(b => b.addEventListener('click', () => deleteFinanceCost(b.dataset.id)));
  host.querySelectorAll('.fin-edit-cost').forEach(b => b.addEventListener('click', () => openCostEdit(b.dataset.id)));
}

async function saveJobValue(siteId, raw) {
  if (!db || !isManagementUser(currentUser)) return;
  const v = raw === '' ? null : parseFloat(raw);
  await db.collection('finance_jobs').doc(String(siteId)).set({ site_id: String(siteId), job_value: isNaN(v) ? null : v, updated_at: new Date().toISOString() }, { merge: true })
    .catch(err => alert('Could not save: ' + err.message));
}

function priceWorkUsers() {
  return allUsers.filter(u => u.status === 'Active' && financePay[String(u.id)] === 'price')
    .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
}

function contractorOptionsHtml(selected) {
  return '<option value="">Paid to: nobody in particular</option>' + priceWorkUsers()
    .map(u => `<option value="${diaryEsc(u.id)}"${String(u.id) === String(selected) ? ' selected' : ''}>Paid to: ${diaryEsc(u.full_name)}</option>`).join('');
}

async function addFinanceCost(siteId, description, category, amount, date, contractorId) {
  if (!db || !isManagementUser(currentUser)) return;
  const amt = parseFloat(amount);
  if (!description.trim() || isNaN(amt) || !date) { alert('Please fill in the description, amount and date.'); return; }
  const id = 'cost_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  await db.collection('finance_costs').doc(id).set({
    site_id: String(siteId), description: description.trim(), category, amount: Math.round(amt * 100) / 100, date,
    contractor_id: contractorId || null,
    added_by: currentUser.full_name, created_at: new Date().toISOString()
  }).catch(err => alert('Could not save: ' + err.message));
  showGreenToast('Cost added');
}

async function deleteFinanceCost(id) {
  if (!db || !isManagementUser(currentUser) || !confirm('Delete this cost?')) return;
  await db.collection('finance_costs').doc(String(id)).delete().catch(console.warn);
}

// ---- Full Finance page ----
function renderFinanceView(force) {
  if (!currentUser || !isManagementUser(currentUser)) return;
  if (!force && isTypingIn('view-finance')) { uiRefreshPending = true; return; }
  const statusF = document.getElementById('finFilterStatus').value;
  const q = (document.getElementById('finSearch').value || '').toLowerCase();
  const sites = allSites
    .filter(s => statusF === 'all' || (statusF === 'archived' ? s.is_archived : !s.is_archived))
    .filter(s => !q || String(s.address).toLowerCase().includes(q))
    .sort((a, b) => String(a.address).localeCompare(String(b.address)));
  const data = sites.map(s => ({ site: s, f: computeSiteFinance(s) }));

  const tot = data.reduce((t, d) => {
    if (d.f.value != null) { t.value += d.f.value; t.costOfValued += d.f.totalCost; }
    t.cost += d.f.totalCost;
    return t;
  }, { value: 0, cost: 0, costOfValued: 0 });
  const profit = tot.value - tot.costOfValued;
  const margin = tot.value ? profit / tot.value * 100 : null;
  const box = (label, val, color) => `<div class="site-card"><div style="font-size: 0.75rem; color: var(--text-muted);">${label}</div><div style="font-size: 1.3rem; font-weight: 800;${color ? ` color: ${color};` : ''}">${val}</div></div>`;
  document.getElementById('finSummary').innerHTML =
    box('TOTAL JOB VALUE (jobs with a value)', money(tot.value)) + box('TOTAL COST (all shown jobs)', money(tot.cost)) +
    box(profit < 0 ? 'LOSS (jobs with a value)' : 'PROFIT (jobs with a value)', money(profit), profitColor(profit)) + box('MARGIN', marginText(margin), profitColor(profit));

  document.getElementById('finJobsBody').innerHTML = data.length ? data.map(({ site, f }) => `<tr class="fin-job-row" data-site="${diaryEsc(site.id)}" style="cursor: pointer;">
      <td><strong>${diaryEsc(site.address)}</strong>${site.is_archived ? ' <small>(archived)</small>' : ''}</td>
      <td data-label="Job value">${f.value != null ? money(f.value) : '<span style="color: var(--warning);">not set</span>'}</td>
      <td data-label="Materials invoiced">${money(f.invoiced)}</td><td data-label="On order">${money(f.onOrder)}</td><td data-label="Labour">${money(f.labour)}</td><td data-label="Extra costs">${money(f.extras)}</td>
      <td data-label="Total cost"><strong>${money(f.totalCost)}</strong></td>
      <td data-label="Profit / loss" style="color: ${profitColor(f.profit)}; font-weight: 700;">${f.profit != null ? money(f.profit) : '-'}</td>
      <td data-label="Margin" style="color: ${profitColor(f.profit)}; font-weight: 700;">${marginText(f.margin)}</td></tr>`).join('')
    : '<tr><td colspan="9" style="color: var(--text-muted);">No jobs found.</td></tr>';
  document.querySelectorAll('.fin-job-row').forEach(r => r.addEventListener('click', () => openSiteFinance(r.dataset.site)));

  // Cost form site list + ledger
  const costSite = document.getElementById('finCostSite');
  const prev = costSite.value;
  costSite.innerHTML = allSites.filter(s => !s.is_archived).map(s => `<option value="${diaryEsc(s.id)}">${diaryEsc(s.address)}</option>`).join('');
  if (prev) costSite.value = prev;
  const contractorSel = document.getElementById('finCostContractor');
  contractorSel.innerHTML = contractorOptionsHtml(contractorSel.value);
  const dateEl = document.getElementById('finCostDate');
  if (!dateEl.value) dateEl.value = diaryDateKey(new Date());
  // Ledger: newest first, optionally one job, scrolls inside its own box
  const costFilter = document.getElementById('finCostFilterSite');
  const prevFilter = costFilter.value;
  costFilter.innerHTML = '<option value="">All jobs</option>' + allSites.map(x => `<option value="${diaryEsc(x.id)}">${diaryEsc(x.address)}</option>`).join('');
  costFilter.value = prevFilter;
  const ledger = financeCosts.filter(c => !costFilter.value || String(c.site_id) === costFilter.value)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const ledgerTotal = ledger.reduce((t, c) => t + (parseFloat(c.amount) || 0), 0);
  document.getElementById('finCostsCount').textContent = `${ledger.length} cost${ledger.length === 1 ? '' : 's'} · ${money(ledgerTotal)} · newest first`;
  document.getElementById('finCostsBody').innerHTML = ledger.map(c => {
      const site = allSites.find(s => String(s.id) === String(c.site_id));
      return `<tr><td>${diaryEsc(formatUKDate(c.date))}</td><td data-label="Job">${diaryEsc(site ? site.address : 'Unknown job')}</td><td data-label="Description">${diaryEsc(c.description)}${c.contractor_id ? ` <small style="color: var(--text-muted);">(${diaryEsc((allUsers.find(u => String(u.id) === String(c.contractor_id)) || {}).full_name || 'Unknown')})</small>` : ''}</td><td data-label="Category">${diaryEsc(c.category || '')}</td><td data-label="Amount">${money(c.amount)}</td>
        <td style="white-space: nowrap;"><button type="button" class="btn btn-outline btn-sm fin-edit-cost" data-id="${diaryEsc(c.id)}" style="padding: 2px 8px;">Edit</button> <button type="button" class="btn btn-danger btn-sm fin-del-cost" data-id="${diaryEsc(c.id)}" style="padding: 2px 8px;">Delete</button></td></tr>`;
    }).join('') || '<tr><td colspan="6" style="color: var(--text-muted);">No extra costs logged.</td></tr>';
  document.querySelectorAll('#finCostsBody .fin-del-cost').forEach(b => b.addEventListener('click', () => deleteFinanceCost(b.dataset.id)));
  document.querySelectorAll('#finCostsBody .fin-edit-cost').forEach(b => b.addEventListener('click', () => openCostEdit(b.dataset.id)));

  // Day rates (Owner / Admin can edit)
  const canEditRates = isOwnerOrAdminUser(currentUser);
  document.getElementById('finRatesCard').style.display = '';
  document.getElementById('finRatesBody').innerHTML = allUsers.filter(u => u.status === 'Active')
    .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))).map(u => {
      const price = financePay[String(u.id)] === 'price';
      const rate = financeRates[String(u.id)];
      return `<tr>
        <td>${diaryEsc(u.full_name)}</td><td data-label="Role">${diaryEsc(u.role)}</td>
        <td data-label="Paid by">${canEditRates
          ? `<select class="form-control fin-paytype" data-user="${diaryEsc(u.id)}" style="min-height: 32px; padding: 2px 8px; width: auto;"><option value="day"${price ? '' : ' selected'}>Day rate</option><option value="price"${price ? ' selected' : ''}>Price work</option></select>`
          : (price ? 'Price work' : 'Day rate')}</td>
        <td data-label="Day rate £">${price ? '<span style="color: var(--text-muted);">invoiced</span>' : canEditRates
          ? `<input type="text" inputmode="decimal" autocomplete="off" class="form-control fin-rate" data-user="${diaryEsc(u.id)}" value="${rate != null ? rate : ''}" placeholder="not set" style="width: 140px; min-height: 32px; padding: 2px 8px;">`
          : (rate != null ? money(rate) : 'not set')}</td></tr>`;
    }).join('');
  document.querySelectorAll('.fin-rate').forEach(inp => inp.addEventListener('change', () => {
    const v = inp.value === '' ? null : parseFloat(inp.value);
    if (v == null || !isNaN(v)) db.collection('finance_rates').doc(String(inp.dataset.user)).set({ user_id: String(inp.dataset.user), day_rate: v }, { merge: true }).catch(console.warn);
  }));
  document.querySelectorAll('.fin-paytype').forEach(sel => sel.addEventListener('change', () => {
    db.collection('finance_rates').doc(String(sel.dataset.user)).set({ user_id: String(sel.dataset.user), pay_type: sel.value }, { merge: true }).catch(console.warn);
  }));
}

function openSiteFinance(siteId) {
  showView('view-projects');
  loadProjectPage(parseInt(siteId));
  const tabBtn = document.getElementById('tabFinanceBtn');
  if (tabBtn) tabBtn.click();
}

function openCostEdit(id) {
  const c = financeCosts.find(x => String(x.id) === String(id));
  if (!c || !isManagementUser(currentUser)) return;
  document.getElementById('costEditId').value = c.id;
  document.getElementById('costEditSite').innerHTML = allSites.map(x => `<option value="${diaryEsc(x.id)}"${String(x.id) === String(c.site_id) ? ' selected' : ''}>${diaryEsc(x.address)}${x.is_archived ? ' (archived)' : ''}</option>`).join('');
  document.getElementById('costEditDesc').value = c.description || '';
  document.getElementById('costEditCategory').value = c.category || 'Other';
  document.getElementById('costEditContractor').innerHTML = contractorOptionsHtml(c.contractor_id);
  document.getElementById('costEditAmount').value = c.amount != null ? c.amount : '';
  document.getElementById('costEditDate').value = c.date || diaryDateKey(new Date());
  openModal('modalCostEdit');
}

async function handleSaveCostEdit(e) {
  e.preventDefault();
  if (!db || !isManagementUser(currentUser)) return;
  const id = document.getElementById('costEditId').value;
  const amt = parseFloat(String(document.getElementById('costEditAmount').value).replace(/[£,\s]/g, ''));
  if (isNaN(amt)) { alert('Please enter a valid amount.'); return; }
  await db.collection('finance_costs').doc(String(id)).update({
    site_id: document.getElementById('costEditSite').value,
    description: document.getElementById('costEditDesc').value.trim(),
    category: document.getElementById('costEditCategory').value,
    contractor_id: document.getElementById('costEditContractor').value || null,
    amount: Math.round(amt * 100) / 100,
    date: document.getElementById('costEditDate').value,
    edited_by: currentUser.full_name,
    edited_at: new Date().toISOString()
  }).catch(err => { alert('Could not save: ' + err.message); });
  closeModal('modalCostEdit');
  showGreenToast('Cost updated');
}

function setupFinanceListeners() {
  document.getElementById('finCostFilterSite').addEventListener('change', renderFinanceView);
  document.getElementById('costEditForm').addEventListener('submit', handleSaveCostEdit);
  document.getElementById('btnCostEditDelete').addEventListener('click', async () => {
    const id = document.getElementById('costEditId').value;
    closeModal('modalCostEdit');
    await deleteFinanceCost(id);
  });
  // Tidy typed amounts like "£1,250.50" into plain numbers
  document.addEventListener('change', ev => {
    const t = ev.target;
    if (t && t.tagName === 'INPUT' && t.getAttribute('inputmode') === 'decimal') t.value = t.value.replace(/[£,\s]/g, '');
  }, true);
  // Redraw anything that was held back while typing
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!uiRefreshPending || isTypingIn('view-finance') || isTypingIn('financeTabContainer') || isTypingIn('poTabContainer') || isTypingIn('plannerTableBody')) return;
      uiRefreshPending = false;
      refreshFinanceViews();
      renderActiveView();
      if (activeSiteId) {
        const site = allSites.find(x => parseInt(x.id) === parseInt(activeSiteId));
        if (site) renderPOTab(site);
      }
    }, 200);
  });

  document.getElementById('finFilterStatus').addEventListener('change', renderFinanceView);
  document.getElementById('finSearch').addEventListener('input', renderFinanceView);
  document.getElementById('finCostForm').addEventListener('submit', ev => {
    ev.preventDefault();
    addFinanceCost(document.getElementById('finCostSite').value, document.getElementById('finCostDesc').value,
      document.getElementById('finCostCategory').value, document.getElementById('finCostAmount').value, document.getElementById('finCostDate').value,
      document.getElementById('finCostContractor').value);
    document.getElementById('finCostDesc').value = '';
    document.getElementById('finCostAmount').value = '';
  });
}
