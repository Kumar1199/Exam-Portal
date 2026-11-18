import admin from 'firebase-admin';
import { MongoClient } from 'mongodb';
import fs from 'node:fs';

const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || new URL('./serviceAccountKey.json', import.meta.url);
if (!fs.existsSync(keyPath)) throw new Error('Firebase Admin key missing. Set FIREBASE_SERVICE_ACCOUNT_PATH to its local path.');
const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8').replace(/^\uFEFF/, ''));
const apply = process.argv.includes('--apply');

if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI before migration.');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const mongo = new MongoClient(process.env.MONGODB_URI);
const source = admin.firestore();
const names = ['users','students','exams','examInvites','results','violations','awardedBadges','notifications','colleges','generated_questions','exam_submissions'];
function clean(value) {
  if (value && typeof value.toDate === 'function') return value.toDate();
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clean(item)]));
  return value;
}
try {
 await mongo.connect(); const target=mongo.db(process.env.MONGODB_DB_NAME || 'student360');
 for (const name of names) {
  const snapshot=await source.collection(name).get(); if(snapshot.empty) { console.log(`${name}: 0 documents`); continue; }
  const records = snapshot.docs.map(item => ({ ...clean(item.data()), _id: item.id }));
  if (!apply) { console.log(`${name}: ${records.length} documents available (preview only)`); continue; }
  // Preserve target records and credentials; rerunning only adds absent documents.
  const operations=records.map(record=>({updateOne:{filter:{_id:record._id},update:{$setOnInsert:record},upsert:true}}));
  for(let offset=0;offset<operations.length;offset+=500) await target.collection(name).bulkWrite(operations.slice(offset,offset+500),{ordered:false});
  console.log(`${name}: processed ${operations.length} documents; existing MongoDB records preserved`);
 }
} finally { await mongo.close(); await admin.app().delete(); }
