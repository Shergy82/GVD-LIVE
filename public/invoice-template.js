// -------------------------------------------------------------------
// OPERATIVE INVOICE TEMPLATE (Admin Settings). Owners/Admins download it and share it with operatives;
// operatives never see it in the app. It is a fillable PDF laid out so the Invoices importer can read it back:
// fixed labels ("Invoice no:", "Week ending:", "Net total", "Total VAT", "Invoice total"), one line per job
// (job address + days + rate + amount), and the typed-in values are read from the form fields.
// -------------------------------------------------------------------
async function buildOperativeInvoicePdf(opts) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const co = ciCompany();
  const PW = 595, M = 40, R = PW - M;
  const navy = [15, 23, 42], grey = [100, 116, 139], line = [203, 213, 225];
  const fmtD = iso => { const p = String(iso || '').split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : ''; };

  // every fillable box sits 11pt above its label's baseline and is 15pt tall, so the importer reads label + value as one line
  const flat = !!opts.flat, vals = opts.values || {};
  const field = (name, x, baseline, w, value, align) => {
    if (flat) {   // finished copy: plain text instead of a fillable box
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...navy);
      const v = String(value == null ? '' : value);
      if (align === 'right') doc.text(v, x + w - 2, baseline, { align: 'right' });
      else if (align === 'center') doc.text(v, x + w / 2, baseline, { align: 'center' });
      else doc.text(doc.splitTextToSize(v, w - 4)[0] || '', x + 2, baseline);
      doc.setDrawColor(...line); doc.setLineWidth(0.6); doc.line(x, baseline + 5, x + w, baseline + 5);
      return;
    }
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
  label('Invoice no:', 330, y + 6); field('invoice_no', 400, y + 6, R - 400, vals.invoice_no || '');
  label('Invoice date:', 330, y + 32); field('invoice_date', 400, y + 32, R - 400, vals.invoice_date || fmtD(diaryDateKey(new Date())));
  label('Week ending:', 330, y + 58); field('week_ending', 400, y + 58, R - 400, fmtD(opts.weekEnding));
  doc.setFontSize(7.5); doc.setTextColor(...grey); doc.text('dd/mm/yyyy - the Sunday of the week worked', 400, y + 76);

  // from
  y = 212;
  label('Operative:', M, y); field('operative_name', M + 60, y, 220, opts.operative || '');
  label('Trading name:', 310, y); field('trading_name', 380, y, R - 380, vals.trading_name || '');
  y += 24;
  label('UTR (if CIS):', M, y); field('utr', M + 60, y, 220, vals.utr || '');
  label('VAT no. (if registered):', 310, y); field('vat_no', 410, y, R - 410, vals.vat_no || '');

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
    if (flat && !l) { y += 0; continue; }
    field(`job_${i + 1}`, M, y, 262, l ? l.address : '');
    field(`days_${i + 1}`, 312, y, 36, l ? String(l.days) : '', 'center');
    field(`rate_${i + 1}`, 365, y, 60, l && l.rate != null ? Number(l.rate).toFixed(2) : '', 'right');
    field(`amount_${i + 1}`, 445, y, R - 445, l && l.amount != null ? Number(l.amount).toFixed(2) : '', 'right');
    y += 24;
  }
  if ((opts.lines || []).length > ROWS) { doc.setFontSize(7.5); doc.setTextColor(185, 28, 28); doc.text(`${opts.lines.length - ROWS} more job(s) were booked this week - add them on a second invoice.`, M, y - 4); }

  // totals
  y += 12;
  label('Net total (ex VAT)', 330, y, true); field('net_total', 445, y, R - 445, vals.net_total || '', 'right'); y += 22;
  label('Total VAT', 330, y); field('total_vat', 445, y, R - 445, vals.total_vat || '', 'right'); y += 22;
  label('Invoice total', 330, y, true); field('invoice_total', 445, y, R - 445, vals.invoice_total || '', 'right');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...grey);
  if (!flat) doc.text(doc.splitTextToSize('Type amounts like 450.00. Leave VAT blank if you are not VAT registered.', R - 330), 330, y + 18);

  // payment details
  const py = y - 44;
  label('PAY TO', M, py - 8, true);
  label('Account Name:', M, py + 14); field('account_name', M + 70, py + 14, 200, vals.account_name || '');
  label('Sort code:', M, py + 38); field('sort_code', M + 70, py + 38, 90, vals.sort_code || '');
  label('Account no:', M, py + 62); field('account_no', M + 70, py + 62, 120, vals.account_no || '');

  // notes
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...grey);
  const notes = [
    `Send this invoice to ${co.email || 'the office'} by Monday for the week just worked.`,
    'Include every job you worked, one line per job, with the number of days and the amount for that job (excluding VAT).',
    'Please fill in on screen (PDF reader) or print and write clearly. Photos of handwritten invoices cannot be read automatically.'
  ];
  let ny = 792; if (!flat) notes.forEach(n => { const ls = doc.splitTextToSize(n, R - M); doc.text(ls, M, ny); ny += ls.length * 10 + 1; });
  return doc;
}
