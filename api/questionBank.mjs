import {parseQuestionCsv} from '../src/utils/questionCsv.mjs';
import {publishBankResult} from './examResults.mjs';
import {gradeBank} from './codingRunner.mjs';
import {executeCode, runnerLanguages, executionPassed} from './codingRunner.mjs';
export function studentBank(bank) {
  if (bank.type === 'MCQ') return {source:'csv',type:'MCQ',revision:bank.revision,questions:bank.questions.map(({correct,...q})=>q)};
  if (bank.type === 'AI Interview') return {source:'csv',type:'AI Interview',revision:bank.revision,questions:bank.questions.map(({expectedKeyPoints,...q})=>q)};
  const problems = bank.problems.map(({testCases,...p}) => ({...p,examples:testCases.filter(t=>!t.hidden).map(t=>({input:t.input,output:t.expectedOutput})),hiddenTestCount:testCases.filter(t=>t.hidden).length}));
  return {source:'csv',type:'CODING',revision:bank.revision,problems,problem:problems[0],languages:runnerLanguages()};
}
export async function questionBankApi(req,res,db,user,action,idValue) {
  if (!user) return res.status(401).json({error:'Sign in required.'});
  const admin=user.role==='admin';
  if (action === 'runner-check') {
    if (!admin || req.method !== 'POST') return res.status(403).json({error:'Administrator access required.'});
    const language = req.body?.language || 'python';
    const programs={python:'a,b=map(int,input().split())\nprint(a+b)',c:'#include <stdio.h>\nint main(){int a,b;scanf("%d%d",&a,&b);printf("%d\\n",a+b);return 0;}',cpp:'#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}',java:'class Main {public static void main(String[] a){java.util.Scanner s=new java.util.Scanner(System.in);System.out.println(s.nextInt()+s.nextInt());}}'};
    try { const result=await executeCode({code:programs[language],language,stdin:'2 3'});const passed=executionPassed(result,'5'); return res.status(200).json({languages:runnerLanguages(),passed,message:passed?'Runner returned the expected answer.':'Runner responded, but the sample program did not pass.'}); }
    catch { return res.status(503).json({languages:runnerLanguages(),error:'Runner unavailable or not configured. Submissions remain pending when the runner is unavailable.'}); }
  }
  const examId=admin ? String(req.query?.examId || req.body?.examId || '') : String(user.examId || '');
  if (!examId) return res.status(403).json({error:'An exam session is required.'});
  const exam=await db.collection('exams').findOne({_id:idValue(examId)});
  if (!exam) return res.status(404).json({error:'Exam not found.'});
  if (!admin) {
    const student=await db.collection('students').findOne({rollNo:user.rollNo});
    const {studentMatchesExam}=await import('../src/utils/examAudience.js');
    if (!student || !studentMatchesExam(exam,student)) return res.status(403).json({error:'You are not eligible for this exam.'});
    if (req.query?.examId && req.query.examId !== examId) return res.status(403).json({error:'This is another exam.'});
  }
  if (action === 'run-code') {
    if (!user.examId || req.method !== 'POST' || !await db.collection('question_banks').findOne({_id:examId})) return res.status(403).json({error:'An uploaded exam session is required.'});
    try { return res.status(200).json(await executeCode(req.body||{})); } catch(e) { return res.status(503).json({error:e.message}); }
  }
  if (action === 'evaluations') {
    if (!admin) return res.status(403).json({error:'Administrator access required.'});
    if (req.method === 'GET') {
      const submissions=await db.collection('exam_submissions').find({examId}).sort({createdAt:-1}).limit(100).toArray();
      return res.status(200).json({submissions:submissions.map(s=>({id:String(s._id),studentId:s.studentId,score:s.score,totalMarks:s.totalMarks,evaluationPending:s.evaluationPending,results:s.results,solutions:s.solutions}))});
    }
    if (req.method !== 'POST') return res.status(405).json({error:'Use GET or POST.'});
    const stored=await db.collection('exam_submissions').findOne({_id:idValue(String(req.body?.submissionId||'')),examId});
    const bank=await db.collection('question_banks').findOne({_id:examId});
    if (!stored || !bank) return res.status(404).json({error:'Submission or question bank not found.'});
    try {
      const grade=await gradeBank(bank,stored);
      await db.collection('exam_submissions').updateOne({_id:stored._id},{$set:{...grade,evaluationError:null}});
      await publishBankResult(db,{...stored,...grade},bank,exam);
      return res.status(200).json({success:true});
    } catch { return res.status(503).json({error:'Compiler unavailable. The saved submission remains pending; retry later.'}); }
  }
  res.setHeader?.('Cache-Control','no-store');
  if (req.method==='GET') {
    const bank=await db.collection('question_banks').findOne({_id:examId});
    return res.status(200).json({bank:bank ? admin ? {...bank,_id:undefined,languages:runnerLanguages()} : studentBank(bank) : null});
  }
  if (!admin || req.method!=='POST') return res.status(403).json({error:'Administrator access required.'});
  if (await db.collection('exam_submissions').findOne({examId})) return res.status(409).json({error:'Questions are locked after the first submission. Create a new exam to change them.'});
  let bank;
  try { bank=parseQuestionCsv(req.body?.csv,exam.examType || 'MCQ'); } catch(error) { return res.status(400).json({error:error.message}); }
  bank={...bank,source:'csv',revision:Date.now().toString(),updatedAt:new Date()};
  await db.collection('question_banks').replaceOne({_id:examId},{...bank,_id:examId},{upsert:true});
  await db.collection('generated_questions').deleteOne({_id:examId});
  await db.collection('exams').updateOne({_id:idValue(examId)},{$set:{questionSource:'csv',questionCount:(bank.questions||bank.problems).length,totalMarks:bank.totalMarks}});
  return res.status(200).json({bank});
}
