const ids = {c:50, cpp:54, java:62, python:71};
export function runnerLanguages() {
  return Object.keys(ids);
}
export function normalizeOutput(value) {
  return String(value ?? '').replace(/\r\n?/g,'\n').trim().replace(/\s+/g,' ');
}
export async function executeCode({code, language, stdin = ''}) {
  if (typeof code !== 'string' || !code.trim() || code.length > 100000 || typeof stdin !== 'string' || stdin.length > 100000) throw new Error('Code/input is empty or too large.');
  if (!Object.hasOwn(ids, language)) throw new Error(`Unsupported language: ${language}.`);
  const direct = process.env[`COMPILER_${language.toUpperCase()}_URL`];
  const attempts = [];
  if (direct) attempts.push(async () => {
    const response = await fetch(direct, { method:'POST', signal:AbortSignal.timeout(12000), headers:{'Content-Type':'application/json'}, body:JSON.stringify({code,stdin}) });
    if (!response.ok) throw new Error(`Configured compiler returned HTTP ${response.status}.`);
    return response.json();
  });
  if (process.env.JUDGE0_URL && process.env.JUDGE0_API_KEY) attempts.push(async () => {
    const url = process.env.JUDGE0_URL.replace(/\/$/,'') + '/submissions?base64_encoded=false&wait=true';
    const response = await fetch(url, { method:'POST', signal:AbortSignal.timeout(20000), headers:{'Content-Type':'application/json','x-rapidapi-key':process.env.JUDGE0_API_KEY,'x-rapidapi-host':process.env.JUDGE0_HOST || new URL(url).hostname}, body:JSON.stringify({source_code:code,language_id:ids[language],stdin,cpu_time_limit:2,wall_time_limit:5,memory_limit:128000}) });
    if (!response.ok) throw new Error(`Judge runner returned HTTP ${response.status}.`);
    return response.json();
  });
  attempts.push(async () => {
    const response = await fetch('https://ce.judge0.com/submissions?base64_encoded=false&wait=true', { method:'POST', signal:AbortSignal.timeout(25000), headers:{'Content-Type':'application/json'}, body:JSON.stringify({source_code:code,language_id:ids[language],stdin,cpu_time_limit:2,wall_time_limit:5,memory_limit:128000}) });
    if (!response.ok) throw new Error(`Free compiler runner returned HTTP ${response.status}.`);
    const result = await response.json();
    return result;
  });
  attempts.reverse();
  let lastError;
  for (const attempt of attempts) {
    try {
      const data = await attempt();
      if (data?.error || data?.success === false) throw new Error('Compiler service could not execute the program.');
      const result = data?.data && typeof data.data === 'object' ? data.data : data;
      if (result.stdout === undefined && !result.stderr && !result.compile_output && !result.status && result.output === undefined) throw new Error('Compiler returned an unsupported response.');
      return {...result, stdout:String(result.stdout ?? result.output ?? '').slice(0,100000)};
    } catch (error) { lastError = error; }
  }
  throw new Error(lastError?.message || 'Compiler service unavailable.');
}
export function executionPassed(result, expected) {
  return !result.stderr && !result.compile_output && !result.error && (result.exit_code === undefined || Number(result.exit_code) === 0) && (!result.status || (typeof result.status === 'object' ? result.status.id === 3 : ['success','accepted','ok'].includes(String(result.status).toLowerCase()))) && normalizeOutput(result.stdout) === normalizeOutput(expected);
}
export async function gradeBank(bank, payload, runner = executeCode) {
  if (bank.type === 'AI Interview') return {score:null,totalMarks:bank.totalMarks,percentage:null,evaluationPending:true};
  if (bank.type === 'MCQ') {
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    const score = bank.questions.reduce((sum,q,i) => sum+(Number.isInteger(answers[i]) && answers[i] === q.correct ? q.marks : 0),0);
    return {score, totalMarks:bank.totalMarks, percentage:Math.round(score/bank.totalMarks*100), evaluationPending:false};
  }
  const solutions = Array.isArray(payload.solutions) ? payload.solutions : [{problemId:bank.problems[0].id, code:payload.code || '', language:payload.language}];
  const deadline=Date.now()+60000;
  const results = []; let passedCases=0, totalCases=0, score=0;
  for (const problem of bank.problems) {
    const solution = solutions.find(s => s.problemId === problem.id);
    let problemPassed=0;
    for (const [index,tc] of problem.testCases.entries()) {
      totalCases++;
      if (!solution?.code?.trim()) { results.push({problemId:problem.id,case:index+1,hidden:tc.hidden,passed:false,status:'Unanswered'}); continue; }
      if (Date.now()>deadline) throw new Error('Grading time limit reached; retry from administrator review.');
      const execution = await runner({code:solution.code,language:solution.language,stdin:tc.input});
      const passed = executionPassed(execution,tc.expectedOutput);
      if (passed) { passedCases++; problemPassed++; }
      results.push({problemId:problem.id,case:index+1,hidden:tc.hidden,passed,status:passed?'Accepted':execution.status?.description || (execution.stderr || execution.compile_output ? 'Execution error':'Wrong answer')});
    }
    score += problem.marks * problemPassed / problem.testCases.length;
  }
  return {score:Math.round(score*100)/100,totalMarks:bank.totalMarks,percentage:Math.round(score/bank.totalMarks*100),passedCases,totalCases,allPassed:totalCases>0 && passedCases===totalCases,results,evaluationPending:false};
}
