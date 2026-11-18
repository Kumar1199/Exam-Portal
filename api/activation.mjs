import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';

const emailValid = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
const indexes = new Map();
const studentIdentity = id => ({ _id: { $in: ObjectId.isValid(id) ? [id, new ObjectId(id)] : [id] } });
export function emailConfigured() {
  try {
    const url = new URL(process.env.APP_BASE_URL);
    return !!process.env.BREVO_API_KEY && emailValid(process.env.BREVO_SENDER_EMAIL || '') && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname));
  } catch { return false; }
}

export async function queueActivation(db, student) {
  const email = String(student.email || '').trim().toLowerCase();
  if (!emailValid(email)) return { status: 'missing_email' };
  const id = String(student._id);
  if (!indexes.has(db.databaseName)) indexes.set(db.databaseName, db.collection('users').createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } }).catch(error => { indexes.delete(db.databaseName); throw error; }));
  await indexes.get(db.databaseName);
  let user = await db.collection('users').findOne({ email });
  if (user && (user.role !== 'student' || user.studentId && user.studentId !== id || !user.studentId && user.rollNo !== student.rollNo)) return { status: 'email_conflict' };
  if (user?.passwordHash) return { status: 'active' };
  if (!user) {
    try {
      const profile = { email, name: student.name || student.rollNo, role: 'student', rollNo: student.rollNo, studentId: id, createdAt: new Date() };
      const result = await db.collection('users').insertOne(profile); user = { ...profile, _id: result.insertedId };
    } catch (error) { if (error.code === 11000) return { status: 'email_conflict' }; throw error; }
  }
  const jobId = `activation:${id}`;
  const job = await db.collection('activationQueue').findOne({ _id: jobId });
  if (job?.status === 'sending' && job.leaseUntil > new Date()) return { status: 'sending' };
  if (job?.sentAt && Date.now() - new Date(job.sentAt).getTime() < 60000) return { status: 'recently_sent' };
  await db.collection('activationQueue').updateOne({ _id: jobId }, {
    $set: { studentId: id, userId: user._id, email, status: 'queued', updatedAt: new Date() },
    $setOnInsert: { createdAt: new Date() },
  }, { upsert: true });
  return { status: 'queued' };
}

export async function sendActivations(db, limit = 25) {
  if (!emailConfigured()) return { configured: false, sent: 0, pending: await db.collection('activationQueue').countDocuments({ status: { $in: ['queued','retry','sending'] } }) };
  const cap = Math.min(300, Math.max(1, Number(process.env.ACTIVATION_DAILY_LIMIT) || 250));
  const day = new Date().toISOString().slice(0, 10);
  await db.collection('emailDailyUsage').updateOne({ _id: day }, { $setOnInsert: { count: 0 } }, { upsert: true });
  const messages = [], jobs = [];
  for (let i = 0; i < Math.min(limit, 100); i++) {
    const job = await db.collection('activationQueue').findOneAndUpdate({
      $or: [{ status: 'queued' }, { status: 'retry', retryAt: { $lte: new Date() } }, { status: 'sending', leaseUntil: { $lte: new Date() } }],
    }, { $set: { status: 'sending', leaseUntil: new Date(Date.now() + 120000) } }, { returnDocument: 'after' });
    if (!job) break;
    const student = await db.collection('students').findOne(studentIdentity(job.studentId));
    const user = await db.collection('users').findOne({ _id: job.userId });
    if (!student || !user || user.passwordHash || String(student.email || '').trim().toLowerCase() !== job.email || user.email !== job.email) {
      await db.collection('activationQueue').updateOne({ _id: job._id }, { $set: { status: user?.passwordHash ? 'active' : 'cancelled' } }); continue;
    }
    const quota = await db.collection('emailDailyUsage').findOneAndUpdate({ _id: day, count: { $lt: cap } }, { $inc: { count: 1 } }, { returnDocument: 'after' });
    if (!quota) { await db.collection('activationQueue').updateOne({ _id: job._id }, { $set: { status: 'queued' } }); break; }
    const token = crypto.randomBytes(32).toString('hex');
    await db.collection('users').updateOne({ _id: job.userId, passwordHash: { $exists: false } }, { $set: { activationHash: digest(token), activationExpiresAt: new Date(Date.now() + 86400000), studentId: job.studentId } });
    const url = new URL('/activate', process.env.APP_BASE_URL); url.hash = `token=${token}`;
    messages.push({ to: [{ email: job.email }], textContent: `Welcome to Student 360.\n\nSet your password using this link:\n${url}\n\nYour username is ${job.email}. This link expires in 24 hours and can be used once. If you did not expect this invitation, ignore this email.` });
    jobs.push(job);
  }
  let sent = 0, failed = 0;
  if (messages.length) {
    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
        body: JSON.stringify({ sender: { email: process.env.BREVO_SENDER_EMAIL, name: process.env.BREVO_SENDER_NAME || 'Student 360' }, subject: 'Activate your Student 360 account', textContent: 'Your Student 360 account activation invitation.', messageVersions: messages }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const code = /^[A-Za-z0-9_ -]{1,64}$/.test(detail.code || '') ? detail.code : 'request_failed';
        throw new Error(`Brevo returned ${response.status} (${code}). Check sender verification, API key and quota.`);
      }
      sent = jobs.length;
      await db.collection('activationQueue').updateMany({ _id: { $in: jobs.map(job => job._id) } }, { $set: { status: 'sent', sentAt: new Date() }, $unset: { lastError: '' } });
    } catch (error) {
      failed = jobs.length;
      const reason = /^Brevo returned /.test(error.message) ? error.message : 'Email delivery failed. Check Brevo configuration and quota.';
      await db.collection('activationQueue').updateMany({ _id: { $in: jobs.map(job => job._id) } }, { $set: { status: 'retry', retryAt: new Date(Date.now() + 60000), lastError: reason } });
    }
  }
  const pending = await db.collection('activationQueue').countDocuments({ status: { $in: ['queued','retry','sending'] } });
  return { configured: true, sent, failed, pending, dailyLimit: cap };
}

export async function activateAccount(db, body) {
  const token = String(body?.token || ''), password = body?.password;
  if (!/^[a-f0-9]{64}$/.test(token) || typeof password !== 'string' || password.length < 12 || password.length > 128) return { status: 400, error: 'Use a valid activation link and a password between 12 and 128 characters.' };
  const hash = digest(token);
  const pending = await db.collection('users').findOne({ activationHash: hash, activationExpiresAt: { $gt: new Date() }, passwordHash: { $exists: false } });
  if (!pending) return { status: 400, error: 'This link is invalid, expired or already used. Ask your administrator to resend it.' };
  const student = await db.collection('students').findOne(studentIdentity(pending.studentId));
  if (!student || String(student.email || '').trim().toLowerCase() !== pending.email) return { status: 400, error: 'This invitation is no longer valid. Contact your administrator.' };
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(password, passwordSalt, 64).toString('hex');
  const result = await db.collection('users').updateOne({ _id: pending._id, activationHash: hash, activationExpiresAt: { $gt: new Date() }, passwordHash: { $exists: false } }, {
    $set: { passwordHash, passwordSalt, activatedAt: new Date(), updatedAt: new Date() }, $unset: { activationHash: '', activationExpiresAt: '' },
  });
  if (!result.modifiedCount) return { status: 400, error: 'This link has already been used or expired.' };
  await db.collection('activationQueue').updateOne({ userId: pending._id }, { $set: { status: 'active' } });
  return { status: 200, success: true };
}

export async function prepareStudentActivations(db, students) {
  const statuses = {};
  for (let offset = 0; offset < students.length; offset += 10) {
    await Promise.all(students.slice(offset, offset + 10).map(async student => {
      let status;
      try { ({ status } = await queueActivation(db, student)); }
      catch { status = 'setup_failed'; }
      statuses[status] = (statuses[status] || 0) + 1;
    }));
  }
  let delivery;
  try { delivery = await sendActivations(db); }
  catch { delivery = { configured: emailConfigured(), failed: 1, error: 'Could not process activation email queue.' }; }
  return { statuses, delivery };
}
