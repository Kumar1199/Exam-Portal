import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, Clock, BookOpen, ExternalLink, ChevronRight, AlertCircle, Monitor, Code, UserCheck, Lock, CheckCircle, X, Loader2, Download } from 'lucide-react';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { formatDate, getDaysUntil, getDifficultyColor } from '../../utils/helpers';
import { collection, getDocs, query, where } from '../../services/mongoDb.js';
import { db } from '../../services/mongoDb.js';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';

const CountdownBadge = ({ days }) => {
  const color = days <= 3 ? '#ef4444' : days <= 7 ? '#f59e0b' : '#f97316';
  const label = days < 0 ? 'Past' : days === 0 ? 'Today!' : `${days}d left`;
  return (
    <span className="text-sm px-3 py-1.5 rounded-full font-semibold" style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}>
      {label}
    </span>
  );
};

const SECURE_EXAM_DOWNLOAD_URL = 'https://github.com/Kumar1199/Secure-app/releases/download/v1.0.0/SecureExam.Setup.1.0.0.exe';

export default function UpcomingExamsPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [exams, setExams] = useState([]);
  const [invitations, setInvitations] = useState({});

  const fetchExams = async () => {
    setLoading(true);
    try {
      const [querySnapshot,response] = await Promise.all([getDocs(collection(db, 'exams')),fetch('/api/proxy?path=exam/my-invites',{headers:{Authorization:`Bearer ${localStorage.getItem('s360_token')||''}`}})]);
      const invitationData=await response.json();
      if(!response.ok)throw new Error(invitationData.error||'Could not load exam codes.');
      setInvitations(Object.fromEntries(invitationData.invitations.map(invite=>[invite.examId,invite.examCode])));
      const examsData = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        if (data.status === 'upcoming' || data.status === 'scheduled') {
          examsData.push({ id: doc.id, ...data });
        }
      });
      // Sort by date (ascending for upcoming exams)
      examsData.sort((a, b) => new Date(a.date) - new Date(b.date));
      setExams(examsData);
    } catch (error) {
      console.error("Error fetching exams: ", error);
      toast.error(error.message || 'Failed to load upcoming exams');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchExams();
  }, []);

  const copyExamCode = async exam => {
    const code=invitations[exam.id];
    if(!code){toast('No active code is available. This exam may already be submitted.');return;}
    try {await navigator.clipboard.writeText(code);toast.success('Code copied. Enter it in the SecureExam Electron app.');}
    catch {toast('Select and copy the exam code shown on this card.');}
  };
  if (loading) return <LoadingSkeleton type="list" rows={5} />;

  const filteredExams = exams.filter(e => filter === 'all' || e.status === filter);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Upcoming Exams</h1>
          <p className="text-base mt-1.5" style={{ color: '#71717a' }}>Scheduled examinations and important dates</p>
        </div>
        <div className="flex items-center gap-2">
          {['all', 'upcoming', 'scheduled'].map(f => (
            <button
              key={f} onClick={() => setFilter(f)}
              className="px-4 py-2 rounded-xl text-sm font-medium capitalize transition-all"
              style={filter === f
                ? { background: 'rgba(249, 115, 22,0.18)', color: '#fdba74', border: '1px solid rgba(249, 115, 22,0.4)' }
                : { color: '#71717a', border: '1px solid #27272a' }
              }
            >{f}</button>
          ))}
        </div>
      </div>

      {/* Alert */}
      {exams.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          className="flex items-start gap-4 px-6 py-5 rounded-2xl"
          style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.28)' }}>
          <AlertCircle size={18} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 2 }} />
          <div>
            <p className="font-semibold text-sm" style={{ color: '#f59e0b' }}>Exam Season Approaching</p>
            <p className="text-sm mt-1" style={{ color: '#b45309' }}>You have {exams.length} upcoming exams. Stay prepared!</p>
          </div>
        </motion.div>
      )}

      <div className="flex flex-col gap-4 rounded-2xl p-6 sm:flex-row sm:items-center sm:justify-between" style={{ background: 'rgba(249,115,22,0.09)', border: '1px solid rgba(249,115,22,0.32)' }}>
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl" style={{ background: 'rgba(249,115,22,0.18)' }}>
            <Monitor size={22} style={{ color: '#fdba74' }} />
          </div>
          <div>
            <h2 className="font-semibold text-white">Secure Exam App for Windows</h2>
            <p className="mt-1 text-sm text-zinc-400">Install this app before your scheduled exam. You will enter the personal exam code shown on your exam card.</p>
          </div>
        </div>
        <a href={SECURE_EXAM_DOWNLOAD_URL} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90" style={{ background: '#ea580c' }}>
          <Download size={17} /> Download for Windows
        </a>
      </div>

      {/* Exam cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <AnimatePresence>
          {filteredExams.length === 0 ? (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="col-span-full py-12 text-center text-zinc-500">
              No upcoming exams at the moment.
            </motion.div>
          ) : (
            filteredExams.map((exam, i) => {
              const days = getDaysUntil(exam.date);
              const diffColor = getDifficultyColor(exam.difficulty);
              const ExamTypeIcon = exam.examType === 'Coding' ? Code : exam.examType === 'AI Interview' ? UserCheck : Monitor;

              return (
                <motion.div
                  key={exam.id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }} transition={{ delay: i * 0.1 }} whileHover={{ y: -2 }}
                  className="rounded-2xl p-7 cursor-pointer transition-all flex flex-col"
                  style={{ background: '#121212', border: '1px solid #27272a' }}
                >
                  <div className="flex items-start justify-between mb-5">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: 'rgba(249, 115, 22,0.15)' }}>
                        <ExamTypeIcon size={22} style={{ color: '#fdba74' }} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-white">{exam.title}</h3>
                          <span className="text-[10px] px-2 py-0.5 rounded uppercase font-bold" style={{ background: 'rgba(255,255,255,0.1)', color: '#a1a1aa' }}>
                            {exam.examType || 'MCQ'}
                          </span>
                        </div>
                        <p className="text-sm mt-1" style={{ color: '#71717a' }}>{exam.subject} &middot; {exam.department}</p>
                      </div>
                    </div>
                    <CountdownBadge days={days} />
                  </div>

                  <div className="grid grid-cols-2 gap-4 mb-5">
                    <div className="flex items-center gap-2.5">
                      <Calendar size={15} style={{ color: '#ffffff' }} />
                      <span className="text-sm" style={{ color: '#a1a1aa' }}>{formatDate(exam.date)}</span>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <Clock size={15} style={{ color: '#ffffff' }} />
                      <span className="text-sm" style={{ color: '#a1a1aa' }}>{exam.time}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 mb-5 flex-wrap">
                    <span className="text-xs px-3 py-1 rounded-full" style={{ background: `${diffColor}20`, color: diffColor }}>{exam.difficulty}</span>
                    <span className="text-xs px-3 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>{exam.totalMarks} marks</span>
                    <span className="text-xs px-3 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>{exam.duration}</span>
                  </div>

                  <div className="pt-4 mt-auto" style={{ borderTop: '1px solid #27272a' }}>
                    <p className="text-sm mb-3" style={{ color: '#71717a' }}>Syllabus: <span style={{ color: '#a1a1aa' }}>{exam.syllabus}</span></p>
                  <div className="my-4 rounded-xl border border-orange-500/30 bg-orange-500/10 p-4">
                    <p className="text-sm text-zinc-300">Your exam code</p>
                    <p className="select-text py-2 font-mono text-3xl font-bold tracking-widest text-orange-300">{invitations[exam.id] || 'Unavailable'}</p>
                    <p className="text-xs text-zinc-400">Enter this code in the SecureExam Electron app. It belongs only to you and this exam. Do not share it.</p>
                  </div>
                    <button 
                      onClick={() => copyExamCode(exam)}
                      className="flex items-center gap-2 text-sm font-semibold hover:underline w-max transition-colors"
                      style={{ color: '#f97316' }}>
                      <Lock size={14} /> Copy exam code
                    </button>
                  </div>
                </motion.div>
              );
            })
          )}
        </AnimatePresence>
      </div>

      {/* Tips */}
      <div className="rounded-2xl p-7" style={{ background: '#121212', border: '1px solid #27272a' }}>
        <h3 className="font-semibold text-base text-white mb-5">📚 Preparation Tips</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { tip: 'Start revisions at least 2 weeks before the exam date', color: '#f97316' },
            { tip: 'Practice previous year papers for better performance', color: '#10b981' },
            { tip: 'Focus on high-weight topics from the syllabus', color: '#f59e0b' },
          ].map((t, i) => (
            <div key={i} className="p-5 rounded-xl flex items-start gap-3" style={{ background: `${t.color}0d`, border: `1px solid ${t.color}28` }}>
              <ChevronRight size={15} style={{ color: t.color, flexShrink: 0, marginTop: 2 }} />
              <p className="text-sm leading-relaxed" style={{ color: '#a1a1aa' }}>{t.tip}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Exam Code Validation Modal */}

    </div>
  );
}
