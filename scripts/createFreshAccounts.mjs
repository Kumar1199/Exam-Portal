import crypto from 'node:crypto';
import fs from 'node:fs';
import { MongoClient } from 'mongodb';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const client = new MongoClient(process.env.MONGODB_URI);
const accounts = [
  { email: 'admin@s360.edu', role: 'admin', name: 'Administrator' },
  { email: 'student.demo@s360.edu', role: 'student', name: 'Demo Student', rollNo: 'DEMO001', studentId: 'DEMO001' }
];
try {
  await client.connect(); const db = client.db(process.env.MONGODB_DB_NAME || 'student360');
  if (await db.collection('users').findOne({ email: { $in: accounts.map(a => a.email) } })) throw new Error('One of these accounts already exists. No passwords were changed.');
  if (await db.collection('students').findOne({ _id: 'DEMO001' })) throw new Error('DEMO001 already exists. No student data was changed.');
  const documents = accounts.map(account => {
    account.password = crypto.randomBytes(18).toString('base64url');
    const { password, ...profile } = account;
    const passwordSalt = crypto.randomBytes(16).toString('hex');
    return { ...profile, passwordSalt, passwordHash: crypto.scryptSync(password, passwordSalt, 64).toString('hex'), createdAt: new Date() };
  });
  await db.collection('students').insertOne({ _id: 'DEMO001', rollNo: 'DEMO001', name: 'Demo Student', email: 'student.demo@s360.edu', branch: [], createdAt: new Date() });
  await db.collection('users').insertMany(documents);
  fs.writeFileSync('fresh-credentials.local', JSON.stringify(accounts, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(accounts.map(({ email, role, password, rollNo }) => ({ email, role, password, rollNo })), null, 2));
} finally { await client.close(); }
