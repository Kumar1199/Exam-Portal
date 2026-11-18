import { MongoClient } from 'mongodb';
import { ensureExamInvite } from '../api/examInvites.mjs';
import { studentMatchesExam } from '../src/utils/examAudience.js';
const client=new MongoClient(process.env.MONGODB_URI);
try{
 await client.connect();const db=client.db(process.env.MONGODB_DB_NAME||'student360');
 const exams=await db.collection('exams').find({status:{$in:['upcoming','scheduled']}}).toArray();
 const students=await db.collection('students').find({rollNo:{$type:'string'}}).toArray();let count=0;
 for(const exam of exams)for(const student of students.filter(student=>studentMatchesExam(exam,student))){await ensureExamInvite(db,exam,student);count++;}
 console.log(`Verified invitations for ${count} eligible student/exam pairs across ${exams.length} active exams. No email was sent.`);
}finally{await client.close();}
