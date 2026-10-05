// Reads the invoices Gmail inbox every few minutes and imports PDF invoices automatically.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const crypto = require('crypto');
const { parseInvoiceText, matchSiteByAddress } = require('./invoiceParser');
// imapflow / mailparser / pdfjs are loaded only when the function runs, so deploying stays quick

const GMAIL_USER = defineSecret('GMAIL_USER');
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');
const BUCKETS = ['gvd-live.firebasestorage.app', 'gvd-live.appspot.com'];
const MAX_PER_RUN = 15;

async function extractLines(buffer) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, isEvalSupported: false }).promise;
  const lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = content.items.filter(it => it.str && it.str.trim()).map(it => ({ x: it.transform[4], y: it.transform[5], str: it.str }))
      .sort((p, q) => q.y - p.y || p.x - q.x);
    const rows = [];
    items.forEach(it => {
      const row = rows.find(r => Math.abs(r.y - it.y) <= 3);
      if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
    });
    rows.sort((p, q) => q.y - p.y).forEach(r => {
      const text = r.items.sort((p, q) => p.x - q.x).map(x => x.str).join(' ').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    });
  }
  return lines;
}

async function saveToStorage(path, buffer) {
  let lastErr = null;
  for (const name of BUCKETS) {
    try {
      const file = getStorage().bucket(name).file(path);
      await file.save(buffer, { contentType: 'application/pdf', resumable: false });
      return `gs://${name}`;
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

function senderAllowed(from, allowed) {
  if (!allowed || !allowed.length) return true;
  const addr = String(from || '').toLowerCase();
  return allowed.some(a => { a = String(a).trim().toLowerCase(); return a && (a.startsWith('@') ? addr.endsWith(a) : addr === a); });
}

async function recalcPo(db, poNumber, extraRecord) {
  const snap = await db.collection('pdfs').where('po_number', '==', poNumber).get();
  const files = snap.docs.map(d => d.data()).filter(f => f.file_type === 'invoice' && f.id !== extraRecord.id).concat([extraRecord]);
  const sum = k => Math.round(files.reduce((t, f) => t + (parseFloat(f[k]) || 0), 0) * 100) / 100;
  return {
    status: 'Invoiced', invoice_value: sum('invoice_net'), invoice_vat: sum('invoice_vat'), invoice_gross: sum('invoice_gross'),
    invoice_no: files.map(f => f.invoice_no).filter(Boolean).join(', ') || null, invoice_file_id: extraRecord.id, invoiced_at: new Date().toISOString()
  };
}

async function importOne({ db, att, mail, ctx }) {
  const hash = crypto.createHash('sha1').update(`${mail.messageId || mail.subject}|${att.filename}|${att.size}`).digest('hex').slice(0, 20);
  const fileId = `pdf_mail_${hash}`;
  if ((await db.collection('pdfs').doc(fileId).get()).exists) return 'already imported';

  let parsed;
  try { parsed = parseInvoiceText(await extractLines(att.content)); }
  catch (err) { console.warn('PDF read failed', att.filename, err.message); parsed = { net: null, vat: null, gross: null, po: null, invNo: null, merchant: null, date: null, deliverText: '', hasText: false }; }

  const matchedPo = parsed.po ? ctx.pos.find(p => String(p.po_number).toUpperCase() === parsed.po) : null;
  let site = matchedPo ? ctx.sites.find(s => String(s.id) === String(matchedPo.site_id)) : null;
  if (!site) site = matchSiteByAddress(parsed.deliverText, ctx.sites.filter(s => !s.is_archived));

  const no = String(parsed.invNo || '').trim().toLowerCase();
  // Same invoice number, or same net + total (and same date when both have one) - held for review, never silently dropped
  const sameAmounts = f => parsed.net != null && parsed.gross != null && !f.dup_dismissed
    && Math.abs((parseFloat(f.invoice_net) || 0) - parsed.net) < 0.005 && Math.abs((parseFloat(f.invoice_gross) || 0) - parsed.gross) < 0.005
    && (!parsed.date || !f.invoice_date || f.invoice_date === parsed.date);
  const dupOf = ctx.invoices.find(f => (no && String(f.invoice_no || '').trim().toLowerCase() === no) || sameAmounts(f));
  const duplicate = !!dupOf;
  const priceOk = parsed.net != null && parsed.hasText;
  // Only a clear, checked, non-duplicate invoice goes straight onto a job; everything else waits (amber/red) in the register
  const confident = !!site && priceOk && parsed.totalsAgree && !parsed.netEstimated && !duplicate;

  const safeName = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `site_files/${confident ? site.id : 'unassigned'}/${fileId}_${safeName}`;
  const bucket = await saveToStorage(path, att.content);
  const poNumber = confident && matchedPo && String(matchedPo.site_id) === String(site.id) ? matchedPo.po_number : `INV-${String(parsed.invNo || fileId).replace(/[^A-Za-z0-9]/g, '')}`;
  const record = {
    id: fileId, site_id: confident ? String(site.id) : '', uploader_id: 'email', uploader_name: 'Email inbox',
    filename: att.filename, file_type: 'invoice', storage_bucket: bucket, storage_path: path,
    po_number: poNumber, invoice_no: parsed.invNo || '', merchant: parsed.merchant || (matchedPo ? matchedPo.merchant : '') || '', invoice_date: parsed.date || '',
    invoice_net: parsed.net != null ? parsed.net : null, invoice_vat: parsed.vat != null ? parsed.vat : null, invoice_gross: parsed.gross != null ? parsed.gross : null,
    source: 'email', email_from: mail.from, email_subject: mail.subject,
    needs_review: !confident, duplicate_of: dupOf ? dupOf.id : null, review_reason: duplicate ? 'possible duplicate' : !site ? 'no job found' : !priceOk ? 'price not found' : 'check the amounts',
    created_at: new Date().toISOString()
  };
  await db.collection('pdfs').doc(fileId).set(record);
  ctx.invoices.push(record);

  if (confident) {
    const fields = await recalcPo(db, poNumber, record);
    if (matchedPo && poNumber === matchedPo.po_number) {
      await db.collection('purchase_orders').doc(poNumber).update(fields);
    } else {
      await db.collection('purchase_orders').doc(poNumber).set({
        po_number: poNumber, seq: null, site_id: String(site.id), site_address: site.address,
        requested_by_id: 'email', requested_by_name: 'Email inbox',
        merchant: record.merchant || 'Unknown merchant', description: `Invoice ${parsed.invNo || ''} (no PO)`.trim(), est_value: null,
        created_at: new Date().toISOString(), ...fields
      });
    }
    return `imported to ${site.address}`;
  }
  return `imported, needs review (${record.review_reason})`;
}

exports.importInvoiceEmails = onSchedule({
  schedule: 'every 5 minutes', timeZone: 'Europe/London', memory: '1GiB', timeoutSeconds: 300,
  secrets: [GMAIL_USER, GMAIL_APP_PASSWORD]
}, async () => {
  const db = getFirestore();
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true, logger: false,
    auth: { user: GMAIL_USER.value().trim(), pass: GMAIL_APP_PASSWORD.value().replace(/\s+/g, '') }
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    if (!uids.length) return;
    const cfg = (await db.collection('settings').doc('invoice_email').get()).data() || {};
    const ctx = {
      sites: (await db.collection('sites').get()).docs.map(d => ({ ...d.data(), id: d.data().id != null ? d.data().id : d.id })),
      pos: (await db.collection('purchase_orders').get()).docs.map(d => d.data()),
      invoices: (await db.collection('pdfs').where('file_type', '==', 'invoice').get()).docs.map(d => d.data())
    };
    for (const uid of uids.slice(0, MAX_PER_RUN)) {
      try {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        const parsed = await simpleParser(msg.source);
        const mail = { messageId: parsed.messageId, subject: parsed.subject || '', from: (parsed.from && parsed.from.value[0] && parsed.from.value[0].address) || '' };
        if (!senderAllowed(mail.from, cfg.allowed_senders)) {
          console.log(`Ignored email from ${mail.from} (not on the allowed list)`);
        } else {
          const pdfs = (parsed.attachments || []).filter(a => /\.pdf$/i.test(a.filename || '') || a.contentType === 'application/pdf');
          for (const a of pdfs) {
            const att = { filename: a.filename || 'invoice.pdf', content: a.content, size: a.size };
            console.log(`${att.filename} from ${mail.from}: ${await importOne({ db, att, mail, ctx })}`);
          }
          if (!pdfs.length) console.log(`Email "${mail.subject}" from ${mail.from} had no PDF attached`);
        }
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      } catch (err) {
        console.error(`Email ${uid} failed:`, err.message); // left unread so it is retried next time
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
});
