// Shared browser/server validation. No partial imports: every row must be valid.
export function parseCsv(text) {
  if (typeof text !== 'string' || text.length > 1000000) throw new Error('CSV must be at most 1 MB.');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const push = () => { row.push(cell); if (row.some(c => c.trim())) rows.push(row); row = []; cell = ''; closed = false; };
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += ch; }
    else if (ch === ',' ) { row.push(cell); cell = ''; closed = false; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i+1] === '\n') i++; push(); }
    else if (ch === '"') { if (cell.trim() || closed) throw new Error(`Invalid quote near CSV row ${rows.length+1}.`); quoted = true; cell = ''; }
    else if (closed && ch.trim()) throw new Error(`Unexpected text after closing quote near row ${rows.length+1}.`);
    else if (!closed) cell += ch;
  }
  if (quoted) throw new Error('Unclosed quoted cell. Put multiline text inside double quotes.');
  push(); return rows;
}
const fields = {
  MCQ: ['question_id','question','option_a','option_b','option_c','option_d','correct_option','marks'],
  Coding: ['problem_id','title','description','input_format','output_format','constraints','marks','test_input','expected_output','visibility'],
  'AI Interview': ['question_id','question','expected_key_points','follow_up','marks'],
};
const multiline = value => value.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
export function parseQuestionCsv(text, type) {
  if (!fields[type]) throw new Error('CSV upload supports MCQ and Coding exams.');
  const [rawHeaders, ...rows] = parseCsv(text);
  if (!rawHeaders || !rows.length) throw new Error('CSV needs a header and at least one data row.');
  const headers = rawHeaders.map(h => h.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate column names.');
  const missing = fields[type].filter(h => !headers.includes(h));
  if (missing.length) throw new Error(`Missing columns: ${missing.join(', ')}.`);
  if (rows.length > 2000) throw new Error('Maximum 2,000 CSV rows.');
  const questions = [], problems = new Map();
  for (const [index, cells] of rows.entries()) {
    const fail = msg => { throw new Error(`Row ${index+2}: ${msg}`); };
    if (cells.length !== headers.length) fail('Column count differs from header. Quote cells containing commas.');
    const r = Object.fromEntries(headers.map((h,i) => [h, cells[i].trim()]));
    const id = r.question_id || r.problem_id;
    if (!/^[\w-]{1,64}$/.test(id || '')) fail('Use a question/problem ID with letters, numbers, underscores or hyphens (max 64).');
    const marks = Number(r.marks);
    if (!Number.isFinite(marks) || marks <= 0 || marks > 1000) fail('Marks must be greater than 0 and at most 1,000.');
    if (type === 'MCQ') {
      if (questions.some(q => q.id === id)) fail(`Duplicate question ID ${id}.`);
      if (!r.question || !r.option_a || !r.option_b || !r.option_c || !r.option_d) fail('Question and all four options are required.');
      if (!/^[ABCD]$/i.test(r.correct_option)) fail('correct_option must be A, B, C or D.');
      const options = ['a','b','c','d'].map(k => multiline(r[`option_${k}`]));
      if (new Set(options).size !== 4) fail('The four options must be different.');
      questions.push({id, question: multiline(r.question), options, correct: 'ABCD'.indexOf(r.correct_option.toUpperCase()), marks});
    } else if (type === 'Coding') {
      const existing = problems.get(id);
      if (!existing && (!r.title || !r.description || !r.input_format || !r.output_format)) fail('First row of each problem needs title, description, input_format and output_format.');
      if (!['sample','hidden'].includes(r.visibility.toLowerCase())) fail('visibility must be sample or hidden.');
      if (!existing) problems.set(id, {id, title:r.title, description:multiline(r.description), inputFormat:multiline(r.input_format), outputFormat:multiline(r.output_format), constraints:multiline(r.constraints), marks, testCases:[]});
      const p = problems.get(id);
      if (p.marks !== marks) fail('Keep the same marks on every row for a problem.');
      for (const [column,key] of [['title','title'],['description','description'],['input_format','inputFormat'],['output_format','outputFormat'],['constraints','constraints']]) {
        if (existing && r[column] && multiline(r[column]) !== p[key]) fail(`Conflicting ${column} for ${id}. Leave repeated metadata blank or identical.`);
      }
      const tc = {input:multiline(r.test_input), expectedOutput:multiline(r.expected_output), hidden:r.visibility.toLowerCase()==='hidden'};
      if (p.testCases.some(t => t.input === tc.input)) fail(`Duplicate test input for ${id}.`);
      p.testCases.push(tc);
      if (p.testCases.length > 50) fail('Maximum 50 test cases per problem.');
    } else {
      if (questions.some(q => q.id === id)) fail(`Duplicate question ID ${id}.`);
      if (!r.question) fail('A question is required.');
      const expectedKeyPoints = multiline(r.expected_key_points).split(/[;|]/).map(point => point.trim()).filter(Boolean);
      if (!expectedKeyPoints.length) fail('expected_key_points needs at least one point, separated by semicolons.');
      questions.push({id, question:multiline(r.question), expectedKeyPoints, followUp:multiline(r.follow_up), marks});
    }
  }
  if ((type === 'MCQ' || type === 'AI Interview') && questions.length > 200) throw new Error('Maximum 200 questions per exam.');
  if (type === 'Coding') {
    if (problems.size > 10) throw new Error('Maximum 10 coding problems per exam.');
    for (const p of problems.values()) {
      if (!p.testCases.some(t => !t.hidden)) throw new Error(`${p.id}: at least one sample test is required.`);
      if (!p.testCases.some(t => t.hidden)) throw new Error(`${p.id}: at least one hidden test is required.`);
    }
  }
  const bank = {type, ...(type === 'Coding' ? {problems:[...problems.values()]} : {questions})};
  bank.totalMarks = (bank.questions || bank.problems).reduce((sum,q) => sum+q.marks,0);
  return bank;
}
export const MCQ_SAMPLE = 'question_id,question,option_a,option_b,option_c,option_d,correct_option,marks\nQ1,What is 2 + 2?,3,4,5,6,B,2\nQ2,"Which structure uses first in, first out?",Stack,Queue,Tree,Graph,B,3\n';
export const CODING_SAMPLE = 'problem_id,title,description,input_format,output_format,constraints,marks,test_input,expected_output,visibility\nP1,Sum of two integers,Read two integers and print their sum.,Two space-separated integers a and b.,Print a single integer.,-1000000 <= a and b <= 1000000,10,2 3,5,sample\nP1,,,,,,10,-4 4,0,hidden\nP1,,,,,,10,1000000 1000000,2000000,hidden\nP2,Sum an array,Read n and then n integers. Print their sum.,First line n. Second line n integers.,Print the sum.,1 <= n <= 1000,10,3\\n1 2 3,6,sample\nP2,,,,,,10,1\\n-7,-7,hidden\nP2,,,,,,10,4\\n0 -2 2 10,10,hidden\n';
export const INTERVIEW_SAMPLE = 'question_id,question,expected_key_points,follow_up,marks\nI1,Explain the difference between a process and a thread.,separate memory;shared memory;context switching,When would you choose a process?,10\nI2,How would you debug a slow API?,measure latency;inspect logs;profile database,Which metric would you inspect first?,10\n';
