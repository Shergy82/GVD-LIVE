// -------------------------------------------------------------------
// WEEKLY INVOICES SUBMITTED IN THE APP
// Operatives (users ticked "Submits weekly invoices") keep their invoice details in their own profile and get a "My Invoice"
// page, pre-filled from the planner (jobs and days that week). They add their rate, check it and submit.
// Owners/Admins review submissions on the Invoices tab; approving turns the lines into labour costs on the jobs
// (exactly like importing a PDF) and files a PDF copy. Nothing costs a job until it is approved.
// Collections: invoice_profiles/{userId}  (bank + business details, own user + management only)
//              operative_invoices/{id}    (one submitted weekly invoice)
// -------------------------------------------------------------------
let operativeInvoices = [];
let myInvProfile = null;
let myInvUnsubs = [];
let myInvWeekEnd = null;     // Sunday of the week being invoiced
let myInvDraft = null;
let myInvProfileOpen = false;

const miR2 = n => Math.round((parseFloat(n) || 0) * 100) / 100;
const miDate = iso => { const p = String(iso || '').split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : ''; };
const miMonday = weekEnd => addDaysISO(weekEnd, -6);

function startMyInvoiceSync() {
  stopMyInvoiceSync();
  if (!db || !currentUser) return;
  const warn = n => err => console.warn(`Firestore ${n} error:`, err);
  const me = String(currentUser.id);
  if (currentUser.submits_invoices) {
    myInvUnsubs.push(db.collection('invoice_profiles').doc(me).onSnapshot(doc => {
      myInvProfile = doc.exists ? doc.data() : null;
      if (!isTypingIn('myInvoiceBody')) renderMyInvoiceView();
    }, warn('invoice_profiles')));
  }
  const q = isManagementUser(currentUser) ? db.collection('operative_invoices') : (currentUser.submits_invoices ? db.collection('operative_invoices').where('user_id', '==', me) : null);
  if (q) myInvUnsubs.push(q.onSnapshot(snap => {
    operativeInvoices = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    if (!isTypingIn('myInvoiceBody')) renderMyInvoiceView();
    renderInvoiceInbox();
    if (typeof renderLabourCheck === 'function' && document.getElementById('view-invoices').style.display !== 'none') renderLabourCheck();
  }, warn('operative_invoices')));
}
function stopMyInvoiceSync() { myInvUnsubs.forEach(u => u()); myInvUnsubs = []; operativeInvoices = []; myInvProfile = null; }

function miProfileComplete(p) {
  return !!(p && String(p.account_name || '').trim() && /^\d{6}$/.test(String(p.sort_code || '').replace(/\D/g, '')) && /^\d{8}$/.test(String(p.account_no || '').replace(/\D/g, '')));
}
function miInvoiceNo(weekEnd) {
  const initials = String(currentUser.full_name || 'OP').split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 3);
  return `${initials}-${weekEnd.replace(/-/g, '')}`;
}
function miLastSunday() { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); return diaryDateKey(d); }

// jobs and days booked for me in the planner that week
function miPlannerLines(userId, weekEnd) {
  const start = miMonday(weekEnd), by = {};
  allShifts.filter(sh => String(sh.operative_id) === String(userId) && !sh.is_drying_day && sh.shift_date >= start && sh.shift_date <= weekEnd).forEach(sh => {
    by[sh.site_id] = (by[sh.site_id] || 0) + (sh.shift_period === 'am' || sh.shift_period === 'pm' ? 0.5 : 1);
  });
  return Object.keys(by).map(id => ({ site_id: String(id), days: by[id] }));
}

function miNewDraft(weekEnd) {
  const rate = myInvProfile && myInvProfile.default_rate != null ? parseFloat(myInvProfile.default_rate) : null;
  return {
    weekEnd, invNo: miInvoiceNo(weekEnd), invDate: diaryDateKey(new Date()),
    lines: miPlannerLines(currentUser.id, weekEnd).map(l => ({ siteId: l.site_id, days: l.days, plannerDays: l.days, rate, amount: rate != null ? miR2(l.days * rate) : null, manual: false }))
  };
}
function miTotals(d) {
  const net = miR2(d.lines.reduce((t, l) => t + (parseFloat(l.amount) || 0), 0));
  const vat = myInvProfile && myInvProfile.vat_registered ? miR2(net * 0.2) : 0;
  return { net, vat, gross: miR2(net + vat) };
}
function miSiteName(id) { const s = allSites.find(x => String(x.id) === String(id)); return s ? s.address : 'Job ' + id; }
const miStatusChip = st => ({ submitted: ['#fef3c7', '#92400e', 'Waiting for approval'], approved: ['#dcfce7', '#166534', 'Approved'], rejected: ['#fee2e2', '#991b1b', 'Sent back'], withdrawn: ['#e2e8f0', '#334155', 'Withdrawn'] }[st] || ['#e2e8f0', '#334155', st]);
const miChipHtml = st => { const c = miStatusChip(st); return `<span style="background: ${c[0]}; color: ${c[1]}; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 700;">${c[2]}</span>`; };

function renderMyInvoiceView() {
  const host = document.getElementById('myInvoiceBody');
  if (!host || !currentUser) return;
  if (!myInvWeekEnd) myInvWeekEnd = miLastSunday();
  const mine = operativeInvoices.filter(i => String(i.user_id) === String(currentUser.id));
  const existing = mine.filter(i => i.week_end === myInvWeekEnd && (i.status === 'submitted' || i.status === 'approved'))[0];
  const complete = miProfileComplete(myInvProfile);
  const p = myInvProfile || {};
  const esc = diaryEsc;
  if (!myInvDraft || myInvDraft.weekEnd !== myInvWeekEnd) myInvDraft = miNewDraft(myInvWeekEnd);
  const d = myInvDraft;
  const open = myInvProfileOpen || !complete;

  let html = `<div class="site-card" style="margin-bottom: 14px;">
    <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
      <h3>My invoice details ${complete ? '<span style="color: var(--success); font-size: 0.8rem;">✅ saved</span>' : '<span style="color: var(--warning); font-size: 0.8rem;">fill these in once</span>'}</h3>
      ${complete ? `<button type="button" class="btn btn-outline btn-sm" id="miToggleProfile">${open ? 'Hide' : 'Edit'}</button>` : ''}
    </div>
    ${open ? `<p style="color: var(--text-muted); font-size: 0.8rem; margin: 6px 0 10px;">Saved once and used on every invoice. Only you and the office can see these.</p>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px;">
      <label>Trading name (optional)<input class="form-control mi-p" data-k="trading_name" value="${esc(p.trading_name || '')}"></label>
      <label>UTR (optional)<input class="form-control mi-p" data-k="utr" value="${esc(p.utr || '')}"></label>
      <label>Account name<input class="form-control mi-p" data-k="account_name" value="${esc(p.account_name || '')}"></label>
      <label>Sort code<input class="form-control mi-p" data-k="sort_code" inputmode="numeric" placeholder="12-34-56" value="${esc(p.sort_code || '')}"></label>
      <label>Account number<input class="form-control mi-p" data-k="account_no" inputmode="numeric" placeholder="8 digits" value="${esc(p.account_no || '')}"></label>
      <label>Day rate £ (pre-fills your invoices)<input class="form-control mi-p" data-k="default_rate" inputmode="decimal" value="${p.default_rate != null ? esc(p.default_rate) : ''}"></label>
      <label style="display: flex; align-items: center; gap: 8px;"><input type="checkbox" class="mi-p" data-k="vat_registered"${p.vat_registered ? ' checked' : ''}> VAT registered</label>
      <label>VAT number<input class="form-control mi-p" data-k="vat_no" value="${esc(p.vat_no || '')}"></label>
    </div>
    <div style="margin-top: 12px;"><button type="button" class="btn btn-primary" id="miSaveProfile">Save my details</button></div>` : ''}
  </div>`;

  html += `<div class="site-card" style="margin-bottom: 14px;">
    <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px;">
      <button type="button" class="btn btn-secondary btn-sm" id="miPrev">←</button>
      <strong>Week ${miDate(miMonday(myInvWeekEnd))} – ${miDate(myInvWeekEnd)}</strong>
      <button type="button" class="btn btn-secondary btn-sm" id="miNext">→</button>
      <button type="button" class="btn btn-outline btn-sm" id="miThisWeek">Last week</button>
    </div>`;
  if (existing) {
    html += `<div>${miChipHtml(existing.status)} <strong>${esc(existing.invoice_no)}</strong> · ${money(existing.gross)} (net ${money(existing.net)})</div>
      <table class="rep-table" style="margin-top: 8px;"><thead><tr><th>Job</th><th>Days</th><th style="text-align:right;">Amount</th></tr></thead><tbody>${existing.lines.map(l => `<tr><td style="white-space: normal;">${esc(l.address)}</td><td>${l.days}</td><td style="text-align: right;">${money(l.net)}</td></tr>`).join('')}</tbody></table>
      <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;"><button type="button" class="btn btn-outline btn-sm mi-pdf" data-id="${esc(existing.id)}">📄 Download PDF</button>${existing.status === 'submitted' ? `<button type="button" class="btn btn-danger btn-sm mi-withdraw" data-id="${esc(existing.id)}">Withdraw to change it</button>` : ''}</div>`;
  } else {
    const t = miTotals(d);
    const rejected = mine.filter(i => i.week_end === myInvWeekEnd && i.status === 'rejected').pop();
    if (rejected) html += `<p style="background: rgba(239,68,68,0.12); border: 1px solid #ef4444; border-radius: 8px; padding: 8px; margin-bottom: 10px;">↩️ This invoice was sent back${rejected.review_note ? ': <strong>' + esc(rejected.review_note) + '</strong>' : ''}. Fix it and submit again.</p>`;
    html += `<p style="color: var(--text-muted); font-size: 0.8rem; margin-bottom: 8px;">The jobs and days below come from the planner. Add your rate, change anything that is wrong, then submit. Amounts exclude VAT.</p>
      <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px;">
        <label style="font-size: 0.8rem;">Invoice no<input class="form-control mi-h" data-k="invNo" value="${esc(d.invNo)}" style="min-height: 36px;"></label>
        <label style="font-size: 0.8rem;">Invoice date<input type="date" class="form-control mi-h" data-k="invDate" value="${esc(d.invDate)}" style="min-height: 36px;"></label>
      </div>
      <div style="overflow-x: auto;"><table class="rep-table" style="min-width: 520px;"><thead><tr><th>Job</th><th>Days</th><th>Rate £</th><th>Amount £</th><th></th></tr></thead><tbody>
      ${d.lines.map((l, i) => `<tr>
        <td style="white-space: normal;"><select class="form-control mi-l" data-i="${i}" data-k="siteId" style="min-height: 34px; padding: 4px 6px;">${miSiteOptions(l.siteId)}</select>${l.plannerDays != null && l.days > l.plannerDays ? `<div style="color: var(--warning); font-size: 0.72rem;">⚠️ planner shows ${l.plannerDays} day${l.plannerDays === 1 ? '' : 's'} here</div>` : ''}</td>
        <td><input class="form-control mi-l" data-i="${i}" data-k="days" inputmode="decimal" value="${l.days}" style="width: 70px; min-height: 34px; padding: 4px 6px;"></td>
        <td><input class="form-control mi-l" data-i="${i}" data-k="rate" inputmode="decimal" value="${l.rate != null ? l.rate : ''}" style="width: 90px; min-height: 34px; padding: 4px 6px;"></td>
        <td><input class="form-control mi-l" data-i="${i}" data-k="amount" inputmode="decimal" value="${l.amount != null ? Number(l.amount).toFixed(2) : ''}" style="width: 110px; min-height: 34px; padding: 4px 6px;"></td>
        <td><button type="button" class="btn btn-danger btn-sm mi-del" data-i="${i}">✕</button></td></tr>`).join('') || '<tr><td colspan="5" style="color: var(--text-muted);">No shifts in the planner for this week. Add the job(s) you worked.</td></tr>'}
      </tbody></table></div>
      <div style="margin: 8px 0;"><button type="button" class="btn btn-outline btn-sm" id="miAddLine">+ Add a job</button></div>
      <div style="text-align: right; line-height: 1.7;">Net ${money(t.net)}<br>${myInvProfile && myInvProfile.vat_registered ? `VAT ${money(t.vat)}<br>` : ''}<strong style="font-size: 1.1rem;">Total ${money(t.gross)}</strong></div>
      <div style="margin-top: 10px;"><button type="button" class="btn btn-primary" id="miSubmit" style="width: 100%;" ${complete ? '' : 'disabled title="Save your details first"'}>📨 Submit invoice for ${money(t.gross)}</button>${complete ? '' : '<p style="color: var(--warning); font-size: 0.8rem; margin-top: 6px;">Save your bank details above first.</p>'}</div>`;
  }
  html += '</div>';

  const hist = mine.filter(i => !existing || i.id !== existing.id).sort((a, b) => String(b.week_end).localeCompare(String(a.week_end)));
  if (hist.length) html += `<div class="site-card"><h4 style="margin-bottom: 8px;">My invoices</h4><table class="rep-table"><tbody>${hist.map(i => `<tr><td>w/e ${miDate(i.week_end)}</td><td>${esc(i.invoice_no)}</td><td style="text-align: right;">${money(i.gross)}</td><td>${miChipHtml(i.status)}${i.status === 'rejected' && i.review_note ? `<div style="font-size: 0.72rem; color: var(--text-muted); white-space: normal;">${esc(i.review_note)}</div>` : ''}</td><td><button type="button" class="btn btn-outline btn-sm mi-pdf" data-id="${esc(i.id)}">PDF</button></td></tr>`).join('')}</tbody></table></div>`;
  host.innerHTML = html;
  miBind(host);
}

function miSiteOptions(selected) {
  const mine = new Set(allShifts.filter(s => String(s.operative_id) === String(currentUser.id)).map(s => String(s.site_id)));
  const sites = allSites.filter(s => !s.is_archived || String(s.id) === String(selected));
  const opt = s => `<option value="${diaryEsc(s.id)}"${String(s.id) === String(selected) ? ' selected' : ''}>${diaryEsc(s.address)}</option>`;
  return `<option value="">Choose job...</option>` + sites.filter(s => mine.has(String(s.id))).map(opt).join('') + '<option disabled>──────────</option>' + sites.filter(s => !mine.has(String(s.id))).map(opt).join('');
}

function miBind(host) {
  const on = (sel, ev, fn) => host.querySelectorAll(sel).forEach(el => el.addEventListener(ev, e => fn(el, e)));
  on('#miToggleProfile', 'click', () => { myInvProfileOpen = !myInvProfileOpen; renderMyInvoiceView(); });
  on('#miSaveProfile', 'click', async () => {
    const rec = { user_id: String(currentUser.id), user_name: currentUser.full_name, updated_at: new Date().toISOString() };
    host.querySelectorAll('.mi-p').forEach(el => { rec[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
    rec.sort_code = String(rec.sort_code || '').replace(/\D/g, '').replace(/^(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3');
    rec.account_no = String(rec.account_no || '').replace(/\D/g, '');
    rec.default_rate = rec.default_rate === '' ? null : parseFloat(String(rec.default_rate).replace(/[£,\s]/g, ''));
    if (rec.default_rate != null && isNaN(rec.default_rate)) { alert('The day rate is not a number.'); return; }
    if (!miProfileComplete(rec)) { alert('Please give the account name, a 6 digit sort code and an 8 digit account number.'); return; }
    try { await db.collection('invoice_profiles').doc(String(currentUser.id)).set(rec); myInvProfile = rec; myInvProfileOpen = false; myInvDraft = null; showGreenToast('Details saved'); renderMyInvoiceView(); }
    catch (err) { alert('Could not save: ' + err.message); }
  });
  on('#miPrev', 'click', () => { myInvWeekEnd = addDaysISO(myInvWeekEnd, -7); renderMyInvoiceView(); });
  on('#miNext', 'click', () => { myInvWeekEnd = addDaysISO(myInvWeekEnd, 7); renderMyInvoiceView(); });
  on('#miThisWeek', 'click', () => { myInvWeekEnd = miLastSunday(); renderMyInvoiceView(); });
  on('.mi-h', 'change', el => { myInvDraft[el.dataset.k] = el.value.trim(); });
  on('.mi-l', 'change', el => {
    const l = myInvDraft.lines[+el.dataset.i], k = el.dataset.k;
    const num = v => { const n = parseFloat(String(v).replace(/[£,\s]/g, '')); return isNaN(n) ? null : n; };
    if (k === 'siteId') { l.siteId = el.value; const pl = miPlannerLines(currentUser.id, myInvDraft.weekEnd).find(x => x.site_id === l.siteId); l.plannerDays = pl ? pl.days : null; }
    else if (k === 'days') { l.days = num(el.value) || 0; if (!l.manual && l.rate != null) l.amount = miR2(l.days * l.rate); }
    else if (k === 'rate') { l.rate = num(el.value); if (!l.manual && l.rate != null) l.amount = miR2((l.days || 0) * l.rate); }
    else if (k === 'amount') { l.amount = num(el.value); l.manual = true; }
    renderMyInvoiceView();
  });
  on('.mi-del', 'click', el => { myInvDraft.lines.splice(+el.dataset.i, 1); renderMyInvoiceView(); });
  on('#miAddLine', 'click', () => { myInvDraft.lines.push({ siteId: '', days: 1, plannerDays: null, rate: myInvProfile && myInvProfile.default_rate != null ? parseFloat(myInvProfile.default_rate) : null, amount: null, manual: false }); renderMyInvoiceView(); });
  on('#miSubmit', 'click', (el) => submitMyInvoice(el));
  on('.mi-pdf', 'click', el => { const rec = operativeInvoices.find(x => x.id === el.dataset.id); if (rec) miDownloadPdf(rec).catch(e => alert('Could not build the PDF: ' + e.message)); });
  on('.mi-withdraw', 'click', async el => {
    if (!confirm('Withdraw this invoice so you can change it?')) return;
    await db.collection('operative_invoices').doc(el.dataset.id).update({ status: 'withdrawn', updated_at: new Date().toISOString() }).catch(err => alert('Could not withdraw: ' + err.message));
  });
}

async function submitMyInvoice(btn) {
  const d = myInvDraft;
  if (!miProfileComplete(myInvProfile)) { alert('Save your bank details first.'); return; }
  if (!d.invNo) { alert('Enter an invoice number.'); return; }
  const lines = d.lines.filter(l => l.siteId || l.amount);
  if (!lines.length) { alert('Add at least one job.'); return; }
  if (lines.some(l => !l.siteId)) { alert('Choose the job on every line.'); return; }
  if (lines.some(l => !(parseFloat(l.amount) > 0))) { alert('Every line needs an amount (days × rate).'); return; }
  if (new Set(lines.map(l => String(l.siteId))).size !== lines.length) { alert('The same job is on two lines - put them on one line.'); return; }
  const t = miTotals({ lines });
  if (!confirm(`Submit invoice ${d.invNo} for ${money(t.gross)}? You can withdraw it until it is approved.`)) return;
  btn.disabled = true;
  const p = myInvProfile;
  const id = 'oi_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const rec = {
    id, user_id: String(currentUser.id), user_name: currentUser.full_name, status: 'submitted',
    week_start: miMonday(d.weekEnd), week_end: d.weekEnd, invoice_no: d.invNo, invoice_date: d.invDate,
    lines: lines.map(l => ({ site_id: String(l.siteId), address: miSiteName(l.siteId), days: parseFloat(l.days) || 0, planner_days: l.plannerDays != null ? l.plannerDays : null, rate: l.rate, net: miR2(l.amount) })),
    net: t.net, vat: t.vat, gross: t.gross,
    trading_name: p.trading_name || '', utr: p.utr || '', vat_registered: !!p.vat_registered, vat_no: p.vat_no || '',
    account_name: p.account_name, sort_code: p.sort_code, account_no: p.account_no,
    submitted_at: new Date().toISOString()
  };
  try {
    await db.collection('operative_invoices').doc(id).set(rec);
    if (d.lines.some(l => l.rate != null) && (!p.default_rate)) await db.collection('invoice_profiles').doc(String(currentUser.id)).set({ default_rate: d.lines.find(l => l.rate != null).rate }, { merge: true }).catch(() => {});
    await Promise.all(allUsers.filter(u => u.status === 'Active' && isOwnerOrAdminUser(u)).map(u => db.collection('notifications').add({
      target_user_id: String(u.id), title: '🧾 Invoice submitted', body: `${currentUser.full_name}: week ending ${miDate(d.weekEnd)} - ${money(t.gross)}`, created_at: new Date().toISOString()
    }).catch(() => {})));
    myInvDraft = null;
    showGreenToast('Invoice submitted');
  } catch (err) { alert('Could not submit: ' + err.message); btn.disabled = false; }
}

async function miBuildPdf(rec, flat = true) {
  const lines = rec.lines.map(l => ({ address: l.address, days: l.days, rate: l.rate, amount: l.net }));
  return buildOperativeInvoicePdf({
    flat, operative: rec.user_name, weekEnding: rec.week_end, lines,
    values: {
      invoice_no: rec.invoice_no, invoice_date: miDate(rec.invoice_date), trading_name: rec.trading_name, utr: rec.utr, vat_no: rec.vat_no,
      net_total: Number(rec.net).toFixed(2), total_vat: rec.vat ? Number(rec.vat).toFixed(2) : '', invoice_total: Number(rec.gross).toFixed(2),
      account_name: rec.account_name, sort_code: rec.sort_code, account_no: rec.account_no
    }
  });
}
async function miDownloadPdf(rec) { const doc = await miBuildPdf(rec); doc.save(`Invoice_${String(rec.invoice_no).replace(/[^A-Za-z0-9-]/g, '_')}.pdf`); }

// ---------------- Office side: review submitted invoices ----------------
function renderInvoiceInbox() {
  const host = document.getElementById('opInvoiceInbox');
  if (!host) return;
  if (!currentUser || !isManagementUser(currentUser)) { host.style.display = 'none'; return; }
  const pending = operativeInvoices.filter(i => i.status === 'submitted').sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
  const recent = operativeInvoices.filter(i => i.status === 'approved' || i.status === 'rejected').sort((a, b) => String(b.reviewed_at || '').localeCompare(String(a.reviewed_at || ''))).slice(0, 8);
  if (!pending.length && !recent.length) { host.style.display = 'none'; return; }
  host.style.display = '';
  const canReview = isOwnerOrAdminUser(currentUser), esc = diaryEsc;
  host.innerHTML = `<h3 style="margin-bottom: 6px;">📨 Invoices submitted by operatives ${pending.length ? `<span style="background: var(--warning); color: #000; border-radius: 999px; padding: 1px 9px; font-size: 0.8rem;">${pending.length}</span>` : ''}</h3>
    ${pending.length ? pending.map(i => {
      const over = i.lines.filter(l => l.planner_days != null ? l.days > l.planner_days : true);
      return `<div style="border: 1px solid var(--border-color); border-left: 4px solid var(--warning); border-radius: 8px; padding: 10px; margin-bottom: 10px;">
        <div style="display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;"><strong>${esc(i.user_name)}</strong><span>w/e ${miDate(i.week_end)} · ${esc(i.invoice_no)} · <strong>${money(i.gross)}</strong>${i.vat ? ` (net ${money(i.net)} + VAT ${money(i.vat)})` : ''}</span></div>
        <table class="rep-table" style="margin-top: 6px;"><thead><tr><th>Job</th><th>Days claimed</th><th>Planner</th><th style="text-align: right;">Amount</th></tr></thead><tbody>${i.lines.map(l => `<tr><td style="white-space: normal;">${esc(l.address)}</td><td>${l.days}</td><td style="${l.planner_days == null || l.days > l.planner_days ? 'color: var(--warning); font-weight: 700;' : ''}">${l.planner_days != null ? l.planner_days : 'not booked'}</td><td style="text-align: right;">${money(l.net)}</td></tr>`).join('')}</tbody></table>
        <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 6px;">Pay to: ${esc(i.account_name)} · ${esc(i.sort_code)} · ${esc(i.account_no)}${i.trading_name ? ' · ' + esc(i.trading_name) : ''}${i.utr ? ' · UTR ' + esc(i.utr) : ''}</div>
        ${canReview ? `<div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;"><button type="button" class="btn btn-primary btn-sm oi-approve" data-id="${esc(i.id)}">✅ Approve &amp; add to job costs</button><button type="button" class="btn btn-danger btn-sm oi-reject" data-id="${esc(i.id)}">Send back</button><button type="button" class="btn btn-outline btn-sm oi-pdf" data-id="${esc(i.id)}">PDF</button></div>` : ''}</div>`;
    }).join('') : '<p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 8px;">Nothing waiting for approval.</p>'}
    ${recent.length ? `<details><summary style="cursor: pointer; font-size: 0.85rem; color: var(--text-muted);">Recently reviewed (${recent.length})</summary><table class="rep-table" style="margin-top: 6px;"><tbody>${recent.map(i => `<tr><td>${esc(i.user_name)}</td><td>w/e ${miDate(i.week_end)}</td><td>${esc(i.invoice_no)}</td><td style="text-align: right;">${money(i.gross)}</td><td>${miChipHtml(i.status)}</td></tr>`).join('')}</tbody></table></details>` : ''}`;
  host.querySelectorAll('.oi-approve').forEach(b => b.addEventListener('click', () => approveOperativeInvoice(b)));
  host.querySelectorAll('.oi-reject').forEach(b => b.addEventListener('click', () => rejectOperativeInvoice(b.dataset.id)));
  host.querySelectorAll('.oi-pdf').forEach(b => b.addEventListener('click', () => { const r = operativeInvoices.find(x => x.id === b.dataset.id); if (r) miDownloadPdf(r).catch(e => alert(e.message)); }));
}

async function approveOperativeInvoice(btn) {
  const rec = operativeInvoices.find(x => x.id === btn.dataset.id);
  if (!rec || rec.status !== 'submitted' || !isOwnerOrAdminUser(currentUser)) return;
  const unbooked = rec.lines.filter(l => l.planner_days == null || l.days > l.planner_days);
  const warn = unbooked.length ? `\n\n⚠️ ${unbooked.length} line(s) claim more days than the planner shows.` : '';
  if (!confirm(`Approve ${rec.user_name}'s invoice ${rec.invoice_no} for ${money(rec.gross)}?\n\nIts ${money(rec.net)} (ex VAT) will be added to the job costs.${warn}`)) return;
  btn.disabled = true;
  try {
    const doc = await miBuildPdf(rec);
    const file = new File([doc.output('blob')], `Invoice_${String(rec.invoice_no).replace(/[^A-Za-z0-9-]/g, '_')}.pdf`, { type: 'application/pdf' });
    const splits = rec.lines.map(l => ({ siteId: l.site_id, net: l.net }));
    await importInvoiceItem({
      file, splits: splits.length > 1 ? splits : null, siteId: splits[0].siteId, net: rec.net, vat: rec.vat || null, gross: rec.gross,
      invNo: rec.invoice_no, merchant: rec.trading_name || rec.user_name, date: rec.invoice_date, contractorId: rec.user_id, week: rec.week_start, poNumber: ''
    });
    await db.collection('operative_invoices').doc(rec.id).update({ status: 'approved', reviewed_by: currentUser.full_name, reviewed_at: new Date().toISOString() });
    await db.collection('notifications').add({ target_user_id: String(rec.user_id), title: '✅ Invoice approved', body: `Your invoice ${rec.invoice_no} (${money(rec.gross)}) for w/e ${miDate(rec.week_end)} has been approved.`, created_at: new Date().toISOString() }).catch(() => {});
    showGreenToast('Approved and added to the job costs');
  } catch (err) { alert('Could not approve: ' + err.message); btn.disabled = false; }
}

async function rejectOperativeInvoice(id) {
  const rec = operativeInvoices.find(x => x.id === id);
  if (!rec || !isOwnerOrAdminUser(currentUser)) return;
  const reason = prompt(`Send ${rec.user_name}'s invoice back. What needs changing?`, '');
  if (reason === null) return;
  await db.collection('operative_invoices').doc(id).update({ status: 'rejected', review_note: reason.trim(), reviewed_by: currentUser.full_name, reviewed_at: new Date().toISOString() }).catch(err => alert('Could not update: ' + err.message));
  await db.collection('notifications').add({ target_user_id: String(rec.user_id), title: '↩️ Invoice sent back', body: `Invoice ${rec.invoice_no} needs changing${reason.trim() ? ': ' + reason.trim() : ''}`, created_at: new Date().toISOString() }).catch(() => {});
}
