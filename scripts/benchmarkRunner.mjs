import { executeCode } from '../api/codingRunner.mjs';
const programs = [
  { name:'simple', code:'print("ok")', language:'python', stdin:'' },
  { name:'loop', code:'n=int(input()); print(sum(range(n+1)))', language:'python', stdin:'100000' },
  { name:'compile-error', code:'int main( {', language:'c', stdin:'' },
  { name:'runtime-error', code:'print(1/0)', language:'python', stdin:'' },
];
const runs = Math.max(1, Math.min(100, Number(process.env.BENCHMARK_RUNS || 5)));
const measurements=[];
for (const program of programs) for (let i=0;i<runs;i++) { const start=performance.now(); try { await executeCode(program); measurements.push({name:program.name,ok:true,ms:performance.now()-start}); } catch (error) { measurements.push({name:program.name,ok:false,ms:performance.now()-start,error:error.message}); } }
const percentile=(items,p)=>items.sort((a,b)=>a-b)[Math.min(items.length-1,Math.floor(items.length*p))]||0;
console.log(JSON.stringify(Object.groupBy(measurements,item=>item.name),null,2));
for (const [name,items] of Object.entries(Object.groupBy(measurements,item=>item.name))) { const values=items.map(item=>item.ms); console.log(`${name}: p50=${percentile(values,.5).toFixed(0)}ms p95=${percentile(values,.95).toFixed(0)}ms p99=${percentile(values,.99).toFixed(0)}ms errors=${items.filter(item=>!item.ok).length}/${items.length}`); }
