import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Award, CheckCircle, Download, TrendingUp } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { formatDate, getGradeColor } from '../../utils/helpers';
import { useAuth } from '../../context/AuthContext';
import { collection, getDocs, query, where } from '../../services/mongoDb.js';
import { db } from '../../services/mongoDb.js';

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="rounded-xl p-4 text-sm" style={{ background: '#1c1917', border: '1px solid #3f3f46' }}>
        <p className="font-semibold text-white">{label}: {payload[0].value}%</p>
      </div>
    );
  }
  return null;
};

export default function ResultsPage() {
  const { user } = useAuth();
  const rollNo = user?.rollNo || (user?.email ? user.email.split('@')[0].toUpperCase() : '');
  const [loading, setLoading] = useState(true);
  const [myResults, setMyResults] = useState([]);

  useEffect(() => {
    if (!rollNo) return;
    const fetchResults = async () => {
      try {
        const q = query(collection(db, 'results'), where('rollNo', '==', rollNo));
        const snap = await getDocs(q);
        setMyResults(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.date || b.submittedAt || b.createdAt || 0) - new Date(a.date || a.submittedAt || a.createdAt || 0)));
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchResults();
  }, [rollNo]);

  const scoredResults = myResults.filter(result => Number.isFinite(Number(result.percentage)));
  const chartData = scoredResults.map(r => ({ subject: (r.subject || r.examTitle || 'Exam').split(' ')[0], percentage: Number(r.percentage) }));
  const avgScore = scoredResults.length ? (scoredResults.reduce((s, r) => s + Number(r.percentage), 0) / scoredResults.length).toFixed(1) : 0;

  if (loading) return <LoadingSkeleton type="table" rows={4} />;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Exam Results</h1>
          <p className="text-base mt-1.5" style={{ color: '#71717a' }}>Detailed results and performance analysis</p>
        </div>
        <button className="flex items-center gap-2.5 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all"
          style={{ background: 'rgba(249, 115, 22,0.15)', color: '#fdba74', border: '1px solid rgba(249, 115, 22,0.3)' }}>
          <Download size={16} /> Export Transcript
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        {[
          { label: 'Exams Appeared', value: myResults.length, color: '#f97316', icon: Award },
          { label: 'Average Score', value: `${avgScore}%`, color: '#10b981', icon: TrendingUp },
          { label: 'Exams Passed', value: myResults.filter(r => r.status === 'passed').length, color: '#f59e0b', icon: CheckCircle },
        ].map((item, i) => (
          <motion.div key={item.label} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}
            className="rounded-2xl p-7 flex items-center gap-5" style={{ background: '#121212', border: '1px solid #27272a' }}>
            <div className="w-13 h-13 w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `${item.color}20` }}>
              <item.icon size={22} style={{ color: item.color }} />
            </div>
            <div>
              <p className="text-sm font-medium" style={{ color: '#71717a' }}>{item.label}</p>
              <p className="text-3xl font-bold text-white mt-0.5">{item.value}</p>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Chart */}
      <div className="rounded-2xl p-7" style={{ background: '#121212', border: '1px solid #27272a' }}>
        <h3 className="font-semibold text-base text-white mb-5">Score Distribution</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis dataKey="subject" stroke="#475569" tick={{ fontSize: 13 }} tickMargin={8} />
            <YAxis domain={[50, 100]} stroke="#475569" tick={{ fontSize: 13 }} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="percentage" name="Score %" fill="#f97316" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Results cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {myResults.length === 0 ? (
          <div className="col-span-full text-center py-12" style={{ color: '#71717a' }}>No results published yet</div>
        ) : myResults.map((result, i) => {
          const color = getGradeColor(result.grade);
          return (
            <motion.div key={result.id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}
              className="rounded-2xl p-7" style={{ background: '#121212', border: '1px solid #27272a' }}>
              <div className="flex items-start justify-between mb-5">
                <div>
                  <h3 className="font-bold text-lg text-white">{result.examTitle || result.subject}</h3>
                  <p className="text-sm mt-1" style={{ color: '#71717a' }}>Published: {formatDate(result.date)}</p>
                </div>
                <div className="w-14 h-14 rounded-xl flex items-center justify-center text-xl font-black"
                  style={{ background: `${color}20`, color }}>
                  {result.status === 'not_appeared' ? '—' : result.grade}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 mt-4">
                {[
                  { label: 'Obtained', value: result.status === 'not_appeared' ? '—' : result.marks },
                  { label: 'Total', value: result.status === 'not_appeared' ? '—' : result.totalMarks },
                  { label: 'Score', value: result.status === 'not_appeared' ? 'Not appeared' : `${result.percentage}%`, colored: true },
                ].map(item => (
                  <div key={item.label} className="text-center p-4 rounded-xl" style={{ background: '#0a0a0a' }}>
                    <p className="text-xl font-bold" style={{ color: item.colored ? color : 'white' }}>{item.value}</p>
                    <p className="text-xs mt-1" style={{ color: '#71717a' }}>{item.label}</p>
                  </div>
                ))}
              </div>

              <div className="mt-5">
                <div className="h-2.5 rounded-full overflow-hidden" style={{ background: '#1c1917' }}>
                  <motion.div initial={{ width: 0 }} animate={{ width: `${result.status === 'not_appeared' ? 0 : result.percentage}%` }}
                    transition={{ duration: 0.8, delay: i * 0.1 }}
                    className="h-full rounded-full" style={{ background: `linear-gradient(90deg, ${color}, ${color}88)` }} />
                </div>
              </div>

              <div className="flex items-center justify-between mt-5 pt-4" style={{ borderTop: '1px solid #27272a' }}>
                <span className="text-sm font-medium status-active px-3 py-1.5 rounded-full">{result.status === 'not_appeared' ? 'Not appeared' : result.status === 'passed' ? 'Passed' : result.status === 'failed' ? 'Failed' : 'Pending'}</span>
                {Number(result.percentage) >= 80 && (
                  <span className="text-sm font-medium px-3 py-1.5 rounded-full" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>
                    🏆 Badge Eligible
                  </span>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
