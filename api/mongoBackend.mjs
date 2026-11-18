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

let clientPromise, checkinIndexPromise;
const collections = new Set(['users', 'students', 'exams', 'examInvites', 'results', 'violations', 'awardedBadges', 'notifications', 'colleges', 'generated_questions', 'exam_submissions']);
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
  await checkinIndexPromise;
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
  if (name === 'students' && ['update', 'merge'].includes(operation)) return roll && String(id || '').toUpperCase() === roll && Object.keys(data).every(key => ['githubUrl', 'githubUsername'].includes(key));
  return false;
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
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const user = await db.collection('users').findOne({ email });
    if (!user?.passwordHash || !(user.passwordHash && safePassword(password, user.passwordSalt, user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password.' });
    const profile = { uid: String(user._id), email: user.email, name: user.name, role: user.role, rollNo: user.rollNo || null, studentId: user.studentId || null };
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
    await db.collection('users').updateOne({ email: normalizedEmail }, { $set: { email: normalizedEmail, name: name || 'Administrator', role: 'admin', passwordSalt: salt, passwordHash, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    return res.status(201).json({ success: true });
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
    const result = await collection.insertOne({ ...data, createdAt: data.createdAt || new Date(), updatedAt: new Date() });
    const activation = name === 'students' ? await prepareStudentActivations(db, [{ ...data, _id: result.insertedId }]) : undefined;
    return res.status(201).json({ id: String(result.insertedId), activation });
  }
  if (operation === 'upsert') {
    const documentId = idValue(id);
    await collection.replaceOne({ _id: documentId }, { ...data, _id: documentId, updatedAt: new Date() }, { upsert: true });
    const activation = name === 'students' ? await prepareStudentActivations(db, [{ ...data, _id: documentId }]) : undefined;
    return res.status(200).json({ id: String(documentId), activation });
  }
  if (operation === 'merge') {
    await collection.updateOne({ _id: idValue(id) }, { $set: { ...data, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    return res.status(200).json({ id: String(id) });
  }  if (operation === 'update') {
    const result = await collection.updateOne({ _id: idValue(id) }, { $set: { ...data, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ error: 'Record not found.' });
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

export async function handleExamApi(req, res, action) {
  const db = await getDb();
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
    const scheduledStart = exam.startTime || exam.start_time || exam.start || (exam.date && exam.time ? `${exam.date}T${exam.time}` : null);
    const startAt = scheduledStart ? new Date(scheduledStart).getTime() : NaN;
    const checkInOpensAt = startAt - (15 * 60 * 1000);
    if (Number.isFinite(startAt) && Date.now() < checkInOpensAt) {
      return res.status(403).json({
        success: false,
        message: 'Secure check-in opens 15 minutes before your scheduled exam time.',
        checkInOpensAt: new Date(checkInOpensAt).toISOString()
      });
    }
    const session = { rollNo, examId: String(invite.examId || ''), pin, exp: Math.floor(Date.now() / 1000) + 4 * 60 * 60 };
    const token = sign({ ...session, exp: Math.floor(Date.now()/1000)+14400 });
    const normalize = value => value && ({ ...value, _id: undefined, id: String(value._id) });
    return res.status(200).json({ success: true, token, invite: normalize(invite), student: { rollNumber: rollNo, name: student?.name || invite.name || 'Student', examType: invite.examType || exam?.examType || exam?.type || 'MCQ', difficulty: invite.difficulty || exam?.difficulty || 'medium', subject: invite.subject || exam?.subject || exam?.title || 'General' }, schedule: normalize(exam || invite) });
  }
  return res.status(404).json({ error: 'Exam endpoint not found.' });
}
