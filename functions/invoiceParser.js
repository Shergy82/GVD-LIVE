// Invoice text parser - server copy of the logic in public/app.js (parseInvoiceText / matchSiteByAddress)
const r2 = n => Math.round(n * 100) / 100;


// Find the PO number even when the merchant's system has dropped the dashes or spaces (PO99800009 -> PO-99800-009),
// and recognise any PO we already hold wherever it appears, ignoring punctuation.
function findPoNumber(text, knownPos) {
  const squash = t => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const hay = squash(text);
  const known = (knownPos || []).map(p => String(p.po_number || p).toUpperCase()).filter(p => /^PO-\d+-\d+$/.test(p));
  const hit = known.find(p => hay.includes(squash(p)));
  if (hit) return hit;
  const m = String(text).match(/\bPO[\s\-–_.]*(\d{4,6})[\s\-–_.]*(\d{3,4})\b/i);
  return m ? `PO-${m[1]}-${m[2]}` : null;
}

// Invoice date: suppliers label it many ways (Invoice/Tax Date, Taxpoint Date, Issue date, or just "Date :") and write it as 10/11/26, 10/11/2026 or 10 Nov 2026.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE_RX = '(\\d{1,2})[\\/.\\-](\\d{1,2})[\\/.\\-](\\d{4}|\\d{2})|(\\d{1,2})(?:st|nd|rd|th)?\\s+([A-Za-z]{3,9})\\.?,?\\s+(\\d{4})';
function isoFromMatch(m, o) {   // o = index of the first group of the date inside the match
  let d, mo, y;
  if (m[o] !== undefined) { d = +m[o]; mo = +m[o + 1]; y = +m[o + 2]; if (String(m[o + 2]).length === 2) y += 2000; }
  else { d = +m[o + 3]; mo = MONTHS[String(m[o + 4]).slice(0, 3).toLowerCase()]; y = +m[o + 5]; }
  if (!mo || mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2015 || y > 2040) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function findInvoiceDate(text) {
  const t = String(text || '');
  const labelled = [
    'invoice\\s*\\/?\\s*tax\\s*(?:point\\s*)?date', 'invoice\\s*date', 'date\\s*of\\s*invoice', 'tax\\s*point\\s*date', 'taxpoint\\s*date', 'tax\\s*point', 'taxpoint',
    'issue\\s*date', 'date\\s*of\\s*issue', 'date\\s*issued', 'tax\\s*date'
  ];
  for (const lab of labelled) {
    const m = new RegExp(lab + '[^0-9A-Za-z\\n]{0,15}(?:' + DATE_RX + ')', 'i').exec(t);
    const iso = m && isoFromMatch(m, 1);
    if (iso) return iso;
  }
  // a bare "Date :" (but never delivery / due / order / payment dates)
  const bare = new RegExp('(?<!delivery |due |order |payment |despatch |dispatch |expiry |print |tax )\\bdate\\s*[:\\-]\\s*(?:' + DATE_RX + ')', 'i').exec(t);
  return bare ? isoFromMatch(bare, 1) : null;
}

// Invoice number. PDF text sometimes splits a number ("SW -51756"), and some suppliers (City Plumbing) print it straight after the word INVOICE with no label.
function findInvoiceNumber(text) {
  const t = String(text || '').replace(/\b([A-Z]{1,6})\s+-\s*(\d{3,})/g, '$1-$2');
  const labelled = ((t.match(/invoice\s*(?:no|number|#)\.?\s*:?\s*(?:[A-Za-z]{2,10}\s+){0,2}?((?=[A-Z0-9\/\-]*\d)[A-Z0-9][A-Z0-9\/\-]{2,})/i)) || [])[1];
  if (labelled) return labelled;
  // labels on one line, values on the next (SWIP): "Invoice number Reference" then "£1,882.21 23 Oct 2026 23 Oct 2026 SW-51756 B 78 2 AX"
  const ls = t.split('\n');
  for (let i = 0; i < ls.length - 1; i++) {
    if (/invoice\s*(?:no|number|#)/i.test(ls[i])) { const m = ls[i + 1].match(/\b([A-Z]{1,6}-\d{3,})\b/); if (m) return m[1]; }
  }
  const bare = (t.match(/(?:^|\n)\s*INVOICE\s+(\d{3,5})\s?([A-Z]{2,4}\d{2,5})\b/) || t.match(/\bINVOICE\s+(\d{3,5})\s?([A-Z]{2,4}\d{2,5})\s+INVOICE\s*\/\s*TAX/i));
  return bare ? bare[1] + bare[2] : null;
}

function parseInvoiceText(lines, knownPos) {
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

  let net = findAmount([/total goods/i, /total\s*(ex|excl)/i, /sub\s*-?\s*total/i, /net\s*(total|amount|value)/i, /goods\s*(value|total)?\s*:/i, /nett?\s*goods/i, /goods\s*total/i]);
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
  const po = findPoNumber(text, knownPos);
  // standalone invoice number: the line after a heading that ends in the word INVOICE (e.g. Travis Perkins)
  const standaloneNo = ((text.match(/\bINVOICE\s*\n\s*(\d{6,12})\s*(?:\n|$)/)) || [])[1] || null;
  const invNo = findInvoiceNumber(text);
  const dateMatch = text.match(/invoice\s*(?:\/\s*tax\s*)?date[^0-9\n]*(\d{2})\/(\d{2})\/(\d{4})/i);
  const altDate = text.match(/date\s*\/?\s*(?:tax\s*point)?\s*:?\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/i);
  const MON = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const altIso = altDate && MON[altDate[2].toLowerCase()] ? `${altDate[3]}-${String(MON[altDate[2].toLowerCase()]).padStart(2, '0')}-${altDate[1].padStart(2, '0')}` : null;
  const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : (altIso || findInvoiceDate(text));
  // supplier name: the company named beside its VAT number, else the bank 'Account Name' with the bank details cut off
  let merchant = ((text.match(/^\s*([A-Z][A-Za-z&' .-]+?(?:Ltd|Limited|LLP|PLC))\s+VAT\s*Reg/im)) || [])[1] || null;
  if (!merchant) merchant = ((text.match(/Account Name:\s*(.+?)\s*\.?\s*$/im)) || [])[1] || null;
  if (merchant) merchant = merchant.replace(/\s+(Sort\s*Code|Account\b|Bank\b|Invoice\b|Tax\s*Date|VAT\b|Registered)\b.*$/i, '').trim() || null;
  if (!merchant) merchant = ((text.match(/([A-Z][A-Za-z&' ]+(?:Limited|Ltd|LLP|PLC))\.?\s*Registered/)) || [])[1] || null;

  // Delivery block text used for matching the job by address
  const deliverIdx = lines.findIndex(l => /deliver(y)?\s*to/i.test(l));
  const deliverText = deliverIdx >= 0 ? lines.slice(deliverIdx, deliverIdx + 8).join(' ') : text;

  return { net, vat, gross, netEstimated, totalsAgree, po: po ? po.toUpperCase() : null, invNo: invNo || standaloneNo, date, merchant, deliverText, hasText: text.length > 40 };
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


module.exports = { parseInvoiceText, matchSiteByAddress, findInvoiceDate, findInvoiceNumber };
