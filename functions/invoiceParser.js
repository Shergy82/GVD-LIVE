// Invoice text parser - server copy of the logic in public/app.js (parseInvoiceText / matchSiteByAddress)
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


module.exports = { parseInvoiceText, matchSiteByAddress };
