import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {MongoClient} from 'mongodb';
import {ensureExamInvite} from '../api/examInvites.mjs';
const database='student360_verify_'+crypto.randomBytes(8).toString('hex');process.env.MONGODB_DB_NAME=database;process.env.JWT_SECRET=crypto.randomBytes(32).toString('hex');
const {handleAuth,handleExamApi}=await import('../api/mongoBackend.mjs');
const client=new MongoClient(process.env.MONGODB_URI);
async function call(handler,body,token,action,method='POST'){const result={};const res={status(code){result.status=code;return this;},json(data){result.data=data;return this;},setHeader(){}};await handler({method,headers:token?{authorization:`Bearer ${token}`}:{},body},res,action);return result;}
try{
 await client.connect();const db=client.db(database),password=crypto.randomBytes(18).toString('hex');
 const students=['CODE01','CODE02'].map(rollNo=>({_id:rollNo,rollNo,name:rollNo,email:`${rollNo.toLowerCase()}@example.test`}));
 const exams=[{_id:'exam-a',title:'Coding A',examType:'Coding',status:'scheduled'},{_id:'exam-b',title:'Interview B',examType:'AI Interview',status:'upcoming'}];
 await db.collection('students').insertMany(students);await db.collection('exams').insertMany(exams);
 const salt=crypto.randomBytes(16).toString('hex');await db.collection('users').insertOne({email:students[0].email,rollNo:'CODE01',role:'student',passwordSalt:salt,passwordHash:crypto.scryptSync(password,salt,64).toString('hex')});
 const same=await Promise.all(Array.from({length:12},()=>ensureExamInvite(db,exams[0],students[0])));assert.equal(new Set(same.map(i=>i.examCode)).size,1);
 const all=[];for(const exam of exams)for(const student of students)all.push(await ensureExamInvite(db,exam,student));
 assert.equal(new Set(all.map(i=>i.examCode)).size,4);assert.ok(all.every(i=>/^\d{6}$/.test(i.examCode)));
 const login=await call(handleAuth,{email:students[0].email,password},null,'login');assert.equal(login.status,200);
 const mine=await call(handleExamApi,null,login.data.token,'my-invites','GET');assert.equal(mine.status,200);assert.equal(mine.data.invitations.length,2);assert.ok(mine.data.invitations.every(i=>i.rollNo==='CODE01'));
 for(const invite of all){const resolved=await call(handleExamApi,{pin:invite.examCode},null,'validate-pin');assert.equal(resolved.status,200);assert.equal(resolved.data.student.rollNumber,invite.rollNo);assert.equal(resolved.data.schedule.id,invite.examId);}
 const refreshed=await call(handleExamApi,null,login.data.token,'my-invites','GET');assert.deepEqual(refreshed.data.invitations,mine.data.invitations);
 assert.equal((await call(handleExamApi,{pin:'000000'},null,'validate-pin')).status,401);
 console.log('PASS: random unique codes across every student/exam pair, concurrent allocation, stable refresh, private student display and exact Electron PIN resolution.');
}finally{await client.db(database).dropDatabase();await client.close();}
process.exit(0);
