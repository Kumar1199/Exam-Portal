import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { queueActivation, sendActivations } from '../api/activation.mjs';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const database = 'student360_verify_' + crypto.randomBytes(8).toString('hex');
process.env.MONGODB_DB_NAME = database;
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
delete process.env.BREVO_API_KEY;
const { handleMongo, handleAuth } = await import('../api/mongoBackend.mjs');
const client = new MongoClient(process.env.MONGODB_URI);
const originalFetch = globalThis.fetch;
const received = [];
async function call(handler, body, token, action, method = 'POST') {
 const result = {}; const res = { status(code) { result.status = code; return this; }, json(data) { result.data = data; return this; }, setHeader() {} };
 await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res, action); return result;
}
const tokenFrom = message => {
 const url = new URL(message.textContent.split('\n').find(line => line.startsWith('https://')));
 return new URLSearchParams(url.hash.slice(1)).get('token');
};
try {
 await client.connect(); const db = client.db(database);
 const salt = crypto.randomBytes(16).toString('hex'), password = crypto.randomBytes(18).toString('hex');
 await db.collection('users').insertOne({ email: 'admin@example.test', role: 'admin', passwordSalt: salt, passwordHash: crypto.scryptSync(password, salt, 64).toString('hex') });
 const admin = await call(handleAuth, { email: 'admin@example.test', password }, null, 'login'); assert.equal(admin.status,200);
 const auth = admin.data.token;
 const creation = await call(handleMongo, { collection: 'students', operation: 'upsert', id: 'ACT001', data: { rollNo: 'ACT001', name: 'Activation Check', email: 'student@example.test' } }, auth);
 assert.equal(creation.status,200); assert.equal(creation.data.activation.statuses.queued,1); assert.equal(creation.data.activation.delivery.configured,false);
 assert.equal((await call(handleAuth, { email: 'student@example.test', password }, null,'login')).status,401);
 process.env.BREVO_API_KEY='mock-only-not-a-real-key'; process.env.BREVO_SENDER_EMAIL='sender@example.test'; process.env.APP_BASE_URL='https://student360.example.test';
 globalThis.fetch=async (url, options) => { assert.equal(url,'https://api.brevo.com/v3/smtp/email'); const body=JSON.parse(options.body); received.push(...body.messageVersions); return {ok:true,status:201}; };
 const first=await sendActivations(db); assert.equal(first.sent,1);
 const token=tokenFrom(received[0]); assert.equal(token.length,64);
 const pending=await db.collection('users').findOne({email:'student@example.test'}); assert.notEqual(pending.activationHash,token); assert.ok(!pending.passwordHash);
 assert.equal((await call(handleAuth, {token,password:'short'},null,'activate')).status,400);
 const activated=await call(handleAuth, {token,password},null,'activate'); assert.equal(activated.status,200);
 assert.equal((await call(handleAuth, {token,password},null,'activate')).status,400);
 const login=await call(handleAuth, {email:'student@example.test',password},null,'login'); assert.equal(login.status,200); assert.equal(login.data.user.rollNo,'ACT001');
 const resendActive=await call(handleAuth,{studentId:'ACT001'},auth,'resend-activation'); assert.equal(resendActive.data.statuses.active,1);
 assert.equal((await call(handleAuth,{studentId:'ACT001'},login.data.token,'resend-activation')).status,403);
 const batch=await call(handleMongo,{collection:'students',operation:'batch',items:[{id:'ACT002',data:{rollNo:'ACT002',email:'two@example.test'}},{id:'ACT003',data:{rollNo:'ACT003',email:'three@example.test'}}]},auth);
 assert.equal(batch.status,200); assert.equal(batch.data.activation.delivery.sent,2);
 const tokenTwo=tokenFrom(received[1]), tokenThree=tokenFrom(received[2]);
 await db.collection('users').updateOne({email:'two@example.test'},{$set:{activationExpiresAt:new Date(0)}});
 assert.equal((await call(handleAuth,{token:tokenTwo,password},null,'activate')).status,400);
 await db.collection('students').deleteOne({_id:'ACT003'});
 assert.equal((await call(handleAuth,{token:tokenThree,password},null,'activate')).status,400);
 const collision=await queueActivation(db,{_id:'different-student',rollNo:'OTHER',email:'student@example.test'}); assert.equal(collision.status,'email_conflict');
 await db.collection('activationQueue').deleteMany({});
 const dailyKey=new Date().toISOString().slice(0,10); await db.collection('emailDailyUsage').deleteMany({}); process.env.ACTIVATION_DAILY_LIMIT='1';
 for(const id of ['QUOTA1','QUOTA2']) {const student={_id:id,rollNo:id,email:`${id.toLowerCase()}@example.test`};await db.collection('students').insertOne(student);await queueActivation(db,student);}
 const deliveries=await Promise.all([sendActivations(db),sendActivations(db)]); assert.equal(deliveries.reduce((sum,item)=>sum+item.sent,0),1);
 assert.equal((await db.collection('emailDailyUsage').findOne({_id:dailyKey})).count,1);
 assert.equal(await db.collection('activationQueue').countDocuments({status:'queued'}),1);
 await db.collection('emailDailyUsage').deleteMany({});process.env.ACTIVATION_DAILY_LIMIT='250';
 globalThis.fetch=async()=>({ok:false,status:429}); const failed=await sendActivations(db); assert.equal(failed.failed,1);assert.equal(await db.collection('activationQueue').countDocuments({status:'retry'}),1);
 console.log('PASS: manual/CSV pending accounts, unconfigured delivery, mocked Brevo email, hashed/expiring/single-use activation, student login, admin-only resend, email conflicts, deleted students, concurrent quota and delivery failure retry. No real email sent.');
} finally {
 globalThis.fetch=originalFetch;
 if(!database.startsWith('student360_verify_'))throw new Error('Unsafe cleanup target.');
 await client.db(database).dropDatabase();await client.close();
}
process.exit(0);
