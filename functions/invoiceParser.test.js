// Run: node --test functions/invoiceParser.test.js
const test = require('node:test'), assert = require('node:assert');
const { findInvoiceDate } = require('./invoiceParser');
const cases = [
  ['City Plumbing', 'INVOICE 3120 ARE487 INVOICE/TAX DATE : 10/11/26 DELIVERY NOTE : E80110 DELIVERY DATE : 10/11/26 ORDER NO. : PO', '2026-11-10'],
  ['AKW', 'Bentley Heath Solihull B93 9BN Date : 10/11/2026 Invoice No. : 2683382', '2026-11-10'],
  ['Howdens', 'ACCOUNT INVOICE Taxpoint Date: 08/10/2026 13:17 Account: 123 PAYMENT DUE: 30/11/2026', '2026-10-08'],
  ['SaaS style', 'Amount due £1,882.21 Due date 23 Oct 2026 Issue date 23 Oct 2026', '2026-10-23'],
  ['Invoice date', 'Invoice Date: 05.11.2026 Due 05.12.2026', '2026-11-05'],
  ['Long month', 'Date of invoice 5th November 2026', '2026-11-05'],
  ['Only a due date', 'Payment due 30/11/2026 Due date: 30/11/2026 Delivery date: 01/11/2026', null],
  ['Nothing', 'Thank you for your business', null],
  ['Impossible', 'Invoice date 45/13/2026', null]
];
for (const [name, text, want] of cases) test(name, () => assert.strictEqual(findInvoiceDate(text), want));
