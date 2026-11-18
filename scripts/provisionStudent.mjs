import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';

const email = String(process.env.STUDENT_EMAIL || '').trim().toLowerCase();
const rollNo = String(process.env.STUDENT_ROLL_NO || '').trim().toUpperCase();
const password = process.env.STUDENT_PASSWORD || '';
if (!process.env.MONGODB_URI || !email.includes('@') || !rollNo || password.length < 12) {
  throw new Error('Set MONGODB_URI, STUDENT_EMAIL, STUDENT_ROLL_NO and STUDENT_PASSWORD (at least 12 characters).');
}
const client = new MongoClient(process.env.MONGODB_URI);
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || 'student360');
  const student = await db.collection('students').findOne({ $or: [{ _id: rollNo }, { rollNo }] });
  if (!student) throw new Error('Create or import the student record before provisioning login.');
  const existing = await db.collection('users').findOne({ $or: [{ email }, { rollNo }] });
  if (existing) throw new Error('An account already uses this email or roll number. No credentials were changed.');
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(password, passwordSalt, 64).toString('hex');
  await db.collection('users').insertOne({ email, rollNo, studentId: String(student._id), name: student.name || rollNo, role: 'student', passwordSalt, passwordHash, createdAt: new Date() });
  console.log('Student account created.');
} finally { await client.close(); }
