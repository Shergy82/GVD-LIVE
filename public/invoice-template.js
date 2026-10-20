// -------------------------------------------------------------------
// OPERATIVE INVOICE TEMPLATE (Admin Settings). Owners/Admins download it and share it with operatives;
// operatives never see it in the app. It is a fillable PDF laid out so the Invoices importer can read it back:
// fixed labels ("Invoice no:", "Week ending:", "Net total", "Total VAT", "Invoice total"), one line per job
// (job address + days + rate + amount), and the typed-in values are read from the form fields.
// -------------------------------------------------------------------
function otLastSunday() {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());   // Sunday on or before today
  return diaryDateKey(d);
}

async function buildOperativeInvoicePdf(opts) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const co = ciCompany();
  const PW = 595, M = 40, R = PW - M;
  const navy = [15, 23, 42], grey = [100, 116, 139], line = [203, 213, 225];
  const fmtD = iso => { const p = String(iso || '').split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : ''; };

  // every fillable box sits 11pt above its label's baseline and is 15pt tall, so the importer reads label + value as one line
  const field = (name, x, baseline, w, value, align) => {
    const f = new jsPDF.AcroForm.TextField();
    f.fieldName = name; f.Rect = [x, baseline - 11, w, 15]; f.value = value || ''; f.fontSize = 10; f.maxFontSize = 10;
    f.borderStyle = 'underline'; f.color = '#0f172a'; f.textAlign = align || 'left';
    doc.addField(f);
    doc.setDrawColor(...line); doc.setLineWidth(0.6); doc.line(x, baseline + 5, x + w, baseline + 5);
  };
  const label = (t, x, y, bold) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(9); doc.setTextColor(...navy); doc.text(t, x, y); };

  // header band + logo
  doc.setFillColor(...navy); doc.rect(0, 0, PW, 74, 'F');
  doc.setFillColor(249, 115, 22); doc.rect(0, 74, PW, 4, 'F');
  const logo = await getLogoBase64().catch(() => null);
  if (logo) {
    try {
      const sz = await ciImageSize(logo); const h = 46, w = Math.min(130, sz && sz.h ? h * sz.w / sz.h : 90);
      doc.setFillColor(255, 255, 255); doc.roundedRect(M - 6, 12, w + 12, h + 6, 4, 4, 'F');
      doc.addImage(logo, 'PNG', M, 15, w, h, undefined, 'FAST');
    } catch (e) { /* logo optional */ }
  }
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
  doc.text('WEEKLY INVOICE', R, 36, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(203, 213, 225);
  doc.text('Operative / subcontractor to ' + co.name, R, 52, { align: 'right' });

  // invoice to (left) and invoice details (right)
  let y = 108;
  label('INVOICE TO', M, y, true);
  doc.setFont('helvetica', 'normal'); doc.setTextColor(...navy); doc.setFontSize(9.5);
  const toLines = [co.name, ...String(co.address || '').split(/\r?\n|,\s*/).filter(Boolean), co.vat_no ? 'VAT no. ' + co.vat_no : ''].filter(Boolean).slice(0, 6);
  toLines.forEach((t, i) => doc.text(t, M, y + 14 + i * 12));
  label('Invoice no:', 330, y + 6); field('invoice_no', 400, y + 6, R - 400, '');
  label('Invoice date:', 330, y + 32); field('invoice_date', 400, y + 32, R - 400, fmtD(diaryDateKey(new Date())));
  label('Week ending:', 330, y + 58); field('week_ending', 400, y + 58, R - 400, fmtD(opts.weekEnding));
  doc.setFontSize(7.5); doc.setTextColor(...grey); doc.text('dd/mm/yyyy - the Sunday of the week worked', 400, y + 76);

  // from
  y = 212;
  label('Operative:', M, y); field('operative_name', M + 60, y, 220, opts.operative || '');
  label('Trading name:', 310, y); field('trading_name', 380, y, R - 380, '');
  y += 24;
  label('UTR (if CIS):', M, y); field('utr', M + 60, y, 220, '');
  label('VAT no. (if registered):', 310, y); field('vat_no', 410, y, R - 410, '');

  // job lines
  y = 268;
  doc.setFillColor(241, 245, 249); doc.rect(M, y - 12, R - M, 20, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(51, 65, 85);
  doc.text('JOB ADDRESS (one line per job)', M + 4, y + 1);
  doc.text('DAYS', 330, y + 1, { align: 'center' });
  doc.text('RATE £', 395, y + 1, { align: 'center' });
  doc.text('AMOUNT £ (ex VAT)', R - 4, y + 1, { align: 'right' });
  y += 28;
  const ROWS = 12;
  for (let i = 0; i < ROWS; i++) {
    const l = (opts.lines || [])[i];
    field(`job_${i + 1}`, M, y, 262, l ? l.address : '');
    field(`days_${i + 1}`, 312, y, 36, l ? String(l.days) : '', 'center');
    field(`rate_${i + 1}`, 365, y, 60, '', 'right');
    field(`amount_${i + 1}`, 445, y, R - 445, '', 'right');
    y += 24;
  }
  if ((opts.lines || []).length > ROWS) { doc.setFontSize(7.5); doc.setTextColor(185, 28, 28); doc.text(`${opts.lines.length - ROWS} more job(s) were booked this week - add them on a second invoice.`, M, y - 4); }

  // totals
  y += 12;
  label('Net total (ex VAT)', 330, y, true); field('net_total', 445, y, R - 445, '', 'right'); y += 22;
  label('Total VAT', 330, y); field('total_vat', 445, y, R - 445, '', 'right'); y += 22;
  label('Invoice total', 330, y, true); field('invoice_total', 445, y, R - 445, '', 'right');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...grey);
  doc.text(doc.splitTextToSize('Type amounts like 450.00. Leave VAT blank if you are not VAT registered.', R - 330), 330, y + 18);

  // payment details
  const py = y - 44;
  label('PAY TO', M, py - 8, true);
  label('Account Name:', M, py + 14); field('account_name', M + 70, py + 14, 200, '');
  label('Sort code:', M, py + 38); field('sort_code', M + 70, py + 38, 90, '');
  label('Account no:', M, py + 62); field('account_no', M + 70, py + 62, 120, '');

  // notes
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...grey);
  const notes = [
    `Send this invoice to ${co.email || 'the office'} by Monday for the week just worked. Payment terms: ${co.terms_days} days from the invoice date.`,
    'Include every job you worked, one line per job, with the number of days and the amount for that job (excluding VAT).',
    'Please fill in on screen (PDF reader) or print and write clearly. Photos of handwritten invoices cannot be read automatically.'
  ];
  let ny = 792; notes.forEach(n => { const ls = doc.splitTextToSize(n, R - M); doc.text(ls, M, ny); ny += ls.length * 10 + 1; });
  return doc;
}

async function downloadOperativeInvoice(prefill) {
  if (typeof window.jspdf === 'undefined') { alert('The PDF library is still loading, please try again.'); return; }
  let opts = { weekEnding: '', operative: '', lines: [] };
  if (prefill) {
    const uid = document.getElementById('otOperative').value;
    const we = document.getElementById('otWeekEnding').value || otLastSunday();
    const u = allUsers.find(x => String(x.id) === uid);
    if (!u) { alert('Choose the operative first.'); return; }
    const start = addDaysISO(we, -6);
    const bySite = {};
    allShifts.filter(sh => String(sh.operative_id) === uid && !sh.is_drying_day && sh.shift_date >= start && sh.shift_date <= we).forEach(sh => {
      bySite[sh.site_id] = (bySite[sh.site_id] || 0) + (sh.shift_period === 'am' || sh.shift_period === 'pm' ? 0.5 : 1);
    });
    const lines = Object.keys(bySite).map(id => ({ address: (allSites.find(s => String(s.id) === String(id)) || {}).address || 'Job ' + id, days: bySite[id] }));
    opts = { weekEnding: we, operative: u.full_name, lines };
  } else {
    opts.weekEnding = '';
  }
  const doc = await buildOperativeInvoicePdf(opts);
  doc.save(prefill ? `Invoice_${opts.operative.replace(/[^A-Za-z0-9]+/g, '_')}_w-e_${opts.weekEnding}.pdf` : 'GVD_Operative_Invoice_Template.pdf');
}

function renderInvoiceTemplateCard() {
  const sel = document.getElementById('otOperative');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Choose operative...</option>' + allUsers.filter(u => u.status === 'Active').sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))).map(u => `<option value="${diaryEsc(u.id)}">${diaryEsc(u.full_name)}</option>`).join('');
  sel.value = prev;
  const we = document.getElementById('otWeekEnding');
  if (!we.value) we.value = otLastSunday();
}

function setupInvoiceTemplateListeners() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('btnOtBlank', () => downloadOperativeInvoice(false).catch(e => alert('Could not build the template: ' + e.message)));
  on('btnOtPrefill', () => downloadOperativeInvoice(true).catch(e => alert('Could not build the invoice: ' + e.message)));
}
