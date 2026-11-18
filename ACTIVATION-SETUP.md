Student activation email setup
==============================

Adding a student manually or through CSV creates a pending student login and queues an activation email. Email is required in the admin form and CSV. Existing active accounts keep their passwords. A different student cannot claim an email already used by another account.

Activation links last 24 hours, work once, and let the student choose a password between 12 and 128 characters. Login uses the student's email. The envelope button in Students resends an activation invitation; it does not reset an active account's password. Password recovery is a separate feature.

To enable real email:

1. Create a free Brevo account and complete its sending approval and sender verification.
2. Create a transactional API key in Brevo. Save it in the web project's ignored `.env.local` file as `BREVO_API_KEY`. Do not put it in frontend source or a `VITE_` variable.
3. Set `BREVO_SENDER_EMAIL` to the verified sender and optionally `BREVO_SENDER_NAME=Student 360`.
4. Set `APP_BASE_URL` to the public HTTPS address students can open, for example `https://your-portal.example`. Local testing can use `http://127.0.0.1:5173`, but remote students cannot open that address.
5. Set a random `CRON_SECRET` for scheduled queue processing. Copy these server variables, plus the existing MongoDB and JWT settings, into the deployment environment.
6. Restart the local web server or redeploy. Add a test student whose email you control, then check the inbox and spam folder. A provider acceptance confirms submission to Brevo, not final inbox delivery.

Without these settings, student records and pending logins still save. Emails remain queued, and the Students page displays an email setup notice. No fake activation links are presented as delivered.

Queue processing
----------------

Student creation immediately attempts up to 25 pending emails. While the local dev server is running, it processes another batch each minute. The admin's Send pending activations button processes up to 25 per click. The included Vercel cron calls `/api/auth/process-activations` daily at 04:00 UTC and processes up to 100; it requires `CRON_SECRET`. Large production backlogs need additional admin processing or a more frequent authenticated scheduler supported by the hosting plan.

`ACTIVATION_DAILY_LIMIT` defaults to 250 and is capped at 300. It counts attempted activation deliveries per UTC day, reserving quota atomically even across simultaneous workers. Failed attempts count too. Other email systems or applications using the same Brevo account consume its allowance separately; reduce this limit to leave room. The provider's own quota/approval also applies. Pending jobs are retained once the cap is reached. Provider failures retry after a delay; abandoned worker jobs can be reclaimed after two minutes.

Resend is limited to once per minute after a successful send, and a replacement email invalidates the previous activation link. Only administrators or the authenticated scheduled worker can process the queue. Anyone with a valid single-use link can activate its corresponding student account. No plaintext password or activation token is stored in MongoDB.

Checks
------

Run `npm run verify:activation` with the local environment configured. It uses an isolated disposable MongoDB database and a mocked Brevo endpoint, so it sends no real emails. It covers manual/CSV account creation, activation, login, expired/reused links, admin-only resends, identity conflicts, deleted students, quota concurrency and email delivery failures.

Brevo API reference: https://developers.brevo.com/reference/send-transac-email
