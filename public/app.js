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
  }, err => console.warn('Firestore shifts error:', err));

  // Real-time Photos Collection Sync
  db.collection('photos').onSnapshot(snapshot => {
    allPhotos = snapshot.docs.map(doc => {
      const d = doc.data();
      return { ...d, id: parseInt(d.id || doc.id) };
    });
    saveLocalStorageData();
    if (activeSiteId) loadProjectPage(activeSiteId);
  }, err => console.warn('Firestore photos error:', err));

  // Real-time PDFs Collection Sync
  db.collection('pdfs').onSnapshot(snapshot => {
    allPdfs = snapshot.docs.map(doc => {
      const d = doc.data();
      return { ...d, id: parseInt(d.id || doc.id) };
    });
    saveLocalStorageData();
    if (activeSiteId) loadProjectPage(activeSiteId);
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

  // Role permissions UI visibility
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isOwnerOrAdmin ? '' : 'none';
  });
  document.querySelectorAll('.manager-admin-only').forEach(el => {
    el.style.display = isManagerOrHigher ? '' : 'none';
  });
  document.querySelectorAll('.op-only').forEach(el => {
    el.style.display = (!isManagerOrHigher) ? '' : 'none';
  });

  updateBrandingUI();
  updatePendingUsersBadge();
  registerDevicePushSubscription(false);
  updateCleanPushUI();

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

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.target === viewId);
  });

  renderActiveView();
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
  const weekDays = getWeekDays(currentPlannerWeekOffset);
  const startDateStr = formatDateShort(weekDays[0]);
  const endDateStr = formatDateShort(weekDays[6]);
  document.getElementById('plannerWeekRangeLabel').textContent = `${startDateStr} — ${endDateStr}`;

  const dock = document.getElementById('activeOperativesDock');
  const activeStaff = getAssignableOperatives();

  dock.innerHTML = activeStaff.map(op => `
    <div class="op-chip" draggable="true" data-op-id="${op.id}" data-op-name="${op.full_name}">
      👤 ${op.full_name} (${op.role})
    </div>
  `).join('');

  dock.querySelectorAll('.op-chip').forEach(chip => {
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('type', 'NEW_OPERATIVE');
      e.dataTransfer.setData('opId', chip.dataset.opId);
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
  });

  const todayISO = formatDateISO(new Date());

  const headerRow = document.getElementById('plannerTableHeaderRow');
  headerRow.innerHTML = `
    <th class="site-col">Site / Property</th>
    ${weekDays.map(d => {
      const dStr = formatDateISO(d);
      const isToday = dStr === todayISO;
      return `<th class="date-col ${isToday ? 'today-col-header' : ''}">${formatDateShort(d)}</th>`;
    }).join('')}
  `;

  const tbody = document.getElementById('plannerTableBody');
  const activeSites = allSites.filter(site => !site.is_archived);
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
        return `
          <div class="shift-card" draggable="true" data-shift-id="${s.id}">
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
        <td class="planner-day-cell ${isToday ? 'today-day-cell' : ''}" data-site-id="${site.id}" data-date="${dateStr}">
          ${cardsHtml}
        </td>
      `;
    }).join('');

    return `
      <tr>
        <td class="site-cell-header">
          <span class="site-badge">${formatSiteId(site.id)}</span>
          <strong>${site.address}</strong>
          <span class="site-type-badge ${site.construction_type.toLowerCase()}">${site.construction_type}</span>
        </td>
        ${cellsHtml}
      </tr>
    `;
  }).join('');

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

      if (type === 'NEW_OPERATIVE') {
        const opId = e.dataTransfer.getData('opId');
        openCreateShiftModal(targetSiteId, opId, targetDate);
      } else if (type === 'EXISTING_SHIFT') {
        const shiftId = parseInt(e.dataTransfer.getData('shiftId'));
        const shift = allShifts.find(s => parseInt(s.id) === shiftId);
        if (shift) {
          const oldDate = shift.shift_date;
          shift.site_id = targetSiteId;
          shift.shift_date = targetDate;
          shift.seen_at = null; // Reset seen status!

          if (isDraftPlanningMode) {
            shift.draft_pending = true;
          } else {
            shift.draft_pending = false;
          }

          if (db) {
            await db.collection('shifts').doc(String(shift.id)).set(shift);
          }
          saveLocalStorageData();
          renderActiveView();

          const todayStr = new Date().toISOString().split('T')[0];
          if (targetDate >= todayStr) {
            if (isDraftPlanningMode) {
              showGreenToast('🛠️ Shift Moved (Draft Mode — Notifications Paused)');
            } else {
              triggerShiftNotification(shift, `📅 Shift Date Changed to ${targetDate}`);
              showGreenToast('⚡ Live Cloud Updated — Operative Notified!');
            }
          }
        }
      }
    });
  });
}

function setupPlannerClickHandlers() {
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
    <button class="mobile-day-btn ${index === selectedMobileDayIndex ? 'active' : ''}" data-day-index="${index}">
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

  const activeSites = allSites.filter(site => !site.is_archived);
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
              return `
                <div class="shift-card" style="margin-top: 8px;">
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
function renderMyShiftsView() {
  const container = document.getElementById('myShiftsContainer');
  if (!currentUser) return;
  const myShifts = allShifts.filter(s => String(s.operative_id) === String(currentUser.id));

  // Automatically mark shifts as SEEN when operative opens the app / views their shifts
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
        <h3>No Upcoming Shifts</h3>
        <p>You have no assigned shifts at this time.</p>
      </div>
    `;
  } else {
    container.innerHTML = myShifts.map(s => {
      const site = allSites.find(st => parseInt(st.id) === parseInt(s.site_id));
      const periodBadge = formatShiftPeriodBadge(s.shift_period);
      const isSeen = s.seen_at && s.updated_at && s.seen_at >= s.updated_at;
      return `
        <div class="site-card shift-op-card" data-shift-id="${s.id}" data-site-id="${s.site_id}" style="cursor: pointer;">
          <div class="site-card-header">
            <div>
              <span class="site-badge">${formatSiteId(s.site_id)}</span>
              ${periodBadge}
            </div>
          </div>
          <h3 style="font-size: 1.1rem; font-weight: 700; margin-bottom: 6px;">${site ? site.address : 'Site Address'}</h3>
          <p style="color: var(--primary); font-weight: 600; font-size: 0.95rem; margin-bottom: 10px;">📅 ${formatUKDate(s.shift_date)}</p>
          <div style="background-color: var(--bg-primary); padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); margin-bottom: 10px;">
            <strong style="font-size: 0.8rem; color: var(--text-muted);">TASK:</strong>
            <p style="margin-top: 2px; font-size: 0.9rem;">${s.task}</p>
          </div>
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
            <span class="site-type-badge ${site.construction_type.toLowerCase()}">${site.construction_type}</span>
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
  document.getElementById('projSiteTypeBadge').textContent = site.construction_type;
  document.getElementById('projSiteTypeBadge').className = `site-type-badge ${site.construction_type.toLowerCase()}`;

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

  renderProjectTabContent(site);
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
          <img src="${p.data_url}" class="photo-img" alt="Project Photo" title="Click to enlarge & download">
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

  imgEl.src = photo.data_url;
  const filename = photo.original_name || photo.filename || `Site_Photo_${photo.id}.png`;
  
  dlBtn.onclick = (e) => {
    e.preventDefault();
    forceDownloadFile(filename, photo.data_url, 'image/png');
  };

  metaEl.innerHTML = `Uploaded by <strong>${photo.uploader_name || 'Operative'}</strong> on ${formatUKDate(photo.created_at)}`;

  const canDelete = isManagementUser(currentUser) || String(photo.uploader_id) === String(currentUser.id);
  if (canDelete) {
    delBtn.style.display = 'inline-flex';
    delBtn.onclick = async () => {
      if (confirm('Delete this photo permanently?')) {
        closeModal('modalPhotoLightbox');
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
      return `
        <div class="pdf-item">
          <div class="pdf-info">
            <span class="pdf-icon">📄</span>
            <div>
              <div class="pdf-name">${pdf.filename}</div>
              <div class="pdf-meta-details">Uploaded by ${pdf.uploader_name || 'Staff'} on ${formatUKDate(pdf.created_at)}</div>
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary btn-sm download-pdf-btn" data-pdf-id="${pdf.id}">View / Download PDF</button>
            ${canDelete ? `<button class="btn btn-danger btn-sm delete-pdf-btn" data-pdf-id="${pdf.id}">Delete</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    pdfList.querySelectorAll('.download-pdf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pdfId = String(btn.dataset.pdfId);
        const pdf = allPdfs.find(p => String(p.id) === pdfId);
        if (pdf) {
          forceDownloadFile(pdf.filename, pdf.data_url, 'application/pdf');
        }
      });
    });

    pdfList.querySelectorAll('.delete-pdf-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Delete this PDF document?')) {
          const pdfId = String(btn.dataset.pdfId);
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
        <td class="labour-cell">
          ${badgesHtml || '<span style="color: var(--border-color); font-size: 0.75rem;">—</span>'}
        </td>
      `;
    }).join('');

    return `
      <tr>
        <td style="font-weight: 700;">👤 ${op.full_name} <span style="font-size: 0.75rem; color: var(--text-muted);">(${op.role})</span></td>
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

  const tbody = document.getElementById('adminUserTableBody');
  if (allUsers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">No registered users found.</td></tr>`;
    return;
  }

  tbody.innerHTML = allUsers.map(user => {
    const jobTitle = user.job_title || (user.email === 'phil@gvdcontracts.com' ? 'Managing Director' : user.role);
    return `
      <tr style="${user.status === 'Pending' ? 'background-color: rgba(245, 158, 11, 0.08);' : ''}">
        <td>
          <strong>${user.full_name}</strong>
          ${user.status === 'Pending' ? '<span style="display: block; font-size: 0.72rem; color: #f59e0b;">⏳ Awaiting Approval</span>' : ''}
        </td>
        <td>
          <input type="text" class="form-control job-title-input" data-user-id="${user.id}" value="${jobTitle}" placeholder="e.g. Managing Director" style="min-height: 36px; padding: 4px 8px; font-size: 0.85rem;">
        </td>
        <td>${user.email}</td>
        <td>${user.phone}</td>
        <td>
          <select class="form-control role-select" data-user-id="${user.id}" style="min-height: 36px; padding: 4px 8px; font-size: 0.85rem;">
            <option value="Operative" ${user.role === 'Operative' ? 'selected' : ''}>Operative</option>
            <option value="Manager" ${user.role === 'Manager' ? 'selected' : ''}>Manager</option>
            <option value="Admin" ${user.role === 'Admin' ? 'selected' : ''}>Admin</option>
            <option value="Owner" ${user.role === 'Owner' ? 'selected' : ''}>Owner</option>
          </select>
        </td>
        <td>
          <select class="form-control status-select" data-user-id="${user.id}" style="min-height: 36px; padding: 4px 8px; font-size: 0.85rem;">
            <option value="Pending" ${user.status === 'Pending' ? 'selected' : ''}>Pending</option>
            <option value="Active" ${user.status === 'Active' ? 'selected' : ''}>Active</option>
            <option value="Restricted" ${user.status === 'Restricted' ? 'selected' : ''}>Restricted</option>
          </select>
        </td>
        <td>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            ${user.status === 'Pending' ? `<button class="btn btn-primary btn-sm approve-user-btn" data-user-id="${user.id}" style="background-color: #10b981; border-color: #10b981; font-size: 0.8rem; padding: 4px 8px;">✅ Approve</button>` : ''}
            <button class="btn btn-danger btn-sm remove-user-btn" data-user-id="${user.id}" ${String(user.id) === String(currentUser.id) ? 'disabled' : ''} style="font-size: 0.8rem; padding: 4px 8px;">
              Remove
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.job-title-input').forEach(input => {
    input.addEventListener('change', async () => {
      const user = allUsers.find(u => String(u.id) === input.dataset.userId);
      if (user) {
        user.job_title = input.value.trim();
        if (db) await db.collection('users').doc(String(user.id)).update({ job_title: user.job_title });
        saveLocalStorageData();
        showGreenToast(`Updated job title for ${user.full_name}: ${user.job_title}`);
      }
    });
  });

  tbody.querySelectorAll('.approve-user-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const user = allUsers.find(u => String(u.id) === btn.dataset.userId);
      if (user) {
        user.status = 'Active';
        if (db) await db.collection('users').doc(String(user.id)).update({ status: 'Active' });
        saveLocalStorageData();
        renderActiveView();
      }
    });
  });

  tbody.querySelectorAll('.role-select').forEach(select => {
    select.addEventListener('change', async () => {
      const user = allUsers.find(u => String(u.id) === select.dataset.userId);
      if (user) {
        user.role = select.value;
        if (db) await db.collection('users').doc(String(user.id)).update({ role: select.value });
        saveLocalStorageData();
        renderActiveView();
      }
    });
  });

  tbody.querySelectorAll('.status-select').forEach(select => {
    select.addEventListener('change', async () => {
      const user = allUsers.find(u => String(u.id) === select.dataset.userId);
      if (user) {
        user.status = select.value;
        if (db) await db.collection('users').doc(String(user.id)).update({ status: select.value });
        saveLocalStorageData();
        renderActiveView();
      }
    });
  });

  tbody.querySelectorAll('.remove-user-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('Remove this user account? Historical shifts will be preserved.')) {
        const userId = btn.dataset.userId;
        if (db) await db.collection('users').doc(String(userId)).delete();
        allUsers = allUsers.filter(u => String(u.id) !== String(userId));
        saveLocalStorageData();
        renderActiveView();
      }
    });
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
  document.getElementById('custPubTypeBadge').textContent = site.construction_type;
  document.getElementById('custPubTypeBadge').className = `site-type-badge ${site.construction_type.toLowerCase()}`;

  const siteShifts = allShifts.filter(s => parseInt(s.site_id) === parseInt(site.id));
  const container = document.getElementById('custPubShiftsContainer');

  if (siteShifts.length === 0) {
    container.innerHTML = `<p style="color: #64748b; padding: 20px;">No current works scheduled for this property.</p>`;
  } else {
    container.innerHTML = siteShifts.map(s => {
      const op = allUsers.find(u => String(u.id) === String(s.operative_id));
      const periodBadge = s.shift_period === 'am' ? 'AM' : (s.shift_period === 'pm' ? 'PM' : 'All Day');
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
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
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
  document.getElementById('btnOpenCreateSiteModal').addEventListener('click', () => openModal('modalCreateSite'));
  document.getElementById('btnPrintA4').addEventListener('click', () => window.print());

  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
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
        op ? op.full_name : 'Unassigned',
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

    const construction_type = document.querySelector('input[name="constructionType"]:checked').value;
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

function handlePhotoUpload(e) {
  const file = e.target.files[0];
  if (!file || !activeSiteId) return;

  const reader = new FileReader();
  reader.onload = async (evt) => {
    const nextPhotoId = 'photo_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const newPhoto = {
      id: nextPhotoId,
      site_id: String(activeSiteId),
      uploader_id: currentUser.id,
      uploader_name: currentUser.full_name,
      filename: file.name,
      data_url: evt.target.result,
      created_at: new Date().toISOString()
    };

    if (db) await db.collection('photos').doc(nextPhotoId).set(newPhoto);
    allPhotos.push(newPhoto);
    deduplicatePhotos();
    saveLocalStorageData();
    e.target.value = '';
    showGreenToast('📷 Photo uploaded successfully!');
    loadProjectPage(activeSiteId);
  };
  reader.readAsDataURL(file);
}

function handlePdfUpload(e) {
  const file = e.target.files[0];
  if (!file || !activeSiteId) return;

  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    alert('Only PDF documents are accepted.');
    return;
  }

  const reader = new FileReader();
  reader.onload = async (evt) => {
    const nextPdfId = 'pdf_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const newPdf = {
      id: nextPdfId,
      site_id: String(activeSiteId),
      uploader_id: currentUser.id,
      uploader_name: currentUser.full_name,
      filename: file.name,
      data_url: evt.target.result,
      created_at: new Date().toISOString()
    };

    if (db) await db.collection('pdfs').doc(nextPdfId).set(newPdf);
    allPdfs.push(newPdf);
    saveLocalStorageData();
    e.target.value = '';
    showGreenToast('📄 PDF document uploaded successfully!');
    loadProjectPage(activeSiteId);
  };
  reader.readAsDataURL(file);
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
