import { MongoClient, ObjectId } from 'mongodb';
import crypto from 'crypto';
import { studentMatchesExam, validateExamAudience } from '../src/utils/examAudience.js';
import { activateAccount, prepareStudentActivations, sendActivations, emailConfigured } from './activation.mjs';
import { sanitizeEvidence } from './proctorEvidence.mjs';
import { ensureExamInvite } from './examInvites.mjs';
import { questionBankApi } from './questionBank.mjs';
import { publishBankResult } from './examResults.mjs';
import { gradeBank } from './codingRunner.mjs';
function sign(payload) {
 const secret=process.env.JWT_SECRET; if(!secret) throw new Error('JWT_SECRET is not configured on the server.');
 const head=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
 const body=Buffer.from(JSON.stringify({...payload,exp:payload.exp||Math.floor(Date.now()/1000)+43200})).toString('base64url');
 const input=head+'.'+body; const sig=crypto.createHmac('sha256',secret).update(input).digest('base64url'); return input+'.'+sig;
}
function verify(token) {
 if (!process.env.JWT_SECRET) return null;
 const [head,body,sig]=String(token).split('.'); if(!head||!body||!sig) return null;
 const input=head+'.'+body; const expected=crypto.createHmac('sha256',process.env.JWT_SECRET||'').update(input).digest('base64url');
 const a=Buffer.from(sig), b=Buffer.from(expected); if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return null;
 const payload=JSON.parse(Buffer.from(body,'base64url').toString()); return payload.exp>Date.now()/1000?payload:null;
}

let clientPromise, checkinIndexPromise, coreIndexPromise, lifecyclePromise, lifecycleLastRun = 0;
const collections = new Set(['users', 'students', 'exams', 'examInvites', 'results', 'violations', 'awardedBadges', 'notifications', 'colleges', 'generated_questions', 'exam_submissions', 'exam_sessions', 'proctor_events']);
const idValue = id => ObjectId.isValid(id) && String(new ObjectId(id)) === String(id) ? new ObjectId(id) : id;

function safePassword(password, salt, stored) { if (!salt || !stored) return false; const actual=crypto.scryptSync(password, salt, 64); const expected=Buffer.from(stored,'hex'); return actual.length===expected.length && crypto.timingSafeEqual(actual,expected); }

export async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured on the server.');
  if (!clientPromise) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    clientPromise = client.connect().catch(error => { clientPromise = null; throw error; });
  }
  const client = await clientPromise;
  const db = client.db(process.env.MONGODB_DB_NAME || 'student360');
  if (!checkinIndexPromise) checkinIndexPromise = db.collection('proctor_checkins').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => null);
  if (!coreIndexPromise) coreIndexPromise = Promise.all([
    db.collection('students').createIndex({ rollNo: 1 }, { unique: true }),
    // Older deployments already have this same unique key with a partial
    // filter. MongoDB reports code 86 when asked to recreate it without that
    // legacy option; the existing index still enforces the required invariant.
    db.collection('examInvites').createIndex({ examId: 1, rollNo: 1 }, { unique: true }).catch(error => { if (error?.code === 86) return null; throw error; }),
    db.collection('exam_submissions').createIndex({ examId: 1, studentId: 1 }, { unique: true }),
    db.collection('results').createIndex({ examId: 1, rollNo: 1 }),
    db.collection('results').createIndex({ rollNo: 1, date: -1 }),
    db.collection('violations').createIndex({ examId: 1, date: -1 }),
    // A session belongs to exactly one student and one exam.  This unique key is
    // the cross-instance duplicate-session lock; no Vercel memory is trusted.
    db.collection('exam_sessions').createIndex({ examId: 1, studentId: 1 }, { unique: true }),
    db.collection('exam_sessions').createIndex({ state: 1, lastHeartbeatAt: -1 }),
    db.collection('exam_sessions').createIndex({ examId: 1, updatedAt: -1 }),
    db.collection('proctor_events').createIndex({ eventId: 1 }, { unique: true }),
    db.collection('proctor_events').createIndex({ sessionId: 1, receivedAt: -1 }),
    db.collection('proctor_events').createIndex({ examId: 1, severity: 1, receivedAt: -1 }),
    db.collection('proctor_events').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('evidence_audit').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]).catch(error => { coreIndexPromise = null; throw error; });
  await checkinIndexPromise;
  await coreIndexPromise;
  return db;
}

export function authUser(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try { return verify(token); } catch { return null; }
}

function canRead(user, name, filters = [], id) {
  filters = filters.filter(filter => filter.op === undefined || filter.op === '==');
  if (!user) return false;
  if (user.role === 'admin') return true;
  const roll = String(user.rollNo || '').toUpperCase();
  if (user.examId) {
    if (name === 'students') return String(id || '').toUpperCase() === roll || filters.some(f => f.field === 'rollNo' && String(f.value).toUpperCase() === roll);
    if (name === 'exams' || name === 'generated_questions') return String(id || '') === String(user.examId);
    if (name === 'exam_submissions') return filters.some(f => f.field === 'studentId' && String(f.value).toUpperCase() === roll) && filters.some(f => f.field === 'examId' && String(f.value) === String(user.examId));
    return false;
  }
  if (['exams', 'colleges', 'notifications'].includes(name)) return true;
  if (name === 'students') return (roll && String(id || '').toUpperCase() === roll) || (id && id === user.studentId) || filters.some(f => f.field === 'rollNo' && String(f.value).toUpperCase() === roll);
  if (name === 'results') return filters.some(f => ['rollNo', 'studentRollNo'].includes(f.field) && String(f.value).toUpperCase() === roll);
  if (name === 'violations') return filters.some(f => ['rollNumber', 'studentName'].includes(f.field) && String(f.value).toUpperCase() === roll);
  if (name === 'awardedBadges') return filters.some(f => ['studentRollNo', 'studentId'].includes(f.field) && (String(f.value).toUpperCase() === roll || f.field === 'studentId' && f.value === user.studentId));
  if (name === 'examInvites') return filters.some(f => f.field === 'rollNo' && String(f.value).toUpperCase() === roll || f.field === 'email' && String(f.value).toLowerCase() === String(user.email).toLowerCase());
  return false;
}
function canWrite(user, name, operation, id, data = {}) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const roll = String(user.rollNo || '').toUpperCase();
  if (user.examId) {
    if (name === 'generated_questions' && operation === 'upsert' && String(id) === String(user.examId)) return true;
    if (name === 'exam_submissions' && operation === 'insert' && String(data.studentId || '').toUpperCase() === roll && String(data.examId || '') === String(user.examId)) return true;
    return false;
  }
  if (name === 'students' && ['update', 'merge'].includes(operation)) return roll && (String(id || '').toUpperCase() === roll || String(id || '') === String(user.studentId || '')) && Object.keys(data).every(key => ['phone', 'mobile', 'gender', 'codingProfiles'].includes(key));
  return false;
}

const notificationTime = value => value ? new Date(value).toISOString() : new Date().toISOString();
async function syncSystemNotifications(db) {
  const now = Date.now();
  const [exams, students, users, banks] = await Promise.all([
    db.collection('exams').find({ status: { $in: ['upcoming', 'scheduled'] } }).toArray(),
    db.collection('students').find({}).toArray(),
    db.collection('users').find({ role: 'student' }).toArray(),
    db.collection('question_banks').find({}).toArray(),
  ]);
  const userRolls = new Set(users.map(user => String(user.rollNo || user.studentId || '').toUpperCase()));
  const bankIds = new Set(banks.map(bank => String(bank._id)));
  const write = (id, data) => db.collection('notifications').updateOne(
    { _id: id }, { $setOnInsert: { ...data, createdAt: new Date(), read: false } }, { upsert: true }
  );
  const jobs = [];
  for (const exam of exams) {
    const examId = String(exam._id);
    const startsAt = scheduledStartInIndia(exam);
    if (!bankIds.has(examId)) jobs.push(write(`system:admin:questions:${examId}`, {
      recipientRole: 'admin', type: 'warning', title: 'Questions need uploading',
      message: `“${exam.title || 'Untitled exam'}” is scheduled without an uploaded question bank.`, date: notificationTime(exam.createdAt), examId,
    }));
    const eligible = students.filter(student => studentMatchesExam(exam, student));
    const unregistered = eligible.filter(student => !userRolls.has(String(student.rollNo || student._id || '').toUpperCase()));
    if (unregistered.length) jobs.push(write(`system:admin:registration:${examId}`, {
      recipientRole: 'admin', type: 'warning', title: 'Students not registered',
      message: `${unregistered.length} eligible student(s) for “${exam.title || 'this exam'}” have not activated their portal account.`, date: notificationTime(exam.updatedAt || exam.createdAt), examId,
    }));
    for (const student of eligible) {
      const rollNo = String(student.rollNo || student._id || '').toUpperCase();
      if (!rollNo) continue;
      jobs.push(write(`system:student:new-exam:${rollNo}:${examId}`, {
        recipientRole: 'student', recipientRollNo: rollNo, type: 'info', title: 'New exam scheduled',
        message: `“${exam.title || 'An exam'}” has been scheduled for you.`, date: notificationTime(exam.createdAt), examId,
      }));
      if (Number.isFinite(startsAt)) {
        const until = startsAt - now;
        if (until > 0 && until <= 60 * 60 * 1000) jobs.push(write(`system:student:one-hour:${rollNo}:${examId}`, {
          recipientRole: 'student', recipientRollNo: rollNo, type: 'reminder', title: 'Exam begins within 1 hour',
          message: `Prepare for “${exam.title || 'your exam'}”. Secure check-in opens 15 minutes before the start time.`, date: new Date().toISOString(), examId,
        }));
        if (until > 0 && until <= 15 * 60 * 1000) jobs.push(write(`system:student:fifteen-minutes:${rollNo}:${examId}`, {
          recipientRole: 'student', recipientRollNo: rollNo, type: 'warning', title: 'Exam check-in is open',
          message: `“${exam.title || 'Your exam'}” begins within 15 minutes. Complete camera check-in now.`, date: new Date().toISOString(), examId,
        }));
      }
    }
  }
  await Promise.all(jobs);
}
export async function handleAuth(req, res, action) {
  const db = await getDb();
  if (action === 'activate' && req.method === 'POST') {
    res.setHeader?.('Cache-Control', 'no-store');
    const result = await activateAccount(db, req.body);
    return res.status(result.status).json(result);
  }
  const caller = authUser(req);
  const cron = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (action === 'lifecycle' && (req.method === 'POST' || req.method === 'GET')) {
    if (caller?.role !== 'admin' && !cron) return res.status(403).json({ error: 'Administrator or cron access required.' });
    await ensureExamLifecycle(db, true);
    return res.status(200).json({ success: true, ranAt: new Date().toISOString() });
  }
  if (action === 'process-activations' && (req.method === 'POST' || req.method === 'GET')) {
    if (caller?.role !== 'admin' && !cron) return res.status(403).json({ error: 'Administrator access required.' });
    return res.status(200).json(await sendActivations(db, cron ? 100 : 25));
  }
  if (action === 'activation-status' && req.method === 'GET') {
    if (caller?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
    return res.status(200).json({ configured: emailConfigured(), pending: await db.collection('activationQueue').countDocuments({ status: { $in: ['queued','retry','sending'] } }) });
  }
  if (action === 'resend-activation' && req.method === 'POST') {
    if (caller?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
    if (typeof req.body?.studentId !== 'string') return res.status(400).json({ error: 'Student ID is required.' });
    const student = await db.collection('students').findOne({ _id: idValue(req.body.studentId) });
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    return res.status(200).json(await prepareStudentActivations(db, [student]));
  }
  if (action === 'login' && req.method === 'POST') {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const requestedRole = String(req.body?.requestedRole || '').toLowerCase();
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const user = await db.collection('users').findOne({ email });
    if (!user?.passwordHash || !(user.passwordHash && safePassword(password, user.passwordSalt, user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password.' });
    if (!['admin', 'student'].includes(requestedRole)) return res.status(400).json({ error: 'Select either Student or Admin before signing in.' });
    if (user.role !== requestedRole) return res.status(403).json({ error: `This account is registered as ${user.role}. Please use the ${user.role === 'admin' ? 'Admin' : 'Student'} sign-in tab.` });
    const profile = { uid: String(user._id), email: user.email, name: user.name, role: user.role, canManageAdmins: user.canManageAdmins === true, rollNo: user.rollNo || null, studentId: user.studentId || null };
    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: 'JWT_SECRET is not configured on the server.' });
    const token = sign(profile);
    return res.status(200).json({ token, user: profile });
  }
  const user = authUser(req);
  if (action === 'me' && req.method === 'GET') return user ? res.status(200).json({ user }) : res.status(401).json({ error: 'Not signed in.' });
  if (action === 'bootstrap-admin' && req.method === 'POST') {
    if (!process.env.ADMIN_BOOTSTRAP_TOKEN || req.headers['x-bootstrap-token'] !== process.env.ADMIN_BOOTSTRAP_TOKEN) return res.status(403).json({ error: 'Invalid bootstrap token.' });
    const { email, password, name } = req.body || {};
    if (!email || !password || password.length < 12) return res.status(400).json({ error: 'Provide an email and a password with at least 12 characters.' });
    const normalizedEmail = String(email).trim().toLowerCase();
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    await db.collection('users').updateOne({ email: normalizedEmail }, { $set: { email: normalizedEmail, name: name || 'Administrator', role: 'admin', canManageAdmins: true, passwordSalt: salt, passwordHash, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    return res.status(201).json({ success: true });
  }
  if (action === 'admin-users' && req.method === 'POST') {
    if (caller?.role !== 'admin' || caller?.canManageAdmins !== true) return res.status(403).json({ error: 'Only the designated super administrator can create administrators.' });
    const email = String(req.body?.email || '').trim().toLowerCase(), password = String(req.body?.password || ''), name = String(req.body?.name || 'Administrator').trim();
    if (!email || password.length < 12) return res.status(400).json({ error: 'Provide an email and a password of at least 12 characters.' });
    const salt = crypto.randomBytes(16).toString('hex'), passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    await db.collection('users').updateOne({ email }, { $set: { email, name, role: 'admin', canManageAdmins: false, passwordSalt: salt, passwordHash, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    return res.status(201).json({ success: true, email, canManageAdmins: false });
  }
  return res.status(404).json({ error: 'Authentication endpoint not found.' });
}

export async function handleMongo(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST for database requests.' });
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  const { collection: name, operation = 'list', id, filters = [], data, items } = req.body || {};
  if (!collections.has(name) || name === 'users') return res.status(400).json({ error: 'Invalid collection.' });
  if (!Array.isArray(filters) || filters.length > 20 || filters.some(f => !f || !/^[A-Za-z][A-Za-z0-9_]*$/.test(f.field) || !['==', '!=', 'in', undefined].includes(f.op) || (f.op === 'in' ? !Array.isArray(f.value) || f.value.some(v => v !== null && typeof v === 'object') : f.value !== null && typeof f.value === 'object'))) return res.status(400).json({ error: 'Invalid query filters.' });
  if (filters.some((f, index) => filters.findIndex(other => other.field === f.field) !== index)) return res.status(400).json({ error: 'Duplicate query fields are not allowed.' });
  if (data && (typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => key.startsWith('$') || key.includes('.') || key === '_id'))) return res.status(400).json({ error: 'Invalid document fields.' });
  if (['get', 'update', 'merge', 'upsert', 'delete'].includes(operation) && (typeof id !== 'string' || !id.trim())) return res.status(400).json({ error: 'A document ID is required.' });
  if (req.body?.orderBy && (!Array.isArray(req.body.orderBy) || req.body.orderBy.some(item => !/^[A-Za-z][A-Za-z0-9_]*$/.test(item.field) || !['asc','desc'].includes(item.direction)))) return res.status(400).json({ error: 'Invalid sort fields.' });
  if (req.body?.limit !== undefined && (!Number.isInteger(req.body.limit) || req.body.limit < 1 || req.body.limit > 5000)) return res.status(400).json({ error: 'Limit must be between 1 and 5000.' });
  const db = await getDb();
  await ensureExamLifecycle(db);
  if (name === 'notifications' && operation === 'list') await syncSystemNotifications(db);
  const collection = db.collection(name);
  if (name === 'generated_questions' && user.role !== 'admin' && !['get','list'].includes(operation) && await db.collection('question_banks').findOne({_id:String(user.examId)})) return res.status(403).json({error:'This exam uses administrator-uploaded questions.'});
  if (user.examId && user.role !== 'admin') {
    const [activeExam, activeStudent] = await Promise.all([
      db.collection('exams').findOne({ _id: idValue(user.examId) }),
      db.collection('students').findOne({ $or: [{ _id: user.rollNo }, { rollNo: user.rollNo }] }),
    ]);
    if (!activeExam || !activeStudent || !studentMatchesExam(activeExam, activeStudent)) return res.status(403).json({ error: 'You are no longer eligible for this exam.' });
  }
  if (name === 'exams' && ['insert', 'upsert', 'update', 'merge'].includes(operation)) {
    const existing = id ? await collection.findOne({ _id: idValue(id) }) : null;
    const exam = { ...existing, ...data };
    const bank = existing && await db.collection('question_banks').findOne({_id:String(existing._id)});
    if (bank && data.examType && data.examType !== bank.type) return res.status(409).json({error:'This exam has uploaded questions. Create a new exam to change the exam type.'});
    if (exam.audienceMode !== undefined || !existing) {
      const colleges = await db.collection('colleges').find({}).toArray();
      const error = validateExamAudience(exam, colleges);
      if (error) return res.status(400).json({ error });
      if (data.audienceMode === 'all') data.audience = [];
      if (Array.isArray(data.audience)) data.audience = data.audience.map(target => ({ ...target, collegeName: colleges.find(college => String(college._id) === target.collegeId)?.name || target.collegeName }));
    }
  }
  const filter = Object.fromEntries(filters.map(({ field, op, value }) => [field, op === 'in' ? { $in: value } : op === '!=' ? { $ne: value } : value]));

  if (operation === 'list' || operation === 'get') {
    if (!canRead(user, name, filters, id)) return res.status(403).json({ error: 'Not allowed to read this data.' });
    let found = operation === 'get' ? await collection.findOne({ _id: idValue(id) }) : await collection.find(filter).sort(Object.fromEntries((req.body?.orderBy || []).map(({field,direction}) => [field, direction === 'desc' ? -1 : 1]))).limit(Math.min(Number(req.body?.limit) || 5000, 5000)).toArray();
    if (name === 'notifications' && user.role !== 'admin') {
      const roll = String(user.rollNo || '').toUpperCase();
      found = found.filter(notification => notification.recipientRole !== 'admin' && (!notification.recipientRollNo || String(notification.recipientRollNo).toUpperCase() === roll));
    }
    if (name === 'exams' && user.role !== 'admin') {
      const student = await db.collection('students').findOne({ $or: [{ _id: user.rollNo }, { rollNo: user.rollNo }] });
      if (operation === 'get' && found && !studentMatchesExam(found, student)) return res.status(403).json({ error: 'This exam is not scheduled for your college and branch.' });
      if (operation === 'list') found = found.filter(exam => studentMatchesExam(exam, student));
    }
    if (operation === 'get' && found && user.role !== 'admin' && name === 'violations' && ![found.rollNumber,found.studentName].some(value => String(value || '').toUpperCase() === String(user.rollNo || '').toUpperCase())) return res.status(403).json({ error: 'This incident belongs to another student.' });
    if (operation === 'get' && found && user.role !== 'admin' && name === 'exam_submissions' && (String(found.studentId).toUpperCase() !== String(user.rollNo || '').toUpperCase() || user.examId && String(found.examId) !== String(user.examId))) return res.status(403).json({ error: 'This submission belongs to another exam session.' });
    const normalize = document => document && ({ ...document, id: String(document._id), _id: undefined });
    return res.status(200).json(operation === 'get' ? { document: normalize(found) } : { documents: found.map(normalize) });
  }

  if (!canWrite(user, name, operation, id, data || {})) return res.status(403).json({ error: 'Not allowed to change this data.' });
  if (name === 'students' && data) {
    for (const field of ['cgpa', 'btech', 'backlogs', 'githubUsername', 'githubUrl', 'githubStats']) delete data[field];
  }
  if (operation === 'insert') {
    if (name === 'examInvites') {
      const exam=await db.collection('exams').findOne({_id:idValue(String(data?.examId||''))});
      const student=await db.collection('students').findOne({rollNo:data?.rollNo});
      if(!exam||!student||!studentMatchesExam(exam,student))return res.status(400).json({error:'Student is not eligible for this exam.'});
      const invite=await ensureExamInvite(db,exam,student);
      return res.status(201).json({id:String(invite._id),examCode:invite.examCode});
    }
    if (name === 'exam_submissions') {
      if (!data?.studentId || !data?.examId) return res.status(400).json({ error: 'Student and exam IDs are required.' });
      // Time is never accepted from the renderer.  It is calculated from the
      // persisted exam record and is therefore identical across all clients.
      const scheduledExam = await db.collection('exams').findOne({ _id: idValue(data.examId) });
      const scheduledEnd = scheduledExam && scheduledStartInIndia(scheduledExam) + examDurationMs(scheduledExam);
      const graceMinutes = Math.max(0, Math.min(15, Number(scheduledExam?.submissionGraceMinutes || 0)));
      if (!scheduledExam || !Number.isFinite(scheduledEnd)) return res.status(409).json({ error: 'The exam schedule is unavailable.' });
      if (Date.now() > scheduledEnd + graceMinutes * 60 * 1000) return res.status(410).json({ error: 'The server-calculated submission deadline has passed.' });
      const claimedSessionId = data.sessionId ? String(data.sessionId) : null;
      if (claimedSessionId) {
        const owned = await db.collection('exam_sessions').findOne({ _id: claimedSessionId, examId: String(data.examId), studentId: String(data.studentId).toUpperCase() });
        if (!owned) return res.status(403).json({ error: 'The session does not belong to this authenticated student.' });
        if (owned.finalSubmissionStatus === 'submitted') {
          const prior = await collection.findOne({ studentId: data.studentId, examId: data.examId });
          if (prior) return res.status(201).json({ id: String(prior._id), duplicate: true, score: prior.score, passedCases: prior.passedCases, totalCases: prior.totalCases, allPassed: prior.allPassed, evaluationPending: prior.evaluationPending, results: prior.results });
          return res.status(409).json({ error: 'This session has already been finalized.' });
        }
      }
      const existing = await collection.findOne({ studentId: data.studentId, examId: data.examId });
      const bank = await db.collection('question_banks').findOne({_id:String(data.examId)});
      if (bank && !existing && data.questionRevision !== bank.revision) return res.status(409).json({error:'The question bank changed. Restart the app to load the current questions before submitting.'});
      if (bank && !existing) {
        // Never accept answer keys, test cases or scores supplied by an exam client.
        delete data.questions; delete data.testCases; delete data.results;
        for (const key of ['score','percentage','passedCases','totalCases','allPassed','evaluationPending']) delete data[key];
        data.questionRevision=bank.revision;
        if (bank.type === 'Coding' && data.submissionReason === 'proctor_limit') { data.evaluationPending=true; data.evaluationError='Saved for administrator evaluation.'; }
        else { try { Object.assign(data,await gradeBank(bank,data)); } catch { data.evaluationPending=true; data.evaluationError='Compiler service unavailable. Answers saved for retry.'; } }
      }
      const submissionId = existing?._id || 'submission:' + crypto.createHash('sha256').update(JSON.stringify([data.studentId, data.examId])).digest('hex');
      const report = data.proctorReport && typeof data.proctorReport === 'object' ? { ...data.proctorReport } : undefined;
      let imageCount = 0;
      if (report) report.events = (Array.isArray(report.events) ? report.events : []).slice(0,1000).filter(event => event && typeof event === 'object').map(event => {
        const clean = { ...event }; delete clean.evidence;
        if (event.type === 'confirmed_incident' && imageCount < 3) { clean.evidence = sanitizeEvidence(event.evidence); if(clean.evidence)imageCount++; }
        return clean;
      });
      await collection.updateOne({ _id: submissionId }, { $setOnInsert: { ...data, ...(report ? { proctorReport: report } : {}), createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
      const stored = await collection.findOne({ _id: submissionId });
      // The deterministic submission key makes simultaneous manual/automatic
      // submissions idempotent. Finalization happens only after persistence.
      if (claimedSessionId) await db.collection('exam_sessions').updateOne({ _id: claimedSessionId, examId: String(data.examId), studentId: String(data.studentId).toUpperCase() }, { $set: { state: 'finalized', finalSubmissionStatus: 'submitted', finalSubmissionReason: String(data.submissionReason || 'manual').slice(0, 80), finalizedAt: new Date(), updatedAt: new Date() } });
      const events = Array.isArray(stored?.proctorReport?.events) ? stored.proctorReport.events.filter(event => event.type === 'confirmed_incident').slice(0, 3) : [];
      const exam = await db.collection('exams').findOne({ _id: idValue(data.examId) });
      for (const event of events) {
        const reasons = Array.isArray(event.reasons) ? event.reasons.join(', ') : 'camera incident';
        await db.collection('violations').updateOne({ _id: `${submissionId}:incident:${event.strike}` }, { $setOnInsert: {
          studentName: data.studentId, rollNumber: data.studentId, examId: data.examId, exam: exam?.title || data.examId,
          type: reasons, severity: event.strike >= 3 ? 'High' : 'Medium', status: 'Pending', date: event.timestamp,
          description: `Automated camera observation ${event.strike}: ${reasons}. Face count: ${event.faceCount}; phone confidence: ${event.phoneConfidence}. Requires human review.`,
          actionTaken: event.action === 'auto_submit' ? 'Automatically submitted after two warnings' : `Warning ${event.strike} of 2`,
          source: 'electron_proctor', submissionId: String(submissionId),
          evidence: sanitizeEvidence(event.evidence),
        } }, { upsert: true });
      }
      if (bank) await publishBankResult(db,stored,bank,exam);
      return res.status(201).json({ id: String(submissionId), score:stored.score, passedCases:stored.passedCases,totalCases:stored.totalCases,allPassed:stored.allPassed,evaluationPending:stored.evaluationPending,results:stored.results });
    }
    if (name === 'exams') delete data.status;
    const result = await collection.insertOne({ ...data, createdAt: data.createdAt || new Date(), updatedAt: new Date() });
    if (name === 'exams') await ensureExamLifecycle(db, true);
    const activation = name === 'students' ? await prepareStudentActivations(db, [{ ...data, _id: result.insertedId }]) : undefined;
    return res.status(201).json({ id: String(result.insertedId), activation });
  }
  if (operation === 'upsert') {
    const documentId = idValue(id);
    if (name === 'exams') delete data.status;
    await collection.replaceOne({ _id: documentId }, { ...data, _id: documentId, updatedAt: new Date() }, { upsert: true });
    if (name === 'exams') await ensureExamLifecycle(db, true);
    const activation = name === 'students' ? await prepareStudentActivations(db, [{ ...data, _id: documentId }]) : undefined;
    return res.status(200).json({ id: String(documentId), activation });
  }
  if (operation === 'merge') {
    if (name === 'exams') delete data.status;
    await collection.updateOne({ _id: idValue(id) }, { $set: { ...data, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    if (name === 'exams') await ensureExamLifecycle(db, true);
    return res.status(200).json({ id: String(id) });
  }  if (operation === 'update') {
    if (name === 'exams') delete data.status;
    const result = await collection.updateOne({ _id: idValue(id) }, { $set: { ...data, updatedAt: new Date() }, ...(name === 'exams' ? { $unset: { noShowProcessedAt: '' } } : {}) });
    if (!result.matchedCount) return res.status(404).json({ error: 'Record not found.' });
    if (name === 'exams') await ensureExamLifecycle(db, true);
    return res.status(200).json({ success: true });
  }
  if (operation === 'delete') {
    const result = await collection.deleteOne({ _id: idValue(id) });
    return res.status(result.deletedCount ? 200 : 404).json({ success: !!result.deletedCount });
  }
  if (operation === 'batch') {
    if (name !== 'students' || user.role !== 'admin' || !Array.isArray(items) || items.length > 500) return res.status(400).json({ error: 'Invalid batch.' });
    const ops = items.map(item => ({ replaceOne: { filter: { _id: String(item.id) }, replacement: { ...item.data, _id: String(item.id), updatedAt: new Date() }, upsert: true } }));
    if (ops.length) await collection.bulkWrite(ops, { ordered: true });
    const activation = await prepareStudentActivations(db, items.map(item => ({ ...item.data, _id: String(item.id) })));
    return res.status(200).json({ success: true, activation });
  }
  return res.status(400).json({ error: 'Unsupported operation.' });
}

function scheduledStartInIndia(exam) {
  const value = exam?.startTime || exam?.start_time || exam?.start || (exam?.date && exam?.time ? `${exam.date}T${exam.time}` : null);
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim();
  if (/Z$/i.test(text) || /[+-]\d{2}:?\d{2}$/.test(text)) return new Date(text).getTime();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return new Date(text).getTime();
  const [, year, month, day, rawHour, minute, second = '0', meridiem] = match;
  let hour = Number(rawHour);
  if (meridiem) {
    hour %= 12;
    if (meridiem.toUpperCase() === 'PM') hour += 12;
  }
  // Timetables created in the admin portal use India Standard Time, even though Vercel runs in UTC.
  return Date.UTC(Number(year), Number(month) - 1, Number(day), hour, Number(minute), Number(second)) - (5.5 * 60 * 60 * 1000);
}

function examDurationMs(exam) {
  const text = String(exam?.durationMinutes || exam?.duration || '60').toLowerCase();
  const hour = text.match(/(\d+(?:\.\d+)?)\s*(?:hour|hr)/);
  const minute = text.match(/(\d+(?:\.\d+)?)\s*(?:minute|min)/);
  const value = hour ? Number(hour[1]) * 60 : minute ? Number(minute[1]) : Number(text);
  return Math.max(1, Number.isFinite(value) ? value : 60) * 60 * 1000;
}

async function syncExamLifecycle(db) {
  const now = Date.now();
  const exams = await db.collection('exams').find({ status: { $ne: 'cancelled' } }).toArray();
  for (const exam of exams) {
    const startAt = scheduledStartInIndia(exam);
    if (!Number.isFinite(startAt)) continue;
    const endAt = startAt + examDurationMs(exam);
    const status = now < startAt ? 'upcoming' : now < endAt ? 'scheduled' : 'completed';
    if (exam.status !== status) await db.collection('exams').updateOne({ _id: exam._id }, { $set: { status, updatedAt: new Date() } });
    if (status !== 'completed' || exam.noShowProcessedAt) continue;
    await db.collection('examInvites').updateMany({ examId: String(exam._id), status: { $ne: 'Expired' } }, { $set: { status: 'Expired', expiredAt: new Date() }, $unset: { examCode: '' } });
    const students = await db.collection('students').find({}).toArray();
    const eligible = students.filter(student => studentMatchesExam(exam, student));
    const [submitted, storedResults] = await Promise.all([
      db.collection('exam_submissions').find({ examId: String(exam._id) }, { projection: { studentId: 1 } }).toArray(),
      db.collection('results').find({ examId: String(exam._id) }, { projection: { rollNo: 1, studentId: 1, studentRollNo: 1 } }).toArray(),
    ]);
    const appeared = new Set([...submitted, ...storedResults].map(item => String(item.studentId || item.rollNo || item.studentRollNo || '').toUpperCase()));
    const noShows = eligible.filter(student => !appeared.has(String(student.rollNo || student._id || '').toUpperCase()));
    if (noShows.length) await db.collection('results').bulkWrite(noShows.map(student => {
      const rollNo = String(student.rollNo || student._id);
      return { updateOne: { filter: { _id: `not-appeared:${exam._id}:${rollNo}` }, update: { $setOnInsert: { studentName: student.name || rollNo, rollNo, studentRollNo: rollNo, examId: String(exam._id), subject: exam.subject || exam.title, examTitle: exam.title, source: 'lifecycle', marks: null, totalMarks: null, percentage: null, status: 'not_appeared', grade: 'Not appeared', date: new Date(endAt).toISOString(), createdAt: new Date() } }, upsert: true } };
    }), { ordered: false });
    await db.collection('exams').updateOne({ _id: exam._id }, { $set: { noShowProcessedAt: new Date() } });
  }
}

async function ensureExamLifecycle(db, force = false) {
  if (!force && Date.now() - lifecycleLastRun < 30000) return lifecyclePromise || undefined;
  if (!lifecyclePromise) lifecyclePromise = syncExamLifecycle(db)
    .then(value => { lifecycleLastRun = Date.now(); return value; })
    .finally(() => { lifecyclePromise = null; });
  return lifecyclePromise;
}

const HEARTBEAT_TIMEOUT_MS = Math.max(15_000, Number(process.env.EXAM_HEARTBEAT_TIMEOUT_MS || 90_000));
const HEARTBEAT_MIN_INTERVAL_MS = Math.max(1_000, Number(process.env.EXAM_HEARTBEAT_MIN_INTERVAL_MS || 5_000));
const HEARTBEAT_REQUEST_MIN_INTERVAL_MS = Math.max(500, Number(process.env.EXAM_HEARTBEAT_REQUEST_MIN_INTERVAL_MS || 1_000));
const PROCTOR_EVENT_RETENTION_DAYS = Math.max(1, Math.min(3650, Number(process.env.PROCTOR_EVENT_RETENTION_DAYS || 90)));
const SESSION_EVENT_TYPES = new Set(['PHONE_DETECTED','MULTIPLE_FACES','FACE_MISSING','FACE_OCCLUDED','HEAD_ROTATION','GAZE_DEVIATION','CAMERA_DISCONNECTED','CAMERA_FROZEN','CAMERA_BLACK_FRAME','CAMERA_STALE_FRAME','CAMERA_LOW_QUALITY','IDENTITY_MISMATCH','APPLICATION_TAMPERING','FULLSCREEN_EXIT','WINDOW_FOCUS_LOST','WINDOW_MINIMIZED','WINDOW_CLOSE_ATTEMPT','DEVTOOLS_ATTEMPT','NAVIGATION_BLOCKED','RENDERER_CRASH','CLIPBOARD_ATTEMPT','PROHIBITED_SHORTCUT','CODE_LARGE_INSERT','CODE_RAPID_CHANGE','CODE_RUN','NETWORK_OFFLINE','NETWORK_RESTORED']);
const EVENT_POLICY = Object.freeze({
  PHONE_DETECTED: ['camera', 'high', 'warning'], MULTIPLE_FACES: ['camera', 'high', 'warning'], FACE_MISSING: ['camera', 'medium', 'warning'],
  CAMERA_DISCONNECTED: ['camera', 'high', 'warning'], CAMERA_FROZEN: ['camera', 'medium', 'advisory'], CAMERA_LOW_QUALITY: ['camera', 'low', 'advisory'],
  CAMERA_BLACK_FRAME: ['camera', 'medium', 'warning'], CAMERA_STALE_FRAME: ['camera', 'medium', 'warning'], FACE_OCCLUDED: ['camera', 'medium', 'advisory'],
  FULLSCREEN_EXIT: ['integrity', 'high', 'warning'], WINDOW_FOCUS_LOST: ['integrity', 'medium', 'warning'], WINDOW_MINIMIZED: ['integrity', 'high', 'warning'], WINDOW_CLOSE_ATTEMPT: ['integrity', 'high', 'warning'],
  DEVTOOLS_ATTEMPT: ['integrity', 'high', 'warning'], NAVIGATION_BLOCKED: ['integrity', 'high', 'warning'], RENDERER_CRASH: ['integrity', 'high', 'advisory'],
  CLIPBOARD_ATTEMPT: ['keyboard', 'medium', 'warning'], PROHIBITED_SHORTCUT: ['keyboard', 'medium', 'warning'], CODE_LARGE_INSERT: ['coding', 'medium', 'advisory'], CODE_RAPID_CHANGE: ['coding', 'low', 'advisory'], CODE_RUN: ['coding', 'info', 'none'],
  HEAD_ROTATION: ['camera', 'low', 'advisory'], GAZE_DEVIATION: ['camera', 'low', 'advisory'], IDENTITY_MISMATCH: ['camera', 'high', 'warning'], APPLICATION_TAMPERING: ['integrity', 'high', 'warning'], NETWORK_OFFLINE: ['network', 'info', 'none'], NETWORK_RESTORED: ['network', 'info', 'none']
});
function deviceId(value) { const text = String(value || ''); return /^[A-Za-z0-9._:-]{16,160}$/.test(text) ? text : null; }
function sessionState(session, now = Date.now()) {
  if (!session) return 'missing';
  if (session.finalSubmissionStatus === 'submitted') return 'submitted';
  if (session.scheduledEndAt && new Date(session.scheduledEndAt).getTime() <= now) return 'expired';
  if (!session.lastHeartbeatAt || now - new Date(session.lastHeartbeatAt).getTime() > HEARTBEAT_TIMEOUT_MS) return 'disconnected';
  return session.connectionStatus === 'reconnecting' ? 'reconnecting' : 'connected';
}
async function authorizedExamUser(db, req) {
  const user = authUser(req);
  if (!user?.examId || !user?.rollNo) return { error: 'An authenticated exam session is required.', status: 403 };
  const [student, exam] = await Promise.all([
    db.collection('students').findOne({ $or: [{ _id: user.rollNo }, { rollNo: user.rollNo }] }),
    db.collection('exams').findOne({ _id: idValue(user.examId) })
  ]);
  if (!student || !exam || !studentMatchesExam(exam, student)) return { error: 'You are not eligible for this examination.', status: 403 };
  const startAt = scheduledStartInIndia(exam), endAt = startAt + examDurationMs(exam);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return { error: 'The exam schedule is invalid.', status: 409 };
  return { user, student, exam, startAt, endAt, studentId: String(student.rollNo || user.rollNo).toUpperCase() };
}
function publicSession(session) {
  return { sessionId: String(session._id), examId: session.examId, studentId: session.studentId, serverStartedAt: session.serverStartedAt, scheduledEndAt: session.scheduledEndAt, lastHeartbeatAt: session.lastHeartbeatAt, connectionStatus: session.connectionStatus, state: sessionState(session), finalSubmissionStatus: session.finalSubmissionStatus || 'not_submitted', warningState: session.warningState || { count: 0 }, updatedAt: session.updatedAt };
}

export async function handleExamApi(req, res, action) {
  const db = await getDb();
  await ensureExamLifecycle(db);
  if (action === 'session-start' && req.method === 'POST') {
    const context = await authorizedExamUser(db, req);
    if (context.error) return res.status(context.status).json({ error: context.error });
    const { startAt, endAt, exam, studentId } = context;
    const now = Date.now();
    if (now < startAt - 15 * 60 * 1000) return res.status(403).json({ error: 'Secure check-in is not open yet.' });
    if (now >= endAt) return res.status(410).json({ error: 'This exam has ended.' });
    const checkin = await db.collection('proctor_checkins').findOne({ examId: String(exam._id), studentId: { $in: [String(context.user.rollNo), studentId] }, expiresAt: { $gt: new Date() } });
    if (!checkin) return res.status(403).json({ error: 'Complete the required camera check-in before starting the exam.' });
    const suppliedDeviceId = deviceId(req.body?.deviceId);
    if (!suppliedDeviceId) return res.status(400).json({ error: 'A valid device identifier is required.' });
    const key = { examId: String(exam._id), studentId };
    const existing = await db.collection('exam_sessions').findOne(key);
    if (existing?.finalSubmissionStatus === 'submitted') return res.status(409).json({ error: 'This exam was already submitted.' });
    const existingHeartbeat = existing?.lastHeartbeatAt ? new Date(existing.lastHeartbeatAt).getTime() : 0;
    if (existing && existing.deviceId !== suppliedDeviceId && now - existingHeartbeat <= HEARTBEAT_TIMEOUT_MS) {
      return res.status(409).json({ error: 'This exam is active on another device.', code: 'DUPLICATE_SESSION' });
    }
    const sessionId = existing?._id || `session:${crypto.randomUUID()}`;
    const connectionStatus = existing && existing.deviceId !== suppliedDeviceId ? 'reconnecting' : 'connected';
    try {
      await db.collection('exam_sessions').updateOne(key, { $set: {
        _id: sessionId, examId: String(exam._id), studentId, deviceId: suppliedDeviceId, serverStartedAt: existing?.serverStartedAt || new Date(),
        scheduledStartAt: new Date(startAt), scheduledEndAt: new Date(endAt), lastHeartbeatAt: new Date(), connectionStatus,
        state: 'active', finalSubmissionStatus: existing?.finalSubmissionStatus || 'not_submitted', warningState: existing?.warningState || { count: 0 }, updatedAt: new Date()
      }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    } catch (error) {
      // The unique compound index is the final arbiter when concurrent serverless
      // requests both observe no session. Re-read and apply the same device rule.
      if (error?.code !== 11000) throw error;
      const raced = await db.collection('exam_sessions').findOne(key);
      const racedHeartbeat = raced?.lastHeartbeatAt ? new Date(raced.lastHeartbeatAt).getTime() : 0;
      if (!raced || (raced.deviceId !== suppliedDeviceId && now - racedHeartbeat <= HEARTBEAT_TIMEOUT_MS)) return res.status(409).json({ error: 'This exam is active on another device.', code: 'DUPLICATE_SESSION' });
      await db.collection('exam_sessions').updateOne({ _id: raced._id, deviceId: raced.deviceId }, { $set: { deviceId: suppliedDeviceId, lastHeartbeatAt: new Date(), connectionStatus: 'reconnecting', state: 'active', updatedAt: new Date() } });
    }
    const session = await db.collection('exam_sessions').findOne(key);
    return res.status(200).json({ session: publicSession(session), heartbeatIntervalMs: HEARTBEAT_MIN_INTERVAL_MS, heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS });
  }
  if (action === 'heartbeat' && req.method === 'POST') {
    const context = await authorizedExamUser(db, req);
    if (context.error) return res.status(context.status).json({ error: context.error });
    const sessionId = String(req.body?.sessionId || ''); const suppliedDeviceId = deviceId(req.body?.deviceId);
    if (!sessionId || !suppliedDeviceId) return res.status(400).json({ error: 'Session and device identifiers are required.' });
    const session = await db.collection('exam_sessions').findOne({ _id: sessionId, examId: String(context.exam._id), studentId: context.studentId, deviceId: suppliedDeviceId });
    if (!session) return res.status(403).json({ error: 'This session does not belong to the authenticated student.' });
    if (session.finalSubmissionStatus === 'submitted' || Date.now() >= context.endAt) return res.status(410).json({ error: 'This examination session is no longer active.' });
    const now = Date.now();
    if (now >= context.endAt || session.finalSubmissionStatus === 'submitted') return res.status(410).json({ error: 'This examination session is no longer active.', session: publicSession(session) });
    const prior = new Date(session.lastHeartbeatAt || 0).getTime();
    if (now - prior < HEARTBEAT_REQUEST_MIN_INTERVAL_MS) return res.status(429).json({ error: 'Heartbeat rate limit exceeded. Retry shortly.' });
    const status = now - prior > HEARTBEAT_TIMEOUT_MS ? 'reconnecting' : 'connected';
    if (now - prior >= HEARTBEAT_MIN_INTERVAL_MS) await db.collection('exam_sessions').updateOne({ _id: session._id }, { $set: { lastHeartbeatAt: new Date(), connectionStatus: status, state: 'active', updatedAt: new Date() } });
    const updated = await db.collection('exam_sessions').findOne({ _id: session._id });
    return res.status(200).json({ session: publicSession(updated), serverTime: new Date().toISOString() });
  }
  if (action === 'events-sync' && req.method === 'POST') {
    const context = await authorizedExamUser(db, req);
    if (context.error) return res.status(context.status).json({ error: context.error });
    const sessionId = String(req.body?.sessionId || ''); const suppliedDeviceId = deviceId(req.body?.deviceId);
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (!sessionId || !suppliedDeviceId || !events.length || events.length > 100) return res.status(400).json({ error: 'Provide 1 to 100 events with a valid session.' });
    const session = await db.collection('exam_sessions').findOne({ _id: sessionId, examId: String(context.exam._id), studentId: context.studentId, deviceId: suppliedDeviceId });
    if (!session) return res.status(403).json({ error: 'This session does not belong to the authenticated student.' });
    if (session.finalSubmissionStatus === 'submitted' || Date.now() >= context.endAt) return res.status(410).json({ error: 'This examination session is no longer active.' });
    const accepted = [], rejected = []; const ops = [];
    for (const event of events) {
      const eventId = String(event?.eventId || ''); const type = String(event?.type || '').toUpperCase();
      const timestamp = new Date(event?.timestamp);
      if (!/^[A-Za-z0-9:_-]{16,180}$/.test(eventId) || !SESSION_EVENT_TYPES.has(type) || !Number.isFinite(timestamp.getTime()) || Math.abs(Date.now() - timestamp.getTime()) > 7 * 24 * 60 * 60 * 1000) { rejected.push(eventId || 'invalid'); continue; }
      const [category, severity, policyAction] = EVENT_POLICY[type] || ['other', 'info', 'none'];
      const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata) ? JSON.parse(JSON.stringify(event.metadata).slice(0, 8000)) : {};
      ops.push({ updateOne: { filter: { eventId }, update: { $setOnInsert: { eventId, sessionId, examId: String(context.exam._id), studentId: context.studentId, category, type, severity, confidence: Math.max(0, Math.min(1, Number(event.confidence) || 0)), timestamp, receivedAt: new Date(), expiresAt: new Date(Date.now() + PROCTOR_EVENT_RETENTION_DAYS * 86400000), metadata, evidenceRef: typeof event.evidenceRef === 'string' ? event.evidenceRef.slice(0, 300) : null, policyAction, processingStatus: 'pending_review' } }, upsert: true } }); accepted.push(eventId);
    }
    if (ops.length) await db.collection('proctor_events').bulkWrite(ops, { ordered: false });
    return res.status(200).json({ accepted, rejected, receivedAt: new Date().toISOString() });
  }
  if (action === 'sessions' && req.method === 'GET') {
    const user = authUser(req); if (user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 25))); const page = Math.max(0, Number(req.query?.page || 0));
    const filter = {}; for (const key of ['examId','studentId']) if (typeof req.query?.[key] === 'string' && req.query[key]) filter[key] = req.query[key];
    const requestedState = String(req.query?.state || ''); const now = new Date(); const staleAt = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS);
    if (requestedState === 'submitted') filter.finalSubmissionStatus = 'submitted';
    else if (requestedState === 'active') filter.state = 'active';
    else if (requestedState === 'connected') Object.assign(filter, { state: 'active', finalSubmissionStatus: { $ne: 'submitted' }, scheduledEndAt: { $gt: now }, lastHeartbeatAt: { $gte: staleAt } });
    else if (requestedState === 'disconnected') Object.assign(filter, { state: 'active', finalSubmissionStatus: { $ne: 'submitted' }, $or: [{ lastHeartbeatAt: { $lt: staleAt } }, { lastHeartbeatAt: { $exists: false } }] });
    else if (requestedState && requestedState !== 'all') return res.status(400).json({ error: 'Invalid session state filter.' });
    const sessions = await db.collection('exam_sessions').find(filter).sort({ updatedAt: -1 }).skip(page * limit).limit(limit).toArray();
    const ids = sessions.map(item => item._id); const eventCounts = ids.length ? await db.collection('proctor_events').aggregate([{ $match: { sessionId: { $in: ids } } }, { $group: { _id: '$sessionId', count: { $sum: 1 }, latestEventAt: { $max: '$receivedAt' } } }]).toArray() : [];
    const counts = new Map(eventCounts.map(row => [row._id, row]));
    return res.status(200).json({ sessions: sessions.map(item => ({ ...publicSession(item), eventCount: counts.get(item._id)?.count || 0, latestEventAt: counts.get(item._id)?.latestEventAt || null })), page, limit, total: await db.collection('exam_sessions').countDocuments(filter) });
  }
  if (action === 'session-timeline' && req.method === 'GET') {
    const user = authUser(req); if (user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
    const sessionId = String(req.query?.sessionId || ''); if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });
    const session = await db.collection('exam_sessions').findOne({ _id: sessionId }); if (!session) return res.status(404).json({ error: 'Session not found.' });
    const events = await db.collection('proctor_events').find({ sessionId }).sort({ timestamp: 1 }).limit(1000).toArray();
    return res.status(200).json({ session: publicSession(session), events: events.map(({ _id, ...event }) => ({ id: String(_id || event.eventId), ...event })) });
  }
  if (action === 'review-event' && req.method === 'POST') {
    const user = authUser(req); if (user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
    const eventId = String(req.body?.eventId || ''); const decision = String(req.body?.decision || '');
    if (!eventId || !['confirmed','dismissed','escalated'].includes(decision)) return res.status(400).json({ error: 'A valid event decision is required.' });
    const event = await db.collection('proctor_events').findOne({ eventId }); if (!event) return res.status(404).json({ error: 'Event not found.' });
    const review = { decision, reviewerId: String(user.uid || user.email || 'admin'), reviewedAt: new Date(), note: String(req.body?.note || '').slice(0, 1000) };
    await db.collection('proctor_events').updateOne({ eventId }, { $set: { processingStatus: decision, review, updatedAt: new Date() } });
    await db.collection('evidence_audit').insertOne({ eventId, sessionId: event.sessionId, action: `review_${decision}`, actor: review.reviewerId, at: new Date(), expiresAt: new Date(Date.now() + PROCTOR_EVENT_RETENTION_DAYS * 86400000) });
    return res.status(200).json({ success: true, review });
  }
  if (action === 'checkin' && req.method === 'POST') {
    const user = authUser(req);
    if (!user?.examId || !user?.rollNo) return res.status(403).json({ error: 'An active exam session is required.' });
    const student = await db.collection('students').findOne({ rollNo: user.rollNo });
    const exam = await db.collection('exams').findOne({ _id: idValue(user.examId) });
    if (!student || !exam || !studentMatchesExam(exam, student)) return res.status(403).json({ error: 'This check-in is not eligible for the assigned exam.' });
    const photo = sanitizeEvidence({ image: req.body?.photo, capturedAt: req.body?.capturedAt, regions: [] });
    if (!photo) return res.status(400).json({ error: 'A valid camera snapshot is required.' });
    const diagnostics = req.body?.camera && typeof req.body.camera === 'object' ? req.body.camera : {};
    const process = { instructionsAccepted: req.body?.instructionsAccepted === true, cameraPermission: diagnostics.permission === 'granted' ? 'granted' : 'unknown', width: Number.isInteger(diagnostics.width) ? diagnostics.width : 0, height: Number.isInteger(diagnostics.height) ? diagnostics.height : 0, checkedAt: new Date() };
    if (!process.instructionsAccepted || process.cameraPermission !== 'granted' || !process.width || !process.height) return res.status(400).json({ error: 'Complete the instructions and live camera check before continuing.' });
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.collection('proctor_checkins').updateOne({ _id: `checkin:${user.rollNo}:${user.examId}` }, { $set: { studentId: user.rollNo, examId: user.examId, photo, process, expiresAt, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    return res.status(201).json({ success: true, expiresAt: expiresAt.toISOString() });
  }
  if (action === 'questions' || action === 'runner-check' || action === 'run-code' || action === 'evaluations') return questionBankApi(req,res,db,authUser(req),action,idValue);
  if(action==='my-invites' && req.method==='GET'){
    const user=authUser(req);
    if(user?.role!=='student'||!user.rollNo)return res.status(403).json({error:'Student sign-in required.'});
    const student=await db.collection('students').findOne({rollNo:user.rollNo});
    if(!student)return res.status(404).json({error:'Student record not found.'});
    const exams=await db.collection('exams').find({status:{$in:['upcoming','scheduled']}}).toArray();
    const invitations=[];
    for(const exam of exams.filter(exam=>studentMatchesExam(exam,student))){
      const submitted=await db.collection('exam_submissions').findOne({studentId:student.rollNo,examId:String(exam._id)});
      if(!submitted){const invite=await ensureExamInvite(db,exam,student);invitations.push({examId:invite.examId,examCode:invite.examCode,rollNo:invite.rollNo});}
    }
    res.setHeader?.('Cache-Control','no-store');
    return res.status(200).json({invitations});
  }
  if (action === 'validate-pin' && req.method === 'POST') {
    const pin = String(req.body?.pin || '').trim();
    if(!/^\d{6}$/.test(pin))return res.status(400).json({success:false,message:'Enter your six-digit exam code.'});
    const invite = await db.collection('examInvites').findOne({ examCode: pin });
    if (!invite) return res.status(401).json({ success: false, message: 'Invalid PIN.' });
    const rollNo = invite.rollNo || invite.rollnumber || invite.roll_no || '';
    const student = await db.collection('students').findOne({ $or: [{ _id: rollNo }, { rollNo }] });
    const exam = invite.examId ? await db.collection('exams').findOne({ _id: idValue(invite.examId) }) : null;
    if (!student || !exam) return res.status(403).json({ success: false, message: 'The student or exam is no longer available.' });
    if (!studentMatchesExam(exam, student)) return res.status(403).json({ success: false, message: 'This exam is not scheduled for your college and branch.' });
    const startAt = scheduledStartInIndia(exam);
    const endAt = startAt + examDurationMs(exam);
    if (Number.isFinite(endAt) && Date.now() >= endAt) return res.status(410).json({ success: false, message: 'This exam has ended. Your access code has expired.' });
    const checkInOpensAt = startAt - (15 * 60 * 1000);
    if (Number.isFinite(startAt) && Date.now() < checkInOpensAt) {
      return res.status(403).json({
        success: false,
        message: `Secure check-in opens at ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(checkInOpensAt))} IST and remains open through your exam start time.`,
        checkInOpensAt: new Date(checkInOpensAt).toISOString()
      });
    }
    const session = { rollNo, examId: String(invite.examId || ''), pin, exp: Math.floor(Date.now() / 1000) + 4 * 60 * 60 };
    const token = sign({ ...session, exp: Math.floor(Date.now()/1000)+14400 });
    const normalize = value => value && ({ ...value, _id: undefined, id: String(value._id) });
    return res.status(200).json({ success: true, token, invite: normalize(invite), clientUpdate: { minimumVersion: process.env.SECURE_EXAM_MIN_VERSION || '1.0.12', downloadUrl: process.env.SECURE_EXAM_DOWNLOAD_URL || 'https://github.com/Kumar1199/Secure-app/releases/download/v1.0.12/SecureExam.Setup.1.0.12.exe' }, student: { rollNumber: rollNo, name: student?.name || invite.name || 'Student', examType: invite.examType || exam?.examType || exam?.type || 'MCQ', difficulty: invite.difficulty || exam?.difficulty || 'medium', subject: invite.subject || exam?.subject || exam?.title || 'General' }, schedule: normalize(exam || invite) });
  }
  return res.status(404).json({ error: 'Exam endpoint not found.' });
}
