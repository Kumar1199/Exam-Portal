import { MongoClient } from 'mongodb';
if(process.env.CONFIRM_DELETE_STUDENTS!=='YES') throw new Error('Set CONFIRM_DELETE_STUDENTS=YES to delete all MongoDB student records.');
if(!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI.'); const client=new MongoClient(process.env.MONGODB_URI);
try { await client.connect(); const result=await client.db(process.env.MONGODB_DB_NAME||'student360').collection('students').deleteMany({}); console.log(`Deleted ${result.deletedCount} student records.`); } finally { await client.close(); }