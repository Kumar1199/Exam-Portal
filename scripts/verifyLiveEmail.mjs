import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadEnv } from 'vite';
import { MongoClient } from 'mongodb';
import { queueActivation, sendActivations } from '../api/activation.mjs';

const env = loadEnv('development',process.cwd(),'');
for (const name of ['MONGODB_URI','MONGODB_DB_NAME','BREVO_API_KEY','BREVO_SENDER_EMAIL','BREVO_SENDER_NAME','APP_BASE_URL','ACTIVATION_DAILY_LIMIT']) if(env[name])process.env[name]=env[name];
if (!env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const filename = '.activation-live.local';
const client = new MongoClient(env.MONGODB_URI);
const originalFetch = globalThis.fetch;
try {
 await client.connect(); const db=client.db(env.MONGODB_DB_NAME||'student360');
 if(process.argv.includes('--events')) {
  const check=JSON.parse(fs.readFileSync(filename,'utf8'));
  if(!check.messageId)throw new Error('No provider message ID was recorded.');
  const url=new URL('https://api.brevo.com/v3/smtp/statistics/events');url.searchParams.set('messageId',check.messageId);url.searchParams.set('limit','20');
  const response=await fetch(url,{headers:{'api-key':env.BREVO_API_KEY},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Could not read delivery events (${response.status}).`);
  const result=await response.json();
  console.log(JSON.stringify({recipient:check.email,events:(result.events||[]).map(event=>({event:event.event,date:event.date,reason:event.reason}))}));
 } else if(process.argv.includes('--cleanup')) {
  const check=JSON.parse(fs.readFileSync(filename,'utf8'));
  const record=await db.collection('students').findOne({_id:check.studentId,verificationRun:check.runId});
  if(!record)throw new Error('Test student identity did not match; refusing cleanup.');
  await db.collection('activationQueue').deleteOne({_id:`activation:${check.studentId}`,email:check.email});
  await db.collection('users').deleteOne({studentId:check.studentId,email:check.email,role:'student'});
  await db.collection('students').deleteOne({_id:check.studentId,verificationRun:check.runId});
  fs.unlinkSync(filename);console.log('Temporary live-email verification account and private test artifact removed.');
 } else {
  if(fs.existsSync(filename))throw new Error('An earlier live verification artifact exists. Complete or clean up that run first.');
  const email=env.BREVO_TEST_EMAIL||env.BREVO_SENDER_EMAIL;
  if(!email)throw new Error('Set a verified sender before testing.');
  if(await db.collection('users').findOne({email}) || await db.collection('students').findOne({email}))throw new Error('The test email already belongs to an account. Set BREVO_TEST_EMAIL to another mailbox you control.');
  const runId=crypto.randomBytes(10).toString('hex');
  const check={runId,studentId:`EMAILCHECK-${runId}`,email,password:crypto.randomBytes(20).toString('base64url')};
  fs.writeFileSync(filename,JSON.stringify(check),{flag:'wx',mode:0o600});
  const student={_id:check.studentId,rollNo:check.studentId,name:'Temporary Email Activation Check',email,verificationRun:runId,createdAt:new Date()};
  await db.collection('students').insertOne(student);await queueActivation(db,student);
  globalThis.fetch=async(url,options)=>{
   const body=JSON.parse(options.body);
   const message=body.messageVersions?.find(item=>item.to?.some(recipient=>recipient.email===email));
   if(message){check.activationUrl=message.textContent.split('\n').find(line=>line.startsWith('http'));fs.writeFileSync(filename,JSON.stringify(check),{mode:0o600});}
   const response=await originalFetch(url,options);
   const result=await response.clone().json().catch(()=>({}));
   check.providerStatus=response.status;check.messageId=result.messageId||result.messageIds?.[0];check.providerCode=result.code;
   fs.writeFileSync(filename,JSON.stringify(check),{mode:0o600});
   return response;
  };
  const delivery=await sendActivations(db,1);
  if(!delivery.sent || !check.activationUrl){const job=await db.collection('activationQueue').findOne({_id:`activation:${check.studentId}`});throw new Error(job?.lastError||'Live activation email was not sent.');}
  console.log(JSON.stringify({sent:delivery.sent,recipient:email,providerStatus:check.providerStatus,linkOrigin:new URL(check.activationUrl).origin,privateArtifact:filename}));
 }
} finally {globalThis.fetch=originalFetch;await client.close();}
