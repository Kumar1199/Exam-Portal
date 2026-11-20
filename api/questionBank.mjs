import {parseQuestionCsv} from '../src/utils/questionCsv.mjs';
import {publishBankResult} from './examResults.mjs';
import {gradeBank} from './codingRunner.mjs';
import {executeCode, runnerLanguages, executionPassed} from './codingRunner.mjs';

// Only transient compiler failures are eligible for unattended retry. A
// proctor-limit submission remains deliberately review-only.
const RETRY_DELAY_MS = 15_000;
const RETRY_LEASE_MS = 2 * 60_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;

export async function retryPendingEvaluations(db, limit = 10) {
  const now = new Date();
  const submissions = await db.collection('exam_submissions').find({
    evaluationPending: true,
    submissionReason: { $ne: 'proctor_limit' },
    $and: [
      { $or: [
        { evaluationRetryEligible: true },
        { evaluationError: { $in: ['Compiler service unavailable. Answers saved for retry.', 'Compiler service unavailable. Automatic retry scheduled.'] } },
      ] },
      { $or: [
        { nextEvaluationAttemptAt: { $lte: now } },
        { nextEvaluationAttemptAt: { $exists: false } },
      ] },
    ],
  }).sort({ nextEvaluationAttemptAt: 1 }).limit(Math.max(1, Math.min(25, limit))).toArray();
  const summary = { checked: submissions.length, completed: 0, deferred: 0, skipped: 0 };

  for (const submission of submissions) {
    // The lease is an atomic cross-instance lock. It prevents two cron
    // invocations from compiling the same student's solution concurrently.
    const claimed = await db.collection('exam_submissions').updateOne({
      _id: submission._id,
      evaluationPending: true,
      evaluationRetryEligible: true,
      $or: [
        { evaluationRetryLeaseUntil: { $exists: false } },
        { evaluationRetryLeaseUntil: { $lte: now } },
      ],
    }, { $set: { evaluationRetryLeaseUntil: new Date(Date.now() + RETRY_LEASE_MS) } });
    if (!claimed.modifiedCount) { summary.skipped++; continue; }

    try {
      const [bank, exam] = await Promise.all([
        db.collection('question_banks').findOne({ _id: String(submission.examId) }),
        // Existing data contains both ObjectId and string exam keys. Matching
        // their normalized server representation keeps retries compatible.
        db.collection('exams').findOne({ $expr: { $eq: [{ $toString: '$_id' }, String(submission.examId)] } }),
      ]);
      if (!bank || !exam) throw new Error('Question bank or exam is unavailable.');
      const grade = await gradeBank(bank, submission);
      await db.collection('exam_submissions').updateOne({ _id: submission._id }, {
        $set: { ...grade, evaluationError: null, evaluationRetryEligible: false, evaluationRetriedAt: new Date() },
        $unset: { evaluationRetryLeaseUntil: '', nextEvaluationAttemptAt: '' },
      });
      await publishBankResult(db, { ...submission, ...grade }, bank, exam);
      summary.completed++;
    } catch (error) {
      const attempts = Number(submission.evaluationRetryCount || 0) + 1;
      const delay = Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * (2 ** Math.min(attempts, 6)));
      await db.collection('exam_submissions').updateOne({ _id: submission._id }, {
        $set: {
          evaluationRetryCount: attempts,
          evaluationError: 'Compiler service unavailable. Automatic retry scheduled.',
          nextEvaluationAttemptAt: new Date(Date.now() + delay),
        },
        $unset: { evaluationRetryLeaseUntil: '' },
      });
      summary.deferred++;
    }
  }
  return summary;
}
export function studentBank(bank) {
  if (bank.type === 'MCQ') return {source:'csv',type:'MCQ',revision:bank.revision,questions:bank.questions.map(({correct,...q})=>q)};
  if (bank.type === 'Mixed') {
    const problems=bank.problems.map(({testCases,...p})=>({...p,examples:testCases.filter(t=>!t.hidden).map(t=>({input:t.input,output:t.expectedOutput})),hiddenTestCount:testCases.filter(t=>t.hidden).length}));
    return {source:'csv',type:'MIXED',revision:bank.revision,questions:bank.questions.map(({correct,...q})=>q),problems,problem:problems[0],languages:runnerLanguages()};
  }
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
  try {
    if (exam.examType === 'Mixed') {
      const mcq=parseQuestionCsv(req.body?.mcqCsv,'MCQ');
      const coding=parseQuestionCsv(req.body?.codingCsv,'Coding');
      bank={type:'Mixed',questions:mcq.questions,problems:coding.problems,totalMarks:mcq.totalMarks+coding.totalMarks};
    } else bank=parseQuestionCsv(req.body?.csv,exam.examType || 'MCQ');
  } catch(error) { return res.status(400).json({error:error.message}); }
  bank={...bank,source:'csv',revision:Date.now().toString(),updatedAt:new Date()};
  await db.collection('question_banks').replaceOne({_id:examId},{...bank,_id:examId},{upsert:true});
  await db.collection('generated_questions').deleteOne({_id:examId});
  await db.collection('exams').updateOne({_id:idValue(examId)},{$set:{questionSource:'csv',questionCount:(bank.questions?.length||0)+(bank.problems?.length||0),totalMarks:bank.totalMarks}});
  return res.status(200).json({bank});
}
