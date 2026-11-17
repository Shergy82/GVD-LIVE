// Who may open a stored file through the siteFile function (/files/<id>).
// Invoices are management business: the caller must send their sign-in token (?t=<token>, or an Authorization: Bearer header)
// and it must belong to an active management user. Every other file opens as before.
const { getAuth } = require('firebase-admin/auth');

const isInvoiceDoc = d => !!d && d.file_type === 'invoice';

// The sign-in token the caller sent. The query form exists because the request goes through a redirect (the old gvd-live address
// sends /files/** on to this function) and a browser drops the Authorization header when it follows a redirect to another site.
function tokenFromRequest(req) {
  const header = String((req.get ? req.get('authorization') : req.headers && req.headers.authorization) || '');
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  return String((req.query && req.query.t) || '').trim();
}

// True only for a valid, unexpired sign-in token whose claims say active management (the same claims the database rules use).
async function callerIsManagement(req, verify = token => getAuth().verifyIdToken(token)) {
  const token = tokenFromRequest(req);
  if (!token) return false;
  try {
    const claims = await verify(token);
    return claims.mgmt === true && claims.active === true;
  } catch (e) {
    return false;
  }
}

module.exports = { isInvoiceDoc, tokenFromRequest, callerIsManagement };
