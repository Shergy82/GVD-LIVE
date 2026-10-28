// Local emulator helper: node set-status.js <userId> <status>
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
initializeApp({ projectId: 'demo-gvd' });
getFirestore().doc('users/' + process.argv[2]).update({ status: process.argv[3] }).then(() => console.log('ok'));
