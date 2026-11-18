import { getDb } from '../api/mongoBackend.mjs';
const gradeFor = p => p>=90?'A+':p>=80?'A':p>=70?'B+':p>=60?'B':p>=50?'C':p>=40?'D':'F';
const statusFor = p => p>=40?'passed':'failed';
export async function submitExamResult(data) {
 try {
  const db=await getDb(); const rollNo=String(data.rollNo||'').trim().toUpperCase(); const marks=Number(data.marks); const totalMarks=Number(data.totalMarks);
  if(!rollNo||!Number.isFinite(marks)||!Number.isFinite(totalMarks)||totalMarks<=0) throw new Error('Valid roll number, marks, and total marks are required.');
  const percentage=Number(((marks/totalMarks)*100).toFixed(2)); const grade=gradeFor(percentage); const status=statusFor(percentage); const now=new Date();
  const result={...data,rollNo,marks,totalMarks,percentage,grade,status,startTime:data.startTime?new Date(data.startTime):null,endTime:data.endTime?new Date(data.endTime):null,submittedAt:now,source:'electron_app'};
  const saved=await db.collection('results').insertOne(result);
  await db.collection('students').updateOne({$or:[{_id:rollNo},{rollNo}]},{$push:{examHistory:{examId:data.examId,examTitle:data.examTitle,subject:data.subject,marks,totalMarks,percentage,grade,status,submittedAt:now}},$set:{lastExamDate:now}});
  return {success:true,resultId:String(saved.insertedId)};
 } catch(error){return {success:false,error:error.message};}
}
export async function submitBatchResults(rows){const results=[];for(const row of rows)results.push(await submitExamResult(row));return results;}
export async function getStudentResults(rollNo){const db=await getDb();return db.collection('results').find({rollNo:String(rollNo).toUpperCase()}).sort({submittedAt:-1}).toArray();}
export async function getExamResults(examId){const db=await getDb();return db.collection('results').find({examId}).sort({submittedAt:-1}).toArray();}
export {gradeFor as calculateGrade,statusFor as calculateStatus};