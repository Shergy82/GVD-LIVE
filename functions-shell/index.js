/* Left behind in the old gvd-live project after GVD Live moved into the Hub project.
   Hosting can only send /files/** to a function in its own project, so this one function sends the request on to the real siteFile. */
const { onRequest } = require('firebase-functions/v2/https');
const TARGET = 'https://us-central1-gvd-hub.cloudfunctions.net/siteFile';

exports.siteFile = onRequest({ region: 'us-central1' }, (req, res) => {
  const id = (req.path || '').split('/').filter(Boolean).pop() || '';
  if (!id) return res.status(400).send('Missing file id');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, TARGET + '/' + encodeURIComponent(decodeURIComponent(id)) + qs);
});
