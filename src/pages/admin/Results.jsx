import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { formatDate, getGradeColor, generateInitials, getAvatarColor, exportToCSV } from '../../utils/helpers';
import { Download, CheckCircle } from 'lucide-react';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import toast from 'react-hot-toast';
import { collection, getDocs } from '../../services/mongoDb.js';
import { db } from '../../services/mongoDb.js';
import { studentMatchesExam } from '../../utils/examAudience.js';

export default function AdminResults() {
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // all, electron_app, manual
  const [allResults, setAllResults] = useState([]);
  const [exams, setExams] = useState([]);
  const [students, setStudents] = useState([]);
  const [examFilter, setExamFilter] = useState('all');
  const [studentFilter, setStudentFilter] = useState('all');
  const [detailExamId, setDetailExamId] = useState('');

  useEffect(() => {
    const fetchResults = async () => {
      try {
        const [resultsSnap, examsSnap, studentsSnap] = await Promise.all([
          getDocs(collection(db, 'results')),
          getDocs(collection(db, 'exams')),
          getDocs(collection(db, 'students')),
        ]);
        setAllResults(resultsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        setExams(examsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => new Date(b.startTime || b.date || b.createdAt || 0) - new Date(a.startTime || a.date || a.createdAt || 0)));
        setStudents(studentsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      } catch (err) {
        toast.error("Failed to load results");
      } finally {
        setLoading(false);
      }
    };
    fetchResults();
  }, []);

  const examLabel = exam => exam.title || exam.subject || exam.id;
  const resultExamId = result => String(result.examId || result.exam || result.subject || '');
  const studentLabel = result => result.studentName || result.rollNo || result.studentId || 'Unknown';
  const visibleResults = allResults.filter(result =>
    (filter === 'all' || result.source === filter) &&
    (examFilter === 'all' || resultExamId(result) === examFilter) &&
    (studentFilter === 'all' || studentLabel(result) === studentFilter)
  ).sort((a, b) => new Date(b.date || b.submittedAt || b.createdAt || 0) - new Date(a.date || a.submittedAt || a.createdAt || 0));
  const resultExamOptions = [...new Map([...exams.map(exam => [exam.id, examLabel(exam)]), ...allResults.map(result => [resultExamId(result), result.examTitle || result.exam || result.subject || resultExamId(result)])]).entries()].filter(([id]) => id);
  const resultStudents = [...new Set(allResults.map(studentLabel))].sort();
  const detailExam = exams.find(exam => exam.id === detailExamId);
  const detailResults = allResults.filter(result => resultExamId(result) === detailExamId);
  const scheduledCount = detailExam ? students.filter(student => studentMatchesExam(detailExam, student)).length : 0;
  const appearedCount = new Set(detailResults.map(result => String(result.rollNo || result.studentId || result.studentName || ''))).size;
  const results = visibleResults;

  if (loading) return <LoadingSkeleton type="table" rows={5} />;

  return (
    <div className="space-y-7">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Results Management</h1>
          <p className="text-base mt-1.5" style={{ color: '#71717a' }}>{results.length} result records</p>
        </div>
        <div className="flex gap-3">
          <button onClick={() => exportToCSV(results, 'results')}
            className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm font-semibold"
            style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)' }}>
            <Download size={15} /> Export
          </button>
          <button onClick={() => toast.success('Results published to all students!')}
            className="flex items-center gap-2.5 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'linear-gradient(135deg,#10b981,#06b6d4)' }}>
            <CheckCircle size={15} /> Publish Results
          </button>
        </div>
      </div>

      {/* Filter buttons */}
      <div className="flex flex-wrap gap-2.5">
        {[
          { key: 'all', label: 'All Results', count: results.length },
          { key: 'electron_app', label: 'Electron App', count: results.filter(r => r.source === 'electron_app').length },
          { key: 'manual', label: 'Manual Entry', count: results.filter(r => r.source === 'manual').length }
        ].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className="px-4 py-2.5 rounded-xl text-sm font-medium capitalize transition-all"
            style={filter === f.key
              ? { background: 'rgba(249, 115, 22,0.2)', color: '#fdba74', border: '1px solid rgba(249, 115, 22,0.4)' }
              : { color: '#71717a', border: '1px solid #27272a' }
            }>
            {f.label} ({f.count})
          </button>
        ))}
        <select value={examFilter} onChange={event => setExamFilter(event.target.value)} className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-sm text-zinc-200">
          <option value="all">All exams</option>{resultExamOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <select value={studentFilter} onChange={event => setStudentFilter(event.target.value)} className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-sm text-zinc-200">
          <option value="all">All students</option>{resultStudents.map(student => <option key={student} value={student}>{student}</option>)}
        </select>
      </div>

      <div className="rounded-2xl p-5" style={{ background: '#121212', border: '1px solid #27272a' }}>
        <label className="mb-3 block text-sm font-semibold text-zinc-200">Exam participation details</label>
        <select value={detailExamId} onChange={event => setDetailExamId(event.target.value)} className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-100">
          <option value="">Select an exam to view students</option>{exams.map(exam => <option key={exam.id} value={exam.id}>{examLabel(exam)}</option>)}
        </select>
        {detailExam && <div className="mt-4">
          <div className="grid grid-cols-2 gap-3 sm:max-w-md"><div className="rounded-xl bg-zinc-950 p-4"><p className="text-xs text-zinc-500">Scheduled students</p><p className="mt-1 text-2xl font-bold text-white">{scheduledCount}</p></div><div className="rounded-xl bg-zinc-950 p-4"><p className="text-xs text-zinc-500">Appeared</p><p className="mt-1 text-2xl font-bold text-emerald-400">{appearedCount}</p></div></div>
          <div className="mt-4 max-h-52 overflow-auto rounded-xl border border-zinc-800"><table className="w-full text-sm"><thead className="bg-zinc-950 text-left text-zinc-500"><tr><th className="px-4 py-3">Student</th><th className="px-4 py-3">Roll no.</th><th className="px-4 py-3">Score</th></tr></thead><tbody>{detailResults.map(result => <tr key={result.id} className="border-t border-zinc-800"><td className="px-4 py-3 text-zinc-100">{studentLabel(result)}</td><td className="px-4 py-3 text-zinc-400">{result.rollNo || result.studentId || '—'}</td><td className="px-4 py-3 text-zinc-100">{result.evaluationPending ? 'Pending' : `${result.percentage ?? '—'}%`}</td></tr>)}{!detailResults.length && <tr><td colSpan={3} className="px-4 py-5 text-center text-zinc-500">No student has appeared yet.</td></tr>}</tbody></table></div>
        </div>}
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ background: '#121212', border: '1px solid #27272a' }}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr style={{ background: '#0a0a0a' }}>
                {['Student', 'Subject', 'Marks', 'Total', 'Percentage', 'Grade', 'Status', 'Source', 'Date'].map(h => (
                  <th key={h} className="text-left px-6 py-4 text-sm font-semibold" style={{ color: '#71717a' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-16 text-base" style={{ color: '#71717a' }}>No results found</td></tr>
              ) : results.map((r, i) => {
                const color = getGradeColor(r.grade);
                return (
                  <motion.tr key={r.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }}
                    className="hover:bg-white/5 transition-all" style={{ borderBottom: '1px solid #27272a' }}>
                    <td className="px-6 py-5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                          style={{ background: getAvatarColor(r.studentName || '') }}>
                          {generateInitials(r.studentName || '?')}
                        </div>
                        <span className="text-sm font-semibold text-white">{r.studentName || 'Unknown'}</span>
                      </div>
                    </td>
                    <td className="px-6 py-5 text-sm" style={{ color: '#a1a1aa' }}>{r.subject}</td>
                    <td className="px-6 py-5 text-sm font-bold text-white">{r.evaluationPending ? 'Pending' : r.marks}</td>
                    <td className="px-6 py-5 text-sm" style={{ color: '#71717a' }}>{r.totalMarks}</td>
                    <td className="px-6 py-5 text-sm font-bold" style={{ color }}>{r.evaluationPending ? 'Pending' : `${r.percentage}%`}</td>
                    <td className="px-6 py-5">
                      <span className="text-sm px-3 py-1.5 rounded-full font-bold" style={{ background: `${color}20`, color }}>{r.grade}</span>
                    </td>
                    <td className="px-6 py-5">
                      <span className="text-sm px-3 py-1.5 rounded-full font-semibold status-active">{r.evaluationPending ? 'Pending evaluation' : r.status === 'passed' ? 'Passed' : 'Failed'}</span>
                    </td>
                    <td className="px-6 py-5">
                      <span className={`text-sm px-3 py-1.5 rounded-full font-medium ${
                        r.source === 'electron_app' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400'
                      }`}>
                        {r.source === 'electron_app' ? 'Electron App' : 'Manual'}
                      </span>
                    </td>
                    <td className="px-6 py-5 text-sm" style={{ color: '#71717a' }}>{formatDate(r.date || r.submittedAt)}</td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
