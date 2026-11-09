// Reads scanned (picture-only) invoice PDFs with Google Cloud Vision, so they import like any other invoice.
// Only used when a PDF has no text of its own. Cost is about 1p a page; the first 5 pages of a PDF are read.
const MAX_PAGES = 5;

async function ocrLines(buffer) {
  const { GoogleAuth } = require('google-auth-library');
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-vision'] }).getClient();
  const res = await client.request({
    url: 'https://vision.googleapis.com/v1/files:annotate', method: 'POST',
    data: { requests: [{
      inputConfig: { mimeType: 'application/pdf', content: Buffer.from(buffer).toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      pages: Array.from({ length: MAX_PAGES }, (_, i) => i + 1)
    }] }
  });
  const err = res.data.responses && res.data.responses[0] && res.data.responses[0].error;
  if (err) throw new Error('Vision: ' + (err.message || 'failed'));
  const pages = (res.data.responses && res.data.responses[0] && res.data.responses[0].responses) || [];
  const lines = [];
  pages.forEach(p => String((p.fullTextAnnotation && p.fullTextAnnotation.text) || '').split('\n').forEach(l => { l = l.replace(/\s+/g, ' ').trim(); if (l) lines.push(l); }));
  return lines;
}

module.exports = { ocrLines };
