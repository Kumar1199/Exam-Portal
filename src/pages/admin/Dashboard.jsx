import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Users, BookOpen, AlertTriangle, TrendingUp, ChevronRight } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import StatCard from '../../components/shared/StatCard';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { generateInitials, getAvatarColor } from '../../utils/helpers';
import { collection, getDocs } from '../../services/mongoDb.js';
import { db } from '../../services/mongoDb.js';

const ChartTip = ({ active, payload, label }) =>
  active && payload?.length ? (
    <div style={{ background: '#1c1917', border: '1px solid #3f3f46', borderRadius: '0.625rem', padding: '0.625rem 0.875rem', fontSize: '0.8125rem' }}>
      <p style={{ fontWeight: 600, color: '#fafafa', marginBottom: 4 }}>{label}</p>
      {payload.map(p => <p key={p.name} style={{ color: p.color }}>{p.name}: {p.value}</p>)}
    </div>
  ) : null;

const DEPT_COLORS = ['#f97316', '#f59e0b', '#06b6d4', '#10b981', '#f59e0b'];

const asDate = value => value ? new Date(value) : null;
const scoreFor = result => {
  const percentage = Number(result?.percentage);
  if (Number.isFinite(percentage)) return percentage;
  const score = Number(result?.score ?? result?.marks);
  const total = Number(result?.totalMarks ?? result?.total);
  return Number.isFinite(score) && total > 0 ? (score / total) * 100 : null;
};

export default function AdminDashboard() {
  const [loading, setLoading] = useState(true);
  const [activeExamsCount, setActiveExamsCount] = useState(0);
  const [students, setStudents] = useState([]);
  const [violationsCount, setViolationsCount] = useState(0);
  const [results, setResults] = useState([]);

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        // Fetch Exams
        const [examsSnap, studentsSnap, resultsSnap, violSnap] = await Promise.all([
          getDocs(collection(db, 'exams')),
          getDocs(collection(db, 'students')),
          getDocs(collection(db, 'results')).catch(() => ({ docs: [] })),
          getDocs(collection(db, 'violations')).catch(() => ({ size: 0 })),
        ]);
        let count = 0;
        examsSnap.forEach((doc) => {
          if (doc.data().status === 'upcoming') count++;
        });
        setActiveExamsCount(count);

        // Fetch Students
        const studentsList = studentsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setStudents(studentsList);
        setResults(resultsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        setViolationsCount(violSnap.size);
      } catch (err) {
        console.error("Error fetching dashboard data:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchDashboardData();
  }, []);

  // Compute Metrics
  const totalStudents = students.length;
  const totalColleges = new Set(students.map((s) => s.college).filter(Boolean)).size;
  const totalBranches = new Set(students.flatMap((s) => s.branch || [])).size;
  const resultScores = results.reduce((byRoll, result) => {
    const roll = String(result.rollNo || result.studentRollNo || result.studentId || '').toUpperCase();
    const score = scoreFor(result);
    if (roll && score !== null) (byRoll[roll] ||= []).push(score);
    return byRoll;
  }, {});
  const topStudents = students.map(student => {
    const scores = resultScores[String(student.rollNo || student.id || '').toUpperCase()] || [];
    return { ...student, examScore: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null };
  }).filter(student => student.examScore !== null).sort((a, b) => b.examScore - a.examScore).slice(0, 5);
  const recentActivity = [
    ...students.map(student => ({ date: asDate(student.updatedAt || student.createdAt), text: `${student.name || student.rollNo || 'Student'} record updated`, color: '#06b6d4' })),
    ...results.map(result => ({ date: asDate(result.submittedAt || result.updatedAt || result.createdAt), text: `${result.studentName || result.rollNo || result.studentId || 'Student'} submitted ${result.examTitle || result.exam || 'an exam'}`, color: '#10b981' })),
  ].filter(item => item.date && !Number.isNaN(item.date.getTime())).sort((a, b) => b.date - a.date).slice(0, 5);

  // Compute Chart Data
  const collegeData = Object.entries(students.reduce((acc, s) => {
    const c = s.college || "Unknown";
    acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {})).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

  const branchData = Object.entries(students.reduce((acc, s) => {
    const branches = s.branch || [];
    branches.forEach(b => { acc[b] = (acc[b] || 0) + 1; });
    return acc;
  }, {})).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

  if (loading) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <LoadingSkeleton type="card" />
      <LoadingSkeleton type="table" rows={5} />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Admin Dashboard</h1>
          <p className="page-subtitle">Institution-wide analytics and overview</p>
        </div>
        <span className="badge badge-violet" style={{ padding: '0.375rem 0.875rem', fontSize: '0.8125rem' }}>⚙️ Admin Mode</span>
      </div>

      {/* Stat cards */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <StatCard title="Total Students"  value={totalStudents}   subtitle="Enrolled"       icon={Users}         color="#f97316" trend="none" trendValue=""      delay={0}    />
        <StatCard title="Colleges"        value={totalColleges}   subtitle="Institutions"   icon={BookOpen}      color="#06b6d4" trend="none" trendValue=""      delay={0.05} />
        <StatCard title="Branches"        value={totalBranches}   subtitle="Disciplines"    icon={BookOpen}      color="#f59e0b" trend="none" trendValue=""      delay={0.1}  />
        <StatCard title="Active Exams"    value={activeExamsCount} subtitle="Scheduled"      icon={TrendingUp}    color="#10b981" trend="none" trendValue=""      delay={0.15} />
        <StatCard title="Violations"      value={violationsCount} subtitle="For review"      icon={AlertTriangle} color="#ef4444" trend="none" trendValue=""      delay={0.2}  />
      </div>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>

        <div className="chart-card">
          <div className="chart-header">
            <span className="chart-title">Branch Distribution</span>
          </div>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={branchData.slice(0, 8)} barGap={4} margin={{ top: 10, right: 10, bottom: 0, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis dataKey="name" stroke="#334155" tick={{ fontSize: 11, fill: '#71717a' }} />
              <YAxis stroke="#334155" tick={{ fontSize: 11, fill: '#71717a' }} />
              <Tooltip content={<ChartTip />} cursor={{ fill: 'rgba(249, 115, 22, 0.05)' }} />
              <Bar dataKey="value" name="Students" fill="#f97316" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-card">
          <div className="chart-header">
            <span className="chart-title">College Distribution</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', height: 250 }}>
            <ResponsiveContainer width="60%" height={250}>
              <PieChart>
                <Pie data={collegeData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={85} innerRadius={55} paddingAngle={2}>
                  {collegeData.map((_, i) => <Cell key={i} fill={DEPT_COLORS[i % DEPT_COLORS.length]} />)}
                </Pie>
                <Tooltip content={<ChartTip />} />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '40%' }}>
              {collegeData.slice(0, 5).map((d, i) => (
                <div key={d.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                    <div style={{ width: 10, height: 10, borderRadius: '2px', background: DEPT_COLORS[i % DEPT_COLORS.length], flexShrink: 0 }} />
                    <span style={{ fontSize: '0.8125rem', color: '#a1a1aa', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100px' }}>{d.name}</span>
                  </div>
                  <span style={{ fontSize: '0.875rem', fontWeight: 700, color: '#fafafa' }}>{d.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>

        {/* Top performers */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.125rem' }}>
            <span className="card-title">Top Performers</span>
            <button style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#f97316', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              View all <ChevronRight size={13} />
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {topStudents.map((s, i) => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, width: 20, textAlign: 'center', color: i === 0 ? '#f59e0b' : '#475569', flexShrink: 0 }}>#{i+1}</span>
                <div style={{ width: 34, height: 34, borderRadius: '50%', background: getAvatarColor(s.name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6875rem', fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                  {generateInitials(s.name)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#fafafa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name || s.rollNo}</p>
                  <p style={{ fontSize: '0.75rem', color: '#71717a' }}>{s.branch?.[0] || 'Unknown Branch'}</p>
                </div>
                <span style={{ fontSize: '1rem', fontWeight: 700, color: '#10b981', flexShrink: 0 }}>{s.examScore}%</span>
              </div>
            ))}{topStudents.length === 0 && <p style={{ color: '#71717a', fontSize: '0.8125rem' }}>No submitted exam results yet.</p>}
          </div>
        </div>

        {/* Activity */}
        <div className="card">
          <span className="card-title" style={{ display: 'block', marginBottom: '1.125rem' }}>Recent Activity</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
            {recentActivity.map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: item.color, marginTop: 5, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '0.8125rem', color: '#fafafa', lineHeight: 1.4 }}>{item.text}</p>
                  <p style={{ fontSize: '0.6875rem', color: '#475569', marginTop: 2 }}>{item.date.toLocaleString('en-IN')}</p>
                </div>
              </div>
            ))}{recentActivity.length === 0 && <p style={{ color: '#71717a', fontSize: '0.8125rem' }}>No database activity yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
