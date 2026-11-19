import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CheckCircle, ClipboardList, Users } from 'lucide-react';
import { collection, getDocs } from '../../services/mongoDb.js';
import { db } from '../../services/mongoDb.js';
import { studentMatchesExam } from '../../utils/examAudience.js';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';

const scoreFor = result => {
  const percentage = Number(result.percentage);
  if (Number.isFinite(percentage)) return percentage;
  const score = Number(result.score ?? result.marks);
  const total = Number(result.totalMarks ?? result.total);
  return Number.isFinite(score) && total > 0 ? (score / total) * 100 : null;
};

export default function AdminReports() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ exams: [], students: [], results: [], violations: [] });

  useEffect(() => {
    Promise.all([
      getDocs(collection(db, 'exams')),
      getDocs(collection(db, 'students')),
      getDocs(collection(db, 'results')),
      getDocs(collection(db, 'violations')),
    ]).then(([exams, students, results, violations]) => setData({
      exams: exams.docs.map(doc => ({ id: doc.id, ...doc.data() })),
      students: students.docs.map(doc => ({ id: doc.id, ...doc.data() })),
      results: results.docs.map(doc => ({ id: doc.id, ...doc.data() })),
      violations: violations.docs.map(doc => ({ id: doc.id, ...doc.data() })),
    })).catch(error => console.error('Unable to load reports:', error)).finally(() => setLoading(false));
  }, []);

  const reportRows = useMemo(() => data.exams.map(exam => {
    const related = data.results.filter(result => String(result.examId || result.exam || '') === String(exam.id));
    const appeared = new Set(related.map(result => String(result.rollNo || result.studentId || result.studentName || '')).filter(Boolean)).size;
    const scheduled = data.students.filter(student => studentMatchesExam(exam, student)).length;
    const scored = related.map(scoreFor).filter(score => score !== null);
    const avgScore = scored.length ? Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length) : null;
    const incidents = data.violations.filter(violation => String(violation.examId || violation.exam || '') === String(exam.id) || String(violation.exam || '') === String(exam.title || '')).length;
    return { id: exam.id, title: exam.title || exam.subject || 'Untitled exam', scheduled, appeared, avgScore, incidents, date: exam.startTime || exam.date || exam.createdAt };
  }).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)), [data]);

  if (loading) return <LoadingSkeleton type="table" rows={5} />;
  const totalAppeared = new Set(data.results.map(result => String(result.rollNo || result.studentId || '')).filter(Boolean)).size;
  const scores = data.results.map(scoreFor).filter(score => score !== null);
  const averageScore = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  const chartRows = reportRows.slice(0, 8).reverse();

  return <div className="space-y-7">
    <div><h1 className="text-2xl font-bold text-white">Live Exam Reports</h1><p className="mt-1 text-sm text-zinc-400">Participation, evaluation, and incident data from MongoDB.</p></div>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {[
        ['Scheduled exams', data.exams.length, ClipboardList, '#f97316'],
        ['Students appeared', totalAppeared, Users, '#06b6d4'],
        ['Average result', `${averageScore}%`, CheckCircle, '#10b981'],
        ['Recorded incidents', data.violations.length, AlertTriangle, '#ef4444'],
      ].map(([label, value, Icon, color]) => <div key={label} className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5"><div className="flex items-center gap-3"><div className="rounded-xl p-3" style={{ background: `${color}20`, color }}><Icon size={20}/></div><div><p className="text-xs text-zinc-500">{label}</p><p className="text-2xl font-bold text-white">{value}</p></div></div></div>)}
    </div>
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5"><h2 className="mb-4 text-base font-semibold text-white">Participation by exam</h2><ResponsiveContainer width="100%" height={280}><BarChart data={chartRows}><CartesianGrid stroke="#27272a" vertical={false}/><XAxis dataKey="title" tick={{ fill: '#a1a1aa', fontSize: 11 }} interval={0} angle={-18} textAnchor="end" height={65}/><YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }}/><Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46' }}/><Bar dataKey="scheduled" name="Scheduled" fill="#334155" radius={[4,4,0,0]}/><Bar dataKey="appeared" name="Appeared" fill="#10b981" radius={[4,4,0,0]}/></BarChart></ResponsiveContainer></div>
    <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950"><div className="border-b border-zinc-800 p-5"><h2 className="font-semibold text-white">Exam summary</h2></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-black/40 text-left text-zinc-500"><tr>{['Exam', 'Scheduled', 'Appeared', 'Average score', 'Incidents'].map(head => <th key={head} className="px-5 py-3 font-medium">{head}</th>)}</tr></thead><tbody>{reportRows.map(row => <tr key={row.id} className="border-t border-zinc-800"><td className="px-5 py-4 font-medium text-white">{row.title}</td><td className="px-5 py-4 text-zinc-300">{row.scheduled}</td><td className="px-5 py-4 text-emerald-400">{row.appeared}</td><td className="px-5 py-4 text-zinc-300">{row.avgScore === null ? 'Pending' : `${row.avgScore}%`}</td><td className="px-5 py-4 text-red-300">{row.incidents}</td></tr>)}{!reportRows.length && <tr><td colSpan={5} className="px-5 py-12 text-center text-zinc-500">No exams have been created yet.</td></tr>}</tbody></table></div></div>
  </div>;
}
