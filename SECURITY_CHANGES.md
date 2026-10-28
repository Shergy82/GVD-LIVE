# GVD Live security change: what changed and how to roll back

## Status: DEPLOYED 2026-10-28
Anonymous read/write is closed on Firestore and Storage. Done in this order: Firestore backup (gs://gvd-live-backup-2026-10-28/pre-security, delete once happy: it holds the old hashes), IAM + Authentication, functions, credentials copy, hosting, Hub `liveData` function + Logic, `--purge`, rules. Verified: anonymous reads/writes refused (403) on all collections and Storage listing; customer QR link, planner, Finance and operative views work when logged in; Logic shows live job values through the Hub function.

## Rollback quick reference
- **Rules (about a minute):** `cp rules-backup/firestore.rules.open firestore.rules && cp rules-backup/storage.rules.open storage.rules && firebase deploy --only firestore:rules,storage --project gvd-live`
- **Hosting:** the old client can no longer log anyone in (hashes purged). To go back further than the rules, restore the Firestore export (`gcloud firestore import gs://gvd-live-backup-2026-10-28/pre-security --project gvd-live`, which overwrites data written since) and the previous hosting release 7cd04d1c504ba5ae.
- **Hub (gvd-hub, branch security/live-data-function):** roll gvd-logic hosting back in the console; the Hub function and IAM grant (`roles/datastore.viewer` for 13789283321-compute@developer.gserviceaccount.com on gvd-live) can stay or be removed with `gcloud projects remove-iam-policy-binding`.

## GVD Logic (UPDATED: no change needed in Logic's login)
Logic users sign in on the gvd-hub project, so Logic now gets GVD Live costs and sites from the Hub's `liveData` function (staff list only), which reads gvd-live server-side. The snippet below (Logic signing in through the GVD Live login) is superseded and not used.


## What changed in the repo
- `functions/api.js`, `functions/credentials.js`: login, refreshSession, setPassword, adminSetTempPassword, register, requestPasswordReset, customerView, customerFeedback, getFinanceSummary. Passwords are scrypt-hashed in `credentials/{id}` (no client access). Old 32-bit hashes are accepted once, upgraded, and the user must then choose a new password.
- `public/app.js`, `public/index.html`: sign-in through `login` + `signInWithCustomToken`; data listeners start only after sign-in; the customer QR page and feedback use `customerView` / `customerFeedback` (no database access); registration, forgot-password and temp passwords use functions; `hashSimple` and every use of `password_hash` removed; web `apiKey`/`appId` added to the config (public identifiers).
- `rules-new/*.rules`: new rules. The live `firestore.rules` / `storage.rules` are untouched until the last step. `rules-backup/*.open` = the current open rules.
- `scripts/migrate-credentials.js`, `rules-test/*`, `firebase.emu.json`: migration and emulator tests.

## Deploy order that was followed
0. Firestore export (backup) of project gvd-live.
1. One-time: enable Authentication (Firebase console > Authentication > Get started) and make sure the Identity Toolkit API is enabled; grant the functions' runtime service account `roles/iam.serviceAccountTokenCreator` on itself (exact command shown before running).
2. `firebase deploy --only functions` (additive; old app unaffected).
3. `node scripts/migrate-credentials.js` (dry run) then `--copy` (copies hashes to `credentials`; users untouched).
4. `firebase deploy --only hosting` (new client). Everyone logs in once and picks a new password. Open rules are still live, so a problem here is fixed by redeploying the old hosting.
5. Soak: wait until every Active user has `last_login_at` after the deploy; hand temp passwords to the rest.
6. `node scripts/migrate-credentials.js --purge` (removes `password_hash` / `temp_password` from `users`).
7. GVD Logic switched to signed-in reads (below), confirmed working.
8. Copy `rules-new/firestore.rules` and `storage.rules` over the live ones, `firebase deploy --only firestore:rules,storage`.

## Rollback
- Rules: copy `rules-backup/firestore.rules.open` and `storage.rules.open` back over `firestore.rules` / `storage.rules` and `firebase deploy --only firestore:rules,storage` (takes effect in about a minute).
- Client: redeploy the previous hosting release (Firebase console > Hosting > rollback). NOTE after step 6 the old client can no longer log anyone in (hashes removed from `users`); roll back before step 6 or restore from the export.
- Functions are additive and can stay deployed.

## GVD Logic (separate repo): signed-in read of finance_summary
Logic users sign in with the same function, then read with the resulting token (needs firebase-app-compat, auth-compat, functions-compat and firestore-compat, same project config as GVD Live):
```js
const login = firebase.app().functions('us-central1').httpsCallable('login');
const { data } = await login({ email, password });          // management users only can read finance data
await firebase.auth().signInWithCustomToken(data.token);
const snap = await firebase.firestore().collection('finance_summary').get();   // allowed for management claims
// or: const { data: { jobs } } = await firebase.app().functions('us-central1').httpsCallable('getFinanceSummary')();
```
If Logic has no user login screen, it needs one (or a dedicated management "service" user whose credentials are stored in Logic's server side, not in browser code).

## Local testing
`cd rules-test && npm test` (rules) and `npm run test:functions` (functions). Both need Java (`brew install openjdk@21`, then put it on PATH). For the browser: `firebase emulators:start --config firebase.emu.json --project demo-gvd --only auth,firestore,functions,hosting`, `node rules-test/seed-emulator.js`, open `http://localhost:5055/?emulator=1` (that flag only works on localhost and uses the `demo-gvd` project).
