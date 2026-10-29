// GVD LIVE Works Planner - Pure Firebase Firestore Real-Time Engine

const firebaseConfig = {
  // Public web identifiers (they ship in every web app); access is controlled by security rules, not by hiding this
  apiKey: "AIzaSyC2nnP8nXrFKw-4JWswddXLfroDD2lBcg0",
  appId: "1:440817107816:web:a000c5685aaf7604a84cdd",
  projectId: "gvd-live",
  authDomain: "gvd-live.firebaseapp.com",
  storageBucket: "gvd-live.appspot.com"
};

// Local testing only: ?emulator=1 on localhost uses the demo-gvd emulator project, so it can never touch production data.
const USE_EMULATOR = location.hostname === 'localhost' && new URLSearchParams(location.search).get('emulator') === '1';
if (USE_EMULATOR) firebaseConfig.projectId = 'demo-gvd';

let db = null;
if (typeof firebase !== 'undefined' && firebase.apps) {
  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }
  db = firebase.firestore();
}

// Sign-in is done by the `login` Cloud Function, which returns a Firebase custom token (role claims inside).
let auth = null;
let fns = null;
if (db) {
  auth = firebase.auth();
  fns = firebase.app().functions('us-central1');
  if (USE_EMULATOR) {
    db.useEmulator('127.0.0.1', 8080);
    auth.useEmulator('http://127.0.0.1:9099');
    fns.useEmulator('127.0.0.1', 5001);
  }
}
let syncStarted = false;
function startSyncOnce() {
  if (syncStarted) return;
  syncStarted = true;
  initFirestoreSync();
}

async function callFn(name, data) {
  try {
    return (await fns.httpsCallable(name)(data || {})).data;
  } catch (err) {
    const known = ['invalid-argument', 'permission-denied', 'not-found', 'already-exists', 'resource-exhausted', 'unauthenticated'];
    const e = new Error(known.includes(String(err.code).replace('functions/', '')) ? err.message : 'Could not reach the server. Please check your connection and try again.');
    e.code = String(err.code || '').replace('functions/', '');
    throw e;
  }
}

// Signs in with a token from login / register / refreshSession and returns the user record
async function signInWithServerSession(res) {
  await auth.signInWithCustomToken(res.token);
  currentUser = res.user;
  localStorage.setItem('gvd_current_user_id', res.user.id);
  return res.user;
}

// Pending accounts wait here; when an administrator approves them we fetch fresh claims and let them in
let approvalUnsub = null;
function watchApproval(userId) {
  if (approvalUnsub) approvalUnsub();
  approvalUnsub = db.collection('users').doc(String(userId)).onSnapshot(async docSnap => {
    if (!docSnap.exists || docSnap.data().status !== 'Active') return;
    try {
      const res = await callFn('refreshSession');
      if (approvalUnsub) { approvalUnsub(); approvalUnsub = null; }
      await signInWithServerSession(res);
      startSyncOnce();
      onUserAuthenticated();
      showGreenToast('🎉 Account Approved! Welcome to Works Planner.');
    } catch (e) { console.warn('Approval refresh failed', e); }
  }, err => console.warn('Approval watch error:', err));
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
// Deleting a site is for Owners only (everyone else archives). The database rules enforce this too.
function isOwnerRole(user) {
  return !!user && (user.role === 'Owner' || user.email === 'phil@gvdcontracts.com');
}
function isManagementUser(user) {
  if (!user) return false;
  return user.role === 'Owner' || user.role === 'Admin' || user.role === 'Manager' || user.email === 'phil@gvdcontracts.com';
}

// ---- Job scope: managers see their own jobs by default, everyone's on request ----
let jobScope = 'mine';
try { jobScope = localStorage.getItem('gvd_job_scope') === 'all' ? 'all' : 'mine'; } catch (e) {}
function managerUsers() { return allUsers.filter(u => isManagementUser(u)).sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))); }
// Jobs with no manager yet show for everyone until someone takes them, so nothing disappears
function siteInScope(site) {
  if (!site) return true;
  if (!currentUser || !isManagementUser(currentUser) || jobScope === 'all') return true;
  return !site.manager_id || String(site.manager_id) === String(currentUser.id);
}
function siteManagerName(site) {
  const u = site && site.manager_id ? allUsers.find(x => String(x.id) === String(site.manager_id)) : null;
  return u ? u.full_name : '';
}
function refreshJobScopeSelects() {
  document.querySelectorAll('.job-scope-select').forEach(sel => {
    sel.innerHTML = '<option value="mine">👤 My jobs</option><option value="all">👥 Everyone\'s jobs</option>';
    sel.value = jobScope;
  });
}
function setJobScope(v) {
  jobScope = v === 'all' ? 'all' : 'mine';
  try { localStorage.setItem('gvd_job_scope', jobScope); } catch (e) {}
  refreshJobScopeSelects();
  renderActiveView();
}

// Managers have the same permissions as Owners and Admins
function isOwnerOrAdminUser(user) {
  if (!user) return false;
  return user.role === 'Owner' || user.role === 'Admin' || user.role === 'Manager' || user.email === 'phil@gvdcontracts.com';
}

function formatSiteId(siteId) {
  // Jobs published from GVD Logic show the Logic reference (e.g. GVD-2026-002) instead of the internal number
  const known = typeof allSites !== 'undefined' && allSites.find(x => parseInt(x.id) === parseInt(siteId));
  if (known && known.logic_ref) return known.logic_ref;
  if (typeof custData !== 'undefined' && custData && custData.site && String(custData.site.id) === String(siteId) && custData.site.logic_ref) return custData.site.logic_ref;
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
    allUsers = (JSON.parse(localStorage.getItem('gvd_users')) || []).map(u => { const c = { ...u }; delete c.password_hash; delete c.temp_password; return c; });
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
      delete d.password_hash; delete d.temp_password; // never keep credentials in memory or the local cache
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
    fsMarkReady('sites');
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
    fsMarkReady('shifts');
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
    fsMarkReady('pdfs');
  }, err => console.warn('Firestore pdfs error:', err));

  // Real-time App Settings Sync
  db.collection('settings').doc('app').onSnapshot(doc => {
    if (doc.exists) {
      appSettings = doc.data();
      saveLocalStorageData();
      updateBrandingUI();
    }
    fsMarkReady('settings');
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

// ---- GVD Hub single sign-on: when this app is opened inside the Hub, the Hub signs management in once and hands us a
// GVD Live ID token. We swap it for a normal session on the server. Only messages from the Hub itself are accepted.
const HUB_ORIGIN = USE_EMULATOR ? 'http://localhost:5056' : 'https://gvd-hub.web.app';
let ssoBusy = false;
// While the Hub is handing over the sign-in, show a plain splash instead of flashing the login page
let ssoSplashTimer = null;
function showSsoSplash() {
  if (document.getElementById('ssoSplash')) return;
  const d = document.createElement('div');
  d.id = 'ssoSplash';
  d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0b1020;color:#8a93b5;display:grid;place-items:center;font:15px -apple-system,BlinkMacSystemFont,sans-serif';
  d.textContent = 'Signing you in…';
  document.body.appendChild(d);
  ssoSplashTimer = setTimeout(hideSsoSplash, 6000);   // never hide the login page for long if the Hub does not answer
}
function hideSsoSplash() {
  clearTimeout(ssoSplashTimer);
  const d = document.getElementById('ssoSplash');
  if (d) d.remove();
}
// Operatives strip above the planner: one scrolling row by default, "Show all" wraps every name (remembered on this device)
function setupOpDockToggle() {
  const dock = document.querySelector('#view-planner .op-dock'), btn = document.getElementById('btnToggleOpDock');
  if (!dock || !btn) return;
  const apply = on => { dock.classList.toggle('expanded', on); btn.textContent = on ? 'Show one row ▴' : 'Show all ▾'; };
  let on = false;
  try { on = localStorage.getItem('gvd_op_dock') === 'all'; } catch (e) {}
  apply(on);
  btn.addEventListener('click', () => { on = !on; apply(on); try { localStorage.setItem('gvd_op_dock', on ? 'all' : 'row'); } catch (e) {} });
}

function setupHubSso() {
  if (window.parent === window || !auth) return;
  showSsoSplash();
  window.addEventListener('message', async e => {
    if (e.origin !== HUB_ORIGIN || !e.data) return;
    if (e.data.type === 'gvd-sso-logout') {
      localStorage.removeItem('gvd_current_user_id');
      await auth.signOut().catch(() => {});
      window.location.reload();
      return;
    }
    if (e.data.type !== 'gvd-sso' || !e.data.idToken || ssoBusy) return;
    ssoBusy = true;
    try {
      const res = await callFn('ssoSession', { idToken: e.data.idToken });
      if (currentUser && String(currentUser.id) === String(res.user.id) && auth.currentUser) { hideSsoSplash(); return; } // already this person
      await signInWithServerSession(res);
      startSyncOnce();
      onUserAuthenticated();
    } catch (err) { console.warn('Hub sign-in failed:', err.message); hideSsoSplash(); }
    finally { ssoBusy = false; }
  });
  window.parent.postMessage({ type: 'gvd-sso-ready' }, HUB_ORIGIN);
}

// -------------------------------------------------------------------
// INITIALIZATION & ROUTING
// -------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  loadLocalStorageData();
  setupEventListeners();
  setupOpDockToggle();
  setupHubSso();
  setupFeedbackListeners();
  setupChatListeners();
  setupCustomerInvoiceListeners();
  registerServiceWorker();

  // Check URL query for customer token (e.g. ?customer=TOKEN). Customers never sign in and never touch the database directly.
  const urlParams = new URLSearchParams(window.location.search);
  const custToken = urlParams.get('customer');
  if (custToken) {
    loadCustomerPublicView(custToken);
    return;
  }

  if (!auth) { showView('view-login'); return; }

  // Restore a signed-in session: Firebase keeps the sign-in, and we ask the server for fresh role claims.
  const fbUser = await new Promise(resolve => { const off = auth.onAuthStateChanged(u => { off(); resolve(u); }); });
  const storedUserId = localStorage.getItem('gvd_current_user_id');
  if (fbUser && storedUserId && fbUser.uid === storedUserId) {
    try {
      const res = await callFn('refreshSession');
      await signInWithServerSession(res);
      if (res.user.status === 'Active') {
        startSyncOnce();
        onUserAuthenticated();
      } else {
        showView('view-awaiting-approval');
        watchApproval(res.user.id);
      }
      return;
    } catch (err) {
      console.warn('Session refresh failed:', err);
      if (err.code === 'unauthenticated' || err.code === 'permission-denied') {
        await auth.signOut().catch(() => {});
        localStorage.removeItem('gvd_current_user_id');
      } else {
        // offline: carry on with the cached record; the data listeners resume when the connection returns
        const cached = allUsers.find(u => String(u.id) === String(storedUserId));
        if (cached && cached.status === 'Active') {
          currentUser = cached;
          startSyncOnce();
          onUserAuthenticated();
          return;
        }
      }
    }
  } else if (storedUserId) {
    localStorage.removeItem('gvd_current_user_id'); // saved before sign-in moved to the server: sign in once more
  }

  showView('view-login');
});

function onUserAuthenticated() {
  if (!currentUser) return;
  requestAnimationFrame(() => requestAnimationFrame(hideSsoSplash));   // lift the splash only once the signed-in screen has painted

  if (currentUser.must_change_password) {
    document.getElementById('appHeader').style.display = 'none';
    showView('view-reset-password');
    return;
  }

  touchLastActive();

  localStorage.setItem('gvd_current_user_id', currentUser.id);
  document.getElementById('appHeader').style.display = 'flex';
  document.getElementById('userNameText').textContent = currentUser.full_name;
  const nameEl = document.getElementById('userNameText');
  nameEl.style.cursor = 'pointer'; nameEl.title = 'My invoice and details';
  nameEl.onclick = () => { activeSiteId = null; showView('view-my-invoice'); };

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
  startFeedbackSync();
  startChatSync();
  if (isManagerOrHigher) startFinanceSync();
  if (typeof startMyInvoiceSync === 'function' && true) startMyInvoiceSync();

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
    btn.classList.toggle('active', btn.dataset.target === viewId || ((viewId === 'view-invoices' || viewId === 'view-reports') && btn.dataset.target === 'view-finance'));
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
  } else if (viewId === 'view-reports') {
    renderReportsView();
  } else if (viewId === 'view-my-invoice') {
    if (typeof renderMyInvoiceView === 'function') renderMyInvoiceView();
  } else if (viewId === 'view-feedback') {
    renderFeedbackView();
  } else if (viewId === 'view-chat') {
    renderChatView(true);
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
const siteInfoOpen = new Set();   // sites whose notes boxes are unfolded, so a redraw does not fold them while someone types
document.addEventListener('toggle', e => {
  const d = e.target;
  if (d && d.classList && d.classList.contains('site-info-details')) { d.open ? siteInfoOpen.add(d.dataset.siteId) : siteInfoOpen.delete(d.dataset.siteId); }
}, true);
function siteInfoEditorHtml(site) {
  const filled = SITE_INFO_FIELDS.filter(([key]) => (site[key] || '').trim()).length;
  return `<details class="site-info-details" data-site-id="${site.id}" ${siteInfoOpen.has(String(site.id)) ? 'open' : ''}><summary>Site info${filled ? ` (${filled} set)` : ''}</summary><div class="site-info-editor" style="margin-top: 6px;">${SITE_INFO_FIELDS.map(([key, label, icon]) => `
    <label style="display: block; font-size: 0.7rem; font-weight: 700; color: var(--text-muted); margin-top: 6px;">${icon} ${label.toUpperCase()}</label>
    <textarea class="form-control site-info-input" data-site-id="${site.id}" data-field="${key}" rows="2" placeholder="Not set" style="font-size: 0.8rem; padding: 4px 6px; min-height: 0; resize: vertical;">${diaryEsc(site[key] || '')}</textarea>`).join('')}</div></details>`;
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

// Status from GVD Logic (Confirmed, WIP, On hold...): shown for jobs published from Logic
const JOB_STATUS_STYLE = { approved: '#dcfce7;color:#166534', wip: '#dbeafe;color:#1e40af', on_hold: '#fef3c7;color:#92400e', awaiting_certs: '#fef3c7;color:#92400e', completed: '#e2e8f0;color:#334155' };
function jobStatusBadgeHtml(site) {
  if (!site || !site.job_status) return '';
  return `<span class="site-type-badge" style="background:${JOB_STATUS_STYLE[site.job_status_key] || '#e2e8f0;color:#334155'}">${diaryEsc(site.job_status)}</span>`;
}
function siteTypeBadgeHtml(site) {
  return (site.construction_type ? `<span class="site-type-badge ${site.construction_type.toLowerCase()}">${site.construction_type}</span>` : '') + jobStatusBadgeHtml(site);
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
  const sites = allSites.filter(site => !site.is_archived && (!currentUser || !isManagementUser(currentUser) || siteInScope(site)));
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

// Each site gets its own stable colour so a site's whole row reads as one block
const SITE_ROW_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#06b6d4', '#a855f7', '#eab308'];
function siteRowColor(siteId) {
  const key = String(siteId);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return SITE_ROW_PALETTE[h % SITE_ROW_PALETTE.length];
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
          <div class="shift-card compact" draggable="true" data-shift-id="${s.id}" style="border-left-color: ${userColor(s.operative_id)}; background-color: ${userColor(s.operative_id)}30;">
            <div class="shift-op-name" style="display:flex; justify-content:space-between; align-items:center;">
              <span>👤 ${opName}</span>
              ${periodBadge}
            </div>
            <div class="shift-task-desc">${s.task}</div>
            <div class="shift-card-foot no-print">
              <div class="shift-seen-status ${s.seen_at ? 'seen' : 'not-seen'}">${seenText}</div>
              <button class="btn btn-outline btn-sm edit-shift-btn" data-shift-id="${s.id}" style="padding: 1px 6px; font-size: 0.7rem;">Edit</button>
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
      <tr class="site-row ${finish && finish.completed ? 'site-completed' : ''}" style="--site-color: ${siteRowColor(site.id)};">
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
const SHIFT_GRACE_DAYS = 3; // operatives keep access to a job (e.g. to attach photos) for this many days after the shift

function renderMyShiftsView() {
  const container = document.getElementById('myShiftsContainer');
  if (!currentUser) return;
  const todayKey = diaryDateKey(new Date());
  const periodRank = { am: 0, all_day: 1, pm: 2 };
  const graceKey = addDaysISO(todayKey, -SHIFT_GRACE_DAYS);
  const upcoming = allShifts
    .filter(s => String(s.operative_id) === String(currentUser.id) && (s.shift_date || '') >= graceKey)
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
        const label = s.shift_date < todayKey ? 'Recent' : s.shift_date === todayKey ? 'Today' : s.shift_date === addDaysISO(todayKey, 1) ? 'Tomorrow' : '';
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
function updateAssignUnassignedBtn() {
  const btn = document.getElementById('btnAssignUnassignedSites');
  if (!btn) return;
  const n = allSites.filter(s => !s.is_archived && !s.manager_id).length;
  btn.style.display = n && currentUser && isManagementUser(currentUser) ? '' : 'none';
  btn.textContent = `Assign ${n} unassigned to me`;
}
async function assignUnassignedToMe() {
  const todo = allSites.filter(s => !s.is_archived && !s.manager_id);
  if (!todo.length || !confirm(`Assign ${todo.length} active job${todo.length > 1 ? 's' : ''} with no manager to ${currentUser.full_name}?`)) return;
  try {
    for (const s of todo) { await db.collection('sites').doc(String(s.id)).update({ manager_id: String(currentUser.id) }); s.manager_id = String(currentUser.id); }
    showGreenToast(`${todo.length} job${todo.length > 1 ? 's' : ''} assigned to you`);
  } catch (err) { alert('Could not assign: ' + err.message); }
  renderSitesList();
}

function renderSitesList() {
  updateAssignUnassignedBtn();
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

  // Managers see their own jobs (plus any not yet given a manager) unless they pick everyone's
  if (isManagementUser(currentUser)) sitesToDisplay = sitesToDisplay.filter(siteInScope);
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

    const deleteBtn = !isOwnerRole(currentUser) ? '' : `<button class="btn btn-danger btn-sm delete-site-card-btn" data-site-id="${site.id}" style="flex: 1; justify-content: center; font-size: 0.85rem; padding: 8px 12px; display: inline-flex; align-items: center; gap: 6px;">🗑️ Delete</button>`;

    return `
      <div class="site-card" data-site-id="${site.id}">
        <div>
          <div class="site-card-header">
            <span class="site-badge">${formatSiteId(site.id)} ${site.is_archived ? '(Archived)' : ''}</span>
            ${siteTypeBadgeHtml(site)}
          </div>
          <h3 class="site-card-address">${site.address}</h3>
          ${isMgmt ? `<select class="form-control site-manager-select" data-site-id="${site.id}" title="Manager responsible for this job" style="margin-top: 8px; min-height: 34px; padding: 4px 8px; font-size: 0.85rem;"><option value="">Manager: not assigned</option>${managerUsers().map(u => `<option value="${diaryEsc(u.id)}"${String(u.id) === String(site.manager_id) ? ' selected' : ''}>Manager: ${diaryEsc(u.full_name)}</option>`).join('')}</select>
          <select class="form-control site-branch-select" data-site-id="${site.id}" title="Branch / department" style="margin-top: 6px; min-height: 34px; padding: 4px 8px; font-size: 0.85rem;"><option value="">Branch: none</option>${repBranches().map(b => `<option value="${diaryEsc(b)}"${(site.branch || '').trim() === b ? ' selected' : ''}>Branch: ${diaryEsc(b)}</option>`).join('')}<option value="__new__">+ New branch...</option></select>` : ''}
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
      if (e.target.closest('.site-manager-select') || e.target.closest('.site-branch-select')) return;
      if (e.target.closest('.archive-site-card-btn') || e.target.closest('.restore-site-card-btn') || e.target.closest('.delete-site-card-btn')) {
        return;
      }
      activeSiteId = parseInt(card.dataset.siteId);
      loadProjectPage(activeSiteId);
    });
  });

  container.querySelectorAll('.site-manager-select').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', async () => {
      const site = allSites.find(x => String(x.id) === String(sel.dataset.siteId));
      if (!site) return;
      site.manager_id = sel.value || null;
      try { await db.collection('sites').doc(String(site.id)).update({ manager_id: site.manager_id }); showGreenToast(site.manager_id ? `Job assigned to ${siteManagerName(site)}` : 'Manager cleared'); }
      catch (err) { alert('Could not save: ' + err.message); }
      renderSitesList();
    });
  });

  container.querySelectorAll('.site-branch-select').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', async () => {
      const site = allSites.find(x => String(x.id) === String(sel.dataset.siteId));
      if (!site) return;
      let v = sel.value;
      if (v === '__new__') { v = (prompt('Name of the new branch / department (e.g. Stoke):') || '').trim(); if (!v) { renderSitesList(); return; } }
      site.branch = v || null;
      try { await db.collection('sites').doc(String(site.id)).update({ branch: site.branch }); showGreenToast(v ? `Branch set to ${v}` : 'Branch cleared'); }
      catch (err) { alert('Could not save: ' + err.message); }
      renderSitesList();
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

      const reportBtnHtml = isOwnerOrAdminUser(currentUser) ? `<button class="btn btn-primary btn-sm" id="btnJobReport">📄 Completed Job Report</button> ` : '';
      actionsContainer.innerHTML = `${reportBtnHtml}${archiveRestoreHtml} ${isOwnerRole(currentUser) ? '<button class="btn btn-danger btn-sm" id="btnDeleteProject">🗑️ Delete Project</button>' : ''}`;
      actionsContainer.style.display = 'flex';

      const repBtn = document.getElementById('btnJobReport');
      if (repBtn) repBtn.onclick = () => downloadJobReport(site, repBtn);

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


// -------------------------------------------------------------------
// COMPLETED JOB REPORT (Owner / Admin): full PDF of a job incl. photos, for the completion folder
// -------------------------------------------------------------------
// Loads a photo (URL or data URL) and returns a downscaled JPEG data URL, or null if it can't be read
async function jobReportPhoto(photo) {
  // Same-origin /files/<id> first (the browser blocks cross-origin reads of the Storage URL), then fall back
  const sources = [];
  if (photo.id && String(photo.id).startsWith('photo_') && photo.storage_path) sources.push(`/files/${encodeURIComponent(photo.id)}`);
  if (photo.data_url) sources.push(photo.data_url);
  if (photo.file_url) sources.push(photo.file_url);
  for (const src of sources) {
    const r = await jobReportPhotoFrom(src);
    if (r) return r;
  }
  return null;
}

async function jobReportPhotoFrom(src) {
  if (!src) return null;
  try {
    let blobUrl = src, made = false;
    if (!src.startsWith('data:')) {
      const res = await fetch(src);
      if (!res.ok) return null;
      blobUrl = URL.createObjectURL(await res.blob()); made = true;
    }
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = blobUrl; });
    const max = 1000, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if (made) URL.revokeObjectURL(blobUrl);
    return { data: c.toDataURL('image/jpeg', 0.78), w: c.width, h: c.height };
  } catch (e) { console.warn('Report photo skipped', e); return null; }
}

async function downloadJobReport(site, btn) {
  if (!isOwnerOrAdminUser(currentUser)) return;
  if (typeof window.jspdf === 'undefined' || typeof window.jspdf.jsPDF === 'undefined') { alert('The PDF library is still loading, please try again.'); return; }
  const original = btn ? btn.textContent : '';
  const setBtn = t => { if (btn) { btn.textContent = t; btn.disabled = t !== original; } };
  try {
    setBtn('⏳ Building report...');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const navy = [15, 23, 42], grey = [100, 116, 139], line = [203, 213, 225];
    const W = 210, M = 15, R = W - M;
    const nowStr = new Date().toLocaleString('en-GB');
    let y = 0;

    const siteShifts = allShifts.filter(s => parseInt(s.site_id) === parseInt(site.id))
      .sort((a, b) => (a.shift_date || '').localeCompare(b.shift_date || ''));
    const workShifts = siteShifts.filter(s => !s.is_drying_day);
    const finishShift = siteShifts.filter(s => s.is_finish).pop();
    const dates = siteShifts.map(s => s.shift_date).filter(Boolean);
    const sitePhotos = allPhotos.filter(p => String(p.site_id) === String(site.id))
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    const sitePdfs = allPdfs.filter(p => String(p.site_id) === String(site.id));
    const sitePOs = allPOs.filter(p => String(p.site_id) === String(site.id));
    const operatives = [...new Set(workShifts.map(s => (allUsers.find(u => String(u.id) === String(s.operative_id)) || {}).full_name).filter(Boolean))];
    const contactIds = Array.isArray(site.customer_contacts) ? site.customer_contacts.map(String) : [];
    const contacts = allUsers.filter(u => contactIds.includes(String(u.id)));

    // ---- header ----
    doc.setFillColor(...navy); doc.rect(0, 0, W, 5, 'F');
    const logo = await getLogoBase64();
    if (logo) {
      const sz = await ciImageSize(logo);
      let w = 50, h = 22;
      if (sz && sz.w && sz.h) { const ar = sz.w / sz.h; if (ar > 50 / 22) { w = 50; h = 50 / ar; } else { h = 22; w = 22 * ar; } }
      try { doc.addImage(logo, 'PNG', M, 12, w, h, undefined, 'FAST'); } catch (e) { /* logo optional */ }
    }
    doc.setTextColor(...navy); doc.setFont('helvetica', 'bold'); doc.setFontSize(20);
    doc.text('JOB COMPLETION REPORT', R, 22, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...grey);
    doc.text(`Generated ${nowStr} by ${currentUser.full_name || 'Admin'}`, R, 28, { align: 'right' });
    doc.setDrawColor(...line); doc.setLineWidth(0.4); doc.line(M, 37, R, 37);

    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...navy);
    const addrLines = doc.splitTextToSize(site.address || '', R - M);
    doc.text(addrLines, M, 46);
    y = 46 + addrLines.length * 6;

    const first = dates[0], last = dates[dates.length - 1];
    const summary = [
      ['Site reference', formatSiteId(site.id)],
      ['Construction type', site.construction_type || '-'],
      ...(site.job_status ? [['Job status (from GVD Logic)', site.job_status]] : []),
      ['Status', site.is_archived ? 'Archived' : (finishShift ? 'Completed' : 'Active')],
      ['First shift', first ? formatUKDate(first) : '-'],
      ['Completed / last shift', finishShift ? formatUKDate(finishShift.shift_date) : (last ? formatUKDate(last) : '-')],
      ['Shifts worked', String(workShifts.length)],
      ['Operatives', operatives.join(', ') || '-'],
      ['Photos on file', String(sitePhotos.length)]
    ];
    if (contacts.length) summary.push(['Customer contact', contacts.map(c => c.full_name + (c.phone ? ' (' + c.phone + ')' : '')).join(', ')]);
    SITE_INFO_FIELDS.forEach(([key, label]) => { if ((site[key] || '').trim()) summary.push([label, site[key].trim()]); });
    doc.autoTable({
      startY: y + 2, body: summary, theme: 'plain', margin: { left: M, right: M },
      styles: { fontSize: 10, cellPadding: 1.8, textColor: [30, 41, 59], overflow: 'linebreak' },
      columnStyles: { 0: { cellWidth: 48, textColor: grey, fontStyle: 'bold' } }
    });
    y = doc.lastAutoTable.finalY + 8;

    // ---- shift history ----
    const section = (title) => {
      if (y > 250) { doc.addPage(); y = 20; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...navy);
      doc.text(title, M, y);
      y += 3;
    };
    const tableStyle = {
      theme: 'grid', margin: { left: M, right: M },
      headStyles: { fillColor: navy, textColor: [255, 255, 255], fontSize: 9 },
      styles: { fontSize: 9, cellPadding: 2.5, textColor: [30, 41, 59], lineColor: [226, 232, 240], lineWidth: 0.2, overflow: 'linebreak' }
    };
    section('Shift history');
    if (siteShifts.length) {
      doc.autoTable({
        ...tableStyle, startY: y,
        head: [['Date', 'Period', 'Operative', 'Task']],
        body: siteShifts.map(s => {
          const op = allUsers.find(u => String(u.id) === String(s.operative_id));
          const per = s.is_drying_day ? '-' : (s.shift_period === 'am' ? 'AM' : s.shift_period === 'pm' ? 'PM' : 'All day');
          return [formatUKDate(s.shift_date), per, s.is_drying_day ? '-' : (op ? op.full_name : 'Unassigned'), (s.is_drying_day ? 'Drying day' : (s.task || '')) + (s.is_finish ? '  [FINISH]' : '')];
        })
      });
      y = doc.lastAutoTable.finalY + 8;
    } else { doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...grey); doc.text('No shifts recorded.', M, y + 5); y += 12; }

    // ---- documents & POs ----
    if (sitePdfs.length || sitePOs.length) {
      section('Documents & purchase orders');
      const rows = [
        ...sitePdfs.map(p => ['Document', p.filename || p.name || 'PDF', p.uploader_name || '', formatUKDate(p.created_at)]),
        ...sitePOs.map(p => ['Purchase order', p.po_number || '', p.requested_by_name || p.requested_by || '', formatUKDate(p.created_at || p.requested_at)])
      ];
      doc.autoTable({ ...tableStyle, startY: y, head: [['Type', 'Reference / file', 'By', 'Date']], body: rows });
      y = doc.lastAutoTable.finalY + 8;
    }

    // ---- photos ----
    doc.addPage(); y = 20;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...navy);
    doc.text(`Photos (${sitePhotos.length})`, M, y); y += 6;
    if (!sitePhotos.length) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...grey);
      doc.text('No photos were uploaded for this job.', M, y + 4);
    }
    const colW = (R - M - 6) / 2, cellH = 78;
    let col = 0, skipped = 0;
    for (let i = 0; i < sitePhotos.length; i++) {
      setBtn(`⏳ Photos ${i + 1}/${sitePhotos.length}...`);
      const p = sitePhotos[i];
      const img = await jobReportPhoto(p);
      if (col === 0 && y + cellH > 280) { doc.addPage(); y = 20; }
      const x = M + col * (colW + 6);
      if (img) {
        const ar = img.w / img.h;
        let w = colW, h = colW / ar;
        if (h > cellH - 10) { h = cellH - 10; w = h * ar; }
        try { doc.addImage(img.data, 'JPEG', x + (colW - w) / 2, y, w, h, undefined, 'FAST'); } catch (e) { skipped++; }
      } else {
        skipped++;
        doc.setDrawColor(...line); doc.rect(x, y, colW, cellH - 10);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...grey);
        doc.text('Photo could not be loaded', x + colW / 2, y + (cellH - 10) / 2, { align: 'center' });
      }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...grey);
      doc.text(`${i + 1}. ${p.uploader_name || 'Operative'} - ${formatUKDate(p.created_at)}`, x, y + cellH - 4);
      if (col === 1) { col = 0; y += cellH; } else col = 1;
    }
    if (skipped) console.warn(`${skipped} photo(s) could not be added to the report`);

    // ---- footer page numbers ----
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...grey);
      doc.text(`${formatSiteId(site.id)} - ${site.address || ''}`.slice(0, 90), M, 289);
      doc.text(`Page ${i} of ${pages}`, R, 289, { align: 'right' });
    }

    const safe = (site.address || 'job').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 50);
    doc.save(`Completion-Report-${formatSiteId(site.id)}-${safe}.pdf`);
    showGreenToast(skipped ? `📄 Report saved (${skipped} photo${skipped > 1 ? 's' : ''} could not be loaded)` : '📄 Completion report saved');
  } catch (err) {
    console.error('Job report error:', err);
    alert('Could not build the report: ' + err.message);
  } finally {
    setBtn(original);
  }
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
  if (!isOwnerRole(currentUser)) { alert('Only an Owner can delete a site. You can archive it instead.'); return; }

  if (!confirm(`Are you sure you want to PERMANENTLY DELETE Site #${site.id} (${site.address})?\n\nThis will remove the site and all its associated shifts, photos and documents from the database. This action cannot be undone.`)) {
    return;
  }

  const wantRef = formatSiteId(site.id);
  const typed = prompt(`Type the site reference (${wantRef}) to confirm the permanent delete:`);
  if (typed === null || typed.trim().toLowerCase() !== String(wantRef).trim().toLowerCase()) {
    if (typed !== null) alert('That did not match, so nothing was deleted.');
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
  loadPushUserIds();
  updatePendingUsersBadge();
  document.getElementById('settingsAppNameInput').value = appSettings.app_name || 'GVD LIVE';
  fillCompanyForm();
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
let custData = null;
let custPollTimer = null;

async function loadCustomerPublicView(token) {
  if (!token) return;
  currentCustomerToken = token;
  document.getElementById('appHeader').style.display = 'none';
  document.querySelectorAll('.app-view, .auth-wrapper').forEach(el => el.style.display = 'none');

  const customerView = document.getElementById('view-customer-public');
  customerView.style.display = 'block';
  if (!custData) customerView.innerHTML = `<div style="text-align: center; margin-top: 60px; color: #64748b; font-size: 1.1rem;">⏳ Loading live project schedule...</div>`;

  try {
    custData = await callFn('customerView', { token });
  } catch (err) {
    if (!custData) {
      customerView.innerHTML = `<div class="alert-box alert-error" style="text-align: center; margin-top: 40px;">${err.code === 'not-found' ? 'Invalid or expired customer schedule link.' : 'Sorry, the schedule could not be loaded. Please try again shortly.'}</div>`;
    }
    return;
  }
  if (!custPollTimer) custPollTimer = setInterval(() => { if (!document.hidden) loadCustomerPublicView(currentCustomerToken); }, 60000);
  const site = custData.site;
  appSettings = { ...appSettings, ...custData.settings };

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

  renderCustomerSchedule(site);

  renderCustomerFeedbackForm(site);
}


let custScheduleTab = 'current';

/** The customer's schedule: today and future days on the main tab; days that have passed move to "Completed" */
function renderCustomerSchedule(site) {
  const container = document.getElementById('custPubShiftsContainer');
  if (!container) return;
  const todayKey = diaryDateKey(new Date());
  const rank = { am: 0, all_day: 1, pm: 2 };
  const siteShifts = (custData && custData.shifts) || [];
  const byDate = (a, b) => (a.shift_date || '').localeCompare(b.shift_date || '') || (rank[a.shift_period] ?? 1) - (rank[b.shift_period] ?? 1);
  const current = siteShifts.filter(s => (s.shift_date || '') >= todayKey).sort(byDate);
  const completed = siteShifts.filter(s => (s.shift_date || '') < todayKey).sort((a, b) => byDate(b, a));

  let tabs = document.getElementById('custPubTabs');
  if (!tabs) {
    tabs = document.createElement('div');
    tabs.id = 'custPubTabs';
    tabs.className = 'cust-tabs';
    container.parentNode.insertBefore(tabs, container);
    tabs.addEventListener('click', e => {
      const b = e.target.closest('[data-cust-tab]');
      if (!b) return;
      custScheduleTab = b.dataset.custTab;
      if (custData) renderCustomerSchedule(custData.site);
    });
  }
  tabs.innerHTML = `
    <button type="button" class="cust-tab ${custScheduleTab === 'current' ? 'active' : ''}" data-cust-tab="current">Current &amp; upcoming (${current.length})</button>
    <button type="button" class="cust-tab ${custScheduleTab === 'completed' ? 'active' : ''}" data-cust-tab="completed">Completed (${completed.length})</button>`;

  const list = custScheduleTab === 'completed' ? completed : current;
  if (list.length === 0) {
    container.innerHTML = `<p style="color: #64748b; padding: 20px;">${custScheduleTab === 'completed' ? 'No completed works yet.' : (siteShifts.length === 0 ? 'No current works scheduled for this property.' : 'No more works are currently scheduled.')}</p>`;
    return;
  }
  const done = custScheduleTab === 'completed';
  container.innerHTML = list.map(s => {
    const periodBadge = s.shift_period === 'am' ? 'AM' : (s.shift_period === 'pm' ? 'PM' : 'All Day');
    const dim = done ? 'opacity: 0.8;' : '';
    if (s.is_drying_day) {
      return `<div class="site-card" style="background-color: #f8fafc; border-color: #e2e8f0; color: #0f172a; ${dim}"><strong style="color: ${done ? '#15803d' : '#2563eb'}; font-size: 1rem;">${done ? '✅' : '📅'} ${formatUKDate(s.shift_date)}</strong><div style="margin-top: 6px; font-weight: 600;">⏳ Drying Day</div></div>`;
    }
    return `
      <div class="site-card" style="background-color: #f8fafc; border-color: #e2e8f0; color: #0f172a; ${dim}">
        <strong style="color: ${done ? '#15803d' : '#2563eb'}; font-size: 1rem;">${done ? '✅' : '📅'} ${formatUKDate(s.shift_date)} (${periodBadge})</strong>
        <div style="margin-top: 6px; font-weight: 600;">Operative: ${s.operative_name ? diaryEsc(s.operative_name) : 'Operative'}</div>
        <div style="margin-top: 4px; color: #475569;">Task: ${diaryEsc(s.task)}</div>
      </div>
    `;
  }).join('');
}

// -------------------------------------------------------------------
// CUSTOMER INVOICES (Admin or higher). A letterheaded PDF invoice for the project total (the job value on the Finance tab).
// Every invoice is saved in `customer_invoices` so it can be downloaded again and numbers never repeat.
// -------------------------------------------------------------------
let customerInvoices = [];

const ciPence = v => Math.round((parseFloat(v) || 0) * 100);
const ciMoney = pence => money((pence || 0) / 100);

function ciCompany() {
  const c = (appSettings && appSettings.company) || {};
  const terms = parseInt(c.terms_days);
  return {
    name: c.name || 'GVD Contracts Ltd', address: c.address || '', phone: c.phone || '', email: c.email || '', web: c.web || '',
    reg_no: c.reg_no || '', vat_no: c.vat_no || '', bank_name: c.bank_name || '', account_name: c.account_name || '',
    sort_code: c.sort_code || '', account_no: c.account_no || '', terms_days: isNaN(terms) ? 30 : terms,
    next_invoice_no: c.next_invoice_no || '', note: c.note || ''
  };
}

function fillCompanyForm() {
  const c = ciCompany();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };
  set('coName', (appSettings.company || {}).name || ''); set('coAddress', c.address); set('coPhone', c.phone); set('coEmail', c.email);
  set('coWeb', c.web); set('coRegNo', c.reg_no); set('coVatNo', c.vat_no); set('coBankName', c.bank_name); set('coAccName', c.account_name);
  set('coSortCode', c.sort_code); set('coAccNo', c.account_no); set('coTermsDays', (appSettings.company || {}).terms_days ?? ''); set('coNextNo', c.next_invoice_no); set('coNote', c.note);
}

async function handleSaveCompany(e) {
  e.preventDefault();
  if (!isOwnerOrAdminUser(currentUser)) return;
  const v = id => (document.getElementById(id).value || '').trim();
  appSettings.company = {
    name: v('coName'), address: v('coAddress'), phone: v('coPhone'), email: v('coEmail'), web: v('coWeb'), reg_no: v('coRegNo'), vat_no: v('coVatNo'),
    bank_name: v('coBankName'), account_name: v('coAccName'), sort_code: v('coSortCode'), account_no: v('coAccNo'),
    terms_days: v('coTermsDays'), next_invoice_no: v('coNextNo'), note: v('coNote')
  };
  if (db) await db.collection('settings').doc('app').set(appSettings);
  saveLocalStorageData();
  showGreenToast('Company details saved');
}

/** Working in whole pence so the figures always add up exactly */
function ciCalc(netPence, mode, rate, cis) {
  const vat = mode === 'standard' ? Math.round(netPence * (parseFloat(rate) || 0) / 100) : 0;
  const total = netPence + vat;
  // CIS is deducted from the labour part of the net only (never materials, never VAT)
  const materials = cis && cis.on ? Math.min(Math.max(cis.materialsPence || 0, 0), netPence) : 0;
  const cisPence = cis && cis.on ? Math.round((netPence - materials) * (parseFloat(cis.rate) || 0) / 100) : 0;
  return { net: netPence, vat, total, materials, cisPence, payable: total - cisPence };
}

function ciCisInput() {
  const on = document.getElementById('ciCis').checked;
  return { on, rate: parseFloat(document.getElementById('ciCisRate').value) || 0, materialsPence: ciPence(document.getElementById('ciMaterials').value) };
}

function ciNextNumber() {
  const nums = customerInvoices.map(i => parseInt(String(i.number).replace(/\D/g, '')) || 0);
  const maxN = nums.length ? Math.max(...nums) : 0;
  const start = parseInt(ciCompany().next_invoice_no) || 1;
  return 'INV-' + String(Math.max(maxN + 1, start)).padStart(4, '0');
}

function ciAddDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return diaryDateKey(d);
}

function ciUpdateTotals() {
  const net = parseInt(document.getElementById('ciNet').dataset.pence || '0');
  const mode = document.getElementById('ciVatMode').value;
  const rate = document.getElementById('ciVatRate').value;
  document.getElementById('ciVatRateGroup').style.display = mode === 'standard' ? '' : 'none';
  const cis = ciCisInput();
  document.getElementById('ciCisGroup').style.display = cis.on ? 'grid' : 'none';
  const c = ciCalc(net, mode, rate, cis);
  const row = (l, v, strong) => `<div style="display: flex; justify-content: space-between; ${strong ? 'font-weight: 800; font-size: 1.1rem; border-top: 1px solid var(--border-color); margin-top: 6px; padding-top: 6px;' : ''}"><span>${l}</span><span>${v}</span></div>`;
  document.getElementById('ciTotals').innerHTML =
    row('Subtotal', ciMoney(c.net)) +
    row(mode === 'standard' ? `VAT (${parseFloat(rate) || 0}%)` : mode === 'reverse' ? 'VAT (domestic reverse charge)' : 'VAT', ciMoney(c.vat)) +
    (cis.on ? row('Total', ciMoney(c.total)) + row(`Less CIS deduction (${cis.rate}% of ${ciMoney(c.net - c.materials)} labour)`, '-' + ciMoney(c.cisPence)) + row('Amount payable', ciMoney(c.payable), true)
            : row('Total due', ciMoney(c.total), true));
}

function openCustomerInvoiceModal(siteId) {
  if (!isOwnerOrAdminUser(currentUser)) return;
  const site = allSites.find(x => parseInt(x.id) === parseInt(siteId));
  if (!site) return;
  const f = computeSiteFinance(site);
  if (f.value == null || !(f.value > 0)) { alert('Enter the Job value first. The invoice is for the project total.'); return; }
  const co = ciCompany();
  const today = diaryDateKey(new Date());
  const net = document.getElementById('ciNet');
  // the project total, or what is still to invoice if an invoice has already gone out (e.g. for a later variation)
  const alreadyInvoiced = customerInvoices.filter(i => String(i.site_id) === String(site.id)).reduce((t, i) => t + (i.net_pence || 0) / 100, 0);
  const toInvoice = alreadyInvoiced > 0 && f.value - alreadyInvoiced > 0.004 ? Math.round((f.value - alreadyInvoiced) * 100) / 100 : f.value;
  net.value = money(toInvoice);
  net.dataset.pence = String(ciPence(toInvoice));
  document.getElementById('ciSiteId').value = String(site.id);
  document.getElementById('ciNumber').value = ciNextNumber();
  document.getElementById('ciDate').value = today;
  document.getElementById('ciDue').value = ciAddDays(today, co.terms_days);
  document.getElementById('ciCustomerName').value = '';
  document.getElementById('ciCustomerAddress').value = '';
  document.getElementById('ciCustomerRef').value = '';
  document.getElementById('ciSiteAddress').value = site.address || '';
  const varText = f.variations.filter(v => v.status === 'approved').map(v => `${v.ref || 'Variation'}: ${v.description} (${money(v.amount)})`).join('\n');
  document.getElementById('ciDescription').value = alreadyInvoiced > 0 && toInvoice !== f.value
    ? `Balance of works at ${site.address || 'site'}${varText ? '\nIncluding variations:\n' + varText : ''}`
    : `Works at ${site.address || 'site'}${varText ? '\nIncluding variations:\n' + varText : ''}`;
  document.getElementById('ciVatMode').value = 'standard';
  document.getElementById('ciVatRate').value = '20';
  document.getElementById('ciCis').checked = false;
  document.getElementById('ciCisRate').value = '20';
  document.getElementById('ciMaterials').value = '0';
  document.getElementById('ciNotes').value = co.note || '';
  const warn = [];
  if (!co.address || !co.account_no) warn.push('Add your company address and bank details in Admin Settings (Company & Invoice Details) so they print on the invoice.');
  const already = customerInvoices.filter(i => String(i.site_id) === String(site.id));
  if (already.length) warn.push(`Already invoiced for this job: ${already.map(i => `${i.number} (${ciMoney(i.total_pence)})`).join(', ')}.`);
  const w = document.getElementById('ciCompanyWarn');
  w.innerHTML = warn.map(t => `⚠️ ${diaryEsc(t)}`).join('<br>');
  w.style.display = warn.length ? '' : 'none';
  ciUpdateTotals();
  openModal('modalCustInvoice');
}

async function handleCreateCustomerInvoice(e) {
  e.preventDefault();
  if (!isOwnerOrAdminUser(currentUser) || !db) return;
  const val = id => (document.getElementById(id).value || '').trim();
  const site = allSites.find(x => String(x.id) === val('ciSiteId'));
  if (!site) return;
  const number = val('ciNumber');
  if (customerInvoices.some(i => String(i.number).toLowerCase() === number.toLowerCase())) { alert(`Invoice number ${number} has already been used. Please choose another.`); return; }
  const mode = val('ciVatMode');
  const rate = mode === 'standard' ? (parseFloat(val('ciVatRate')) || 0) : 0;
  const cisIn = ciCisInput();
  const calc = ciCalc(parseInt(document.getElementById('ciNet').dataset.pence || '0'), mode, rate, cisIn);
  const rec = {
    id: 'ci_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    number, site_id: String(site.id), site_ref: formatSiteId(site.id), site_address: site.address || '',
    customer_name: val('ciCustomerName'), customer_address: val('ciCustomerAddress'), customer_ref: val('ciCustomerRef'),
    description: val('ciDescription'), net_pence: calc.net, vat_mode: mode, vat_rate: rate, vat_pence: calc.vat, total_pence: calc.total,
    cis_applied: cisIn.on, cis_rate: cisIn.on ? cisIn.rate : 0, cis_materials_pence: calc.materials, cis_pence: calc.cisPence, payable_pence: calc.payable,
    invoice_date: val('ciDate'), due_date: val('ciDue'), notes: val('ciNotes'),
    company: ciCompany(),
    created_by: currentUser.full_name, created_by_id: String(currentUser.id), created_at: new Date().toISOString()
  };
  const btn = document.getElementById('ciSubmit');
  btn.disabled = true;
  try {
    await db.collection('customer_invoices').doc(rec.id).set(rec);
    closeModal('modalCustInvoice');
    try {
      await ciDownloadPdf(rec);
      showGreenToast(`🧾 Invoice ${rec.number} created`);
    } catch (pdfErr) {
      console.warn('Invoice PDF failed', pdfErr);
      alert(`Invoice ${rec.number} was saved, but the PDF could not be made (${pdfErr.message}). You can download it again from "Invoices raised".`);
    }
  } catch (err) {
    console.warn('Invoice save failed', err);
    alert('Sorry, the invoice could not be saved. Please check your connection and try again.');
  } finally {
    btn.disabled = false;
  }
}

function ciImageSize(dataUrl) {
  return new Promise(resolve => {
    const i = new Image();
    i.onload = () => resolve({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => resolve(null);
    i.src = dataUrl;
  });
}

async function ciBuildPdf(inv) {
  if (typeof window.jspdf === 'undefined' || typeof window.jspdf.jsPDF === 'undefined') throw new Error('the PDF library is still loading, please try again');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const navy = [15, 23, 42], grey = [100, 116, 139], line = [203, 213, 225];
  const W = 210, M = 15, R = W - M;
  const co = inv.company || ciCompany();
  const lines = t => String(t || '').split('\n').map(x => x.trim()).filter(Boolean);

  // ---- letterhead ----
  doc.setFillColor(...navy);
  doc.rect(0, 0, W, 5, 'F');
  const logo = await getLogoBase64();
  if (logo) {
    const sz = await ciImageSize(logo);
    const maxW = 62, maxH = 28;
    let w = maxW, h = maxH;
    if (sz && sz.w && sz.h) { const ar = sz.w / sz.h; if (ar > maxW / maxH) { w = maxW; h = maxW / ar; } else { h = maxH; w = maxH * ar; } }
    try { doc.addImage(logo, 'PNG', M, 13, w, h, undefined, 'FAST'); } catch (e) { console.warn('Logo not added to invoice', e); }
  }
  let y = 16;
  doc.setTextColor(...navy);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  doc.text(co.name || 'GVD Contracts Ltd', R, y, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...grey);
  const head = [...lines(co.address)];
  if (co.phone) head.push('Tel: ' + co.phone);
  if (co.email) head.push(co.email);
  if (co.web) head.push(co.web);
  head.forEach(t => { y += 4.6; doc.text(t, R, y, { align: 'right' }); });
  const reg = [];
  if (co.reg_no) reg.push('Company No. ' + co.reg_no);
  if (co.vat_no) reg.push('VAT No. ' + co.vat_no);
  if (reg.length) { y += 5.2; doc.setFontSize(8); doc.text(reg.join('   |   '), R, y, { align: 'right' }); }
  const headEnd = Math.max(y, 13 + 28) + 6;
  doc.setDrawColor(...line); doc.setLineWidth(0.4); doc.line(M, headEnd, R, headEnd);

  // ---- title + invoice details ----
  doc.setTextColor(...navy); doc.setFont('helvetica', 'bold'); doc.setFontSize(26);
  doc.text('INVOICE', M, headEnd + 15);
  const meta = [['Invoice no.', inv.number], ['Invoice date', formatUKDate(inv.invoice_date)], ['Due date', formatUKDate(inv.due_date)]];
  if (inv.customer_ref) meta.push(['Your ref', inv.customer_ref]);
  let my = headEnd + 9;
  meta.forEach(([l, v]) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...grey);
    doc.text(l, 135, my);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...navy);
    doc.text(String(v), R, my, { align: 'right' });
    my += 6;
  });

  // ---- bill to / project ----
  let by = Math.max(headEnd + 28, my + 4);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...grey);
  doc.text('BILL TO', M, by);
  doc.text('PROJECT / SITE', 112, by);
  doc.setFontSize(11); doc.setTextColor(...navy);
  let ly = by + 6;
  doc.text(inv.customer_name || '', M, ly);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(60, 72, 90);
  lines(inv.customer_address).forEach(t => { ly += 5; doc.splitTextToSize(t, 90).forEach((p, i) => { if (i) ly += 5; doc.text(p, M, ly); }); });
  let ry = by + 6;
  doc.splitTextToSize(inv.site_address || '', 83).forEach((p, i) => { if (i) ry += 5; doc.text(p, 112, ry); });
  const blockEnd = Math.max(ly, ry) + 10;

  // ---- line item ----
  doc.autoTable({
    startY: blockEnd,
    head: [['Description', 'Amount']],
    body: [[inv.description || '', ciMoney(inv.net_pence)]],
    theme: 'grid',
    margin: { left: M, right: M },
    headStyles: { fillColor: navy, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 10, cellPadding: 4 },
    styles: { fontSize: 10, cellPadding: 5, textColor: [30, 41, 59], lineColor: [226, 232, 240], lineWidth: 0.2, overflow: 'linebreak' },
    columnStyles: { 1: { cellWidth: 38, halign: 'right', fontStyle: 'bold' } },
    didParseCell: d => { if (d.section === 'head' && d.column.index === 1) d.cell.styles.halign = 'right'; }
  });

  let ty = doc.lastAutoTable.finalY + 8;
  const ensure = h => { if (ty + h > 272) { doc.addPage(); ty = 20; } };
  ensure(40);
  const vatLabel = inv.vat_mode === 'standard' ? `VAT (${inv.vat_rate}%)` : inv.vat_mode === 'reverse' ? 'VAT (domestic reverse charge)' : 'VAT';
  const trow = (l, v) => { doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(60, 72, 90); doc.text(l, 120, ty); doc.text(v, R, ty, { align: 'right' }); ty += 7; };
  trow('Subtotal', ciMoney(inv.net_pence));
  trow(vatLabel, ciMoney(inv.vat_pence));
  const totalBox = (label, amount) => {
    doc.setFillColor(241, 245, 249);
    doc.roundedRect(116, ty - 5, R - 116, 11, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...navy);
    doc.text(label, 120, ty + 2);
    doc.text(amount, R - 3, ty + 2, { align: 'right' });
    ty += 16;
  };
  if (inv.cis_applied) {
    trow('Total', ciMoney(inv.total_pence));
    const labour = (inv.net_pence || 0) - (inv.cis_materials_pence || 0);
    trow(`Less CIS @ ${inv.cis_rate}% of labour`, '-' + ciMoney(inv.cis_pence));
    ty += 1;
    totalBox('Amount payable', ciMoney(inv.payable_pence != null ? inv.payable_pence : inv.total_pence - (inv.cis_pence || 0)));
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(...grey);
    const cn = doc.splitTextToSize(`CIS: this invoice is subject to the Construction Industry Scheme. Tax of ${inv.cis_rate}% is deducted from the labour element (${ciMoney(labour)}); materials${inv.cis_materials_pence ? ' (' + ciMoney(inv.cis_materials_pence) + ')' : ''} and VAT are not subject to the deduction. The deduction is paid to HMRC on our behalf and a CIS payment and deduction statement should be provided.`, R - M);
    doc.text(cn, M, ty); ty += cn.length * 4.5 + 4;
  } else {
    totalBox('Total due', ciMoney(inv.total_pence));
  }
  if (inv.vat_mode === 'reverse') {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(...grey);
    const t = doc.splitTextToSize('Domestic reverse charge: the customer is required to account to HMRC for the VAT due on this supply.', R - M);
    doc.text(t, M, ty); ty += t.length * 4.5 + 4;
  }

  // ---- payment details ----
  const pay = [];
  if (co.bank_name) pay.push(['Bank', co.bank_name]);
  if (co.account_name) pay.push(['Account name', co.account_name]);
  if (co.sort_code) pay.push(['Sort code', co.sort_code]);
  if (co.account_no) pay.push(['Account number', co.account_no]);
  pay.push(['Payment reference', inv.number]);
  ensure(12 + pay.length * 6);
  doc.setDrawColor(...line); doc.setLineWidth(0.3);
  const boxH = 12 + pay.length * 6;
  doc.roundedRect(M, ty, R - M, boxH, 2, 2, 'S');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...grey);
  doc.text('PAYMENT DETAILS', M + 4, ty + 6);
  let py = ty + 12;
  pay.forEach(([l, v]) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...grey); doc.text(l, M + 4, py);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...navy); doc.text(String(v), M + 46, py);
    py += 6;
  });
  ty += boxH + 8;

  // ---- terms + notes ----
  const days = Math.max(0, Math.round((new Date(inv.due_date) - new Date(inv.invoice_date)) / 86400000));
  const terms = [`Payment terms: ${days} day${days === 1 ? '' : 's'} from the date of invoice. Payment due by ${formatUKDate(inv.due_date)}.`];
  if (inv.notes) terms.push(inv.notes);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(60, 72, 90);
  terms.forEach(t => {
    const wrapped = doc.splitTextToSize(t, R - M);
    ensure(wrapped.length * 4.5 + 3);
    doc.text(wrapped, M, ty);
    ty += wrapped.length * 4.5 + 3;
  });

  // ---- footer on every page ----
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...line); doc.setLineWidth(0.3); doc.line(M, 284, R, 284);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...grey);
    doc.text([co.name, ...reg].filter(Boolean).join('  |  '), W / 2, 289, { align: 'center' });
    if (pages > 1) doc.text(`Page ${p} of ${pages}`, R, 289, { align: 'right' });
  }
  return doc;
}

async function ciDownloadPdf(inv) {
  const doc = await ciBuildPdf(inv);
  const safe = String(inv.site_address || 'job').replace(/[^A-Za-z0-9 ]+/g, '').trim().slice(0, 40);
  doc.save(`Invoice ${inv.number} - ${safe}.pdf`);
}

function setupCustomerInvoiceListeners() {
  const form = document.getElementById('custInvoiceForm');
  if (!form) return;
  form.addEventListener('submit', handleCreateCustomerInvoice);
  document.getElementById('ciVatMode').addEventListener('change', ciUpdateTotals);
  document.getElementById('ciVatRate').addEventListener('input', ciUpdateTotals);
  ['ciCis', 'ciCisRate'].forEach(id => document.getElementById(id).addEventListener('change', ciUpdateTotals));
  document.getElementById('ciMaterials').addEventListener('input', ciUpdateTotals);
  document.getElementById('ciDate').addEventListener('change', e => {
    if (e.target.value) document.getElementById('ciDue').value = ciAddDays(e.target.value, ciCompany().terms_days);
  });
  const co = document.getElementById('settingsCompanyForm');
  if (co) co.addEventListener('submit', handleSaveCompany);
}

// -------------------------------------------------------------------
// CUSTOMER FEEDBACK
// Customers leave feedback from the QR code page (no login). Every registered user can read it in the Feedback page;
// only Owners / Admins / Managers can remove comments (a copy is kept in feedback_removed).
// -------------------------------------------------------------------
let allFeedback = [];
let feedbackUnsub = null;
let fbFilter = 'all';
let fbPageOpenedAt = Date.now();

const FB_LABELS = { 1: 'Poor', 2: 'Not great', 3: 'Okay', 4: 'Good', 5: 'Excellent' };
const fbSentiment = r => (r >= 4 ? 'pos' : r === 3 ? 'neu' : 'neg');
const fbStars = r => `<span class="fb-stars" aria-label="${r} out of 5 stars">${'★'.repeat(r)}<span class="off">${'★'.repeat(5 - r)}</span></span>`;
const fbDate = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

function startFeedbackSync() {
  if (feedbackUnsub || !db || !currentUser) return;
  feedbackUnsub = db.collection('feedback').onSnapshot(snapshot => {
    allFeedback = snapshot.docs.map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const v = document.getElementById('view-feedback');
    if (v && v.style.display !== 'none') renderFeedbackView();
  }, err => console.warn('Firestore feedback error:', err));
}

function stopFeedbackSync() {
  if (feedbackUnsub) feedbackUnsub();
  feedbackUnsub = null;
  allFeedback = [];
}

/** The customer's form, shown under the live schedule on the QR code page */
function renderCustomerFeedbackForm(site) {
  const host = document.querySelector('#view-customer-public .customer-print-preview');
  if (!host || document.getElementById('custFeedbackCard')) return; // already there: never redraw while they are typing
  const card = document.createElement('div');
  card.id = 'custFeedbackCard';
  card.className = 'fb-public-card';
  host.appendChild(card);
  fbPageOpenedAt = Date.now();
  drawCustomerFeedbackForm(site, card);
  if (new URLSearchParams(window.location.search).get('feedback')) card.scrollIntoView({ behavior: 'smooth' });
}

function drawCustomerFeedbackForm(site, card) {
  card.innerHTML = `
    <div class="fb-public-title">How did we do?</div>
    <p class="fb-public-sub">We would love to hear about your experience with us at <strong>${diaryEsc(site.address)}</strong>. Your feedback helps us recognise great work and keep improving.</p>
    <div class="fb-stars-input" role="radiogroup" aria-label="Your rating">
      ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="fb-star-btn" data-star="${n}" role="radio" aria-checked="false" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}
    </div>
    <div class="fb-rating-label" id="fbRatingLabel">Tap a star to rate us</div>
    <div class="fb-grid">
      <label class="fb-field">Your name *<input type="text" id="fbName" maxlength="80" autocomplete="name"></label>
      <label class="fb-field">Property address *<input type="text" id="fbAddress" maxlength="200" autocomplete="street-address" value="${diaryEsc(site.address)}"></label>
      <label class="fb-field">Email (optional)<input type="email" id="fbEmail" maxlength="120" autocomplete="email"></label>
      <label class="fb-field">Phone (optional)<input type="tel" id="fbPhone" maxlength="30" autocomplete="tel"></label>
      <label class="fb-field wide">Your feedback *<textarea id="fbComment" rows="5" maxlength="2000" placeholder="Tell us what went well, or what we could do better..."></textarea></label>
    </div>
    <label class="fb-consent"><input type="checkbox" id="fbConsent"> <span>I am happy for my name, address and comments to be recorded with this feedback and shared with the GVD team.</span></label>
    <input type="text" id="fbWebsite" class="fb-hp" tabindex="-1" autocomplete="off" aria-hidden="true">
    <div class="fb-error" id="fbError" role="alert"></div>
    <button type="button" class="fb-submit" id="fbSubmit">Send feedback</button>`;

  let rating = 0;
  const label = card.querySelector('#fbRatingLabel');
  const paint = n => card.querySelectorAll('.fb-star-btn').forEach(b => {
    const on = parseInt(b.dataset.star) <= n;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(parseInt(b.dataset.star) === rating));
  });
  card.querySelectorAll('.fb-star-btn').forEach(b => {
    b.addEventListener('click', () => { rating = parseInt(b.dataset.star); paint(rating); label.textContent = `${rating} star${rating > 1 ? 's' : ''} - ${FB_LABELS[rating]}`; });
    b.addEventListener('mouseenter', () => paint(parseInt(b.dataset.star)));
    b.addEventListener('mouseleave', () => paint(rating));
  });

  card.querySelector('#fbSubmit').addEventListener('click', async () => {
    const val = id => (card.querySelector('#' + id).value || '').trim();
    const err = card.querySelector('#fbError');
    const fail = m => { err.textContent = m; };
    fail('');
    if (card.querySelector('#fbWebsite').value) return; // spam trap: real people never see this box
    if (!rating) return fail('Please tap a star to rate us.');
    if (!val('fbName')) return fail('Please enter your name.');
    if (!val('fbAddress')) return fail('Please enter the property address.');
    if (val('fbComment').length < 5) return fail('Please tell us a little about your experience.');
    if (val('fbEmail') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val('fbEmail'))) return fail('That email address does not look right.');
    if (!card.querySelector('#fbConsent').checked) return fail('Please tick the box to confirm you are happy for us to record your feedback.');
    if (Date.now() - fbPageOpenedAt < 4000) return fail('Please take a moment to check your answers, then press Send again.');
    const last = parseInt(localStorage.getItem('gvd_fb_last') || '0');
    if (Date.now() - last < 30000) return fail('Your feedback has just been sent. Thank you!');

    const btn = card.querySelector('#fbSubmit');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      await callFn('customerFeedback', {
        token: currentCustomerToken,
        rating,
        comment: val('fbComment').slice(0, 2000),
        customer_name: val('fbName').slice(0, 80),
        customer_address: val('fbAddress').slice(0, 200),
        customer_email: val('fbEmail').slice(0, 120),
        customer_phone: val('fbPhone').slice(0, 30),
        consent: true
      });
      localStorage.setItem('gvd_fb_last', String(Date.now()));
      card.innerHTML = `
        <div class="fb-thanks">
          <div class="fb-thanks-tick">✓</div>
          <div class="fb-public-title">Thank you, ${diaryEsc(val('fbName') || 'again')}!</div>
          <p class="fb-public-sub">Your feedback has been sent to the team. We really appreciate you taking the time.</p>
        </div>`;
    } catch (e) {
      console.warn('Feedback failed', e);
      btn.disabled = false;
      btn.textContent = 'Send feedback';
      fail('Sorry, that did not send. Please check your connection and try again.');
    }
  });
}

/** Everything the in-app Feedback page needs, wired once */
function setupFeedbackListeners() {
  const view = document.getElementById('view-feedback');
  if (!view) return;
  view.addEventListener('click', e => {
    const chip = e.target.closest('[data-fb-filter]');
    if (chip) { fbFilter = chip.dataset.fbFilter; renderFeedbackView(); return; }
    const del = e.target.closest('[data-fb-delete]');
    if (del) deleteFeedback(del.dataset.fbDelete);
  });
  document.getElementById('fbSearch').addEventListener('input', renderFeedbackList);
  document.getElementById('fbSite').addEventListener('change', renderFeedbackList);
}

function fbFiltered() {
  const site = (document.getElementById('fbSite') || {}).value || '';
  const q = ((document.getElementById('fbSearch') || {}).value || '').trim().toLowerCase();
  return allFeedback.filter(f =>
    (fbFilter === 'all' || fbSentiment(f.rating) === fbFilter) &&
    (!site || String(f.site_id) === site) &&
    (!q || [f.customer_name, f.customer_address, f.site_address, f.comment].some(t => String(t || '').toLowerCase().includes(q))));
}

function renderFeedbackView() {
  if (!currentUser) return;
  const total = allFeedback.length;
  const avg = total ? allFeedback.reduce((t, f) => t + (f.rating || 0), 0) / total : 0;
  const count = n => allFeedback.filter(f => f.rating === n).length;
  const pos = allFeedback.filter(f => f.rating >= 4).length;

  document.getElementById('fbSummary').innerHTML = total === 0 ? '' : `
    <div class="fb-summary-card">
      <div class="fb-score">
        <div class="fb-score-num">${avg.toFixed(1)}</div>
        ${fbStars(Math.round(avg))}
        <div class="fb-score-sub">${total} review${total === 1 ? '' : 's'} · ${Math.round((pos / total) * 100)}% positive</div>
      </div>
      <div class="fb-bars">
        ${[5, 4, 3, 2, 1].map(n => `<div class="fb-bar-row"><span>${n} ★</span><div class="fb-bar-track"><div class="fb-bar-fill" style="width: ${(count(n) / total) * 100}%;"></div></div><span>${count(n)}</span></div>`).join('')}
      </div>
    </div>`;

  const chips = [['all', `All (${total})`], ['pos', `Positive (${pos})`], ['neu', `Okay (${count(3)})`], ['neg', `Negative (${count(1) + count(2)})`]];
  document.getElementById('fbChips').innerHTML = chips.map(([k, l]) => `<button type="button" class="fb-chip ${fbFilter === k ? 'active' : ''}" data-fb-filter="${k}">${l}</button>`).join('');

  const siteSel = document.getElementById('fbSite');
  const keep = siteSel.value;
  const sites = {};
  allFeedback.forEach(f => { sites[f.site_id] = f.site_address || f.site_ref || f.site_id; });
  siteSel.innerHTML = `<option value="">All properties</option>` + Object.keys(sites).map(id => `<option value="${diaryEsc(id)}">${diaryEsc(sites[id])}</option>`).join('');
  siteSel.value = Object.keys(sites).includes(keep) ? keep : '';

  renderFeedbackList();
}

function renderFeedbackList() {
  const host = document.getElementById('fbList');
  if (!host) return;
  const mgmt = isManagementUser(currentUser);
  const list = fbFiltered();
  if (list.length === 0) {
    host.innerHTML = `<div class="fb-empty">${allFeedback.length === 0 ? 'No feedback yet. When a customer scans the QR code and leaves a review it will appear here.' : 'No feedback matches those filters.'}</div>`;
    return;
  }
  host.innerHTML = list.map(f => {
    const kind = fbSentiment(f.rating);
    const tag = { pos: 'Positive', neu: 'Okay', neg: 'Negative' }[kind];
    const contact = mgmt ? [
      f.customer_email ? `<a href="mailto:${diaryEsc(f.customer_email)}">${diaryEsc(f.customer_email)}</a>` : '',
      f.customer_phone ? `<a href="tel:${diaryEsc(f.customer_phone)}">${diaryEsc(f.customer_phone)}</a>` : ''
    ].filter(Boolean).join(' · ') : '';
    return `
      <div class="fb-card ${kind}">
        <div class="fb-card-top">
          <div>${fbStars(f.rating || 0)} <span class="fb-tag ${kind}" style="margin-left: 8px;">${tag}</span></div>
          <span class="fb-date">${fbDate(f.created_at)}</span>
        </div>
        <div class="fb-quote">${diaryEsc(f.comment)}</div>
        <div class="fb-who">
          <div>
            <div class="fb-who-name">${diaryEsc(f.customer_name)}</div>
            <div class="fb-who-detail">📍 ${diaryEsc(f.customer_address || f.site_address)}${f.site_ref ? ` · Site ${diaryEsc(f.site_ref)}` : ''}${contact ? `<br>${contact}` : ''}</div>
          </div>
          ${mgmt ? `<button type="button" class="fb-del" data-fb-delete="${diaryEsc(f.id)}">🗑 Remove comment</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

async function deleteFeedback(id) {
  const f = allFeedback.find(x => x.id === id);
  if (!f || !isManagementUser(currentUser)) return;
  if (!confirm(`Remove this ${f.rating}-star comment from ${f.customer_name}?\n\nA record of who removed it is kept in the audit log.`)) return;
  try {
    await db.collection('feedback_removed').doc(id).set({
      ...f, removed_by: currentUser.full_name, removed_by_id: String(currentUser.id), removed_at: new Date().toISOString()
    });
    await db.collection('feedback').doc(id).delete();
  } catch (e) {
    console.warn('Could not remove feedback', e);
    alert('Could not remove that comment. Please try again.');
  }
}


// -------------------------------------------------------------------
// TEAM CHAT
// One group chat for every registered user. Owners / Admins can post announcements, which are highlighted,
// pinned at the top and pushed to every phone. Typing @ tags a person (or @all): they get a push and a pop-up in the app.
// Everyone can delete their own messages; Owners / Admins can delete any.
// -------------------------------------------------------------------
let chatMessages = [];
let chatUnsub = null;
let chatFirstSnapshot = true;
let chatMentionMatches = [];
let chatMentionIndex = 0;

const chatSeenKey = () => `gvd_chat_seen_${currentUser ? currentUser.id : ''}`;
const chatActiveUsers = () => allUsers.filter(u => u.status === 'Active');
const chatFirstName = u => String(u.full_name || '').trim().split(/\s+/)[0] || '';
const chatEscRe = t => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Who a message tags: { all, ids } from the @names in the text */
function chatFindMentions(text, senderId) {
  const users = chatActiveUsers();
  const lower = String(text || '').toLowerCase();
  const all = /(^|[^\w])@(all|everyone)(?![\w])/i.test(text);
  const firstCount = {};
  users.forEach(u => { const f = chatFirstName(u).toLowerCase(); firstCount[f] = (firstCount[f] || 0) + 1; });
  const ids = users.filter(u => {
    if (String(u.id) === String(senderId)) return false;
    if (lower.includes('@' + String(u.full_name).toLowerCase())) return true;
    const f = chatFirstName(u).toLowerCase();
    return f && firstCount[f] === 1 && new RegExp('(^|[^\\w])@' + chatEscRe(f) + '(?![\\w])', 'i').test(text);
  }).map(u => String(u.id));
  return { all, ids };
}

const chatMentionsMe = m => !!currentUser && String(m.sender_id) !== String(currentUser.id) &&
  (m.mention_all === true || (Array.isArray(m.mentions) && m.mentions.map(String).includes(String(currentUser.id))));

/** Safe HTML for a message, with @tags highlighted (stronger when it is you) */
function chatFormatText(text) {
  const users = chatActiveUsers();
  const firstCount = {};
  users.forEach(u => { const f = chatFirstName(u).toLowerCase(); firstCount[f] = (firstCount[f] || 0) + 1; });
  const names = ['everyone', 'all'];
  users.forEach(u => { names.push(u.full_name); if (firstCount[chatFirstName(u).toLowerCase()] === 1) names.push(chatFirstName(u)); });
  const alt = names.filter(Boolean).sort((x, y) => y.length - x.length).map(n => chatEscRe(diaryEsc(n))).join('|');
  const html = diaryEsc(text);
  if (!alt) return html;
  const mine = currentUser ? [String(currentUser.full_name).toLowerCase(), chatFirstName(currentUser).toLowerCase(), 'all', 'everyone'] : [];
  return html.replace(new RegExp('(^|[^\\w])@(' + alt + ')(?![\\w])', 'gi'), (m0, pre, name) =>
    `${pre}<span class="chat-mention ${mine.includes(name.toLowerCase().replace(/&#39;/g, "'")) ? 'me' : ''}">@${name}</span>`);
}

function startChatSync() {
  if (chatUnsub || !db || !currentUser) return;
  chatFirstSnapshot = true;
  chatUnsub = db.collection('group_chat').orderBy('created_at').limitToLast(300).onSnapshot(snapshot => {
    chatMessages = snapshot.docs.map(d => ({ ...d.data(), id: d.id }));
    // first ever visit: start from now, so old history is not counted as unread
    if (!localStorage.getItem(chatSeenKey())) {
      const newest = chatMessages.length ? chatMessages[chatMessages.length - 1].created_at : new Date().toISOString();
      localStorage.setItem(chatSeenKey(), newest);
    }
    const v = document.getElementById('view-chat');
    const viewing = !!v && v.style.display !== 'none' && !document.hidden;

    // pop-up when someone tags you (new tags as they arrive; on opening the app, the latest one you have not seen)
    if (!viewing) {
      const seen = localStorage.getItem(chatSeenKey()) || '';
      let fresh;
      if (chatFirstSnapshot) fresh = chatMessages.filter(m => chatMentionsMe(m) && (m.created_at || '') > seen).pop();
      else fresh = snapshot.docChanges().filter(c => c.type === 'added').map(c => ({ ...c.doc.data(), id: c.doc.id })).filter(chatMentionsMe).pop();
      if (fresh) showChatMentionBanner(fresh);
    }
    chatFirstSnapshot = false;

    if (v && v.style.display !== 'none') renderChatView(false); else updateChatBadge();
  }, err => console.warn('Firestore group_chat error:', err));
}

function stopChatSync() {
  if (chatUnsub) chatUnsub();
  chatUnsub = null;
  chatMessages = [];
  const b = document.getElementById('chatMentionBanner');
  if (b) b.remove();
  updateChatBadge();
}

/** Red dot on the Team Chat button while there is anything new (an @ when you have been tagged) */
function updateChatBadge() {
  const btn = document.getElementById('navChatBtn');
  if (!btn) return;
  const seen = currentUser ? (localStorage.getItem(chatSeenKey()) || '') : '';
  const unread = currentUser ? chatMessages.filter(m => String(m.sender_id) !== String(currentUser.id) && (m.created_at || '') > seen) : [];
  btn.classList.toggle('has-unread-chat', unread.length > 0);
  btn.classList.toggle('has-unread-mention', unread.some(chatMentionsMe));
  btn.title = unread.length ? `${unread.length} new message${unread.length === 1 ? '' : 's'}` : '';
}

function showChatMentionBanner(m) {
  let b = document.getElementById('chatMentionBanner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'chatMentionBanner';
    b.className = 'chat-mention-banner';
    document.body.appendChild(b);
  }
  b.innerHTML = `
    <div class="cm-title">💬 ${diaryEsc(m.sender_name)} ${m.mention_all ? 'tagged everyone' : 'tagged you'} in Team Chat</div>
    <div class="cm-text">${diaryEsc(m.text)}</div>
    <div class="cm-actions"><button type="button" class="cm-open">Open chat</button><button type="button" class="cm-close">Dismiss</button></div>`;
  b.querySelector('.cm-open').onclick = () => { b.remove(); showView('view-chat'); };
  b.querySelector('.cm-close').onclick = () => b.remove();
  if (navigator.vibrate) { try { navigator.vibrate(120); } catch (e) {} }
}

function chatDayLabel(iso) {
  const d = new Date(iso);
  const key = x => diaryDateKey(x);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (key(d) === key(today)) return 'Today';
  if (key(d) === key(yest)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function chatInitials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join('');
}

function renderChatView(forceBottom) {
  if (!currentUser) return;
  const box = document.getElementById('chatMessages');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const canAnnounce = isOwnerOrAdminUser(currentUser);
  const isAdmin = canAnnounce;
  document.getElementById('chatAnnounceRow').style.display = canAnnounce ? '' : 'none';

  // pinned: the most recent announcement from the last 7 days
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const latest = chatMessages.filter(m => m.kind === 'announcement' && (m.created_at || '') > weekAgo).pop();
  document.getElementById('chatPinned').innerHTML = latest
    ? `<div class="chat-pinned">📌 <b>Announcement</b> from <b>${diaryEsc(latest.sender_name)}</b> · ${diaryEsc(chatDayLabel(latest.created_at))}<div style="margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere;">${chatFormatText(latest.text)}</div></div>`
    : '';

  if (chatMessages.length === 0) {
    box.innerHTML = '<div class="chat-empty">No messages yet.<br>Say hello to the team 👋</div>';
  } else {
    let lastDay = '';
    box.innerHTML = chatMessages.map(m => {
      const day = diaryDateKey(new Date(m.created_at));
      const sep = day !== lastDay ? `<div class="chat-day">${diaryEsc(chatDayLabel(m.created_at))}</div>` : '';
      lastDay = day;
      const mine = String(m.sender_id) === String(currentUser.id);
      const time = new Date(m.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const del = (mine || isAdmin) ? `<button type="button" data-chat-delete="${diaryEsc(m.id)}">Delete</button>` : '';
      const role = ['Owner', 'Admin', 'Manager'].includes(m.sender_role) ? `<span class="chat-role">${diaryEsc(m.sender_role)}</span>` : '';
      if (m.kind === 'announcement') {
        return `${sep}<div class="chat-announce"><div class="chat-tag">📢 Announcement from ${diaryEsc(m.sender_name)}${role}</div><div class="chat-text">${chatFormatText(m.text)}</div><div class="chat-meta"><span>${diaryEsc(m.sender_name)} · ${time}</span>${del}</div></div>`;
      }
      return `${sep}
        <div class="chat-row ${mine ? 'mine' : ''} ${chatMentionsMe(m) ? 'tagged' : ''}">
          ${mine ? '' : `<div class="chat-avatar" style="background: ${userColor(m.sender_id)};">${diaryEsc(chatInitials(m.sender_name))}</div>`}
          <div class="chat-bubble">
            <div class="chat-name" style="color: ${userColor(m.sender_id)};">${diaryEsc(m.sender_name)}${role}</div>
            <div class="chat-text">${chatFormatText(m.text)}</div>
            <div class="chat-meta"><span>${time}</span>${del}</div>
          </div>
        </div>`;
    }).join('');
  }
  if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;

  // looking at the chat marks everything as read
  const v = document.getElementById('view-chat');
  if (v && v.style.display !== 'none' && chatMessages.length) {
    localStorage.setItem(chatSeenKey(), chatMessages[chatMessages.length - 1].created_at);
    const banner = document.getElementById('chatMentionBanner');
    if (banner) banner.remove();
  }
  updateChatBadge();
}

async function sendChatMessage() {
  if (!currentUser || !db) return;
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  closeChatMentionMenu();
  const announce = isOwnerOrAdminUser(currentUser) && document.getElementById('chatAnnounce').checked;
  const tags = chatFindMentions(text, currentUser.id);
  const btn = document.getElementById('chatSend');
  btn.disabled = true;
  try {
    await db.collection('group_chat').add({
      text: text.slice(0, 2000),
      sender_id: String(currentUser.id),
      sender_name: currentUser.full_name,
      sender_role: currentUser.role,
      kind: announce ? 'announcement' : 'message',
      mentions: tags.ids,
      mention_all: tags.all,
      created_at: new Date().toISOString()
    });
    input.value = '';
    input.style.height = 'auto';
    document.getElementById('chatAnnounce').checked = false;

    // phone alerts (delivered by the existing notification service, even to phones that are asleep):
    // announcements go to everyone; otherwise only the people tagged, or everyone for @all
    const others = chatActiveUsers().filter(u => String(u.id) !== String(currentUser.id));
    const push = (users, title) => Promise.all(users.map(u => db.collection('notifications').add({
      target_user_id: String(u.id), title, body: text.slice(0, 300), created_at: new Date().toISOString()
    }).catch(err => console.warn('Chat alert failed:', err))));
    if (announce) await push(others, `📢 Announcement from ${currentUser.full_name}`);
    else if (tags.all) await push(others, `💬 ${currentUser.full_name} tagged everyone in Team Chat`);
    else if (tags.ids.length) await push(others.filter(u => tags.ids.includes(String(u.id))), `💬 ${currentUser.full_name} tagged you in Team Chat`);
    renderChatView(true);
  } catch (e) {
    console.warn('Chat send failed', e);
    alert('Sorry, that message did not send. Please check your connection and try again.');
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

async function deleteChatMessage(id) {
  const m = chatMessages.find(x => x.id === id);
  if (!m || !currentUser) return;
  if (!(String(m.sender_id) === String(currentUser.id) || isOwnerOrAdminUser(currentUser))) return;
  if (!confirm('Delete this message for everyone?')) return;
  try { await db.collection('group_chat').doc(id).delete(); } catch (e) { alert('Could not delete that message.'); }
}

// ---- @ suggestions ----
function closeChatMentionMenu() {
  const menu = document.getElementById('chatMentionMenu');
  if (menu) menu.style.display = 'none';
  chatMentionMatches = [];
}

function updateChatMentionMenu() {
  const input = document.getElementById('chatInput');
  const menu = document.getElementById('chatMentionMenu');
  if (!input || !menu || !currentUser) return;
  const before = input.value.slice(0, input.selectionStart);
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  if (!m) { closeChatMentionMenu(); return; }
  const q = m[2].toLowerCase();
  const items = [];
  if ('all'.startsWith(q) || 'everyone'.startsWith(q)) items.push({ label: '@all', sub: 'Notify everyone', insert: '@all ' });
  chatActiveUsers()
    .filter(u => String(u.id) !== String(currentUser.id) && String(u.full_name).toLowerCase().split(/\s+/).some(w => w.startsWith(q)))
    .slice(0, 6)
    .forEach(u => items.push({ label: '@' + u.full_name, sub: u.role, insert: '@' + u.full_name + ' ' }));
  if (!items.length) { closeChatMentionMenu(); return; }
  chatMentionMatches = items.map(i => ({ ...i, start: before.length - m[2].length - 1 }));
  chatMentionIndex = 0;
  drawChatMentionMenu();
}

function drawChatMentionMenu() {
  const menu = document.getElementById('chatMentionMenu');
  menu.innerHTML = chatMentionMatches.map((i, n) =>
    `<button type="button" class="chat-mention-item ${n === chatMentionIndex ? 'active' : ''}" data-mention-pick="${n}"><span>${diaryEsc(i.label)}</span><small>${diaryEsc(i.sub)}</small></button>`).join('');
  menu.style.display = '';
}

function pickChatMention(n) {
  const item = chatMentionMatches[n];
  const input = document.getElementById('chatInput');
  if (!item || !input) return;
  const caret = input.selectionStart;
  input.value = input.value.slice(0, item.start) + item.insert + input.value.slice(caret);
  const pos = item.start + item.insert.length;
  input.setSelectionRange(pos, pos);
  closeChatMentionMenu();
  input.focus();
}

function setupChatListeners() {
  const input = document.getElementById('chatInput');
  if (!input) return;
  document.getElementById('chatSend').addEventListener('click', sendChatMessage);
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    updateChatMentionMenu();
  });
  input.addEventListener('keydown', e => {
    if (chatMentionMatches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); chatMentionIndex = (chatMentionIndex + 1) % chatMentionMatches.length; drawChatMentionMenu(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); chatMentionIndex = (chatMentionIndex - 1 + chatMentionMatches.length) % chatMentionMatches.length; drawChatMentionMenu(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickChatMention(chatMentionIndex); return; }
      if (e.key === 'Escape') { closeChatMentionMenu(); return; }
    }
    // On a computer Enter sends (Shift+Enter for a new line); on a phone Enter starts a new line and the Send button sends
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); sendChatMessage(); }
  });
  // pick with the mouse or a tap without the box losing focus
  document.getElementById('chatMentionMenu').addEventListener('mousedown', e => {
    const b = e.target.closest('[data-mention-pick]');
    if (b) { e.preventDefault(); pickChatMention(parseInt(b.dataset.mentionPick)); }
  });
  document.getElementById('chatMentionMenu').addEventListener('touchend', e => {
    const b = e.target.closest('[data-mention-pick]');
    if (b) { e.preventDefault(); pickChatMention(parseInt(b.dataset.mentionPick)); }
  });
  document.getElementById('chatMessages').addEventListener('click', e => {
    const b = e.target.closest('[data-chat-delete]');
    if (b) deleteChatMessage(b.dataset.chatDelete);
  });
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

  document.getElementById('btnAssignUnassignedSites').addEventListener('click', assignUnassignedToMe);
  if (typeof setupReportsListeners === 'function') setupReportsListeners();
  refreshJobScopeSelects();
  document.querySelectorAll('.job-scope-select').forEach(sel => sel.addEventListener('change', () => setJobScope(sel.value)));
  document.querySelectorAll('.fin-subtab').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));

  document.getElementById('linkRegister').addEventListener('click', (e) => { e.preventDefault(); showView('view-register'); });
  document.getElementById('linkBackToLogin').addEventListener('click', (e) => { e.preventDefault(); showView('view-login'); });
  document.getElementById('linkForgotPassword').addEventListener('click', (e) => { e.preventDefault(); showView('view-forgot-password'); });
  document.getElementById('linkBackToLoginFromForgot').addEventListener('click', (e) => { e.preventDefault(); showView('view-login'); });
  document.getElementById('btnBackToLoginFromApproval').addEventListener('click', () => showView('view-login'));
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);

  document.getElementById('btnCheckApproval').addEventListener('click', async () => {
    try {
      const res = await callFn('refreshSession');
      if (res.user.status === 'Active') {
        await signInWithServerSession(res);
        startSyncOnce();
        onUserAuthenticated();
        return;
      }
    } catch (e) {}
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
        labelDays.textContent = `${val} working days`;
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

  const btn = e.submitter || document.querySelector('#registerForm button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const res = await callFn('register', { full_name, email, phone, role: regRoleSelect, password });
    await signInWithServerSession(res);
    if (res.user.status === 'Active') {
      alert('Registration successful! Your account has been registered and activated as the Owner.');
      startSyncOnce();
      onUserAuthenticated();
    } else {
      showView('view-awaiting-approval');
      watchApproval(res.user.id);
    }
  } catch (err) {
    alertEl.textContent = err.message;
    alertEl.style.display = 'block';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// LOGIN HANDLER
async function handleLogin(e) {
  e.preventDefault();
  const alertEl = document.getElementById('loginAlert');
  alertEl.style.display = 'none';

  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;

  const btn = e.submitter || document.querySelector('#loginForm button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const res = await callFn('login', { email, password });
    await signInWithServerSession(res);
    if (res.user.status === 'Pending' || res.user.status === 'Pending Approval') {
      showView('view-awaiting-approval');
      watchApproval(res.user.id);
      return;
    }
    startSyncOnce();
    onUserAuthenticated();
  } catch (err) {
    alertEl.textContent = err.message;
    alertEl.style.display = 'block';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleSetNewPassword(e) {
  e.preventDefault();
  const alertEl = document.getElementById('resetAlert');
  alertEl.style.display = 'none';
  const pw = document.getElementById('resetNewPassword').value;
  const pw2 = document.getElementById('resetConfirmPassword').value;
  const problem = pw.length < 6 ? 'Password must be at least 6 characters.'
    : pw !== pw2 ? 'The two passwords do not match.'
    : '';
  if (problem) {
    alertEl.textContent = problem;
    alertEl.style.display = 'block';
    return;
  }
  try {
    await callFn('setPassword', { newPassword: pw });
  } catch (err) {
    alertEl.textContent = err.message;
    alertEl.style.display = 'block';
    return;
  }
  currentUser.must_change_password = false;
  saveLocalStorageData();
  document.getElementById('resetNewPassword').value = '';
  document.getElementById('resetConfirmPassword').value = '';
  onUserAuthenticated();
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const alertEl = document.getElementById('forgotAlert');
  const email = ((document.getElementById('forgotEmail') || {}).value || '').trim().toLowerCase();
  if (email) await callFn('requestPasswordReset', { email }).catch(() => {});
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
  stopFeedbackSync();
  stopChatSync();
  stopFinanceSync();
  if (typeof stopMyInvoiceSync === 'function') stopMyInvoiceSync();
  currentUser = null;
  localStorage.removeItem('gvd_current_user_id');
  localStorage.removeItem('gvd_push_subscribed');
  if (auth) await auth.signOut().catch(() => {});
  // a clean reload drops every data listener, which would otherwise keep running without a signed-in user
  window.location.reload();
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
      manager_id: isManagementUser(currentUser) ? String(currentUser.id) : null,
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
  if (labelDays) labelDays.textContent = '2 working days';
  const wkChk = document.getElementById('shiftDuplicateWeekends'); if (wkChk) wkChk.checked = false;

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

let shiftSaving = false;
async function handleSaveShift(e) {
  e.preventDefault();
  // A double tap on a phone used to run this twice and create the shift twice
  if (shiftSaving) return;
  shiftSaving = true;
  const submitBtn = document.querySelector('#shiftForm button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  try { await saveShiftFromForm(); }
  finally { shiftSaving = false; if (submitBtn) submitBtn.disabled = false; }
}

async function saveShiftFromForm() {
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
      showGreenToast('✅ Shift updated & operative notified');
      triggerShiftNotification(targetShift, '⚡ Live Shift Assigned').catch(console.warn);
    } else {
      showGreenToast(isDraftPlanningMode ? '✅ Draft shift updated (silent)' : '✅ Shift updated');
    }
  } else {
    // Creating Shift(s)
    const isDuplicate = document.getElementById('shiftDuplicateChk')?.checked;
    const numDays = isDuplicate ? Math.max(1, parseInt(document.getElementById('shiftDuplicateDaysInput')?.value) || 1) : 1;

    const [year, month, day] = shift_date.split('-').map(Number);
    let createdCount = 0, skippedDuplicates = 0;
    const notifyShifts = [];

    const includeWeekends = !!document.getElementById('shiftDuplicateWeekends')?.checked;
    let dayOffset = -1;
    for (let i = 0; i < numDays; i++) {
      // working days only (Mon-Fri) unless weekends are ticked; a single shift always goes on the chosen date
      let d;
      do { dayOffset++; d = new Date(year, month - 1, day + dayOffset); } while (isDuplicate && !includeWeekends && isWeekendDay(d));
      const currentDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      
      // never create the same person / job / day / period twice
      if (allShifts.some(s => String(s.operative_id) === String(operative_id) && parseInt(s.site_id) === site_id && s.shift_date === currentDateStr && (s.shift_period || 'all_day') === shift_period && !s.is_drying_day)) { skippedDuplicates++; continue; }
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
      if (!isDraftPlanningMode && currentDateStr >= todayStr) notifyShifts.push(newShift);
    }

    deduplicateShifts();
    saveLocalStorageData();
    closeModal('modalShift');
    renderActiveView();

    if (skippedDuplicates && !createdCount) {
      showGreenToast('That shift already exists - nothing added');
    } else if (createdCount > 1) {
      showGreenToast(`✅ ${createdCount} shifts saved${includeWeekends ? '' : ' (Mon–Fri)'}${notifyShifts.length ? ' & operative notified' : ''}`);
    } else if (isDraftPlanningMode) {
      showGreenToast('✅ Draft shift saved (silent)');
    } else if (notifyShifts.length) {
      showGreenToast('✅ Shift saved & operative notified');
    } else {
      showGreenToast('✅ Shift saved');
    }
    // Notify in the background so the box is already closed
    notifyShifts.forEach(sh => triggerShiftNotification(sh, '⚡ Live Shift Assigned').catch(console.warn));
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

// Diary is filtered by people: tick whose entries to show (admin level and above), any combination
let diaryHidden = [];      // people unticked
let diaryShowOthers = false; // entries that only involve operatives, or nobody
try { diaryHidden = JSON.parse(localStorage.getItem('gvd_diary_hidden') || '[]'); diaryShowOthers = localStorage.getItem('gvd_diary_others') === '1'; } catch (e) {}
function diaryFilterMatches(e) {
  const mgmtIds = managerUsers().map(u => String(u.id));
  const ids = (e.assignee_ids || []).map(String);
  const involved = ids.filter(id => mgmtIds.includes(id));
  if (!involved.length) return diaryShowOthers;
  return involved.some(id => !diaryHidden.includes(id));
}
function refreshDiaryFilterSelect() {
  const box = document.getElementById('diaryFilter');
  if (!box) return;
  const people = managerUsers().filter(u => u.status === 'Active' || allDiary.some(e => (e.assignee_ids || []).map(String).includes(String(u.id))));
  const chip = (key, label, on, color) => `<label style="display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; cursor: pointer; font-size: 0.85rem; font-weight: 700; border: 2px solid ${color}; background: ${on ? color : 'transparent'}; color: ${on ? '#fff' : 'var(--text-main, inherit)'};"><input type="checkbox" data-diary-who="${diaryEsc(key)}"${on ? ' checked' : ''} style="accent-color: ${color};"> ${diaryEsc(label)}</label>`;
  box.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-muted);">Show:</span>' +
    people.map(u => chip(String(u.id), u.full_name, !diaryHidden.includes(String(u.id)), userColor(String(u.id)))).join('') +
    chip('__others__', 'Others', diaryShowOthers, '#64748b');
  box.querySelectorAll('input[data-diary-who]').forEach(inp => inp.addEventListener('change', () => {
    const k = inp.dataset.diaryWho;
    if (k === '__others__') diaryShowOthers = inp.checked;
    else diaryHidden = inp.checked ? diaryHidden.filter(x => x !== k) : diaryHidden.concat(k);
    try { localStorage.setItem('gvd_diary_hidden', JSON.stringify(diaryHidden)); localStorage.setItem('gvd_diary_others', diaryShowOthers ? '1' : '0'); } catch (e) {}
    renderDiaryView();
  }));
}

function renderDiaryView() {
  if (!currentUser || !isManagementUser(currentUser)) return;
  refreshDiaryFilterSelect();
  const year = diaryMonth.getFullYear();
  const month = diaryMonth.getMonth();
  document.getElementById('diaryMonthLabel').textContent = diaryMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const todayKey = diaryDateKey(new Date());
  const byDate = {};
  const diaryEntries = allDiary.filter(diaryFilterMatches);
  diaryEntries.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });
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

  const monthEntries = diaryEntries.filter(e => (e.date || '') >= todayKey)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const agenda = document.getElementById('diaryAgenda');
  if (monthEntries.length === 0) {
    agenda.innerHTML = '<p style="color: var(--text-muted);">No upcoming diary entries.</p>';
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
  document.getElementById('userModalPayType').value = financePay[String(user.id)] || 'day';
  const hh0 = financeHourly[String(user.id)] || {};
  if (financePay[String(user.id)] === 'hourly') document.getElementById('userModalDayRate').value = hh0.rate != null ? hh0.rate : '';
  document.getElementById('userModalHours').value = hh0.hpd || 8;
  updateUserModalPayUi();

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
    const pt = document.getElementById('userModalPayType').value;
    const rec = { user_id: String(user.id), pay_type: pt };
    if (pt === 'hourly') { rec.hourly_rate = isNaN(rate) ? null : rate; rec.hours_per_day = parseFloat(document.getElementById('userModalHours').value) || 8; }
    else rec.day_rate = isNaN(rate) ? null : rate;
    await db.collection('finance_rates').doc(String(user.id)).set(rec, { merge: true }).catch(console.warn);
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
// True if there is any sign this person has used the app: a recorded login, a subscribed phone,
// an opened shift, an uploaded photo/file, a PO, or a diary entry.
let pushUserIds = new Set();
let pushIdsLoadedAt = 0;

async function loadPushUserIds() {
  if (!db || Date.now() - pushIdsLoadedAt < 60000) return;
  pushIdsLoadedAt = Date.now();
  try {
    const snap = await db.collectionGroup('subscriptions').get();
    const ids = new Set(snap.docs.map(d => String(d.data().user_id || d.ref.parent.parent.id)));
    const changed = ids.size !== pushUserIds.size || Array.from(ids).some(id => !pushUserIds.has(id));
    pushUserIds = ids;
    if (changed) renderActiveView();
  } catch (err) {
    console.warn('Could not read push subscriptions:', err);
  }
}

function hasUsedApp(user) {
  const id = String(user.id);
  if (user.last_login_at || user.last_active_at) return true;
  if (pushUserIds.has(id)) return true;
  if (allShifts.some(sh => String(sh.operative_id) === id && sh.seen_at)) return true;
  if (allPhotos.some(p => String(p.uploader_id) === id)) return true;
  if (allPdfs.some(f => String(f.uploader_id) === id)) return true;
  if (allPOs.some(po => String(po.requested_by_id) === id)) return true;
  if (allDiary.some(e => String(e.created_by) === id)) return true;
  return false;
}

// Remember each time someone opens the app (at most every 6 hours) so this stays accurate
function touchLastActive() {
  if (!db || !currentUser) return;
  const key = 'gvd_last_touch_' + currentUser.id;
  try {
    if (Date.now() - parseInt(localStorage.getItem(key) || '0', 10) < 6 * 3600 * 1000) return;
    localStorage.setItem(key, String(Date.now()));
  } catch (e) {}
  currentUser.last_active_at = new Date().toISOString();
  db.collection('users').doc(String(currentUser.id)).update({ last_active_at: currentUser.last_active_at }).catch(console.warn);
}

function buildLoginMessage(user, tempPw) {
  const first = String(user.full_name || '').split(' ')[0];
  return `Hi ${first},\n\nYour GVD LIVE login:\nWebsite: ${window.location.origin}\nEmail: ${user.email}\nTemporary password: ${tempPw}\n\nThe first time you log in you will be asked to choose your own password.`;
}

async function applyTempLogin(user, tempPw) {
  // The server stores only a hash of the temporary password; it is never kept in the user record
  await callFn('adminSetTempPassword', { userId: String(user.id), tempPassword: tempPw });
  user.must_change_password = true;
  saveLocalStorageData();
}

async function userModalShareLogin(mode) {
  const user = allUsers.find(u => String(u.id) === document.getElementById('userModalId').value);
  if (!user) return;
  const tempPw = document.getElementById('userModalTempPw').value.trim();
  if (tempPw.length < 3) { alert('Enter a temporary password (at least 3 characters).'); return; }
  if (hasUsedApp(user)) { alert('This person has already used the app, so their password was not changed.'); return; }
  if (!user.must_change_password && !confirm(`This will set ${user.full_name}'s password to "${tempPw}" and make them choose a new one at first login. Continue?`)) return;
  try { await applyTempLogin(user, tempPw); } catch (err) { alert('Could not set the temporary password: ' + err.message); return; }
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
    fsMarkReady('pos');
  }, err => console.warn('Firestore purchase_orders error:', err));
}

function stopPOSync() {
  if (poUnsub) poUnsub();
  poUnsub = null;
  allPOs = [];
  fsReady.delete('pos');
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
  // Every page is read, in order, so totals printed on page 2, 3... are found too
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = content.items.filter(it => it.str && it.str.trim()).map(it => ({ x: it.transform[4], y: it.transform[5], str: it.str }))
      .sort((p, q) => q.y - p.y || p.x - q.x);
    // Text whose baseline is within a few points sits on the same printed line
    const rows = [];
    items.forEach(it => {
      const row = rows.find(r => Math.abs(r.y - it.y) <= 3);
      if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
    });
    // typed-in form fields (our operative invoice template) are not part of the page text: read them and put them on the line of their label
    try {
      const annots = await page.getAnnotations();
      annots.forEach(a => {
        if (a.subtype !== 'Widget' || typeof a.fieldValue !== 'string' || !a.fieldValue.trim() || !a.rect) return;
        let v = a.fieldValue.trim();
        if (/^(rate|amount|net_total|total_vat|invoice_total)/.test(a.fieldName || '') && /^[£\s]*\d[\d,]*(\.\d{1,2})?$/.test(v)) v = '£' + parseFloat(v.replace(/[£,\s]/g, '')).toFixed(2);
        const y = a.rect[1] + 4;
        const row = rows.find(r => Math.abs(r.y - y) <= 3);
        if (row) row.items.push({ x: a.rect[0], y, str: v }); else rows.push({ y, items: [{ x: a.rect[0], y, str: v }] });
      });
    } catch (e) { /* plain PDF */ }
    rows.sort((p, q) => q.y - p.y).forEach(r => {
      const text = r.items.sort((p, q) => p.x - q.x).map(x => x.str).join(' ').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    });
  }
  return lines;
}

const r2 = n => Math.round(n * 100) / 100;

function parseInvoiceText(lines) {
  const money = /(?:£\s*)?(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\b/g;
  const amountsIn = line => [...line.matchAll(money)].map(m => parseFloat(m[1].replace(/,/g, '')));
  // A label's amount is on its own line, or - when the figures are laid out below the labels - on the next line or two
  const amountFor = idx => {
    for (let k = 0; k <= 2 && idx + k < lines.length; k++) {
      const found = amountsIn(lines[idx + k]);
      if (found.length) return found[found.length - 1];
    }
    return null;
  };
  // Last match wins: on multi-page invoices the real totals are at the end, earlier pages only carry page sub-totals
  const findAmount = patterns => {
    for (const pat of patterns) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (pat.test(lines[i])) {
          const v = amountFor(i);
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
  const agrees = () => net != null && vat != null && gross != null && Math.abs(net + vat - gross) < 0.02;

  // When the labelled figures do not add up, look for the net + VAT = total set among all the amounts,
  // working back from the end of the invoice
  if (!agrees()) {
    const all = [];
    lines.forEach(l => amountsIn(l).forEach(a => all.push(a)));
    const tail = all.slice(-60).reverse();
    const rates = [0.2, 0.05, 0];
    const candidates = gross != null ? [gross, ...tail] : tail;
    outer: for (const g of candidates) {
      for (const n of tail) {
        if (n >= g || n <= 0) continue;
        const v = r2(g - n);
        if (rates.some(r => Math.abs(n * r - v) <= 0.03) && (v === 0 || tail.some(t => Math.abs(t - v) < 0.005))) {
          net = n; vat = v; gross = g; netEstimated = false; break outer;
        }
      }
    }
  }
  if (net == null && gross != null && vat != null) net = r2(gross - vat);
  if (net == null && gross != null) {
    const rateLine = lines.find(l => /rate\s*%\s*:/i.test(l));
    const rate = rateLine ? parseFloat((rateLine.match(/(\d+(?:\.\d+)?)\s*$/) || [])[1]) : 20;
    net = r2(gross / (1 + (rate || 20) / 100));
    netEstimated = true;
  }
  // VAT must be the difference between the total and the net price - never a repeat of the net figure
  if (gross != null && net != null && !agrees()) {
    if (net >= gross || Math.abs(net - (vat == null ? NaN : vat)) < 0.005) {
      const derived = r2(gross / 1.2);
      if (Math.abs(derived - net) > 0.02) netEstimated = true; // the labelled net already fits the total at 20% VAT, so it is not a guess
      net = derived;
    }
    vat = r2(gross - net);
  }
  if (vat == null && net != null && gross != null) vat = r2(gross - net);
  const totalsAgree = agrees();

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

  return { net, vat, gross, netEstimated, totalsAgree, po: po ? po.toUpperCase() : null, invNo, date, merchant, deliverText, rawText: text, lines, hasText: text.length > 40 };
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

// Suggest jobs from partial addresses: "Meaford" on an invoice should point at "18 Meaford Road, ...".
// Words that most jobs share (road, town, county) count for little; a street name that only a few jobs share counts a lot.
const ADDRESS_STOPWORDS = new Set(['road', 'rd', 'street', 'st', 'lane', 'ln', 'avenue', 'ave', 'close', 'drive', 'dr', 'way', 'court', 'crescent', 'grove', 'place', 'the', 'and', 'on', 'of', 'flat', 'unit', 'house', 'farm']);
function addressWords(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}
function wordsClose(a, b) {
  if (a === b) return true;
  if (a.length < 6 || b.length < 6 || Math.abs(a.length - b.length) > 1) return false;
  // one letter out (typo / OCR slip)
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}
function suggestSites(text, sites, limit = 3) {
  const textWords = addressWords(text);
  if (!textWords.length || !sites.length) return [];
  const textSet = new Set(textWords);
  const siteWords = sites.map(site => ({
    site,
    words: Array.from(new Set(addressWords(site.address).filter(w => w.length > 2 && !/^\d+$/.test(w) && !ADDRESS_STOPWORDS.has(w) && !/^[a-z]{1,2}\d{1,2}[a-z]?$|^\d[a-z]{2}$/.test(w)))),
    numbers: addressWords(site.address).filter(w => /^\d{1,4}[a-z]?$/.test(w))
  }));
  const df = {};
  siteWords.forEach(sw => sw.words.forEach(w => { df[w] = (df[w] || 0) + 1; }));
  const out = [];
  siteWords.forEach(sw => {
    let score = 0; const hits = [];
    sw.words.forEach(w => {
      const weight = Math.log(1 + sites.length / df[w]) - Math.log(2);
      if (weight <= 0.3) return;
      const found = textSet.has(w) || (w.length >= 6 && textWords.some(t => wordsClose(t, w)));
      if (found) { score += weight; hits.push(w); }
    });
    if (!hits.length) return;
    // "18 meaford" beats a bare "meaford"
    const numberNextToStreet = sw.numbers.some(n => hits.some(h => textWords.some((t, i) => t === n && (textWords[i + 1] === h || textWords[i - 1] === h))));
    if (numberNextToStreet) score += 2;
    out.push({ site: sw.site, score, hits, exactNumber: numberNextToStreet });
  });
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// An operative's weekly invoice often lists several jobs. Pull out "address ... £amount" lines and group them by job.
function parseAllocations(parsed) {
  const sites = allSites.filter(s => !s.is_archived);
  const bySite = new Map();
  (parsed.lines || []).forEach(line => {
    if (/total|vat|sub\s*-?total|balance|amount due|retention|cis|deduct/i.test(line)) return;
    const amts = [...line.matchAll(/(?:£\s*)?(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\b/g)];
    if (!amts.length) return;
    const amount = parseFloat(amts[amts.length - 1][1].replace(/,/g, ''));
    if (!(amount > 0)) return;
    const g = suggestSites(line, sites, 1)[0];
    if (!g || g.score < 1) return;
    bySite.set(String(g.site.id), Math.round(((bySite.get(String(g.site.id)) || 0) + amount) * 100) / 100);
  });
  return Array.from(bySite.entries()).map(([siteId, net]) => ({ siteId, net }));
}

function mondayOfISO(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return diaryDateKey(d);
}
// Week the invoice covers: "week ending 18/10/2026" if it says so, otherwise the week before the invoice date
function guessInvoiceWeek(parsed) {
  const m = String(parsed.rawText || '').match(/(?:week\s*ending|w\/e|w\.e\.?|week\s*commencing|w\/c)\s*:?\s*(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/i);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (!isNaN(new Date(iso))) return /commenc|w\/c/i.test(m[0]) ? mondayOfISO(iso) : mondayOfISO(addDaysISO(iso, -6));
  }
  const base = parsed.date || diaryDateKey(new Date());
  return addDaysISO(mondayOfISO(base), -7);
}

// ---- Batch import ----
let invBatch = [];

const OVERHEAD_SITE = { id: 'overhead', address: 'Overhead / general (no job)' };
function invSiteById(id) { return String(id) === OVERHEAD_SITE.id ? OVERHEAD_SITE : allSites.find(s => String(s.id) === String(id)); }

function invSiteOptions(selectedId, includeArchived = false) {
  return `<option value="">Choose job...</option><option value="${OVERHEAD_SITE.id}"${String(selectedId) === OVERHEAD_SITE.id ? ' selected' : ''}>🏢 ${OVERHEAD_SITE.address}</option>` + allSites.filter(x => includeArchived || !x.is_archived || String(x.id) === String(selectedId))
    .map(x => `<option value="${diaryEsc(x.id)}"${String(x.id) === String(selectedId) ? ' selected' : ''}>${diaryEsc(x.address)}${x.is_archived ? ' (archived)' : ''}</option>`).join('');
}

function invPoOptions(siteId, selectedPo) {
  const pos = allPOs.filter(po => String(po.site_id) === String(siteId) && po.status !== 'Cancelled')
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return `<option value="">➕ No PO - record as new invoice</option>` + pos.map(po =>
    `<option value="${diaryEsc(po.po_number)}"${po.po_number === selectedPo ? ' selected' : ''}>${diaryEsc(po.po_number)} - ${diaryEsc(po.merchant)} - ${diaryEsc(String(po.description || '').slice(0, 30))}</option>`).join('');
}

// Why an invoice looks like a repeat (or '' if it does not): already imported, or twice in this batch
function invDuplicateReason(it) {
  const no = String(it.invNo || '').trim().toLowerCase();
  const inRegister = allPdfs.filter(f => f.file_type === 'invoice');
  if (no && inRegister.some(f => String(f.invoice_no || '').trim().toLowerCase() === no)) return 'invoice number already imported';
  if (inRegister.some(f => f.filename === it.file.name && (it.net == null || Math.abs((parseFloat(f.invoice_net) || 0) - it.net) < 0.005))) return 'this file was already imported';
  if (it.net != null && it.gross != null && inRegister.some(f => !f.dup_dismissed && Math.abs((parseFloat(f.invoice_net) || 0) - it.net) < 0.005 && Math.abs((parseFloat(f.invoice_gross) || 0) - it.gross) < 0.005 && (!it.date || !f.invoice_date || f.invoice_date === it.date))) return 'same amounts and date as an invoice already imported';
  const others = invBatch.filter(o => o !== it && o.status !== 'error');
  if (no && others.some(o => String(o.invNo || '').trim().toLowerCase() === no)) return 'same invoice number appears twice in this batch';
  if (others.some(o => o.file.name === it.file.name && o.file.size === it.file.size)) return 'same file added twice in this batch';
  return '';
}

function analyseInvoice(parsed) {
  const matchedPo = parsed.po ? allPOs.find(po => String(po.po_number).toUpperCase() === parsed.po) : null;
  let site = matchedPo ? allSites.find(s => String(s.id) === String(matchedPo.site_id)) : null;
  let how = matchedPo ? `✅ PO ${matchedPo.po_number} found on the invoice` : '';
  if (!site) {
    site = matchSiteByAddress(parsed.deliverText, allSites.filter(s => !s.is_archived));
    if (site) how = `📍 No PO number found - matched from the delivery address`;
  }
  if (!site) {
    const guess = suggestSites((parsed.deliverText || '') + ' ' + (parsed.rawText || ''), allSites.filter(s => !s.is_archived), 1)[0];
    how = parsed.po ? `⚠️ ${parsed.po} is on the invoice but not in the app - choose the job` : '⚠️ No PO number or matching address found - choose the job';
    if (guess) { site = guess.site; how = `🤔 Could be ${guess.site.address} (invoice mentions "${guess.hits.join(', ')}") - check it`; return { matchedPo, site, how, duplicate: false, confident: false }; }
  }
  const duplicate = false; // worked out by invDuplicateReason() so it also catches repeats inside the same batch
  const priceOk = parsed.net != null && parsed.hasText;
  const confident = !!site && priceOk && parsed.totalsAgree && !parsed.netEstimated;
  return { matchedPo, site, how, duplicate, confident };
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
        parsed, how: a.how, confident: a.confident,
        siteId: a.site ? String(a.site.id) : '', poNumber: a.matchedPo ? a.matchedPo.po_number : '',
        net: parsed.net, vat: parsed.vat, gross: parsed.gross, invNo: parsed.invNo || '',
        merchant: parsed.merchant || (a.matchedPo ? a.matchedPo.merchant : '') || '', date: parsed.date || '',
        selected: false,
        contractorId: suggestContractor((parsed.merchant || '') + ' ' + ((String(parsed.rawText || '').match(/Operative:\s*([^\n]+)/i) || [])[1] || '')),
        week: guessInvoiceWeek(parsed),
        splits: (() => { const al = parseAllocations(parsed); return al.length >= 2 ? al : null; })(),
        _single: (() => { const al = parseAllocations(parsed); return al.length === 1 ? al[0].siteId : ''; })(),
        priceNote: !parsed.hasText ? 'Looks like a scan/photo - type the price in.' : parsed.net == null ? 'Price not found - type it in.'
          : parsed.netEstimated ? 'Net price estimated from the total - check it.' : parsed.totalsAgree ? '' : 'Check the amounts.'
      });
    }
    if (!item.siteId && item._single && !item.splits) item.siteId = item._single;
    invBatch.push(item);
  }
  document.getElementById('invBatchReading').style.display = 'none';
  e.target.value = '';
  invBatch.forEach(it => {
    if (it.status !== 'ready') return;
    it.duplicateReason = invDuplicateReason(it);
    it.selected = it.confident && !it.duplicateReason;
  });
  renderInvBatch();
}

function invSplitSum(it) { return Math.round((it.splits || []).reduce((t, x) => t + (parseFloat(x.net) || 0), 0) * 100) / 100; }
function invSplitStatus(it) {
  const diff = Math.round(((it.net || 0) - invSplitSum(it)) * 100) / 100;
  return Math.abs(diff) < 0.02 ? `<span style="color: var(--success);">✅ Adds up to the invoice net ${formatPounds(it.net)}</span>`
    : `<span style="color: var(--warning);">⚠️ Allocated ${formatPounds(invSplitSum(it))} of ${formatPounds(it.net) || 'the net price'} - ${diff > 0 ? formatPounds(diff) + ' still to allocate' : formatPounds(-diff) + ' too much'}</span>`;
}
function invSplitTotals(row, it) { const el = row.querySelector('.inv-sp-status'); if (el) el.innerHTML = invSplitStatus(it); }
function invSplitHtml(it) {
  return `<div style="border: 1px dashed var(--border-color); border-radius: var(--radius-sm); padding: 8px;">
    <div style="font-weight: 700; font-size: 0.85rem; margin-bottom: 6px;">✂️ Split across jobs <span style="font-weight: 400; color: var(--text-muted);">- each job gets its share of the net price as a cost</span></div>
    ${it.splits.map((sp, i) => `<div style="display: grid; grid-template-columns: 1fr 130px auto; gap: 6px; margin-bottom: 6px;">
      <select class="form-control inv-sp-site" data-i="${i}" style="min-height: 34px; padding: 4px 8px;">${invSiteOptions(sp.siteId, true)}</select>
      <input type="text" inputmode="decimal" autocomplete="off" class="form-control inv-sp-net" data-i="${i}" placeholder="Net £" value="${sp.net != null ? Number(sp.net).toFixed(2) : ''}" style="min-height: 34px; padding: 4px 8px;">
      <button type="button" class="btn btn-danger btn-sm inv-sp-del" data-i="${i}">✕</button></div>`).join('')}
    <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;"><button type="button" class="btn btn-outline btn-sm inv-sp-add">+ Add job</button><button type="button" class="btn btn-outline btn-sm inv-sp-off">Back to one job</button><span class="inv-sp-status" style="font-size: 0.8rem;">${invSplitStatus(it)}</span></div></div>`;
}

function renderInvBatch() {
  const host = document.getElementById('invBatchList');
  const actions = document.getElementById('invBatchActions');
  if (!invBatch.length) { host.innerHTML = ''; actions.style.display = 'none'; return; }
  invBatch.forEach(it => { if (it.status === 'ready') it.duplicateReason = invDuplicateReason(it); });
  host.innerHTML = invBatch.map(it => {
    if (it.status === 'error') return `<div class="diary-agenda-item" style="cursor: default; border-color: var(--danger);">❌ ${diaryEsc(it.file.name)} - ${diaryEsc(it.message)}</div>`;
    if (it.status === 'done') return `<div class="diary-agenda-item" style="cursor: default; border-color: var(--success);">✅ ${diaryEsc(it.file.name)} - ${diaryEsc(it.message)}</div>`;
    // red = possible duplicate, amber = no job picked yet, green = ready
    const style = it.duplicateReason ? 'border-color: var(--danger); background: rgba(239, 68, 68, 0.15);'
      : !it.siteId ? 'border-color: var(--warning); background: rgba(245, 158, 11, 0.14);'
      : it.confident ? 'border-color: var(--success);' : 'border-color: var(--warning);';
    return `<div class="diary-agenda-item" data-key="${it.key}" style="cursor: default; ${style}">
      <label style="display: flex; gap: 8px; align-items: center; font-weight: 700;"><input type="checkbox" class="inv-select"${it.selected ? ' checked' : ''}> ${diaryEsc(it.file.name)}</label>
      <div style="font-size: 0.8rem; margin: 4px 0;">${diaryEsc(it.how)}${it.duplicateReason ? ` · <strong style="color: #fca5a5;">⚠️ Possible duplicate - ${diaryEsc(it.duplicateReason)}</strong>` : ''}${it.priceNote ? ' · ' + diaryEsc(it.priceNote) : ''}${!it.siteId ? ' · <strong style="color: var(--warning);">No job yet - will import as unattributed</strong>' : ''}</div>
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
      ${it.contractorId ? `<div style="margin-top: 8px; font-size: 0.8rem;"><label>👷 Labour invoice for the week starting <input type="date" class="form-control inv-week" value="${diaryEsc(it.week || '')}" style="display: inline-block; width: auto; min-height: 32px; padding: 2px 8px;"></label> <span style="color: var(--text-muted);">- counted as labour on the job, not materials</span></div>` : ''}
      <div style="margin-top: 8px;">
        ${it.splits ? invSplitHtml(it) : `<button type="button" class="btn btn-outline btn-sm inv-split-on">✂️ Split across several jobs</button>`}
      </div>
    </div>`;
  }).join('');
  const ready = invBatch.filter(i => i.status === 'ready');
  actions.style.display = ready.length ? 'flex' : 'none';
  const tickAll = document.getElementById('invTickAll');
  tickAll.checked = ready.length > 0 && ready.every(i => i.selected);
  document.getElementById('btnInvImportSelected').textContent = `Import ticked invoices (${ready.filter(i => i.selected).length})`;
  document.getElementById('btnInvImportAll').textContent = `Import all (${ready.length})`;

  host.querySelectorAll('[data-key]').forEach(row => {
    const it = invBatch.find(x => x.key === row.dataset.key);
    const bind = (sel, fn) => row.querySelector(sel).addEventListener('change', fn);
    bind('.inv-select', ev => { it.selected = ev.target.checked; renderInvBatch(); });
    bind('.inv-site', ev => { it.siteId = ev.target.value; it.poNumber = ''; renderInvBatch(); });
    bind('.inv-po', ev => { it.poNumber = ev.target.value; });
    bind('.inv-contractor', ev => { it.contractorId = ev.target.value; if (it.contractorId && !it.week) it.week = guessInvoiceWeek(it.parsed || {}); renderInvBatch(); });
    bind('.inv-merchant', ev => { it.merchant = ev.target.value.trim(); });
    bind('.inv-no', ev => { it.invNo = ev.target.value.trim(); renderInvBatch(); });
    bind('.inv-net', ev => { it.net = ev.target.value === '' ? null : parseFloat(ev.target.value); });
    bind('.inv-vat', ev => { it.vat = ev.target.value === '' ? null : parseFloat(ev.target.value); });
    bind('.inv-gross', ev => { it.gross = ev.target.value === '' ? null : parseFloat(ev.target.value); });
    const wk = row.querySelector('.inv-week'); if (wk) wk.addEventListener('change', ev => { it.week = ev.target.value; });
    const splitOn = row.querySelector('.inv-split-on'); if (splitOn) splitOn.addEventListener('click', () => { it.splits = [{ siteId: it.siteId || '', net: it.net }, { siteId: '', net: null }]; renderInvBatch(); });
    row.querySelectorAll('.inv-sp-site').forEach(el => el.addEventListener('change', ev => { it.splits[+el.dataset.i].siteId = ev.target.value; invSplitTotals(row, it); }));
    row.querySelectorAll('.inv-sp-net').forEach(el => el.addEventListener('change', ev => { const v = ev.target.value.replace(/[£,\s]/g, ''); it.splits[+el.dataset.i].net = v === '' ? null : parseFloat(v); invSplitTotals(row, it); }));
    row.querySelectorAll('.inv-sp-del').forEach(el => el.addEventListener('click', () => { it.splits.splice(+el.dataset.i, 1); if (it.splits.length < 2) { it.siteId = (it.splits[0] || {}).siteId || it.siteId; it.splits = null; } renderInvBatch(); }));
    const spAdd = row.querySelector('.inv-sp-add'); if (spAdd) spAdd.addEventListener('click', () => { const left = Math.round(((it.net || 0) - it.splits.reduce((t, x) => t + (x.net || 0), 0)) * 100) / 100; it.splits.push({ siteId: '', net: left > 0 ? left : null }); renderInvBatch(); });
    const spOff = row.querySelector('.inv-sp-off'); if (spOff) spOff.addEventListener('click', () => { it.siteId = (it.splits[0] || {}).siteId || it.siteId; it.splits = null; renderInvBatch(); });
  });
}

function priceWorkUsersForImport() { return typeof priceWorkUsers === 'function' ? priceWorkUsers() : []; }

// Labour invoices are tied to the operative they came from (so the cost lands in that week's labour, not materials)
function suggestContractor(merchant) {
  const m = String(merchant || '').toLowerCase();
  if (!m) return '';
  const hit = priceWorkUsersForImport().find(u => {
    const tokens = String(u.full_name).toLowerCase().split(/\s+/).filter(t => t.length > 2);
    return tokens.length && tokens.every(t => m.includes(t));
  });
  return hit ? String(hit.id) : '';
}

function contractorOptionsHtml(selected) {
  return '<option value="">Materials / other (not a labour invoice)</option>' + priceWorkUsersForImport()
    .map(u => `<option value="${diaryEsc(u.id)}"${String(u.id) === String(selected) ? ' selected' : ''}>👷 Labour invoice - ${diaryEsc(u.full_name)}</option>`).join('');
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

// No job picked: still imported (kept out of every job's costs) and shown amber in the register until it is attached
async function importUnassignedInvoice(it) {
  if (it.net == null || isNaN(it.net)) throw new Error('Enter the net price');
  const fileId = 'pdf_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const safeName = it.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `site_files/unassigned/${fileId}_${safeName}`;
  const up = await uploadSiteFile(path, it.file);
  const net = Math.round(it.net * 100) / 100;
  const isLabour = !!it.contractorId;
  const record = {
    id: fileId, site_id: '', uploader_id: currentUser.id, uploader_name: currentUser.full_name,
    filename: it.file.name, file_type: 'invoice', file_url: up.url, storage_bucket: up.bucket, storage_path: path,
    po_number: `INV-${String(it.invNo || Date.now()).replace(/[^A-Za-z0-9]/g, '')}`, invoice_no: it.invNo || '', merchant: it.merchant || '', invoice_date: it.date || '',
    contractor_id: it.contractorId || null, cost_type: isLabour ? 'labour' : 'materials', week_start: isLabour ? (it.week || '') : '',
    invoice_net: net, invoice_vat: it.vat == null || isNaN(it.vat) ? null : it.vat, invoice_gross: it.gross == null || isNaN(it.gross) ? null : it.gross,
    created_at: new Date().toISOString()
  };
  await db.collection('pdfs').doc(fileId).set(record);
  if (!allPdfs.some(f => String(f.id) === fileId)) allPdfs.push(record);
  return `${formatPounds(net)} ex VAT imported - no job yet (shown in amber in the register)`;
}

async function importInvoiceItem(it) {
  if (!it.siteId && !(it.splits && it.splits.length > 1)) return importUnassignedInvoice(it);
  const splits = it.splits && it.splits.length > 1 ? it.splits : [{ siteId: it.siteId, net: it.net }];
  const sites = splits.map(sp => invSiteById(sp.siteId));
  if (sites.some(x => !x)) throw new Error(splits.length > 1 ? 'Choose a job for every line of the split' : 'Choose the job');
  if (it.net == null || isNaN(it.net)) throw new Error('Enter the net price');
  if (splits.length > 1) {
    if (splits.some(sp => !(parseFloat(sp.net) > 0))) throw new Error('Enter an amount for every job in the split');
    if (Math.abs(invSplitSum({ splits }) - it.net) >= 0.02) throw new Error(`The split (${formatPounds(invSplitSum({ splits }))}) does not add up to the invoice net (${formatPounds(it.net)})`);
    if (new Set(splits.map(sp => String(sp.siteId))).size !== splits.length) throw new Error('The same job is in the split twice');
  }
  const base = 'pdf_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const safeName = it.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `site_files/${sites[0].id}/${base}_${safeName}`;
  const up = await uploadSiteFile(path, it.file);   // one copy of the PDF, shared by every part of a split
  const total = Math.round(it.net * 100) / 100;
  const isLabour = !!it.contractorId;
  const msgs = [];
  let vatLeft = it.vat == null || isNaN(it.vat) ? null : it.vat, grossLeft = it.gross == null || isNaN(it.gross) ? null : it.gross;
  for (let i = 0; i < splits.length; i++) {
    const site = sites[i];
    const last = i === splits.length - 1;
    const net = Math.round(parseFloat(splits[i].net) * 100) / 100;
    const ratio = total ? net / total : 1;
    const vat = vatLeft == null ? null : last ? Math.round(vatLeft * 100) / 100 : Math.round((it.vat * ratio) * 100) / 100;
    const gross = grossLeft == null ? null : last ? Math.round(grossLeft * 100) / 100 : Math.round((it.gross * ratio) * 100) / 100;
    if (vatLeft != null) vatLeft -= vat;
    if (grossLeft != null) grossLeft -= gross;
    const fileId = splits.length > 1 ? `${base}_${i + 1}` : base;
    const single = splits.length === 1;
    const poNumber = single && it.poNumber ? it.poNumber : `INV-${String(it.invNo || Date.now()).replace(/[^A-Za-z0-9]/g, '')}${single ? '' : '-' + (i + 1)}`;
    const record = {
      id: fileId, site_id: String(site.id), uploader_id: currentUser.id, uploader_name: currentUser.full_name,
      filename: it.file.name, file_type: 'invoice', file_url: up.url, storage_bucket: up.bucket, storage_path: path,
      po_number: poNumber, invoice_no: it.invNo || '', merchant: it.merchant || '', invoice_date: it.date || '', contractor_id: it.contractorId || null,
      cost_type: isLabour ? 'labour' : 'materials', week_start: isLabour ? (it.week || '') : '',
      split_group: single ? '' : base, split_total_net: single ? null : total,
      invoice_net: net, invoice_vat: vat, invoice_gross: gross,
      created_at: new Date().toISOString()
    };
    await db.collection('pdfs').doc(fileId).set(record);
    const fields = await recalcPoFromInvoices(poNumber, [record]);
    if (single && it.poNumber) {
      await db.collection('purchase_orders').doc(poNumber).update(fields);
    } else {
      await db.collection('purchase_orders').doc(poNumber).set({
        po_number: poNumber, seq: null, site_id: String(site.id), site_address: site.address,
        requested_by_id: String(currentUser.id), requested_by_name: currentUser.full_name,
        merchant: it.merchant || 'Unknown merchant', description: `${isLabour ? 'Labour invoice' : 'Invoice'} ${it.invNo || ''} (no PO)`.trim(), est_value: null,
        created_at: new Date().toISOString(), ...fields
      });
    }
    msgs.push(`${formatPounds(net)} to ${site.address}`);
  }
  return isLabour ? `Labour ${msgs.join(' · ')}` : `${msgs.join(' · ')} ex VAT added`;
}

async function runInvoiceImport(todo) {
  if (!db || !isManagementUser(currentUser)) return;
  if (!todo.length) { alert('Tick the invoices you want to import.'); return; }
  const dups = todo.filter(i => i.duplicateReason).length;
  if (dups && !confirm(`${dups} of these look like duplicates (highlighted red). Import them anyway?`)) return;
  const btns = [document.getElementById('btnInvImportSelected'), document.getElementById('btnInvImportAll')];
  btns.forEach(b => { b.disabled = true; });
  let ok = 0, unattributed = 0;
  for (const it of todo) {
    btns[0].textContent = `Importing ${ok + 1} of ${todo.length}...`;
    try {
      it.message = await importInvoiceItem(it);
      it.status = 'done';
      if (!it.siteId) unattributed++;
      ok++;
    } catch (err) {
      alert(`${it.file.name}: ${err.message}`);
    }
  }
  btns.forEach(b => { b.disabled = false; });
  invBatch = invBatch.filter(i => i.status !== 'done'); // imported ones leave the list, only unimported/failed stay
  renderInvBatch();
  renderInvoiceRegister();
  if (ok) showGreenToast(`✅ ${ok} invoice${ok > 1 ? 's' : ''} imported successfully${unattributed ? ` (${unattributed} still need a job - see the register)` : ''}`);
}

function handleImportSelectedInvoices() {
  return runInvoiceImport(invBatch.filter(i => i.status === 'ready' && i.selected));
}

function handleImportAllInvoices() {
  return runInvoiceImport(invBatch.filter(i => i.status === 'ready'));
}

// ---- Register ----
function renderInvoicesView() {
  if (!currentUser || !isManagementUser(currentUser)) return;
  if (typeof renderInvoiceInbox === 'function') renderInvoiceInbox();
  renderLabourCheck();
  const siteSel = document.getElementById('invFilterSite');
  const merchSel = document.getElementById('invFilterMerchant');
  const invoices = allPdfs.filter(f => f.file_type === 'invoice');
  const prevSite = siteSel.value, prevMerch = merchSel.value;
  siteSel.innerHTML = '<option value="">All jobs</option><option value="overhead">🏢 Overhead / general</option>' + allSites.filter(siteInScope).map(s => `<option value="${diaryEsc(s.id)}">${diaryEsc(s.address)}</option>`).join('');
  const merchants = Array.from(new Set(invoices.map(f => invMerchantOf(f)).filter(Boolean))).sort();
  merchSel.innerHTML = '<option value="">All merchants</option>' + merchants.map(m => `<option value="${diaryEsc(m)}">${diaryEsc(m)}</option>`).join('');
  siteSel.value = prevSite; merchSel.value = prevMerch;
  renderInvoiceRegister();
}

// Who has worked, and has their weekly invoice arrived? Weeks run Monday to Sunday.
function renderLabourCheck() {
  const host = document.getElementById('invLabourCheck');
  if (!host) return;
  if (!labourFromInvoices()) { host.style.display = 'none'; return; }
  const today = diaryDateKey(new Date());
  const thisMon = mondayOfISO(today);
  const weeks = [0, 1, 2, 3, 4, 5].map(i => addDaysISO(thisMon, -7 * i)).filter(w => w >= labourCutoff());
  const oldest = weeks[weeks.length - 1] || thisMon;
  const alloc = allocateShiftCosts();
  const days = {};
  allShifts.forEach(sh => {
    if (!sh.operative_id || sh.is_drying_day || !sh.shift_date || sh.shift_date < oldest || sh.shift_date > today || isDirectPay(sh.operative_id)) return;
    const a = alloc.get(sh); if (!a) return;
    const k = `${sh.operative_id}|${mondayOfISO(sh.shift_date)}`;
    days[k] = (days[k] || 0) + a.frac;
  });
  const got = {};
  allPdfs.filter(f => isLabourInvoice(f) && f.contractor_id).forEach(f => {
    const wk = f.week_start || addDaysISO(mondayOfISO(f.invoice_date || String(f.created_at).slice(0, 10)), -7);
    const k = `${f.contractor_id}|${wk}`;
    got[k] = (got[k] || 0) + (parseFloat(f.invoice_net) || 0);
  });
  const ids = Array.from(new Set(Object.keys(days).concat(Object.keys(got)).map(k => k.split('|')[0])));
  const people = ids.map(id => ({ id, name: (allUsers.find(u => String(u.id) === id) || {}).full_name || 'Unknown' })).sort((a, b) => a.name.localeCompare(b.name));
  let missing = 0;
  const cell = (id, wk) => {
    const d = Math.round((days[`${id}|${wk}`] || 0) * 10) / 10, g = got[`${id}|${wk}`];
    if (g != null) return `<td style="color: var(--success);">${d ? d + 'd · ' : ''}${money(g)} ✅</td>`;
    const sub = (typeof operativeInvoices !== 'undefined' ? operativeInvoices : []).find(x => x.status === 'submitted' && String(x.user_id) === String(id) && x.week_start === wk);
    if (sub) return `<td style="color: #60a5fa;">${d ? d + 'd · ' : ''}📨 submitted ${money(sub.net)}</td>`;
    if (!d) return '<td style="color: var(--text-muted);">-</td>';
    if (wk === thisMon) return `<td style="color: var(--text-muted);">${d}d · in progress</td>`;
    missing++;
    return `<td style="color: var(--warning); font-weight: 700;">${d}d · no invoice yet</td>`;
  };
  const rows = people.map(p => `<tr><td><strong>${diaryEsc(p.name)}</strong></td>${weeks.map(w => cell(p.id, w)).join('')}</tr>`).join('');
  host.style.display = '';
  host.innerHTML = `<h3 style="margin-bottom: 4px;">👷 Weekly labour invoices</h3>
    <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 8px;">Days booked in the planner against the invoice received for that week. ${missing ? `<strong style="color: var(--warning);">${missing} week${missing > 1 ? 's' : ''} still waiting for an invoice.</strong>` : 'Nothing outstanding.'} Labour only counts as a cost once its invoice is imported below.</p>
    ${people.length ? `<div style="overflow-x: auto;"><table class="rep-table"><thead><tr><th>Operative</th>${weeks.map(w => `<th>w/c ${diaryEsc(formatUKDate(w).slice(0, 5))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p style="color: var(--text-muted);">No shifts booked since the start date.</p>'}`;
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
    .filter(f => !siteF && jobScope === 'mine' ? (!invSiteById(f.site_id) || f.site_id === OVERHEAD_SITE.id || siteInScope(invSiteById(f.site_id))) : true)
    .filter(f => !merchF || invMerchantOf(f) === merchF)
    .filter(f => !q || [f.invoice_no, f.po_number, invMerchantOf(f), f.filename].join(' ').toLowerCase().includes(q))
    .sort((a, b) => String(b.invoice_date || b.created_at).localeCompare(String(a.invoice_date || a.created_at)));
  const sum = key => rows.reduce((t, f) => t + (parseFloat(f[key]) || 0), 0);
  document.getElementById('invRegisterSummary').textContent = rows.length
    ? `${rows.length} invoice${rows.length > 1 ? 's' : ''} · Net ${formatPounds(sum('invoice_net'))} · VAT ${formatPounds(sum('invoice_vat'))} · Total ${formatPounds(sum('invoice_gross'))}`
    : 'No invoices found.';
  const canDelete = isOwnerOrAdminUser(currentUser);
  // Repeats: same invoice number, or same net + total + date. "Not a duplicate" (dup_dismissed) takes an invoice out of the check.
  const allInv = allPdfs.filter(f => f.file_type === 'invoice');
  const sameInvoice = (f, o) => {
    const n1 = String(f.invoice_no || '').trim().toLowerCase(), n2 = String(o.invoice_no || '').trim().toLowerCase();
    if (n1 && n1 === n2) return true;
    const a = parseFloat(f.invoice_net), b = parseFloat(o.invoice_net), ga = parseFloat(f.invoice_gross), gb = parseFloat(o.invoice_gross);
    if ([a, b, ga, gb].some(isNaN)) return false;
    return Math.abs(a - b) < 0.005 && Math.abs(ga - gb) < 0.005 && (!f.invoice_date || !o.invoice_date || f.invoice_date === o.invoice_date);
  };
  const dupMatch = f => f.dup_dismissed ? null : allInv.find(o => String(o.id) !== String(f.id) && !o.dup_dismissed && sameInvoice(f, o)) || null;
  body.innerHTML = rows.map(f => {
    const site = invSiteById(f.site_id);
    const unassigned = !site;
    const match = dupMatch(f);
    const dup = !!match;
    const matchSite = match ? invSiteById(match.site_id) : null;
    const rowStyle = dup ? DUP_ROW_STYLE : unassigned ? 'background: rgba(245, 158, 11, 0.18); box-shadow: inset 4px 0 0 var(--warning);' : '';
    return `<tr${rowStyle ? ` style="${rowStyle}"` : ''}>
      <td>${diaryEsc(formatUKDate(f.invoice_date || f.created_at))}</td>
      <td data-label="Invoice">${diaryEsc(f.invoice_no || '-')}${dup ? DUP_BADGE + `<div style="font-size: 0.72rem; color: #fca5a5;">Matches ${diaryEsc(match.invoice_no ? 'invoice ' + match.invoice_no : match.filename)} on ${diaryEsc(matchSite ? matchSite.address : 'no job yet')}</div>` : ''}${f.source === 'email' ? `<div style="font-size: 0.72rem; color: var(--text-muted);">📧 Emailed${f.needs_review && f.review_reason ? ' - ' + diaryEsc(f.review_reason) : ''}</div>` : ''}</td>
      <td data-label="Merchant">${diaryEsc(invMerchantOf(f) || '-')}${isLabourInvoice(f) ? `<div style="font-size: 0.72rem; color: var(--text-muted);">👷 Labour${f.contractor_id ? ' - ' + diaryEsc((allUsers.find(u => String(u.id) === String(f.contractor_id)) || {}).full_name || '') : ''}${f.week_start ? ' - w/c ' + diaryEsc(formatUKDate(f.week_start)) : ''}</div>` : ''}${f.split_group ? `<div style="font-size: 0.72rem; color: var(--text-muted);">✂️ part of ${formatPounds(f.split_total_net)} invoice</div>` : ''}</td>
      <td data-label="PO">${diaryEsc(String(f.po_number || '').startsWith('INV-') ? 'No PO' : f.po_number)}</td>
      <td data-label="Job">${unassigned ? '<div style="color: var(--warning); font-weight: 700; font-size: 0.8rem;">⚠️ Not attributed to a job</div>' : diaryEsc(site.address)}</td>
      <td data-label="Net £"><strong>${diaryEsc(formatPounds(f.invoice_net) || '-')}</strong></td>
      <td data-label="VAT £">${diaryEsc(formatPounds(f.invoice_vat) || '-')}</td>
      <td data-label="Total £">${diaryEsc(formatPounds(f.invoice_gross) || '-')}</td>
      <td style="white-space: nowrap;">${dup ? `<button type="button" class="btn btn-outline btn-sm inv-keep" data-id="${diaryEsc(f.id)}" title="This is a different invoice - keep it">Not a duplicate</button> ` : ''}<a class="btn btn-outline btn-sm" href="/files/${encodeURIComponent(f.id)}" target="_blank">Open</a>${!site || site === OVERHEAD_SITE ? ` <button type="button" class="btn ${site ? 'btn-outline' : 'btn-primary'} btn-sm inv-assign" data-id="${diaryEsc(f.id)}">${site ? 'Change job' : 'Attach to job'}</button>` : ''}${canDelete ? ` <button type="button" class="btn btn-danger btn-sm inv-delete" data-id="${diaryEsc(f.id)}">Delete</button>` : ''}</td>
    </tr>`;
  }).join('');
  body.querySelectorAll('.inv-assign').forEach(b => b.addEventListener('click', () => openAssignInvoice(b.dataset.id)));
  body.querySelectorAll('.inv-delete').forEach(b => b.addEventListener('click', () => deleteInvoice(b.dataset.id)));
  body.querySelectorAll('.inv-keep').forEach(b => b.addEventListener('click', async () => {
    const f = allPdfs.find(x => String(x.id) === String(b.dataset.id));
    if (!f || !db) return;
    await db.collection('pdfs').doc(String(f.id)).update({ dup_dismissed: true }).catch(err => alert('Could not save: ' + err.message));
    f.dup_dismissed = true;
    renderInvoiceRegister();
    showGreenToast('✅ Kept - marked as not a duplicate');
  }));
}

// ---- Attach an unassigned invoice to a job ----
async function openAssignInvoice(fileId) {
  const f = allPdfs.find(x => String(x.id) === String(fileId));
  if (!f) return;
  document.getElementById('invAssignOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'invAssignOverlay';
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.innerHTML = `<div class="modal-card"><div class="modal-header"><h3>Attach invoice to a job</h3></div>
    <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 10px;">${diaryEsc(invMerchantOf(f) || f.filename)} · ${diaryEsc(f.invoice_no || 'no invoice no.')} · ${diaryEsc(formatPounds(f.invoice_net) || '-')} net</p>
    <div id="invAssignSuggest" style="margin-bottom: 12px;">⏳ Reading the invoice for an address...</div>
    <select id="invAssignSite" class="form-control">${invSiteOptions('', true)}</select>
    <div style="display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end;">
      <button type="button" class="btn btn-outline" id="invAssignCancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="invAssignSave">Attach</button>
    </div></div>`;
  document.body.appendChild(overlay);
  const sel = overlay.querySelector('#invAssignSite');
  overlay.querySelector('#invAssignCancel').addEventListener('click', close);
  overlay.querySelector('#invAssignSave').addEventListener('click', async ev => {
    if (!sel.value) { alert('Choose the job.'); return; }
    ev.target.disabled = true;
    try { await assignInvoiceToSite(f, sel.value); close(); showGreenToast('🧾 Invoice attached to the job'); }
    catch (err) { alert('Could not attach: ' + err.message); ev.target.disabled = false; }
  });
  // suggestions: read the PDF text, plus the merchant and file name
  let text = [invMerchantOf(f), f.filename].join(' ');
  try {
    const res = await fetch('/files/' + encodeURIComponent(f.id));
    const blob = await res.blob();
    const lines = await extractPdfLines(new File([blob], f.filename || 'invoice.pdf', { type: 'application/pdf' }));
    text += ' ' + lines.join(' ');
  } catch (err) { console.warn('Could not read invoice text', err); }
  const box = overlay.querySelector('#invAssignSuggest');
  if (!box) return;
  const guesses = suggestSites(text, allSites, 3);
  if (!guesses.length) { box.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">No address found on the invoice - choose the job below.</span>'; return; }
  box.innerHTML = `<div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 6px;">Could be:</div>` + guesses.map(g =>
    `<button type="button" class="btn btn-outline inv-guess" data-id="${diaryEsc(g.site.id)}" style="display: block; width: 100%; text-align: left; margin-bottom: 6px;">${diaryEsc(g.site.address)}${g.site.is_archived ? ' (archived)' : ''} <small style="color: var(--text-muted);">- invoice mentions "${diaryEsc(g.hits.join(', '))}"</small></button>`).join('');
  box.querySelectorAll('.inv-guess').forEach(b => b.addEventListener('click', () => { sel.value = b.dataset.id; }));
  if (guesses.length === 1 || guesses[0].score > guesses[1].score * 1.5) sel.value = String(guesses[0].site.id);
}

async function assignInvoiceToSite(f, siteId) {
  const site = invSiteById(siteId);
  if (!site) throw new Error('Job not found');
  // an invoice imported with no job (or an emailed one with no price found) has no cost on any job yet
  if (f.invoice_net == null || isNaN(parseFloat(f.invoice_net))) {
    const typed = prompt('The price was not found on this invoice. Enter the net price (ex VAT):');
    const net = parseFloat(String(typed || '').replace(/[£,\s]/g, ''));
    if (isNaN(net)) throw new Error('A net price is needed to cost the invoice');
    f.invoice_net = Math.round(net * 100) / 100;
    await db.collection('pdfs').doc(String(f.id)).update({ invoice_net: f.invoice_net });
  }
  await db.collection('pdfs').doc(String(f.id)).update({ site_id: String(site.id), needs_review: false });
  f.site_id = String(site.id); f.needs_review = false;
  const po = allPOs.find(p => p.po_number === f.po_number);
  if (po) {
    await db.collection('purchase_orders').doc(po.po_number).update({ site_id: String(site.id), site_address: site.address });
    po.site_id = String(site.id); po.site_address = site.address;
  } else {
    const poNumber = f.po_number || `INV-${String(f.invoice_no || f.id).replace(/[^A-Za-z0-9]/g, '')}`;
    const fields = await recalcPoFromInvoices(poNumber, [f]);
    await db.collection('purchase_orders').doc(poNumber).set({
      po_number: poNumber, seq: null, site_id: String(site.id), site_address: site.address,
      requested_by_id: String(currentUser.id), requested_by_name: currentUser.full_name,
      merchant: f.merchant || 'Unknown merchant', description: `${isLabourInvoice(f) ? 'Labour invoice' : 'Invoice'} ${f.invoice_no || ''} (no PO)`.trim(), est_value: null,
      created_at: new Date().toISOString(), ...fields
    });
    if (f.po_number !== poNumber) { await db.collection('pdfs').doc(String(f.id)).update({ po_number: poNumber }); f.po_number = poNumber; }
  }
  renderInvoiceRegister();
}

async function deleteInvoice(fileId) {
  const f = allPdfs.find(x => String(x.id) === String(fileId));
  if (!f || !isOwnerOrAdminUser(currentUser) || !confirm('Delete this invoice and take its cost off the job?')) return;
  const sharedFile = f.storage_path && allPdfs.some(x => x.id !== f.id && x.storage_path === f.storage_path);
  if (f.storage_path && !sharedFile && typeof firebase.storage === 'function') {
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
  document.getElementById('btnInvImportAll').addEventListener('click', handleImportAllInvoices);
  document.getElementById('invTickAll').addEventListener('change', ev => {
    invBatch.forEach(i => { if (i.status === 'ready') i.selected = ev.target.checked; });
    renderInvBatch();
  });
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
let financeVariations = [];
let financeRates = {};
let financePay = {};
let financeHourly = {};   // direct employees on an hourly rate: { rate, hpd }
function isDirectPay(opId) { const p = financePay[String(opId)]; return p === 'hourly' || p === 'direct'; }
let financeUnsubs = [];

function startFinanceSync() {
  if (financeUnsubs.length || !db || !currentUser || !isManagementUser(currentUser)) return;
  const warn = name => err => console.warn(`Firestore ${name} error:`, err);
  financeUnsubs.push(db.collection('finance_jobs').onSnapshot(snap => {
    financeJobs = {};
    snap.docs.forEach(d => { financeJobs[d.id] = d.data(); });
    refreshFinanceViews();
    fsMarkReady('finance_jobs');
  }, warn('finance_jobs')));
  financeUnsubs.push(db.collection('finance_costs').onSnapshot(snap => {
    financeCosts = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    refreshFinanceViews();
    fsMarkReady('finance_costs');
  }, warn('finance_costs')));
  financeUnsubs.push(db.collection('finance_variations').onSnapshot(snap => {
    financeVariations = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    refreshFinanceViews();
    fsMarkReady('finance_variations');
  }, warn('finance_variations')));
  financeUnsubs.push(db.collection('customer_invoices').onSnapshot(snap => {
    customerInvoices = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    refreshFinanceViews();
    fsMarkReady('customer_invoices');
  }, warn('customer_invoices')));
  financeUnsubs.push(db.collection('finance_rates').onSnapshot(snap => {
    financeRates = {};
    financePay = {};
    financeHourly = {};
    snap.docs.forEach(d => {
      const data = d.data();
      const pt = ['price', 'hourly', 'direct'].includes(data.pay_type) ? data.pay_type : 'day';
      financePay[d.id] = pt;
      if (pt === 'hourly') {
        // an hourly rate is turned into a cost per full day (hours per day, 8 unless set); AM or PM shifts are half
        const hr = parseFloat(data.hourly_rate), hpd = parseFloat(data.hours_per_day) || 8;
        financeHourly[d.id] = { rate: isNaN(hr) ? null : hr, hpd };
        if (!isNaN(hr)) financeRates[d.id] = Math.round(hr * hpd * 100) / 100;
      } else {
        const v = parseFloat(data.day_rate);
        if (!isNaN(v)) financeRates[d.id] = v;
      }
    });
    refreshFinanceViews();
    fsMarkReady('finance_rates');
  }, warn('finance_rates')));
}

function stopFinanceSync() {
  financeUnsubs.forEach(u => u());
  financeUnsubs = [];
  financeJobs = {};
  financeCosts = [];
  financeVariations = [];
  financeRates = {};
  financePay = {};
  financeHourly = {};
  customerInvoices = [];
  // forget what was loaded so the next login never publishes from half-loaded data
  ['finance_jobs', 'finance_costs', 'finance_variations', 'finance_rates', 'customer_invoices', 'pos'].forEach(n => fsReady.delete(n));
  clearTimeout(fsTimer);
  fsLast = null;
}

let uiRefreshPending = false;

// True while the user is typing in a box inside this container (so we don't redraw it under them)
function isTypingIn(containerId) {
  const a = document.activeElement;
  const box = document.getElementById(containerId);
  return !!(a && box && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && box.contains(a));
}

// ---- Finance summary for GVD Logic ----
// GVD Logic (the job register) shows each linked job's cost from here. The figures come from computeSiteFinance, the same
// calculation as the Finance tab, so the two apps always agree. Written only by a management user, only once every source
// the calculation needs has loaded (never from cached or half-loaded data), and only for jobs whose figures have changed.
const FS_NEEDED = ['sites', 'shifts', 'pdfs', 'pos', 'settings', 'finance_jobs', 'finance_costs', 'finance_variations', 'finance_rates', 'customer_invoices'];
const fsReady = new Set();
let fsTimer = null;
let fsLast = null;   // site id -> signature of what is already stored
const fsSig = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
const fs2 = n => n == null || isNaN(n) ? null : Math.round(n * 100) / 100;
function fsMarkReady(name) {
  fsReady.add(name);
  if (!db || !currentUser || !isManagementUser(currentUser) || !FS_NEEDED.every(n => fsReady.has(n))) return;
  clearTimeout(fsTimer);
  fsTimer = setTimeout(publishFinanceSummary, 5000);
}
async function publishFinanceSummary() {
  try {
    if (!db || !currentUser || !isManagementUser(currentUser)) return;
    if (!fsLast) {
      fsLast = {};
      const snap = await db.collection('finance_summary').get();
      snap.forEach(d => { const x = { ...d.data() }; delete x.updated_at; fsLast[d.id] = fsSig(x); });
    }
    const writes = [];
    allSites.forEach(site => {
      const f = computeSiteFinance(site);
      const rec = {
        site_id: String(site.id), site_address: site.address || '',
        value: fs2(f.value), variations_approved: fs2(f.variationsApproved), total_cost: fs2(f.totalCost), profit: fs2(f.profit),
        materials_invoiced: fs2(f.invoiced), labour_invoiced: fs2(f.labourInvoiced), labour_day_rate: fs2(f.labour),
        on_order: fs2(f.onOrder), extras: fs2(f.extras), labour_planned: fs2(f.labourPlanned)
      };
      const sig = fsSig(rec);
      if (fsLast[rec.site_id] !== sig) writes.push({ rec, sig });
    });
    for (let i = 0; i < writes.length; i += 400) {
      const batch = db.batch();
      writes.slice(i, i + 400).forEach(w => batch.set(db.collection('finance_summary').doc(w.rec.site_id), { ...w.rec, updated_at: new Date().toISOString() }));
      await batch.commit();
      writes.slice(i, i + 400).forEach(w => { fsLast[w.rec.site_id] = w.sig; });
    }
  } catch (err) { console.warn('Finance summary publish failed:', err); }
}

function refreshFinanceViews() {
  if (!currentUser || !isManagementUser(currentUser)) return;
  if (fsReady.size) { clearTimeout(fsTimer); if (FS_NEEDED.every(n => fsReady.has(n))) fsTimer = setTimeout(publishFinanceSummary, 5000); }
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

/**
 * Cost every booked shift so that a person's cost on any one day can NEVER exceed their day rate, however many jobs
 * they are booked on. The day is two halves (AM, PM). An AM shift uses the morning, a PM shift the afternoon, an
 * all-day shift both. Each half is worth half the day rate and is shared equally between the shifts using it:
 *   4 AM jobs on £200        -> £100 for the morning, £25 each
 *   2 all-day jobs on £200   -> £200 for the day, £100 each
 *   all-day + AM on £200     -> £200 for the day: £150 and £50
 * Worked in whole pence (largest remainder), so the shares add up to exactly the person's cost for the day.
 * Returns a Map of shift -> { frac (share of a day), pence, overlap (booked on more than one job in the same half) }.
 */
function allocateShiftCosts() {
  const groups = {};
  allShifts.forEach(sh => {
    if (!sh.operative_id || sh.is_drying_day) return;
    const k = `${sh.operative_id}|${sh.shift_date}`;
    (groups[k] = groups[k] || []).push(sh);
  });
  const out = new Map();
  Object.keys(groups).forEach(k => {
    const shifts = groups[k].slice().sort((x, y) => String(x.site_id).localeCompare(String(y.site_id)) || String(x.id).localeCompare(String(y.id)));
    const usesAm = sh => sh.shift_period !== 'pm';
    const usesPm = sh => sh.shift_period !== 'am';
    const am = shifts.filter(usesAm).length;
    const pm = shifts.filter(usesPm).length;
    const dayFrac = (am > 0 ? 0.5 : 0) + (pm > 0 ? 0.5 : 0);
    const opId = String(shifts[0].operative_id);
    const rate = financeRates[opId];
    const paid = financePay[opId] !== 'price' && rate != null;
    const totalPence = paid ? Math.round(rate * 100 * dayFrac) : 0;
    const weights = shifts.map(sh => (usesAm(sh) ? 0.5 / am : 0) + (usesPm(sh) ? 0.5 / pm : 0));
    const raw = weights.map(w => (dayFrac ? totalPence * w / dayFrac : 0));
    const pence = raw.map(Math.floor);
    let left = totalPence - pence.reduce((t, v) => t + v, 0);
    raw.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((x, y) => y.r - x.r || x.i - y.i).forEach(o => { if (left > 0) { pence[o.i]++; left--; } });
    shifts.forEach((sh, i) => out.set(sh, {
      frac: weights[i],
      pence: pence[i],
      overlap: (usesAm(sh) && am > 1) || (usesPm(sh) && pm > 1),
    }));
  });
  return out;
}

function computeSiteFinance(site) {
  const sid = String(site.id);
  const pos = allPOs.filter(po => String(po.site_id) === sid && po.status !== 'Cancelled');
  const invoicedAll = pos.filter(po => po.invoice_value != null).reduce((t, po) => t + (parseFloat(po.invoice_value) || 0), 0);
  // Operatives' invoices are labour, not materials
  const labourDocs = allPdfs.filter(f => isLabourInvoice(f) && String(f.site_id) === sid);
  const labourAllNet = labourDocs.reduce((t, f) => t + (parseFloat(f.invoice_net) || 0), 0);
  const labourInvoiced = Math.round(labourDocs.filter(labourInvoiceCounts).reduce((t, f) => t + (parseFloat(f.invoice_net) || 0), 0) * 100) / 100;
  const invoiced = Math.max(0, Math.round((invoicedAll - labourAllNet) * 100) / 100);
  const onOrder = pos.filter(po => po.invoice_value == null && po.est_value != null).reduce((t, po) => t + (parseFloat(po.est_value) || 0), 0);
  const extrasList = financeCosts.filter(c => String(c.site_id) === sid);
  const extras = extrasList.reduce((t, c) => t + (parseFloat(c.amount) || 0), 0);

  // Only shifts up to and including today count. Future (planned) shifts are shown separately and not costed.
  const todayKey = diaryDateKey(new Date());
  const byOp = {};
  let labour = 0, labourPlanned = 0;
  const noRate = new Set();
  // One person's cost on one day can never exceed their day rate: the day is worked out once per person across ALL sites
  // and shared out between the jobs (see allocateShiftCosts).
  const alloc = allocateShiftCosts();
  const cutoff = labourCutoff();
  let labourEstimate = 0;
  const doubleBooked = new Set();
  allShifts.filter(sh => String(sh.site_id) === sid && sh.operative_id && !sh.is_drying_day).forEach(sh => {
    const a = alloc.get(sh) || { frac: 0, pence: 0, overlap: false };
    const frac = a.frac;
    if ((sh.shift_date || '') >= cutoff && !isDirectPay(sh.operative_id)) {
      // from the cutoff, labour comes from invoices; the day-rate figure is only an estimate
      const r0 = financeRates[String(sh.operative_id)];
      if (financePay[String(sh.operative_id)] !== 'price' && r0 != null && (sh.shift_date || '') <= todayKey) labourEstimate += a.pence / 100;
      return;
    }
    if (a.overlap) {
      const u0 = allUsers.find(x => String(x.id) === String(sh.operative_id));
      doubleBooked.add(`${u0 ? u0.full_name : 'Unknown'} on ${sh.shift_date}`);
    }
    const rate = financeRates[String(sh.operative_id)];
    const priceWork = financePay[String(sh.operative_id)] === 'price';
    const isFuture = (sh.shift_date || '') > todayKey;
    const cost = priceWork || rate == null ? 0 : a.pence / 100;
    if (isFuture) { labourPlanned += cost; return; }
    const u = allUsers.find(x => String(x.id) === String(sh.operative_id));
    const name = u ? u.full_name : 'Unknown';
    if (rate == null && !priceWork) noRate.add(name);
    const row = byOp[sh.operative_id] = byOp[sh.operative_id] || { name, days: 0, cost: 0, priceWork };
    row.days = Math.round((row.days + frac) * 1000) / 1000;
    row.cost = Math.round((row.cost + cost) * 100) / 100;
    labour = Math.round((labour + cost) * 100) / 100;
  });

  // Job value = original quote + approved variations (omissions are negative). Pending ones are shown but not counted.
  const baseValue = financeJobs[sid] && financeJobs[sid].job_value != null ? parseFloat(financeJobs[sid].job_value) : null;
  const variations = financeVariations.filter(v => String(v.site_id) === sid).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const variationsApproved = Math.round(variations.filter(v => v.status === 'approved').reduce((t, v) => t + (parseFloat(v.amount) || 0), 0) * 100) / 100;
  const variationsPending = Math.round(variations.filter(v => v.status === 'pending').reduce((t, v) => t + (parseFloat(v.amount) || 0), 0) * 100) / 100;
  const value = baseValue != null ? Math.round((baseValue + variationsApproved) * 100) / 100 : null;
  const totalCost = invoiced + labourInvoiced + onOrder + labour + extras;
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
  return { contractors, value, baseValue, variations, variationsApproved, variationsPending, invoiced, labourInvoiced, labourEstimate, onOrder, labour, labourPlanned, extras, extrasList, byOp: Object.values(byOp), noRate: Array.from(noRate), doubleBooked: Array.from(doubleBooked), totalCost, profit, margin };
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
  const dupIds = findDuplicateCostIds(f.extrasList);
  const costRows = f.extrasList.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.created_at || '').localeCompare(String(a.created_at || ''))).map(c => `<tr${dupIds.has(c.id) ? ` style="${DUP_ROW_STYLE}"` : ''}>
      <td>${diaryEsc(formatUKDate(c.date))}</td><td>${diaryEsc(c.description)}${dupIds.has(c.id) ? DUP_BADGE : ''}<div style="font-size: 0.75rem; color: var(--text-muted);">${diaryEsc(c.category || '')}</div></td>
      <td style="text-align: right;">${money(c.amount)}</td>
      <td style="white-space: nowrap;"><button type="button" class="btn btn-outline btn-sm fin-edit-cost" data-id="${diaryEsc(c.id)}" style="padding: 2px 8px;">Edit</button> <button type="button" class="btn btn-danger btn-sm fin-del-cost" data-id="${diaryEsc(c.id)}" style="padding: 2px 8px;">Delete</button></td></tr>`).join('');

  const fjT = financeJobs[String(site.id)] || {};
  const trackerInput = (key, label, type, ph) => `<label style="font-size: 0.75rem; color: var(--text-muted); display: block;">${label}<input type="${type}" class="form-control fin-track" data-key="${key}" value="${diaryEsc(fjT[key] || '')}"${ph ? ` placeholder="${ph}"` : ''} style="margin-top: 2px;"></label>`;
  host.innerHTML = `
    <div class="site-card" style="margin-bottom: 16px;">
      <h4 style="margin-bottom: 8px;">Job tracker <span style="font-weight: 400; font-size: 0.8rem; color: var(--text-muted);">- used by the finance reports. Install and completion dates come from the planner; only fill in dates here to override them.</span></h4>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px;">
        ${trackerInput('client', 'Client', 'text', 'e.g. Stoke City Council')}
        ${trackerInput('client_po', 'Client PO', 'text', '')}
        ${trackerInput('handover_date', 'Handover docs sent', 'date')}
        ${trackerInput('paid_date', 'Date paid', 'date')}
        ${trackerInput('install_override', 'Install date (override)', 'date')}
        ${trackerInput('completion_override', 'Completion date (override)', 'date')}
      </div>
      <label style="display: flex; gap: 8px; align-items: center; margin-top: 10px; cursor: pointer;"><input type="checkbox" id="finTrackIssues"${fjT.flag_issues ? ' checked' : ''}> <strong>Flag as ISSUES</strong></label>
      <input type="text" class="form-control fin-track" data-key="issue_note" value="${diaryEsc(fjT.issue_note || '')}" placeholder="What is the issue? (shows in the reports)" style="margin-top: 6px;">
    </div>
    <div class="site-card" style="margin-bottom: 16px;">
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <label for="finJobValue" style="font-weight: 700;">Original quote £ ex VAT</label>
        <input type="text" inputmode="decimal" autocomplete="off" id="finJobValue" class="form-control" step="0.01" min="0" value="${f.value != null ? f.value : ''}" placeholder="e.g. 10000" style="width: 180px;">
      </div>
      ${f.value == null ? '<p style="color: var(--warning); font-size: 0.85rem; margin-top: 8px;">Enter the original quote to see profit and margin.</p>' : ''}
      ${f.baseValue != null && f.variations.length ? `<p style="margin-top: 8px; font-size: 0.9rem;">Quote ${money(f.baseValue)} ${f.variationsApproved < 0 ? '−' : '+'} variations ${money(Math.abs(f.variationsApproved))} = <strong>current job value ${money(f.value)}</strong>${f.variationsPending ? ` <span style="color: var(--warning);">(${money(f.variationsPending)} of pending variations not included)</span>` : ''}</p>` : ''}
      ${isOwnerOrAdminUser(currentUser) ? `<div style="margin-top: 12px;"><button type="button" class="btn btn-primary" id="finCreateInvoice" style="width: auto;">🧾 Create invoice for ${f.value != null ? money(f.value) : 'the job'}</button></div>` : ''}
    </div>
    <div class="site-card" style="margin-bottom: 16px;">
      <h4 style="margin-bottom: 4px;">Variations</h4>
      <p style="color: var(--text-muted); font-size: 0.8rem; margin-bottom: 8px;">Extra or omitted works agreed after the quote. Approved variations change the job value, and so profit, margin and the invoice. Use a minus for omissions.</p>
      ${f.variations.length ? `<div style="overflow-x: auto; margin-bottom: 10px;"><table class="rep-table"><thead><tr><th>Ref</th><th>Date</th><th>Description of works</th><th style="text-align: right;">Amount</th><th>Status</th><th></th></tr></thead><tbody>${f.variations.map((v, i) => `<tr>
        <td><strong>${diaryEsc(v.ref || 'VO' + (i + 1))}</strong></td><td>${diaryEsc(formatUKDate(v.date))}</td><td style="white-space: normal;">${diaryEsc(v.description)}</td>
        <td style="text-align: right; white-space: nowrap; ${parseFloat(v.amount) < 0 ? 'color: #ef4444;' : ''}">${money(v.amount)}</td>
        <td><select class="form-control fin-var-status" data-id="${diaryEsc(v.id)}" style="min-height: 30px; padding: 2px 6px; width: auto;"><option value="approved"${v.status === 'approved' ? ' selected' : ''}>Approved</option><option value="pending"${v.status === 'pending' ? ' selected' : ''}>Pending</option><option value="rejected"${v.status === 'rejected' ? ' selected' : ''}>Rejected</option></select></td>
        <td style="white-space: nowrap;"><button type="button" class="btn btn-outline btn-sm fin-var-edit" data-id="${diaryEsc(v.id)}" style="padding: 2px 8px;">Edit</button> <button type="button" class="btn btn-danger btn-sm fin-var-del" data-id="${diaryEsc(v.id)}" style="padding: 2px 8px;">✕</button></td></tr>`).join('')}</tbody></table></div>` : ''}
      <form id="finVarForm" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px;">
        <input type="text" id="finVarDesc" class="form-control" placeholder="Description of the works" required style="grid-column: span 2;">
        <input type="text" inputmode="decimal" autocomplete="off" id="finVarAmount" class="form-control" placeholder="£ ex VAT (minus to omit)" required>
        <input type="date" id="finVarDate" class="form-control" value="${diaryDateKey(new Date())}" required>
        <select id="finVarStatus" class="form-control"><option value="approved">Approved</option><option value="pending">Pending</option></select>
        <button type="submit" class="btn btn-primary">+ Add variation</button>
      </form>
    </div>
    ${(() => {
      const invs = customerInvoices.filter(i => String(i.site_id) === String(site.id)).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      if (!invs.length) return '';
      return `<div class="site-card" style="margin-bottom: 16px;"><h4 style="margin-bottom: 8px;">Invoices raised</h4><table class="planner-table" style="min-width: 0;"><tbody>${invs.map(i => `<tr>
        <td><strong>${diaryEsc(i.number)}</strong><div style="font-size: 0.75rem; color: var(--text-muted);">${diaryEsc(formatUKDate(i.invoice_date))} · ${diaryEsc(i.customer_name)}</div></td>
        <td style="text-align: right; white-space: nowrap;">${money((i.total_pence || 0) / 100)}${i.cis_applied ? `<div style="font-size: 0.7rem; color: var(--text-muted);">CIS ${i.cis_rate}% · payable ${money((i.payable_pence || 0) / 100)}</div>` : ''}</td>
        <td style="text-align: right;"><button type="button" class="btn btn-outline btn-sm ci-download" data-id="${diaryEsc(i.id)}" style="padding: 2px 10px;">PDF</button></td></tr>`).join('')}</tbody></table></div>`;
    })()}

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
        ${row('Labour (day rates)', money(f.labour), labourFromInvoices() ? `Shifts before ${formatUKDate(labourCutoff())} only` : (f.labourPlanned > 0 ? `Shifts up to today only. ${money(f.labourPlanned)} of future shifts not counted yet` : 'Shifts up to and including today'))}
        ${labourFromInvoices() ? row('Labour invoiced', money(f.labourInvoiced), `From operatives' weekly invoices (ex VAT) for weeks from ${formatUKDate(labourCutoff())}.${f.labourEstimate ? ` For reference only, days booked since then at day rates would be about ${money(f.labourEstimate)} - not counted` : ''}`) : ''}
        ${row('Extra costs', money(f.extras))}
        ${row('<strong>Total cost</strong>', '<strong>' + money(f.totalCost) + '</strong>')}
      </tbody></table>
      ${f.doubleBooked && f.doubleBooked.length ? `<p style="color: var(--warning); font-size: 0.85rem; margin-top: 8px;">⚠️ Booked on more than one job at the same time: ${diaryEsc(f.doubleBooked.join('; '))}. Their day rate is shared between those jobs, never charged twice.</p>` : ''}
      ${f.noRate.length ? `<p style="color: var(--warning); font-size: 0.85rem; margin-top: 8px;">⚠️ No day rate set for: ${diaryEsc(f.noRate.join(', '))}. Their shifts cost £0 until a rate is added (Admin Settings, or the Finance page).</p>` : ''}
    </div>

    <div class="site-card" style="margin-bottom: 16px;">
      <h4 style="margin-bottom: 8px;">Labour on this job</h4>
      ${labourRows ? `<table class="planner-table" style="min-width: 0;"><tbody>${labourRows}</tbody></table>` : '<p style="color: var(--text-muted);">No shifts with a day rate yet.</p>'}
    </div>

    <div class="site-card">
      <h4 style="margin-bottom: 8px;">Extra costs</h4>
      <form id="finSiteCostForm" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 10px;">
        <input type="text" id="finSiteCostDesc" class="form-control" placeholder="Description" required>
        <select id="finSiteCostCategory" class="form-control"><option>Materials</option><option>Plant / equipment hire</option><option>Subcontractor</option><option>Waste / skips</option><option>Travel / fuel</option><option>Other</option></select>
        <input type="text" inputmode="decimal" autocomplete="off" id="finSiteCostAmount" class="form-control" step="0.01" min="0" placeholder="£ ex VAT" required>
        <input type="date" id="finSiteCostDate" class="form-control" value="${diaryDateKey(new Date())}" required>
        <button type="submit" class="btn btn-primary">+ Add cost</button>
      </form>
      ${costRows ? `<div style="overflow: auto; max-height: 300px; border: 1px solid var(--border-color); border-radius: var(--radius-sm);"><table class="planner-table" style="min-width: 0;"><tbody>${costRows}</tbody></table></div>` : '<p style="color: var(--text-muted);">No extra costs logged.</p>'}
    </div>`;

  host.querySelector('#finJobValue').addEventListener('change', ev => saveJobValue(site.id, ev.target.value));
  const saveTrack = (patch) => db.collection('finance_jobs').doc(String(site.id)).set({ site_id: String(site.id), ...patch, updated_at: new Date().toISOString() }, { merge: true }).catch(err => alert('Could not save: ' + err.message));
  host.querySelectorAll('.fin-track').forEach(inp => inp.addEventListener('change', () => saveTrack({ [inp.dataset.key]: inp.value.trim() || null })));
  host.querySelector('#finTrackIssues').addEventListener('change', ev => saveTrack({ flag_issues: ev.target.checked }));
  host.querySelector('#finVarForm').addEventListener('submit', ev => {
    ev.preventDefault();
    addVariation(site.id, host.querySelector('#finVarDesc').value, host.querySelector('#finVarAmount').value, host.querySelector('#finVarDate').value, host.querySelector('#finVarStatus').value);
  });
  host.querySelectorAll('.fin-var-status').forEach(sel => sel.addEventListener('change', () => db.collection('finance_variations').doc(sel.dataset.id).update({ status: sel.value, updated_by: currentUser.full_name, updated_at: new Date().toISOString() }).catch(err => alert('Could not save: ' + err.message))));
  host.querySelectorAll('.fin-var-edit').forEach(b => b.addEventListener('click', () => editVariation(b.dataset.id)));
  host.querySelectorAll('.fin-var-del').forEach(b => b.addEventListener('click', () => deleteVariation(b.dataset.id)));
  const ciBtn = host.querySelector('#finCreateInvoice');
  if (ciBtn) ciBtn.addEventListener('click', () => openCustomerInvoiceModal(site.id));
  host.querySelectorAll('.ci-download').forEach(b => b.addEventListener('click', () => {
    const rec = customerInvoices.find(x => x.id === b.dataset.id);
    if (rec) ciDownloadPdf(rec).catch(e => alert('Could not create the PDF: ' + e.message));
  }));
  host.querySelector('#finSiteCostForm').addEventListener('submit', ev => {
    ev.preventDefault();
    addFinanceCost(site.id, host.querySelector('#finSiteCostDesc').value, host.querySelector('#finSiteCostCategory').value,
      host.querySelector('#finSiteCostAmount').value, host.querySelector('#finSiteCostDate').value);
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

// Labour is costed from the operatives' weekly invoices (default). 'day_rate' puts the old automatic day-rate costing back.
function labourFromInvoices() { return appSettings.labour_costing !== 'day_rate'; }
// Invoice-based labour starts on this date (a Monday). Earlier shifts keep costing at day rates, exactly as before.
function labourCutoff() { return labourFromInvoices() ? (appSettings.labour_invoices_from || '2026-10-19') : '9999-12-31'; }
// A labour invoice counts if it covers a week from the cutoff on, or is for a price-work person (always counted), or has no week recorded (older invoices).
// An invoice for an earlier week from someone on day rates would double count shifts already costed, so it is left out.
function labourInvoiceCounts(f) {
  if (!isLabourInvoice(f)) return false;
  if (!f.week_start || f.week_start >= labourCutoff()) return true;
  return financePay[String(f.contractor_id)] === 'price';
}
function isLabourInvoice(f) { return f.file_type === 'invoice' && (f.cost_type === 'labour' || !!f.contractor_id); }

function priceWorkUsers() {
  return allUsers.filter(u => u.status === 'Active' && !isDirectPay(u.id) && (labourFromInvoices() || financePay[String(u.id)] === 'price'))
    .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
}

// Costs on the same job with the same description and amount - flagged for admin to review
function findDuplicateCostIds(costs) {
  const groups = {};
  costs.forEach(c => {
    const key = [c.site_id, String(c.description || '').trim().toLowerCase(), Math.round((parseFloat(c.amount) || 0) * 100)].join('|');
    (groups[key] = groups[key] || []).push(c.id);
  });
  const dup = new Set();
  Object.values(groups).forEach(ids => { if (ids.length > 1) ids.forEach(id => dup.add(id)); });
  return dup;
}
const DUP_ROW_STYLE = 'background: rgba(239, 68, 68, 0.18); box-shadow: inset 4px 0 0 var(--danger);';
const DUP_BADGE = ' <span style="color: #fca5a5; font-size: 0.72rem; font-weight: 700; white-space: nowrap;">⚠️ Possible duplicate - review</span>';

async function addFinanceCost(siteId, description, category, amount, date) {
  if (!db || !isManagementUser(currentUser)) return;
  const amt = parseFloat(amount);
  if (!description.trim() || isNaN(amt) || !date) { alert('Please fill in the description, amount and date.'); return; }
  const id = 'cost_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  await db.collection('finance_costs').doc(id).set({
    site_id: String(siteId), description: description.trim(), category, amount: Math.round(amt * 100) / 100, date,
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
    .filter(siteInScope)
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
      <td data-label="Job value">${f.value != null ? money(f.value) : '<span style="color: var(--warning);">not set</span>'}${f.variations.some(v => v.status === 'approved') ? `<div style="font-size: 0.7rem; color: var(--text-muted);">incl. ${money(f.variationsApproved)} variations</div>` : ''}</td>
      <td data-label="Materials invoiced">${money(f.invoiced)}</td><td data-label="On order">${money(f.onOrder)}</td><td data-label="Labour">${money(f.labour + f.labourInvoiced)}</td><td data-label="Extra costs">${money(f.extras)}</td>
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
  const dateEl = document.getElementById('finCostDate');
  if (!dateEl.value) dateEl.value = diaryDateKey(new Date());
  // Ledger: newest first, optionally one job, scrolls inside its own box
  const costFilter = document.getElementById('finCostFilterSite');
  const prevFilter = costFilter.value;
  costFilter.innerHTML = '<option value="">All jobs</option>' + allSites.map(x => `<option value="${diaryEsc(x.id)}">${diaryEsc(x.address)}</option>`).join('');
  costFilter.value = prevFilter;
  const ledger = financeCosts.filter(c => !costFilter.value || String(c.site_id) === costFilter.value)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const ledgerDupIds = findDuplicateCostIds(financeCosts);
  const ledgerDupCount = ledger.filter(c => ledgerDupIds.has(c.id)).length;
  const ledgerTotal = ledger.reduce((t, c) => t + (parseFloat(c.amount) || 0), 0);
  document.getElementById('finCostsCount').textContent = `${ledger.length} cost${ledger.length === 1 ? '' : 's'} · ${money(ledgerTotal)} · newest first${ledgerDupCount ? ` · ⚠️ ${ledgerDupCount} possible duplicate${ledgerDupCount === 1 ? '' : 's'} highlighted` : ''}`;
  document.getElementById('finCostsBody').innerHTML = ledger.map(c => {
      const site = allSites.find(s => String(s.id) === String(c.site_id));
      const isDup = ledgerDupIds.has(c.id);
      return `<tr${isDup ? ` style="${DUP_ROW_STYLE}"` : ''}><td>${diaryEsc(formatUKDate(c.date))}</td><td data-label="Job">${diaryEsc(site ? site.address : 'Unknown job')}</td><td data-label="Description">${diaryEsc(c.description)}${isDup ? DUP_BADGE : ''}</td><td data-label="Category">${diaryEsc(c.category || '')}</td><td data-label="Amount">${money(c.amount)}</td>
        <td style="white-space: nowrap;"><button type="button" class="btn btn-outline btn-sm fin-edit-cost" data-id="${diaryEsc(c.id)}" style="padding: 2px 8px;">Edit</button> <button type="button" class="btn btn-danger btn-sm fin-del-cost" data-id="${diaryEsc(c.id)}" style="padding: 2px 8px;">Delete</button></td></tr>`;
    }).join('') || '<tr><td colspan="6" style="color: var(--text-muted);">No extra costs logged.</td></tr>';
  document.querySelectorAll('#finCostsBody .fin-del-cost').forEach(b => b.addEventListener('click', () => deleteFinanceCost(b.dataset.id)));
  document.querySelectorAll('#finCostsBody .fin-edit-cost').forEach(b => b.addEventListener('click', () => openCostEdit(b.dataset.id)));

  updateLabourModeUi();
  // Day rates (Owner / Admin can edit)
  const canEditRates = isOwnerOrAdminUser(currentUser);
  document.getElementById('finRatesCard').style.display = '';
  document.getElementById('finRatesBody').innerHTML = allUsers.filter(u => u.status === 'Active')
    .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))).map(u => {
      const pt = financePay[String(u.id)] || 'day';
      const price = pt === 'price';
      const hourly = pt === 'hourly';
      const rate = financeRates[String(u.id)];
      const hh = financeHourly[String(u.id)] || {};
      const ptLabel = { day: 'Day rate', price: 'Price work', hourly: 'Hourly - direct employee', direct: 'Day rate - direct employee' };
      return `<tr>
        <td>${diaryEsc(u.full_name)}</td><td data-label="Role">${diaryEsc(u.role)}</td>
        <td data-label="Paid by">${canEditRates
          ? `<select class="form-control fin-paytype" data-user="${diaryEsc(u.id)}" style="min-height: 32px; padding: 2px 8px; width: auto;">${Object.keys(ptLabel).map(k => `<option value="${k}"${pt === k ? ' selected' : ''}>${ptLabel[k]}</option>`).join('')}</select>`
          : ptLabel[pt]}</td>
        <td data-label="Rate">${price ? '<span style="color: var(--text-muted);">invoiced</span>' : hourly
          ? (canEditRates
            ? `<input type="text" inputmode="decimal" autocomplete="off" class="form-control fin-hourly" data-user="${diaryEsc(u.id)}" value="${hh.rate != null ? hh.rate : ''}" placeholder="£ per hour" style="width: 110px; min-height: 32px; padding: 2px 8px; display: inline-block;"> × <input type="text" inputmode="decimal" autocomplete="off" class="form-control fin-hpd" data-user="${diaryEsc(u.id)}" value="${hh.hpd || 8}" style="width: 60px; min-height: 32px; padding: 2px 8px; display: inline-block;"> h/day <span style="color: var(--text-muted); font-size: 0.75rem;">${rate != null ? '= ' + money(rate) + ' a day' : ''}</span>`
            : (hh.rate != null ? `${money(hh.rate)}/h × ${hh.hpd || 8}h` : 'not set'))
          : canEditRates
          ? `<input type="text" inputmode="decimal" autocomplete="off" class="form-control fin-rate" data-user="${diaryEsc(u.id)}" value="${rate != null ? rate : ''}" placeholder="not set" style="width: 140px; min-height: 32px; padding: 2px 8px;">`
          : (rate != null ? money(rate) : 'not set')}</td></tr>`;
    }).join('');
  document.querySelectorAll('.fin-rate').forEach(inp => inp.addEventListener('change', () => {
    const v = inp.value === '' ? null : parseFloat(inp.value);
    if (v == null || !isNaN(v)) db.collection('finance_rates').doc(String(inp.dataset.user)).set({ user_id: String(inp.dataset.user), day_rate: v }, { merge: true }).catch(console.warn);
  }));
  const saveHourly = user => {
    const r = document.querySelector(`.fin-hourly[data-user="${user}"]`), h = document.querySelector(`.fin-hpd[data-user="${user}"]`);
    const rate = r && r.value !== '' ? parseFloat(r.value) : null, hpd = h && h.value !== '' ? parseFloat(h.value) : 8;
    if ((rate != null && isNaN(rate)) || isNaN(hpd)) return;
    db.collection('finance_rates').doc(String(user)).set({ user_id: String(user), hourly_rate: rate, hours_per_day: hpd }, { merge: true }).catch(console.warn);
  };
  document.querySelectorAll('.fin-hourly, .fin-hpd').forEach(inp => inp.addEventListener('change', () => saveHourly(inp.dataset.user)));
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
    amount: Math.round(amt * 100) / 100,
    date: document.getElementById('costEditDate').value,
    edited_by: currentUser.full_name,
    edited_at: new Date().toISOString()
  }).catch(err => { alert('Could not save: ' + err.message); });
  closeModal('modalCostEdit');
  showGreenToast('Cost updated');
}

function updateLabourModeUi() {
  const sel = document.getElementById('finLabourMode');
  if (!sel) return;
  sel.value = labourFromInvoices() ? 'invoices' : 'day_rate';
  sel.disabled = !isOwnerOrAdminUser(currentUser);
  const fromEl = document.getElementById('finLabourFrom');
  if (fromEl) { fromEl.value = appSettings.labour_invoices_from || '2026-10-19'; fromEl.style.display = labourFromInvoices() ? '' : 'none'; fromEl.disabled = !isOwnerOrAdminUser(currentUser); }
  document.getElementById('finLabourModeHelp').textContent = labourFromInvoices()
    ? "Shifts from the start date below no longer cost anything by themselves: each operative's weekly invoice is imported on the Invoices tab and its amounts are added to the jobs it covers. Earlier shifts keep their day-rate cost, so past jobs are unchanged. Direct employees (set to Hourly or Direct below) are always costed from their shifts."
    : 'Every booked shift (up to today) costs the person\'s day rate against the job, automatically. Operatives set to price work are costed from their invoices.';
  const rates = document.getElementById('finRatesCard');
  if (rates) rates.style.opacity = '';
}

async function addVariation(siteId, description, amountRaw, date, status) {
  if (!db || !isManagementUser(currentUser)) return;
  const amt = parseFloat(String(amountRaw).replace(/[£,\s]/g, ''));
  if (isNaN(amt) || amt === 0) { alert('Enter the variation amount (use a minus for an omission).'); return; }
  if (!String(description).trim()) { alert('Describe the works.'); return; }
  const sid = String(siteId);
  const n = financeVariations.filter(v => String(v.site_id) === sid).reduce((m, v) => Math.max(m, parseInt(String(v.ref || '').replace(/\D/g, '')) || 0), 0) + 1;
  const id = 'var_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  await db.collection('finance_variations').doc(id).set({
    id, site_id: sid, ref: 'VO' + n, description: String(description).trim(), amount: Math.round(amt * 100) / 100,
    date: date || diaryDateKey(new Date()), status: status === 'pending' ? 'pending' : 'approved',
    created_by: currentUser.full_name, created_at: new Date().toISOString()
  }).catch(err => alert('Could not save: ' + err.message));
  showGreenToast(`Variation VO${n} added`);
}
function editVariation(id) {
  const v = financeVariations.find(x => x.id === id);
  if (!v) return;
  const desc = prompt('Description of the works:', v.description || '');
  if (desc === null) return;
  const amtRaw = prompt('Amount £ ex VAT (minus for an omission):', v.amount);
  if (amtRaw === null) return;
  const amt = parseFloat(String(amtRaw).replace(/[£,\s]/g, ''));
  if (isNaN(amt) || !desc.trim()) { alert('Description and a valid amount are needed.'); return; }
  db.collection('finance_variations').doc(id).update({ description: desc.trim(), amount: Math.round(amt * 100) / 100, updated_by: currentUser.full_name, updated_at: new Date().toISOString() }).catch(err => alert('Could not save: ' + err.message));
}
function deleteVariation(id) {
  const v = financeVariations.find(x => x.id === id);
  if (!v || !confirm(`Delete variation ${v.ref || ''} (${money(v.amount)})? The job value will change.`)) return;
  db.collection('finance_variations').doc(id).delete().catch(err => alert('Could not delete: ' + err.message));
}

function updateUserModalPayUi() {
  const pt = document.getElementById('userModalPayType').value;
  document.getElementById('userModalRateLabel').textContent = pt === 'hourly' ? 'Hourly rate £' : 'Day rate £';
  document.getElementById('userModalHoursWrap').style.display = pt === 'hourly' ? '' : 'none';
}

function setupFinanceListeners() {
  document.getElementById('userModalPayType').addEventListener('change', updateUserModalPayUi);
  document.getElementById('finLabourFrom').addEventListener('change', async ev => {
    if (!isOwnerOrAdminUser(currentUser)) return;
    const v = ev.target.value;
    if (!v || new Date(v + 'T12:00:00').getDay() !== 1) { alert('Pick a Monday so whole weeks switch over together.'); updateLabourModeUi(); return; }
    if (!confirm(`Invoice-based labour will apply to shifts from ${formatUKDate(v)}. Shifts before that cost day rates. Continue?`)) { updateLabourModeUi(); return; }
    appSettings.labour_invoices_from = v;
    try { await db.collection('settings').doc('app').set({ labour_invoices_from: v }, { merge: true }); showGreenToast('Start date updated'); } catch (err) { alert('Could not save: ' + err.message); }
    refreshFinanceViews(); renderActiveView(); updateLabourModeUi();
  });
  document.getElementById('finLabourMode').addEventListener('change', async ev => {
    if (!isOwnerOrAdminUser(currentUser)) return;
    const v = ev.target.value === 'day_rate' ? 'day_rate' : 'invoices';
    if (!confirm(v === 'invoices' ? 'Cost labour from weekly invoices from the start date? Shifts from that date will stop costing day rates.' : 'Go back to automatic day-rate labour costing? Shift costs will be counted again in every job and report.')) { updateLabourModeUi(); return; }
    appSettings.labour_costing = v;
    try { await db.collection('settings').doc('app').set({ labour_costing: v }, { merge: true }); showGreenToast('Labour costing updated'); }
    catch (err) { alert('Could not save: ' + err.message); }
    refreshFinanceViews(); renderActiveView(); updateLabourModeUi();
  });
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
      document.getElementById('finCostCategory').value, document.getElementById('finCostAmount').value, document.getElementById('finCostDate').value);
    document.getElementById('finCostDesc').value = '';
    document.getElementById('finCostAmount').value = '';
  });
}
