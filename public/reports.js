// -------------------------------------------------------------------
// FINANCE REPORTS: quarterly finance report (per manager / branch) and weekly activity report.
// Everything is worked out from data already in the app (shifts, POs, supplier invoices, customer invoices, costs);
// the only typed-in extras are on each job's Finance tab ("Job tracker"): client, client PO, handover docs, date paid.
// Costs are job-to-date and use exactly the same figures as the Finance page (computeSiteFinance).
// -------------------------------------------------------------------
let repType = 'quarter';
let repWeekStart = null;
let lastReport = null;

function repToday() { return diaryDateKey(new Date()); }
function repMondayOf(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return diaryDateKey(d);
}
function repShort(iso) { if (!iso) return ''; const p = String(iso).split('T')[0].split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0].slice(2)}` : iso; }
function repQuarterList() {
  const now = new Date(); let y = now.getFullYear(), q = Math.floor(now.getMonth() / 3) + 1;
  const out = [];
  for (let i = 0; i < 8; i++) {
    const sm = (q - 1) * 3;
    const start = diaryDateKey(new Date(y, sm, 1));
    const end = diaryDateKey(new Date(y, sm + 3, 0));
    out.push({ key: `${y}-Q${q}`, label: `Q${q} ${y} (${new Date(y, sm, 1).toLocaleDateString('en-GB', { month: 'short' })} – ${new Date(y, sm + 2, 1).toLocaleDateString('en-GB', { month: 'short' })})`, start, end });
    q--; if (q === 0) { q = 4; y--; }
  }
  return out;
}
function repPostcode(address) {
  const m = String(address || '').toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);
  return m ? `${m[1]} ${m[2]}` : '';
}
function repAddressShort(address) {
  // street address without the postcode, as in the tracker spreadsheet
  return String(address || '').replace(/,?\s*\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b\s*$/, '').trim();
}
function repBranches() {
  return Array.from(new Set(allSites.map(s => (s.branch || '').trim()).filter(Boolean))).sort();
}

// One row of facts about a job, used by both reports
function repJob(site, ctx) {
  const sid = String(site.id);
  const fj = financeJobs[sid] || {};
  const f = computeSiteFinance(site);
  const today = repToday();
  const dates = allShifts.filter(sh => String(sh.site_id) === sid && !sh.is_drying_day && sh.shift_date).map(sh => sh.shift_date).sort();
  const install = fj.install_override || dates[0] || '';
  const fin = getSiteFinish(site.id);
  const completion = fj.completion_override || (fin ? fin.date : '');
  const completed = !!completion && (fj.completion_override ? completion <= today : completion < today);
  const invs = customerInvoices.filter(i => String(i.site_id) === sid).sort((a, b) => String(a.invoice_date).localeCompare(String(b.invoice_date)));
  const raised = invs.length ? invs[invs.length - 1].invoice_date : '';
  const invoicedNet = invs.reduce((t, i) => t + (i.net_pence || 0) / 100, 0);
  const status = fj.flag_issues ? 'ISSUES' : completed ? 'COMPLETE' : install && install <= today ? 'WIP' : 'PIPELINE';
  return {
    site, sid, f, fj, install, completion, completed, status, invs, raised, invoicedNet,
    paid: fj.paid_date || '', handover: fj.handover_date || '',
    client: fj.client || (invs.length ? invs[invs.length - 1].customer_name : ''),
    po: fj.client_po || '',
    manager: siteManagerName(site) || 'Unassigned',
    branch: (site.branch || '').trim() || 'No branch'
  };
}

// Plain-English accuracy checks. Anything listed here could make the figures wrong or the paperwork late.
function repAttention(j) {
  const out = [];
  const today = repToday();
  if (j.status === 'PIPELINE') return out;
  if (j.f.value == null) out.push('No job value entered, so profit cannot be shown');
  if (j.f.noRate.length) out.push(`No day rate for ${j.f.noRate.join(', ')} - their labour counts as £0`);
  if (j.f.doubleBooked.length) out.push(`Someone is booked on two jobs at once (${j.f.doubleBooked.length} case${j.f.doubleBooked.length > 1 ? 's' : ''}) - check the cost split`);
  if (j.status === 'COMPLETE' && !j.invs.length) out.push('Job complete but no invoice raised');
  if (j.status === 'COMPLETE' && !j.handover) out.push('Job complete but handover documents not recorded as sent');
  if (j.status === 'COMPLETE' && j.f.onOrder > 0) out.push(`${money(j.f.onOrder)} of materials still "on order" (estimate, not invoiced) on a completed job`);
  if (j.raised && !j.paid) {
    const days = Math.floor((new Date(today) - new Date(j.raised)) / 86400000);
    if (days > 30) out.push(`Invoice raised ${repShort(j.raised)} - ${days} days unpaid`);
  }
  if (j.status === 'ISSUES' && j.fj.issue_note) out.push('Flagged: ' + j.fj.issue_note);
  return out;
}

function repFilterSites() {
  const sel = (document.getElementById('repFor') || {}).value || 'mine';
  let sites = allSites.slice(), groupKey = null, label = 'All jobs';
  if (sel === 'mine') { sites = sites.filter(s => String(s.manager_id) === String(currentUser.id)); label = `${currentUser.full_name} - my jobs`; }
  else if (sel === 'all-mgr') { groupKey = 'manager'; label = 'All managers'; }
  else if (sel === 'all-branch') { groupKey = 'branch'; label = 'All branches'; }
  else if (sel.startsWith('m:')) { const id = sel.slice(2); sites = sites.filter(s => String(s.manager_id) === id); label = (allUsers.find(u => String(u.id) === id) || {}).full_name || 'Manager'; }
  else if (sel.startsWith('b:')) { const b = sel.slice(2); sites = sites.filter(s => (s.branch || '').trim() === b); label = `${b} branch`; }
  else if (sel === 'unassigned') { sites = sites.filter(s => !s.manager_id); label = 'Jobs with no manager'; }
  return { sites, groupKey, label };
}

function repGroup(jobs, groupKey) {
  if (!groupKey) return [{ name: '', jobs }];
  const map = {};
  jobs.forEach(j => { (map[j[groupKey]] = map[j[groupKey]] || []).push(j); });
  return Object.keys(map).sort((a, b) => (a === 'Unassigned' || a === 'No branch') - (b === 'Unassigned' || b === 'No branch') || a.localeCompare(b)).map(name => ({ name, jobs: map[name] }));
}

const REP_PCT = (profit, value) => value ? (profit / value * 100).toFixed(1) + '%' : '-';

// ---------------- Quarterly finance report ----------------
function buildQuarterReport() {
  const qs = repQuarterList();
  const q = qs.find(x => x.key === document.getElementById('repQuarter').value) || qs[0];
  const { sites, groupKey, label } = repFilterSites();
  const today = repToday();
  const inQ = d => d && d >= q.start && d <= q.end;
  const all = sites.map(repJob);
  const jobs = all.filter(j => {
    const active = j.install && j.install <= q.end && (!j.completion || j.completion >= q.start || !j.completed);
    const money_ = j.invs.some(i => inQ(i.invoice_date)) || inQ(j.paid);
    const pipeline = j.status === 'PIPELINE' && !j.site.is_archived && q.end >= today;
    return active || money_ || pipeline;
  }).sort((a, b) => (a.install || '9999').localeCompare(b.install || '9999') || a.site.address.localeCompare(b.site.address));

  const columns = [
    { h: 'Job address' }, { h: 'Postcode' }, { h: 'Client' }, { h: 'Client PO' }, { h: 'Install' }, { h: 'Complete' }, { h: 'Handover' },
    { h: 'Value', a: 'right' }, { h: 'Cost', a: 'right' }, { h: 'Profit', a: 'right' }, { h: '%', a: 'right' }, { h: 'Invoiced' }, { h: 'Paid' }, { h: 'Status' }
  ];
  const rowOf = j => [repAddressShort(j.site.address), repPostcode(j.site.address), j.client, j.po, repShort(j.install), repShort(j.completion), repShort(j.handover),
    j.f.value != null ? money(j.f.value) : 'not set', money(j.f.totalCost), j.f.profit != null ? money(j.f.profit) : '-', REP_PCT(j.f.profit, j.f.value), repShort(j.raised), repShort(j.paid), j.status];
  const sum = (list, fn) => list.reduce((t, j) => t + fn(j), 0);
  const valued = list => list.filter(j => j.f.value != null);
  const foot = list => {
    const v = sum(valued(list), j => j.f.value), c = sum(valued(list), j => j.f.totalCost), p = v - c;
    return ['TOTAL', '', '', '', '', '', '', money(v), money(sum(list, j => j.f.totalCost)), money(p), REP_PCT(p, v), '', '', `${list.length} jobs`];
  };

  const groups = repGroup(jobs, groupKey);
  const sections = groups.map(g => ({ heading: g.name || '', columns, rows: g.jobs.map(rowOf), foot: foot(g.jobs), statusCol: 13 }));

  const vj = valued(jobs), val = sum(vj, j => j.f.value), cost = sum(vj, j => j.f.totalCost);
  const raisedQ = customerInvoices.filter(i => inQ(i.invoice_date) && jobs.some(j => j.sid === String(i.site_id)));
  const raisedNet = sum(raisedQ, i => (i.net_pence || 0) / 100);
  const paidQ = jobs.filter(j => inQ(j.paid));
  const paidVal = sum(paidQ, j => j.invoicedNet || j.f.value || 0);
  const outstanding = jobs.filter(j => j.raised && !j.paid);
  const outVal = sum(outstanding, j => j.invoicedNet || j.f.value || 0);
  const kpis = [
    { label: 'Jobs in report', value: String(jobs.length) },
    { label: 'Completed in quarter', value: String(jobs.filter(j => j.completed && inQ(j.completion)).length) },
    { label: 'Job value (valued jobs)', value: money(val) },
    { label: 'Total cost', value: money(cost) },
    { label: val - cost < 0 ? 'Loss' : 'Profit', value: money(val - cost), tone: val - cost < 0 ? 'bad' : 'good' },
    { label: 'Margin', value: val ? ((val - cost) / val * 100).toFixed(1) + '%' : '-', tone: val - cost < 0 ? 'bad' : 'good' },
    { label: 'Invoiced to clients in quarter', value: money(raisedNet) },
    { label: 'Paid in quarter', value: money(paidVal) },
    { label: 'Invoiced, not yet paid', value: `${money(outVal)} (${outstanding.length})` }
  ];
  const attention = [];
  jobs.forEach(j => repAttention(j).forEach(msg => attention.push([repAddressShort(j.site.address), j.manager, msg])));
  const notUnvalued = jobs.length - vj.length;
  return {
    title: 'Quarterly Finance Report', filename: `Finance_Report_${q.key}_${label.replace(/[^A-Za-z0-9]+/g, '_')}`,
    subtitle: `${label}  •  ${q.label.split(' (')[0]}  (${repShort(q.start)} – ${repShort(q.end)})`,
    kpis, sections, attention,
    notes: [
      'Job value is the quote entered on each job (ex VAT). Total cost is job-to-date: materials invoiced + materials on order (estimates) + labour for shifts up to today + extra costs.',
      'A job is included if it was on site at any point in the quarter, had a client invoice raised or paid in the quarter, or is in the pipeline.',
      notUnvalued ? `${notUnvalued} job${notUnvalued > 1 ? 's have' : ' has'} no job value entered, so ${notUnvalued > 1 ? 'they are' : 'it is'} left out of the profit and margin totals.` : ''
    ].filter(Boolean)
  };
}

// ---------------- Weekly activity report ----------------
function buildWeekReport() {
  const start = repWeekStart, end = addDaysISO(start, 6), next = addDaysISO(start, 7), nextEnd = addDaysISO(start, 13);
  const today = repToday();
  const inW = d => d && d >= start && d <= end;
  const { sites, groupKey, label } = repFilterSites();
  const jobs = sites.map(repJob);
  const byId = Object.fromEntries(jobs.map(j => [j.sid, j]));
  const alloc = allocateShiftCosts();
  // work done in the week, per job
  const work = {};
  allShifts.forEach(sh => {
    if (!sh.operative_id || sh.is_drying_day || !inW(sh.shift_date) || !byId[String(sh.site_id)]) return;
    const w = work[String(sh.site_id)] = work[String(sh.site_id)] || { frac: 0, cost: 0, ops: new Set() };
    const a = alloc.get(sh) || { frac: 0, pence: 0 };
    w.frac += a.frac;
    if (sh.shift_date <= today) w.cost += a.pence / 100;
    const u = allUsers.find(x => String(x.id) === String(sh.operative_id));
    if (u) w.ops.add(u.full_name);
  });
  const worked = jobs.filter(j => work[j.sid]);
  const started = jobs.filter(j => inW(j.install));
  const completedJ = jobs.filter(j => j.completed && inW(j.completion));
  const startingNext = jobs.filter(j => j.install >= next && j.install <= nextEnd);
  const supplier = allPdfs.filter(f => f.file_type === 'invoice' && inW(f.invoice_date) && byId[String(f.site_id)]);
  const clientInv = customerInvoices.filter(i => inW(i.invoice_date) && byId[String(i.site_id)]);
  const paidJ = jobs.filter(j => inW(j.paid));
  const extras = financeCosts.filter(c => inW(c.date) && byId[String(c.site_id)]);
  const sumN = (arr, fn) => arr.reduce((t, x) => t + fn(x), 0);
  // Labour is costed from operatives' invoices for the week (week_start), or from day rates if that mode is on
  const viaInv = labourFromInvoices() && start >= labourCutoff();
  const wkOf = f => f.week_start || addDaysISO(mondayOfISO(f.invoice_date || String(f.created_at).slice(0, 10)), -7);
  const labInv = {};
  allPdfs.filter(f => labourInvoiceCounts(f) && byId[String(f.site_id)] && wkOf(f) === start).forEach(f => { labInv[String(f.site_id)] = (labInv[String(f.site_id)] || 0) + (parseFloat(f.invoice_net) || 0); });
  const labourOf = j => viaInv ? (labInv[j.sid] || 0) : work[j.sid].cost;
  const labour = viaInv ? sumN(Object.values(labInv), v => v) : sumN(Object.values(work), w => w.cost);

  const mk = (list, cols, rowFn, extra = {}) => ({ columns: cols, rows: list.map(rowFn), ...extra });
  const secsFor = (title, list, cols, rowFn, footFn) => {
    if (!list.length) return [];
    return repGroup(list, groupKey).map(g => ({
      heading: (groupKey ? `${g.name} — ` : '') + title + ` (${g.jobs.length})`,
      ...mk(g.jobs, cols, rowFn), ...(footFn ? { foot: footFn(g.jobs) } : {})
    }));
  };
  const sections = [
    ...secsFor('Jobs started', started, [{ h: 'Job address' }, { h: 'Manager' }, { h: 'Client' }, { h: 'Start date' }, { h: 'Job value', a: 'right' }],
      j => [repAddressShort(j.site.address), j.manager, j.client, repShort(j.install), j.f.value != null ? money(j.f.value) : 'not set']),
    ...secsFor('Jobs completed', completedJ, [{ h: 'Job address' }, { h: 'Manager' }, { h: 'Completed' }, { h: 'Job value', a: 'right' }, { h: 'Total cost', a: 'right' }, { h: 'Profit', a: 'right' }, { h: 'Profit %', a: 'right' }],
      j => [repAddressShort(j.site.address), j.manager, repShort(j.completion), j.f.value != null ? money(j.f.value) : 'not set', money(j.f.totalCost), j.f.profit != null ? money(j.f.profit) : '-', REP_PCT(j.f.profit, j.f.value)]),
    ...secsFor('On site this week', worked, [{ h: 'Job address' }, { h: 'Manager' }, { h: 'Who was on site' }, { h: 'Operative days', a: 'right' }, { h: viaInv ? 'Labour invoiced' : 'Labour cost', a: 'right' }, { h: 'Status' }],
      j => [repAddressShort(j.site.address), j.manager, Array.from(work[j.sid].ops).join(', '), String(Math.round(work[j.sid].frac * 10) / 10), viaInv && !labInv[j.sid] ? 'awaiting invoice' : money(labourOf(j)), j.status],
      list => ['TOTAL', '', '', String(Math.round(sumN(list, j => work[j.sid].frac) * 10) / 10), money(sumN(list, j => labourOf(j))), '']),
  ];
  if (supplier.length) sections.push({ heading: `Supplier invoices received (${supplier.length})`, columns: [{ h: 'Date' }, { h: 'Merchant' }, { h: 'Invoice no.' }, { h: 'Job' }, { h: 'Net', a: 'right' }],
    rows: supplier.sort((a, b) => String(a.invoice_date).localeCompare(String(b.invoice_date))).map(f => [repShort(f.invoice_date), invMerchantOf(f), f.invoice_no || '', repAddressShort((invSiteById(f.site_id) || {}).address || ''), money(f.invoice_net)]),
    foot: ['TOTAL', '', '', '', money(sumN(supplier, f => parseFloat(f.invoice_net) || 0))] });
  if (clientInv.length) sections.push({ heading: `Invoices raised to clients (${clientInv.length})`, columns: [{ h: 'Date' }, { h: 'Invoice' }, { h: 'Client' }, { h: 'Job' }, { h: 'Net', a: 'right' }],
    rows: clientInv.map(i => [repShort(i.invoice_date), i.number, i.customer_name, repAddressShort(i.site_address), money((i.net_pence || 0) / 100)]),
    foot: ['TOTAL', '', '', '', money(sumN(clientInv, i => (i.net_pence || 0) / 100))] });
  if (paidJ.length) sections.push({ heading: `Payments received (${paidJ.length})`, columns: [{ h: 'Date paid' }, { h: 'Job' }, { h: 'Client' }, { h: 'Invoiced (net)', a: 'right' }],
    rows: paidJ.map(j => [repShort(j.paid), repAddressShort(j.site.address), j.client, money(j.invoicedNet || j.f.value || 0)]),
    foot: ['TOTAL', '', '', money(sumN(paidJ, j => j.invoicedNet || j.f.value || 0))] });
  sections.push(...secsFor(`Starting next week (${repShort(next)} – ${repShort(nextEnd)})`, startingNext, [{ h: 'Job address' }, { h: 'Manager' }, { h: 'Client' }, { h: 'Start date' }, { h: 'Job value', a: 'right' }],
    j => [repAddressShort(j.site.address), j.manager, j.client, repShort(j.install), j.f.value != null ? money(j.f.value) : 'not set']).map(s => ({ ...s, heading: s.heading.replace(/\(\d+\)$/, '').trim() })));

  const kpis = [
    { label: 'Jobs started', value: String(started.length) },
    { label: 'Jobs completed', value: String(completedJ.length) },
    { label: 'Jobs on site', value: String(worked.length) },
    { label: 'Operative days', value: String(Math.round(sumN(Object.values(work), w => w.frac) * 10) / 10) },
    { label: viaInv ? 'Labour invoiced for the week' : 'Labour cost', value: money(labour) },
    { label: 'Supplier invoices', value: money(sumN(supplier, f => parseFloat(f.invoice_net) || 0)) },
    { label: 'Extra costs logged', value: money(sumN(extras, c => parseFloat(c.amount) || 0)) },
    { label: 'Invoiced to clients', value: money(sumN(clientInv, i => (i.net_pence || 0) / 100)) },
    { label: 'Paid by clients', value: money(sumN(paidJ, j => j.invoicedNet || j.f.value || 0)) }
  ];
  const attention = [];
  worked.concat(completedJ).filter((j, i, a) => a.indexOf(j) === i).forEach(j => repAttention(j).forEach(msg => attention.push([repAddressShort(j.site.address), j.manager, msg])));
  return {
    title: 'Weekly Activity Report', filename: `Weekly_Report_${start}_${label.replace(/[^A-Za-z0-9]+/g, '_')}`,
    subtitle: `${label}  •  Week ${repShort(start)} – ${repShort(end)}`,
    kpis, sections, attention,
    notes: ['A job counts as started in the week of its first booked shift and as complete in the week of its finish shift. ' + (viaInv ? 'Labour is the operatives\' invoices covering this week; "awaiting invoice" means days were booked but the invoice has not been imported yet.' : 'Labour cost covers shifts up to today only.')]
  };
}

// ---------------- Output ----------------
function repBuild() { return repType === 'quarter' ? buildQuarterReport() : buildWeekReport(); }

const REP_STATUS_COL = { COMPLETE: ['#c6efce', '#14532d'], WIP: ['#ffeb9c', '#713f12'], ISSUES: ['#ffc7ce', '#7f1d1d'], PIPELINE: ['#e2e8f0', '#334155'] };

function repRenderHtml(rep) {
  const esc = diaryEsc;
  const tone = t => t === 'bad' ? 'color: #ef4444;' : t === 'good' ? 'color: #10b981;' : '';
  let html = `<div class="site-card" style="margin-bottom: 14px;"><h3 style="margin-bottom: 2px;">${esc(rep.title)}</h3><div style="color: var(--text-muted);">${esc(rep.subtitle)}</div></div>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px;">${rep.kpis.map(k => `<div class="site-card"><div style="font-size: 0.72rem; color: var(--text-muted);">${esc(k.label.toUpperCase())}</div><div style="font-size: 1.15rem; font-weight: 800; ${tone(k.tone)}">${esc(k.value)}</div></div>`).join('')}</div>`;
  if (!rep.sections.length) html += '<div class="site-card" style="color: var(--text-muted);">Nothing to report for this period.</div>';
  rep.sections.forEach(s => {
    html += `<div class="site-card" style="margin-bottom: 14px; padding: 12px;">${s.heading ? `<h4 style="margin-bottom: 8px;">${esc(s.heading)}</h4>` : ''}
      <table class="rep-table"><thead><tr>${s.columns.map(c => `<th${c.a ? ` style="text-align: ${c.a};"` : ''}>${esc(c.h)}</th>`).join('')}</tr></thead><tbody>
      ${s.rows.map(r => `<tr>${r.map((v, i) => {
        const st = s.statusCol === i && REP_STATUS_COL[v];
        const style = [s.columns[i].a ? `text-align: ${s.columns[i].a}` : '', st ? `background: ${st[0]}; color: ${st[1]}; font-weight: 700` : ''].filter(Boolean).join('; ');
        return `<td${style ? ` style="${style}"` : ''}>${esc(v)}</td>`;
      }).join('')}</tr>`).join('')}
      ${s.foot ? `<tr style="font-weight: 800; border-top: 2px solid var(--border-color);">${s.foot.map((v, i) => `<td${s.columns[i].a ? ` style="text-align: ${s.columns[i].a};"` : ''}>${esc(v)}</td>`).join('')}</tr>` : ''}
      </tbody></table></div>`;
  });
  html += `<div class="site-card" style="margin-bottom: 14px;"><h4 style="margin-bottom: 8px;">${rep.attention.length ? `⚠️ Needs attention (${rep.attention.length})` : '✅ Nothing needs attention'}</h4>
    ${rep.attention.length ? `<table class="rep-table"><tbody>${rep.attention.map(a => `<tr><td><strong>${esc(a[0])}</strong><div style="font-size: 0.75rem; color: var(--text-muted);">${esc(a[1])}</div></td><td>${esc(a[2])}</td></tr>`).join('')}</tbody></table>` : '<p style="color: var(--text-muted);">Every job in this report has the information needed to report accurately.</p>'}</div>
    <div style="color: var(--text-muted); font-size: 0.8rem;">${rep.notes.map(n => `<p style="margin-bottom: 4px;">${esc(n)}</p>`).join('')}</div>`;
  return html;
}

function renderReportsView() {
  if (!currentUser || !isManagementUser(currentUser)) return;
  const forSel = document.getElementById('repFor');
  const prevFor = forSel.value || 'mine';
  const mgrs = managerUsers().filter(u => allSites.some(s => String(s.manager_id) === String(u.id)));
  forSel.innerHTML = '<option value="mine">👤 My jobs</option><option value="all-mgr">👥 All jobs — grouped by manager</option>' +
    (repBranches().length ? '<option value="all-branch">🏢 All jobs — grouped by branch</option>' : '') +
    mgrs.map(u => `<option value="m:${diaryEsc(u.id)}">Manager: ${diaryEsc(u.full_name)}</option>`).join('') +
    repBranches().map(b => `<option value="b:${diaryEsc(b)}">Branch: ${diaryEsc(b)}</option>`).join('') +
    '<option value="unassigned">Jobs with no manager</option>';
  forSel.value = Array.from(forSel.options).some(o => o.value === prevFor) ? prevFor : 'mine';
  const qSel = document.getElementById('repQuarter');
  const prevQ = qSel.value;
  qSel.innerHTML = repQuarterList().map(q => `<option value="${q.key}">${q.label}</option>`).join('');
  if (prevQ) qSel.value = prevQ;
  if (!repWeekStart) repWeekStart = repMondayOf(repToday());
  document.getElementById('repWeekLabel').textContent = `${repShort(repWeekStart)} – ${repShort(addDaysISO(repWeekStart, 6))}`;
  document.getElementById('repQuarterWrap').style.display = repType === 'quarter' ? '' : 'none';
  document.getElementById('repWeekWrap').style.display = repType === 'week' ? 'flex' : 'none';
  document.querySelectorAll('.rep-type').forEach(b => b.classList.toggle('active', b.dataset.type === repType));
  lastReport = repBuild();
  document.getElementById('repOutput').innerHTML = repRenderHtml(lastReport);
}

function repDownloadCsv() {
  if (!lastReport) return;
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [[lastReport.title], [lastReport.subtitle], [], ...lastReport.kpis.map(k => [k.label, k.value]), []];
  lastReport.sections.forEach(s => {
    if (s.heading) lines.push([s.heading]);
    lines.push(s.columns.map(c => c.h)); s.rows.forEach(r => lines.push(r)); if (s.foot) lines.push(s.foot); lines.push([]);
  });
  if (lastReport.attention.length) { lines.push(['Needs attention']); lastReport.attention.forEach(a => lines.push(a)); lines.push([]); }
  lastReport.notes.forEach(n => lines.push([n]));
  const blob = new Blob(['﻿' + lines.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = lastReport.filename + '.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function repDownloadPdf() {
  if (!lastReport) return;
  if (typeof window.jspdf === 'undefined') { alert('The PDF library is still loading, please try again.'); return; }
  const rep = lastReport;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const navy = [15, 23, 42], grey = [100, 116, 139];
  const W = 297, M = 10;
  doc.setFillColor(...navy); doc.rect(0, 0, W, 4, 'F');
  let y = 14;
  const logo = await getLogoBase64().catch(() => null);
  if (logo) { try { const sz = await ciImageSize(logo); const h = 12, w = sz && sz.h ? h * sz.w / sz.h : 30; doc.addImage(logo, 'PNG', M, 8, Math.min(w, 45), h, undefined, 'FAST'); } catch (e) { /* optional */ } }
  doc.setTextColor(...navy); doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
  doc.text(rep.title.toUpperCase(), W - M, 15, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...grey);
  doc.text(rep.subtitle, W - M, 21, { align: 'right' });
  doc.setFontSize(8); doc.text(`Generated ${new Date().toLocaleString('en-GB')} by ${currentUser.full_name}`, W - M, 26, { align: 'right' });
  y = 32;
  // KPI boxes
  const per = Math.min(rep.kpis.length, 9), bw = (W - M * 2 - (per - 1) * 2) / per;
  rep.kpis.slice(0, per).forEach((k, i) => {
    const x = M + i * (bw + 2);
    doc.setDrawColor(203, 213, 225); doc.setFillColor(248, 250, 252); doc.roundedRect(x, y, bw, 14, 1.5, 1.5, 'FD');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(...grey); doc.text(k.label.toUpperCase(), x + 2, y + 4.5, { maxWidth: bw - 3 });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...(k.tone === 'bad' ? [185, 28, 28] : k.tone === 'good' ? [21, 128, 61] : navy)); doc.text(k.value, x + 2, y + 11, { maxWidth: bw - 3 });
  });
  y += 20;
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  rep.sections.forEach(s => {
    if (s.heading) {
      if (y > 180) { doc.addPage(); y = 14; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...navy); doc.text(s.heading, M, y); y += 2;
    }
    doc.autoTable({
      startY: y, margin: { left: M, right: M, bottom: 14 },
      head: [s.columns.map(c => c.h)], body: s.rows, foot: s.foot ? [s.foot] : undefined, showFoot: 'lastPage',
      styles: { fontSize: 7, cellPadding: 1.4, textColor: navy, lineColor: [203, 213, 225], lineWidth: 0.1 },
      headStyles: { fillColor: [226, 232, 240], textColor: navy, fontStyle: 'bold' },
      footStyles: { fillColor: [241, 245, 249], textColor: navy, fontStyle: 'bold' },
      columnStyles: Object.fromEntries(s.columns.map((c, i) => [i, c.a ? { halign: c.a } : {}]).filter(e => Object.keys(e[1]).length)),
      didParseCell: d => {
        if (d.section === 'body' && s.statusCol === d.column.index && REP_STATUS_COL[d.cell.raw]) {
          const c = REP_STATUS_COL[d.cell.raw]; d.cell.styles.fillColor = hex(c[0]); d.cell.styles.textColor = hex(c[1]); d.cell.styles.fontStyle = 'bold';
        }
      }
    });
    y = doc.lastAutoTable.finalY + 8;
  });
  if (y > 170) { doc.addPage(); y = 14; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...navy);
  doc.text(rep.attention.length ? `Needs attention (${rep.attention.length})` : 'Needs attention: nothing - every job has the information needed to report accurately', M, y);
  if (rep.attention.length) {
    doc.autoTable({ startY: y + 2, margin: { left: M, right: M, bottom: 14 }, head: [['Job', 'Manager', 'Issue']], body: rep.attention,
      styles: { fontSize: 7, cellPadding: 1.4, textColor: navy, lineColor: [203, 213, 225], lineWidth: 0.1 }, headStyles: { fillColor: [254, 226, 226], textColor: [127, 29, 29] } });
    y = doc.lastAutoTable.finalY;
  }
  y += 8;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...grey);
  rep.notes.forEach(n => { const ls = doc.splitTextToSize(n, W - M * 2); if (y + ls.length * 3.2 > 200) { doc.addPage(); y = 14; } doc.text(ls, M, y); y += ls.length * 3.2 + 1; });
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(7); doc.setTextColor(...grey); doc.text(`GVD Contracts Ltd  •  ${rep.title}  •  Page ${i} of ${pages}`, M, 205); }
  doc.save(rep.filename + '.pdf');
}

function setupReportsListeners() {
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  document.querySelectorAll('.rep-type').forEach(b => b.addEventListener('click', () => { repType = b.dataset.type; renderReportsView(); }));
  ['repFor', 'repQuarter'].forEach(id => on(id, 'change', renderReportsView));
  on('repWeekPrev', 'click', () => { repWeekStart = addDaysISO(repWeekStart, -7); renderReportsView(); });
  on('repWeekNext', 'click', () => { repWeekStart = addDaysISO(repWeekStart, 7); renderReportsView(); });
  on('repWeekThis', 'click', () => { repWeekStart = repMondayOf(repToday()); renderReportsView(); });
  on('btnRepPdf', 'click', () => repDownloadPdf().catch(err => alert('Could not build the PDF: ' + err.message)));
  on('btnRepCsv', 'click', repDownloadCsv);
}
