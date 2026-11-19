import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { BookOpen, Calendar, Trophy, TrendingUp, Star, Target, Award, ChevronRight, Zap, Code } from 'lucide-react';
import StatCard from '../../components/shared/StatCard';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { formatDate, getDaysUntil, getGradeColor, calculatePlacementIndex } from '../../utils/helpers';
import { useAuth } from '../../context/AuthContext';
import { collection, getDocs, doc, getDoc, query, where } from '../../services/mongoDb.js';
import { db } from '../../services/mongoDb.js';

const ChartTip = ({ active, payload, label }) =>
  active && payload?.length ? (
    <div style={{ background: '#1c1917', border: '1px solid #3f3f46', borderRadius: '0.625rem', padding: '0.625rem 0.875rem', fontSize: '0.8125rem' }}>
      <p style={{ fontWeight: 600, color: '#fafafa', marginBottom: 4 }}>{label}</p>
      {payload.map(p => <p key={p.name} style={{ color: p.color }}>{p.name}: {p.value}</p>)}
    </div>
  ) : null;

export default function StudentDashboard() {
  const { user } = useAuth();
  const rollNo = user?.rollNo || (user?.email ? user.email.split('@')[0].toUpperCase() : '');
  const [loading, setLoading] = useState(true);
  const [studentData, setStudentData] = useState(null);
  const [dashboardStats, setDashboardStats] = useState(null);
  const [codingProfiles, setCodingProfiles] = useState({ leetcode: null, gfg: null, codechef: null, hackerrank: null });
  const [upcomingExams, setUpcomingExams] = useState([]);
  const [myResults, setMyResults] = useState([]);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const studentBadges  = [];

  useEffect(() => {
    if (!rollNo) return;
    const fetchData = async () => {
      try {
        setError(false);
        const body = JSON.stringify({ roll_no: rollNo });
        const headers = { 'Content-Type': 'application/json' };

        const safeFetch = async (url) => {
          // External profile services are intentionally disabled. Dashboard data is portal-database only.
          return null;
          try {
            const res = await fetch(url, { method: 'POST', headers, body, timeout: 10000 });
            if (!res.ok) {
              console.warn(`⚠️ API returned status ${res.status} for ${url}`);
              return null;
            }
            const data = await res.json();
            return data;
          } catch (e) {
            console.warn(`⚠️ Fetch failed for ${url}:`, e.message);
            return null;
          }
        };

        const fetchStudentDetails = async () => {
          const docSnap = await getDoc(doc(db, 'students', rollNo));
          return docSnap.exists() ? docSnap.data() : null;
          try {
            const idRes = await fetch('/api/get-student-id-by-rollno', {
              method: 'POST',
              headers,
              body,
              timeout: 10000
            });
            if (!idRes.ok) {
              console.warn(`⚠️ get-student-id-by-rollno returned status ${idRes.status}`);
              return null;
            }
            const idData = await idRes.json();
            if (!idData.success || !idData.objectId) {
              console.warn(`⚠️ get-student-id-by-rollno failed:`, idData);
              return null;
            }
            
            const detailsRes = await fetch(`/api/get-user-by-id/${idData.objectId}`, {
              method: 'GET',
              headers: { 'Accept': 'application/json' },
              timeout: 10000
            });
            if (!detailsRes.ok) {
              console.warn(`⚠️ get-user-by-id returned status ${detailsRes.status}`);
              return null;
            }
            const data = await detailsRes.json();
            return data;
          } catch (e) {
            console.warn(`⚠️ fetchStudentDetails failed:`, e.message);
            return null;
          }
        };

        const [studentJson, statsJson, lc, gfg, cc, hr] = await Promise.all([
          fetchStudentDetails(),
          safeFetch('/api/get-student-problems-count-dashboard'),
          safeFetch('/api/get-leetcode-details-by-rollno'),
          safeFetch('/api/get-geeksforgeeks-details-by-rollno'),
          safeFetch('/api/get-codechef-details-by-rollno'),
          safeFetch('/api/get-hackerrank-details-by-rollno')
        ]);

        // Unified Student Data Fetching (API -> Firestore -> Mock)
        let finalStudentData = studentJson;
        if (!finalStudentData) {
          try {
            const docRef = doc(db, 'students', rollNo);
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
              finalStudentData = docSnap.data();
            }
          } catch (e) { console.error("Firestore error:", e); }
        }

        const finalStats = statsJson || {};

        // Fetch upcoming exams and results from Firestore (Production source)
        const examsSnap = await getDocs(collection(db, 'exams'));
        const examsData = examsSnap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(e => e.status === 'upcoming' || e.status === 'scheduled')
          .sort((a, b) => new Date(a.date) - new Date(b.date));
        
        setUpcomingExams(examsData.slice(0, 3));

        const resultsQuery = query(collection(db, 'results'), where('rollNo', '==', rollNo));
        const resultsSnap = await getDocs(resultsQuery);
        const userResults = resultsSnap.docs
          .map(d => d.data());
        
        setMyResults(userResults);
        setCodingProfiles({ leetcode: lc, gfg, codechef: cc, hackerrank: hr });

        setStudentData(finalStudentData);
        setDashboardStats(finalStats);
      } catch (err) {
        console.error("❌ Error fetching dashboard data", err);
        setError(true);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [rollNo, retryCount]);

  const handleRetry = () => {
    setLoading(true);
    setError(false);
    setRetryCount(c => c + 1);
  };

  if (error) return <ErrorState message="Unable to fetch dashboard data. Please check your connection and try again." onRetry={handleRetry} />;

  if (loading) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <LoadingSkeleton type="card" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
        <LoadingSkeleton type="table" rows={3} />
        <LoadingSkeleton type="list" rows={3} />
      </div>
    </div>
  );

  const studentName = studentData?.first_name || user?.name || 'Student';
  const studentDept = studentData?.branch?.[0] || 'No branch assigned';
  const studentYear = studentData?.passout_year || '';
  const studentRoll = studentData?.roll_no || rollNo;
  const placementIndex = calculatePlacementIndex(studentData, myResults);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* Welcome banner */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          borderRadius: '1rem', padding: '1.5rem 2rem',
          background: 'linear-gradient(135deg, rgba(249, 115, 22,0.15) 0%, rgba(245, 158, 11,0.1) 60%, rgba(6,182,212,0.07) 100%)',
          border: '1px solid rgba(249, 115, 22,0.25)',
          position: 'relative', overflow: 'hidden',
        }}
      >
        <div style={{ position: 'absolute', right: '2rem', top: '50%', transform: 'translateY(-50%)', opacity: 0.12 }}>
          <Zap size={80} color="#f97316" />
        </div>
        <p style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#fdba74', marginBottom: '0.375rem' }}>👋 Welcome back,</p>
        <h1 style={{ fontSize: '1.625rem', fontWeight: 800, color: '#fafafa', letterSpacing: '-0.03em', lineHeight: 1.2 }}>{studentName}</h1>
        <p style={{ fontSize: '0.875rem', color: '#71717a', marginTop: '0.375rem' }}>
          {studentDept} {studentYear ? `· Batch ${studentYear}` : ''} · {studentRoll}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', marginTop: '0.875rem' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem', color: '#a1a1aa' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
            Active student
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem', color: '#a1a1aa' }}>
            <Star size={13} style={{ color: '#f59e0b' }} /> Top performer
          </span>
        </div>
      </motion.div>

      {/* Stat cards */}
      <div className="stat-grid">
        <StatCard title="Total Problems"  value={dashboardStats?.total || 0} subtitle="Across all platforms" icon={Code} color="#f97316" trend="up" trendValue={`${dashboardStats?.easy || 0} Easy`} delay={0} />
        <StatCard title="Coding Rank"     value={dashboardStats?.rank ? `#${dashboardStats.rank}` : 'N/A'} subtitle="Global Rank" icon={Trophy} color="#06b6d4" trend="up" trendValue={`${dashboardStats?.score || 0} pts`} delay={0.08} />
        <StatCard title="PI Score"        value={`${placementIndex}/100`} subtitle="Placement Index" icon={Award} color="#10b981" trend={placementIndex >= 80 ? 'up' : placementIndex >= 65 ? 'none' : 'down'} trendValue={placementIndex >= 80 ? 'Excellent' : placementIndex >= 65 ? 'Good' : 'Needs work'} delay={0.12} />
        <StatCard title="Active Courses"  value={studentData?.current_courses?.length || 0} subtitle="Currently Enrolled" icon={BookOpen} color="#f59e0b" trend="none" trendValue="" delay={0.16} />
        <StatCard title="Upcoming Exams"  value={upcomingExams.length} subtitle="Next: May 20" icon={Calendar} color="#10b981" trend="up" trendValue="3 due" delay={0.24} />
      </div>

      {/* Bottom row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.25rem' }}>

        {/* Upcoming Exams */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.125rem' }}>
            <span className="card-title">Upcoming Exams</span>
            <button style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#f97316', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              View all <ChevronRight size={13} />
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {upcomingExams.map((exam, i) => {
              const days = getDaysUntil(exam.date);
              return (
                <div key={exam.id} style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.75rem', borderRadius: '0.75rem', background: '#0a0a0a', border: '1px solid #27272a' }}>
                  <div style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(249, 115, 22,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <BookOpen size={16} style={{ color: '#fdba74' }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#fafafa', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{exam.title}</p>
                    <p style={{ fontSize: '0.75rem', color: '#71717a', marginTop: 2 }}>{exam.subject} · {exam.duration}</p>
                  </div>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: days <= 7 ? '#ef4444' : '#f59e0b', flexShrink: 0 }}>{days}d</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Subject scores */}
      <div className="card">
        <span className="card-title" style={{ display: 'block', marginBottom: '1.25rem' }}>Subject Performance</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.875rem' }}>
          {myResults.length === 0 ? <p style={{ color: '#71717a' }}>No results published yet.</p> : myResults.slice(0, 6).map((s, i) => {
            const pct = Math.round((parseFloat(s.marks) / parseFloat(s.totalMarks)) * 100);
            const color = getGradeColor(s.grade);
            return (
              <motion.div key={s.subject} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.06 }}
                style={{ padding: '0.875rem 1rem', borderRadius: '0.75rem', background: '#0a0a0a', border: '1px solid #27272a' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
                  <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#a1a1aa' }}>{s.subject}</span>
                  <span className="badge" style={{ background: `${color}18`, color, border: `1px solid ${color}28`, fontSize: '0.6875rem' }}>{s.grade}</span>
                </div>
                <div className="progress-track">
                  <motion.div className="progress-fill" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, delay: i * 0.07 }}
                    style={{ background: `linear-gradient(90deg, ${color}, ${color}88)` }} />
                </div>
                <p style={{ fontSize: '0.75rem', color: '#71717a', marginTop: '0.375rem' }}>{s.marks}/{s.total} · {pct}%</p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
