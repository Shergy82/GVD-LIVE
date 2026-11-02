// Callable functions that replace the old "download every user and compare a hash in the browser" login,
// plus the public customer page and feedback, and the finance summary read for GVD Logic.
const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { legacyHash, hashPassword, verifyPassword, randomTempPassword } = require('./credentials');

const OWNER_EMAIL = 'phil@gvdcontracts.com';
const MAX_FAILS = 10;
const LOCK_MINUTES = 15;
const MIN_PASSWORD = 6;

const opts = { region: 'us-central1', cors: true };
// Reset emails go out through the same Gmail account the invoices inbox already uses
const GMAIL_USER = defineSecret('GMAIL_USER');
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');
const APP_URL = 'https://gvd-live.web.app';
const RESET_MINUTES = 60;
const RESET_MAX_PER_HOUR = 3;
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
const db = () => getFirestore();

const isMgmtRole = (role, email) => role === 'Owner' || role === 'Admin' || role === 'Manager' || email === OWNER_EMAIL;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// What the client may keep of a user document. Credentials are never in `users`, but strip them defensively.
function publicUser(id, u) {
  const out = { ...u, id };
  delete out.password_hash;
  delete out.temp_password;
  return out;
}

async function issueToken(id, u) {
  const mgmt = isMgmtRole(u.role, u.email);
  // u_email lets other GVD apps (Portal) match a Hub sign-in to their own staff profile without reading this database
  const claims = { role: u.role || 'Operative', mgmt, active: u.status === 'Active', u_email: String(u.email || '').toLowerCase() };
  return getAuth().createCustomToken(String(id), claims);
}

async function findUserByEmail(email) {
  const snap = await db().collection('users').where('email', '==', email).limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

function requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please log in.');
  return req.auth;
}

function requireMgmt(req) {
  const a = requireAuth(req);
  if (!a.token.mgmt || !a.token.active) throw new HttpsError('permission-denied', 'Management access is required.');
  return a;
}

function formatSiteId(siteId) {
  const n = parseInt(siteId);
  if (isNaN(n)) return `Site #${siteId}`;
  return n >= 10000 ? `Site #${n}` : `Site #${74000 + (n * 137)}`;
}

// ---------------------------------------------------------------------------
// login(email, password) -> { token, user, must_change_password }
// ---------------------------------------------------------------------------
exports.login = onCall(opts, async (req) => {
  const email = str(req.data && req.data.email, 200).toLowerCase();
  const password = String((req.data && req.data.password) || '');
  const bad = () => new HttpsError('invalid-argument', 'Invalid email address or password.');
  if (!email || !password || password.length > 200) throw bad();

  const userDoc = await findUserByEmail(email);
  if (!userDoc) throw bad();
  const id = userDoc.id;
  const user = userDoc.data();

  const credRef = db().collection('credentials').doc(id);
  const credSnap = await credRef.get();
  const cred = credSnap.exists ? credSnap.data() : null;
  if (!cred) throw bad();

  if (cred.locked_until && cred.locked_until.toMillis && cred.locked_until.toMillis() > Date.now()) {
    throw new HttpsError('resource-exhausted', `Too many attempts. Try again in ${LOCK_MINUTES} minutes.`);
  }

  let ok = false;
  let upgraded = false;
  if (cred.algo === 'scrypt') {
    ok = await verifyPassword(password, cred);
  } else if (cred.legacy_hash) {
    ok = cred.legacy_hash === legacyHash(password);
    upgraded = ok;
  }

  if (!ok) {
    const fails = (cred.failed_count || 0) + 1;
    const patch = { failed_count: fails };
    if (fails >= MAX_FAILS) {
      patch.failed_count = 0;
      patch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
    }
    await credRef.set(patch, { merge: true });
    throw bad();
  }

  if (user.status === 'Restricted') {
    throw new HttpsError('permission-denied', 'Your account access has been restricted by an administrator.');
  }

  const credPatch = { failed_count: 0, locked_until: FieldValue.delete() };
  const userPatch = { last_login_at: new Date().toISOString() };
  let mustChange = !!user.must_change_password;
  if (upgraded) {
    // The old 32-bit hash is weak (many passwords collide), so move them to scrypt and make them pick a fresh password.
    Object.assign(credPatch, await hashPassword(password), { legacy_hash: FieldValue.delete(), upgraded_at: new Date().toISOString() });
    userPatch.must_change_password = true;
    mustChange = true;
  }
  await credRef.set(credPatch, { merge: true });
  await db().collection('users').doc(id).update(userPatch);

  const token = await issueToken(id, user);
  return { token, user: publicUser(id, { ...user, ...userPatch }), must_change_password: mustChange };
});

// ---------------------------------------------------------------------------
// refreshSession() -> same shape as login. Fresh claims from the current user record (after approval, role change, or app restart).
// ---------------------------------------------------------------------------
async function sessionFor(uid) {
  const snap = await db().collection('users').doc(uid).get();
  if (!snap.exists) throw new HttpsError('unauthenticated', 'Please log in again.');
  const user = snap.data();
  if (user.status === 'Restricted') throw new HttpsError('permission-denied', 'Your account access has been restricted by an administrator.');
  return { token: await issueToken(snap.id, user), user: publicUser(snap.id, user), must_change_password: !!user.must_change_password };
}

exports.refreshSession = onCall(opts, async (req) => sessionFor(requireAuth(req).uid));

// ---------------------------------------------------------------------------
// ssoSession(idToken): used when GVD Live is opened inside the GVD Hub. The Hub signs management in once and hands each app a
// GVD Live ID token; this verifies it and returns a normal session for this app. Management accounts only.
// ---------------------------------------------------------------------------
exports.liveSsoSession = onCall(opts, async (req) => {
  let decoded;
  try { decoded = await getAuth().verifyIdToken(String((req.data && req.data.idToken) || '')); }
  catch (e) { throw new HttpsError('unauthenticated', 'Please sign in again.'); }
  const res = await sessionFor(decoded.uid);
  if (!isMgmtRole(res.user.role, res.user.email) || res.user.status !== 'Active') {
    throw new HttpsError('permission-denied', 'Management access is required.');
  }
  return res;
});

// ---------------------------------------------------------------------------
// setPassword(newPassword): the signed-in user chooses their own password (forced change or voluntary)
// ---------------------------------------------------------------------------
exports.setPassword = onCall(opts, async (req) => {
  const a = requireAuth(req);
  const pw = String((req.data && req.data.newPassword) || '');
  if (pw.length < MIN_PASSWORD || pw.length > 200) throw new HttpsError('invalid-argument', `Password must be at least ${MIN_PASSWORD} characters.`);
  const id = a.uid;
  const credRef = db().collection('credentials').doc(id);
  const cred = (await credRef.get()).data();
  if (cred && cred.algo === 'scrypt' && await verifyPassword(pw, cred)) {
    throw new HttpsError('invalid-argument', 'Please choose a different password to your current one.');
  }
  await credRef.set({ ...(await hashPassword(pw)), legacy_hash: FieldValue.delete(), updated_at: new Date().toISOString() }, { merge: true });
  await db().collection('users').doc(id).update({ must_change_password: false });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// adminSetTempPassword(userId, tempPassword?) (management only). Returns the temp password ONCE; only a hash is stored.
// ---------------------------------------------------------------------------
exports.adminSetTempPassword = onCall(opts, async (req) => {
  requireMgmt(req);
  const userId = str(req.data && req.data.userId, 200);
  let temp = String((req.data && req.data.tempPassword) || '');
  if (!userId) throw new HttpsError('invalid-argument', 'Missing user.');
  const userRef = db().collection('users').doc(userId);
  if (!(await userRef.get()).exists) throw new HttpsError('not-found', 'No such user.');
  if (!temp) temp = randomTempPassword();
  if (temp.length < 3 || temp.length > 200) throw new HttpsError('invalid-argument', 'Temporary password must be at least 3 characters.');
  await db().collection('credentials').doc(userId).set({
    ...(await hashPassword(temp)), legacy_hash: FieldValue.delete(), failed_count: 0, locked_until: FieldValue.delete(), updated_at: new Date().toISOString()
  }, { merge: true });
  await userRef.update({ must_change_password: true });
  return { tempPassword: temp };
});

// ---------------------------------------------------------------------------
// register(...) -> same shape as login. The first user ever, or phil@gvdcontracts.com, becomes the active Owner; everyone else is Pending.
// ---------------------------------------------------------------------------
exports.register = onCall(opts, async (req) => {
  const d = req.data || {};
  const full_name = str(d.full_name, 120);
  const email = str(d.email, 200).toLowerCase();
  const phone = str(d.phone, 40);
  const password = String(d.password || '');
  const requested = ['Operative', 'Manager', 'Admin'].includes(d.role) ? d.role : 'Operative';
  if (!full_name || !email || !phone || password.length < MIN_PASSWORD || password.length > 200) {
    throw new HttpsError('invalid-argument', 'Please fill in all fields (password at least 6 characters).');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'That email address does not look right.');
  if (await findUserByEmail(email)) throw new HttpsError('already-exists', 'An account with this email address already exists.');

  const anyUser = await db().collection('users').limit(1).get();
  const isOwner = anyUser.empty || email === OWNER_EMAIL;
  const id = 'user_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const user = {
    id, full_name, email, phone,
    role: isOwner ? 'Owner' : requested,
    status: isOwner ? 'Active' : 'Pending',
    created_at: new Date().toISOString()
  };
  await db().collection('users').doc(id).set(user);
  await db().collection('credentials').doc(id).set({ ...(await hashPassword(password)), failed_count: 0, updated_at: new Date().toISOString() });
  return { token: await issueToken(id, user), user: publicUser(id, user), must_change_password: false };
});

// ---------------------------------------------------------------------------
// requestPasswordReset(email): always the same answer, whether or not the account exists. If it does, the person gets
// an email with a one-time link (valid for an hour). Their password is NOT changed until they use the link, so nobody
// else can lock them out by typing their address. Only a hash of the link token is stored.
// ---------------------------------------------------------------------------
async function sendResetEmail(to, name, link) {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: GMAIL_USER.value().trim(), pass: GMAIL_APP_PASSWORD.value().replace(/\s+/g, '') } });
  const hi = name ? `Hi ${String(name).split(' ')[0]},` : 'Hi,';
  await t.sendMail({
    from: `GVD LIVE <${GMAIL_USER.value().trim()}>`, to,
    subject: 'Reset your GVD LIVE password',
    text: `${hi}\n\nWe received a request to reset your GVD LIVE password. Open this link to choose a new one (it works once and expires in ${RESET_MINUTES} minutes):\n\n${link}\n\nIf you did not ask for this, ignore this email. Your password has not been changed.\n`,
    html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:480px;color:#18202b"><p>${hi}</p><p>We received a request to reset your GVD LIVE password.</p>
      <p><a href="${link}" style="display:inline-block;background:#2f5d3a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Choose a new password</a></p>
      <p style="color:#667085;font-size:13px">The link works once and expires in ${RESET_MINUTES} minutes. If you did not ask for this, ignore this email. Your password has not been changed.</p></div>`
  });
}

exports.requestPasswordReset = onCall({ ...opts, secrets: [GMAIL_USER, GMAIL_APP_PASSWORD] }, async (req) => {
  const email = str(req.data && req.data.email, 200).toLowerCase();
  if (email) {
    const u = await findUserByEmail(email);
    if (u && u.data().status === 'Active') {
      const since = Date.now() - 3600 * 1000;
      const recent = (await db().collection('password_resets').where('user_id', '==', u.id).get()).docs.filter(d => Date.parse(d.data().created_at) > since);
      if (recent.length < RESET_MAX_PER_HOUR) {
        const token = crypto.randomBytes(32).toString('hex');
        await db().collection('password_resets').doc(sha256(token)).set({
          user_id: u.id, email, used: false, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + RESET_MINUTES * 60000).toISOString()
        });
        try { await sendResetEmail(email, u.data().full_name, `${APP_URL}/?reset=${token}`); }
        catch (err) { console.error('Reset email failed:', err.message); }
      }
    }
  }
  return { ok: true };
});

// completePasswordReset(token, newPassword): no sign-in needed; the one-time token is the proof.
exports.completePasswordReset = onCall(opts, async (req) => {
  const token = str(req.data && req.data.token, 200);
  const pw = String((req.data && req.data.newPassword) || '');
  const expired = () => new HttpsError('invalid-argument', 'This reset link has expired or was already used. Please request a new one.');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpsError('invalid-argument', 'This reset link is not valid.');
  if (pw.length < MIN_PASSWORD || pw.length > 200) throw new HttpsError('invalid-argument', `Password must be at least ${MIN_PASSWORD} characters.`);
  const ref = db().collection('password_resets').doc(sha256(token));
  const used = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data();
    if (!snap.exists || d.used || Date.parse(d.expires_at) < Date.now()) return null;
    tx.update(ref, { used: true, used_at: new Date().toISOString() });
    return d;
  });
  if (!used) throw expired();
  const userRef = db().collection('users').doc(used.user_id);
  const user = await userRef.get();
  if (!user.exists || user.data().status !== 'Active') throw expired();
  await db().collection('credentials').doc(used.user_id).set({
    ...(await hashPassword(pw)), legacy_hash: FieldValue.delete(), failed_count: 0, locked_until: FieldValue.delete(), updated_at: new Date().toISOString()
  }, { merge: true });
  await userRef.update({ must_change_password: false });
  // any other link still outstanding for this person is now void
  const others = await db().collection('password_resets').where('user_id', '==', used.user_id).get();
  await Promise.all(others.docs.filter(d => !d.data().used).map(d => d.ref.update({ used: true, used_at: new Date().toISOString() })));
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Public customer page: only the one site the token belongs to, and only what the page shows.
// ---------------------------------------------------------------------------
async function siteForToken(token) {
  token = str(token, 200);
  if (!token) return null;
  const snap = await db().collection('sites').where('customer_token', '==', token).limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

exports.customerView = onCall(opts, async (req) => {
  const site = await siteForToken(req.data && req.data.token);
  if (!site) throw new HttpsError('not-found', 'Invalid or expired customer schedule link.');
  const [shiftSnap, settingsSnap] = await Promise.all([
    db().collection('shifts').where('site_id', 'in', [...new Set([site.id, String(site.id), Number(site.id)].filter(v => v === v))]).get(),
    db().collection('settings').doc('app').get()
  ]);
  const opIds = [...new Set(shiftSnap.docs.map(s => String(s.data().operative_id)).filter(Boolean))];
  const names = {};
  await Promise.all(opIds.map(async uid => {
    const u = await db().collection('users').doc(uid).get();
    if (u.exists) names[uid] = u.data().full_name || '';
  }));
  const s = settingsSnap.exists ? settingsSnap.data() : {};
  return {
    site: { id: site.id, address: site.address || '', construction_type: site.construction_type || '', logic_ref: site.logic_ref || '' },
    settings: { app_name: s.app_name || 'GVD LIVE', logo_url: s.logo_url || '/gvd-logo.png' },
    shifts: shiftSnap.docs.map(d => {
      const x = d.data();
      return {
        shift_date: x.shift_date || '', shift_period: x.shift_period || '', task: x.task || '',
        is_drying_day: !!x.is_drying_day, operative_name: names[String(x.operative_id)] || ''
      };
    })
  };
});

exports.customerFeedback = onCall(opts, async (req) => {
  const d = req.data || {};
  const site = await siteForToken(d.token);
  if (!site) throw new HttpsError('not-found', 'Invalid or expired customer schedule link.');
  if (d.website) return { ok: true }; // spam trap
  const rating = parseInt(d.rating);
  const customer_name = str(d.customer_name, 80);
  const customer_address = str(d.customer_address, 200);
  const comment = str(d.comment, 2000);
  const customer_email = str(d.customer_email, 120);
  const customer_phone = str(d.customer_phone, 30);
  if (!(rating >= 1 && rating <= 5) || !customer_name || !customer_address || comment.length < 5 || d.consent !== true) {
    throw new HttpsError('invalid-argument', 'Please complete the required fields.');
  }
  if (customer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email)) throw new HttpsError('invalid-argument', 'That email address does not look right.');

  // at most one submission per site every 30 seconds
  const rl = db().collection('rate_limits').doc('fb_' + site.id);
  const last = (await rl.get()).data();
  if (last && Date.now() - last.at < 30000) throw new HttpsError('resource-exhausted', 'Your feedback has just been sent. Thank you!');
  await rl.set({ at: Date.now() });

  await db().collection('feedback').add({
    site_id: String(site.id),
    site_ref: site.logic_ref || formatSiteId(site.id),
    site_address: site.address || '',
    rating,
    sentiment: rating >= 4 ? 'pos' : rating === 3 ? 'neu' : 'neg',
    comment, customer_name, customer_address, customer_email, customer_phone,
    consent: true,
    source: 'customer_qr',
    created_at: new Date().toISOString()
  });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// getFinanceSummary(): for GVD Logic. Needs a signed-in management user (Logic signs in with the same login function).
// ---------------------------------------------------------------------------
exports.getFinanceSummary = onCall(opts, async (req) => {
  requireMgmt(req);
  const snap = await db().collection('finance_summary').get();
  return { jobs: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});
