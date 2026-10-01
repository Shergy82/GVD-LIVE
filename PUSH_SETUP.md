# Push notification setup

1. `firebase login`
2. `firebase use gvd-live`
3. `firebase functions:secrets:set VAPID_PRIVATE_KEY` (paste the private key when asked)
4. `cd functions && npm install && cd ..`
5. `firebase deploy --only functions,hosting` (functions need the Blaze plan)
6. On each phone: open the app, tap the bell / "Enable Push", allow notifications.
   iPhone: must be installed via Safari > Share > Add to Home Screen first.

Check delivery with `firebase functions:log` (look for "Push sent to device ... HTTP 201").
If you run `push_worker.js` or `server.js` instead, set the env var `VAPID_PRIVATE_KEY`.
