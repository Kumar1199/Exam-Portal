MongoDB setup
=============

Use Node 22.14 or newer. Copy `.env.example` to `.env.local` and supply server secrets. Do not prefix database credentials with `VITE_`. Run `npm run dev` for the local web application and API. Production Vercel settings need the same environment variables.

Fresh accounts are created with `node --env-file=.env.local scripts/createFreshAccounts.mjs`. This refuses to overwrite existing account emails or the demo student. Generated credentials are saved in the git-ignored `fresh-credentials.local`. The fresh setup contains demo data only, not the old Firebase records.

For another student, create their record through Students (manual or CSV) with a valid email. A pending login and activation invitation are now created automatically. Follow `ACTIVATION-SETUP.md` to configure Brevo delivery so students can set their own passwords. Existing active accounts keep their credentials. The older `provision:student` CLI is only for accounts that do not already exist; it does not overwrite pending accounts.

Run `npm run verify:mongo` to check login, access control, college CRUD, student batches/deletion, and exam PIN/submission. It uses a randomly named verification database and removes it afterward.

Electron uses `STUDENT360_API_BASE_URL` for the shared API. For local use, set it to `http://127.0.0.1:5173/api/proxy` before launching Electron. Its default production URL requires the new backend to be deployed. MongoDB credentials must never be placed in Electron configuration.

Microsoft login remains unavailable until a Microsoft identity application is configured. Existing Firebase data is not needed for this fresh setup.

Optional future import: set `FIREBASE_SERVICE_ACCOUNT_PATH` to a local Firebase Admin JSON key and run `npm run migrate:firebase` for a preview. Run `npm run migrate:firebase -- --apply` to add absent records. Existing MongoDB records remain intact. Firebase Auth passwords are not imported. Imported profiles require separately provisioned passwords; duplicate email identities must be resolved before provisioning.
