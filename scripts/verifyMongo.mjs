import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { MongoClient } from 'mongodb';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const database = 'student360_verify_' + crypto.randomBytes(8).toString('hex');
process.env.MONGODB_DB_NAME = database;
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
const { handleMongo, handleAuth, handleExamApi } = await import('../api/mongoBackend.mjs');
const client = new MongoClient(process.env.MONGODB_URI);
async function call(handler, body, token, action) {
  const result = {};
  const res = { status(code) { result.status = code; return this; }, json(data) { result.data = data; return this; } };
  await handler({ method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res, action);
  return result;
}
try {
  await client.connect(); const db = client.db(database);
  const password = crypto.randomBytes(20).toString('hex');
  for (const role of ['admin', 'student']) {
    const salt = crypto.randomBytes(16).toString('hex');
    await db.collection('users').insertOne({ email: role + '@example.test', role, rollNo: role === 'student' ? 'TEST01' : null, passwordSalt: salt, passwordHash: crypto.scryptSync(password, salt, 64).toString('hex') });
  }
  const admin = await call(handleAuth, { email: 'admin@example.test', password }, null, 'login');
  const student = await call(handleAuth, { email: 'student@example.test', password }, null, 'login');
  assert.equal(admin.status, 200); assert.equal(student.status, 200);
  const a = admin.data.token, s = student.data.token;
  assert.equal((await call(handleMongo, { collection: 'students' })).status, 401);
  assert.equal((await call(handleMongo, { collection: 'students', operation: 'upsert', id: 'TEST01', data: { rollNo: 'TEST01', name: 'Verification Student' } }, a)).status, 200);
  const record = await call(handleMongo, { collection: 'students', operation: 'get', id: 'TEST01' }, s);
  assert.equal(record.status, 200); assert.equal(record.data.document.name, 'Verification Student');
  assert.equal((await call(handleMongo, { collection: 'students', operation: 'get', id: 'OTHER' }, s)).status, 403);
  assert.equal((await call(handleMongo, { collection: 'students', operation: 'merge', id: 'TEST01', data: { cgpa: 10 } }, s)).status, 403);
  assert.equal((await call(handleMongo, { collection: 'students', operation: 'merge', id: 'TEST01', data: { githubUsername: 'example' } }, s)).status, 200);
  assert.equal((await call(handleMongo, { collection: 'students', filters: [{ field: 'rollNo', value: { $ne: '' } }] }, s)).status, 400);
  const college = await call(handleMongo, { collection: 'colleges', operation: 'insert', data: { name: 'Verification College', branches: ['CSE'] } }, a);
  assert.equal(college.status, 201);
  assert.equal((await call(handleMongo, { collection: 'colleges', operation: 'update', id: college.data.id, data: { branches: ['CSE','ECE'] } }, a)).status, 200);
  assert.equal((await call(handleMongo, { collection: 'students', operation: 'batch', items: [{ id: 'TEST02', data: { rollNo: 'TEST02' } }] }, a)).status, 200);
  await db.collection('exams').insertOne({ _id: 'exam-test', title: 'Verification Exam' });
  await db.collection('examInvites').insertOne({ _id: 'invite-test', examCode: '987654', examId: 'exam-test', rollNo: 'TEST01' });
  const exam = await call(handleExamApi, { pin: '987654' }, null, 'validate-pin');
  assert.equal(exam.status, 200); assert.equal(exam.data.invite.examId, 'exam-test'); assert.equal(exam.data.schedule.id, 'exam-test');
  const submitted = await call(handleMongo, { collection: 'exam_submissions', operation: 'insert', data: { studentId: 'TEST01', examId: 'exam-test', score: 1 } }, exam.data.token);
  assert.equal(submitted.status, 201);
  const replay = await call(handleMongo, { collection: 'exam_submissions', operation: 'insert', data: { studentId: 'TEST01', examId: 'exam-test', score: 999 } }, exam.data.token);
  assert.equal(replay.data.id, submitted.data.id);
  assert.equal(await db.collection('exam_submissions').countDocuments({ studentId: 'TEST01', examId: 'exam-test' }), 1);
  assert.equal((await db.collection('exam_submissions').findOne({ studentId: 'TEST01', examId: 'exam-test' })).score, 1);
  const evidence = process.env.PROCTOR_EVIDENCE_FIXTURE ? { image: 'data:image/jpeg;base64,'+fs.readFileSync(process.env.PROCTOR_EVIDENCE_FIXTURE).toString('base64'), capturedAt: new Date().toISOString(), regions: [{type:'phone',x:0.1,y:0.1,width:0.4,height:0.5,score:0.95}] } : undefined;
  const forced = await call(handleMongo, { collection: 'exam_submissions', operation: 'insert', data: { studentId: 'TEST02', examId: 'exam-test', code: 'Current draft', submissionReason: 'proctor_limit', proctorReport: { strikes: 3, events: [1,2,3].map(strike => ({ type: 'confirmed_incident', strike, reasons: ['phone_detected'], faceCount: 1, phoneConfidence: 0.95, timestamp: new Date().toISOString(), action: strike === 3 ? 'auto_submit' : 'warning', evidence })) } } }, a);
  assert.equal(forced.status,201);assert.equal(await db.collection('violations').countDocuments({rollNumber:'TEST02'}),3);
  const incidents=await db.collection('violations').find({rollNumber:'TEST02'}).toArray();
  assert.equal((await call(handleMongo,{collection:'violations',operation:'list',filters:[{field:'rollNumber',op:'!=',value:'TEST01'}]},s)).status,403);
  assert.equal((await call(handleMongo,{collection:'violations',operation:'get',id:incidents[0]._id,filters:[{field:'rollNumber',op:'==',value:'TEST01'}]},s)).status,403);
  if(evidence){assert.ok(incidents.every(incident=>incident.evidence?.image===evidence.image));assert.equal((await db.collection('exam_submissions').findOne({_id:forced.data.id})).proctorReport.events.filter(event=>event.evidence?.image).length,3);console.log('PASS: bounded incident snapshots persist in submission/admin records; unrelated students cannot read them.');}
  console.log('PASS: submission retries do not duplicate or overwrite saved answers, and proctor incidents appear in the admin violation collection.');
  await db.collection('colleges').insertOne({ _id: 'college-b', name: 'Other College', branches: ['MECH','CSE'] });
  await db.collection('students').updateOne({ _id: 'TEST01' }, { $set: { college: 'Verification College', branch: ['CSE'] } });
  const target = { audienceMode: 'selected', audience: [
    { collegeId: college.data.id, collegeName: 'Verification College', branches: ['CSE','ECE'] },
    { collegeId: 'college-b', collegeName: 'Other College', branches: ['MECH'] },
  ] };
  const targeted = await call(handleMongo, { collection: 'exams', operation: 'insert', data: { title: 'Targeted exam', ...target } }, a);
  assert.equal(targeted.status, 201);
  let visible = await call(handleMongo, { collection: 'exams', operation: 'list' }, s);
  assert.ok(visible.data.documents.some(item => item.id === targeted.data.id));
  const changed = { audienceMode: 'selected', audience: [{ collegeId: 'college-b', collegeName: 'Other College', branches: ['MECH'] }] };
  assert.equal((await call(handleMongo, { collection: 'exams', operation: 'update', id: targeted.data.id, data: changed }, a)).status, 200);
  visible = await call(handleMongo, { collection: 'exams', operation: 'list' }, s);
  assert.ok(!visible.data.documents.some(item => item.id === targeted.data.id));
  assert.equal((await call(handleMongo, { collection: 'exams', operation: 'get', id: targeted.data.id }, s)).status, 403);
  await db.collection('examInvites').insertOne({ examCode: '111111', examId: targeted.data.id, rollNo: 'TEST01' });
  assert.equal((await call(handleExamApi, { pin: '111111' }, null, 'validate-pin')).status, 403);
  const invalid = await call(handleMongo, { collection: 'exams', operation: 'insert', data: { audienceMode: 'selected', audience: [{ collegeId: 'college-b', branches: [] }] } }, a);
  assert.equal(invalid.status, 400);
  await db.collection('students').updateOne({ _id: 'TEST01' }, { $set: { college: 'Other College', branch: 'MECH' } });
  const eligibleSession = await call(handleExamApi, { pin: '111111' }, null, 'validate-pin');
  assert.equal(eligibleSession.status, 200);
  await db.collection('students').updateOne({ _id: 'TEST01' }, { $set: { branch: 'CSE' } });
  assert.equal((await call(handleMongo, { collection: 'exam_submissions', operation: 'insert', data: { studentId: 'TEST01', examId: targeted.data.id } }, eligibleSession.data.token)).status, 403);
  console.log('PASS: college/branch targeting, multiple branches, audience edits, invalid selections, exam visibility, and PIN eligibility.');
  assert.equal((await call(handleMongo, { collection: 'colleges', operation: 'delete', id: college.data.id }, a)).status, 200);
  assert.equal((await call(handleMongo, { collection: 'students', operation: 'delete', id: 'TEST02' }, a)).status, 200);
  console.log('PASS: login, access control, document reads, college CRUD, student batch/delete, exam PIN and submission.');
} finally {
  if (!database.startsWith('student360_verify_')) throw new Error('Refusing cleanup outside verification database.');
  await client.db(database).dropDatabase();
  await client.close();
  // The backend caches its client for a server process; explicitly exit this CLI.
}
process.exit(0);
