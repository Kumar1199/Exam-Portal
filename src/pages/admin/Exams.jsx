import QuestionBankModal from '../../components/admin/QuestionBankModal';
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { Search, Plus, Calendar, Clock, BookOpen, ChevronRight, Edit2, Trash2, ShieldAlert, Monitor, UserCheck, Code, Save, X, Loader2 } from 'lucide-react';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { formatDate, getDifficultyColor, getExamStatusColor } from '../../utils/helpers';

import toast from 'react-hot-toast';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, query, where } from '../../services/mongoDb.js';
import { db } from '../../services/mongoDb.js';
import { studentMatchesExam, validateExamAudience } from '../../utils/examAudience';

export default function AdminExams() {
  const [loading, setLoading] = useState(true);
  const [exams, setExams] = useState([]);
  const [colleges, setColleges] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editExam, setEditExam] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [questionExam, setQuestionExam] = useState(null);
  const [filter, setFilter] = useState('all');

  const fetchExams = async () => {
    setLoading(true);
    try {
      const [querySnapshot, collegeSnapshot] = await Promise.all([
        getDocs(collection(db, 'exams')), getDocs(collection(db, 'colleges')),
      ]);
      setColleges(collegeSnapshot.docs.map(item => ({ ...item.data(), id: item.id })));
      const examsData = [];
      querySnapshot.forEach((doc) => {
        examsData.push({ id: doc.id, ...doc.data() });
      });
      // Sort by date (descending)
      examsData.sort((a, b) => new Date(b.date) - new Date(a.date));
      setExams(examsData);
    } catch (error) {
      console.error("Error fetching exams: ", error);
      toast.error('Failed to load exams');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchExams();
    const timer = window.setInterval(fetchExams, 30000);
    return () => window.clearInterval(timer);
  }, []);

  const filtered = exams.filter(e => filter === 'all' || e.status === filter);

  const handleDelete = async (id) => {
    setIsDeleting(true);
    setDeletingId(id);
    try {
      await deleteDoc(doc(db, 'exams', id));
      setExams(p => p.filter(e => e.id !== id));
      toast.success('Exam removed');
    } catch (error) {
      toast.error('Failed to delete exam');
    } finally {
      setIsDeleting(false);
      setDeletingId(null);
    }
  };

  /**
   * Fetch all eligible students from the students collection
   */
  const fetchStudents = async () => {
    try {
      const querySnapshot = await getDocs(collection(db, 'students'));
      const students = [];
      querySnapshot.forEach((doc) => {
        students.push({ ...doc.data() });
      });
      return students;
    } catch (error) {
      console.error('Error fetching students:', error);
      throw new Error('Failed to fetch students for exam invites');
    }
  };

  /**
   * Create exam invites for all students
   * Generates a unique 6-digit code for each student and stores in examInvites collection
   */
  const createExamInvites = async (students, examId, examTitle) => {
    try {
      const powerAutomateUrl = import.meta.env.VITE_POWER_AUTOMATE_URL;
      
      if (!powerAutomateUrl) {
        console.warn('VITE_POWER_AUTOMATE_URL is not configured. Invites will be created but emails will not be sent.');
      }

      for (const student of students) {

        // Create invite record in Firestore
        const invitation = await addDoc(collection(db, 'examInvites'), {
          rollNo: student.rollNo || '',
          email: student.email || '',
          examId,
          status: 'Pending',
          createdAt: new Date(),
        });
        const code = invitation.examCode;

        // Send to Power Automate if URL is configured
        if (powerAutomateUrl) {
          try {
            await fetch(powerAutomateUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                email: student.email,
                name: student.name || student.rollNo,
                examTitle,
                examCode: code,
              }),
            });
            console.log(`Email sent to ${student.email} with code ${code}`);
          } catch (error) {
            console.error(`Failed to send email to ${student.email}:`, error);
            // Don't throw - continue with other students
          }
        }
      }

      console.log(`Successfully created exam invites for ${students.length} students`);
      toast.success(`Exam invites created for ${students.length} students`);
    } catch (error) {
      console.error('Error creating exam invites:', error);
      throw error;
    }
  };

  const handleSave = async (data) => {
    const audienceError = validateExamAudience(data, colleges);
    if (audienceError) { toast.error(audienceError); return; }
    setIsSaving(true);
    try {
      const students = (await fetchStudents()).filter(student => studentMatchesExam(data, student));
      let savedId;
      if (editExam?.id) {
        // Updating existing exam
        const examRef = doc(db, 'exams', editExam.id);
        await updateDoc(examRef, data);
        setExams(p => p.map(e => e.id === editExam.id ? { ...e, ...data } : e));
        toast.success('Exam updated');
        savedId = editExam.id;
      } else {
        // Creating new exam - generate invites for all students
        const docRef = await addDoc(collection(db, 'exams'), { ...data, examLink: '#' });
        setExams(p => [{ ...data, id: docRef.id, examLink: '#' }, ...p]);
        toast.success('Exam scheduled');
        savedId = docRef.id;
      }
      if (data.status !== 'completed') {
        try {
          const existing = await getDocs(query(collection(db, 'examInvites'), where('examId', '==', savedId)));
          const eligibleRolls = new Set(students.map(student => student.rollNo));
          const retainedRolls = new Set();
          for (const invite of existing.docs) {
            if (!eligibleRolls.has(invite.data().rollNo)) await deleteDoc(doc(db, 'examInvites', invite.id));
            else retainedRolls.add(invite.data().rollNo);
          }
          const missing = students.filter(student => !retainedRolls.has(student.rollNo));
          if (missing.length) await createExamInvites(missing, savedId, data.title);
          if (!students.length) toast('No students currently match the selected colleges and branches.');
        } catch (error) {
          console.error('Failed to synchronize invitations:', error);
          toast.error('Exam saved, but invitations could not be fully updated. Edit and save again to retry.');
        }
      }
      setModalOpen(false);
      setEditExam(null);
    } catch (error) {
      console.error('Error saving exam:', error);
      toast.error('Failed to save exam');
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) return <LoadingSkeleton type="list" rows={5} />;

  return (
    <div className="space-y-7">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Exam Management</h1>
          <p className="text-base mt-1.5" style={{ color: '#ffffff' }}>{exams.length} exams scheduled</p>
        </div>
        <button onClick={() => { setEditExam(null); setModalOpen(true); }}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:scale-105"
          style={{ background: 'linear-gradient(135deg,#f97316,#f59e0b)', boxShadow: '0 8px 20px rgba(249,115,22,0.2)' }}>
          <Plus size={16} /> Schedule Exam
        </button>
      </div>

      <div className="flex gap-2.5">
        {['all', 'upcoming', 'scheduled', 'completed'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className="px-4 py-2.5 rounded-xl text-sm font-medium capitalize transition-all"
            style={filter === f
              ? { background: 'rgba(249, 115, 22,0.2)', color: '#fdba74', border: '1px solid rgba(249, 115, 22,0.4)' }
              : { color: '#71717a', border: '1px solid #27272a' }
            }>{f}</button>
        ))}
      </div>

      <div className="space-y-4">
        <AnimatePresence>
          {filtered.length === 0 ? (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-12 text-center text-zinc-500">
              No exams found. Click "Schedule Exam" to create one.
            </motion.div>
          ) : (
            filtered.map((exam, i) => {
              const diffColor = getDifficultyColor(exam.difficulty);
              const statusColor = getExamStatusColor(exam.status);
              
              const ExamTypeIcon = exam.examType === 'Coding' ? Code : exam.examType === 'AI Interview' ? UserCheck : Monitor;

              return (
                <motion.div key={exam.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }} transition={{ delay: i * 0.06 }}
                  className="rounded-2xl p-7" style={{ background: '#121212', border: '1px solid #27272a' }}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-5">
                      <div className="w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0"
                        style={{ background: 'rgba(249, 115, 22,0.12)' }}>
                        <ExamTypeIcon size={24} style={{ color: '#fdba74' }} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-base text-white">{exam.title}</h3>
                          <span className="text-xs px-2 py-0.5 rounded-md font-medium" style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
                            {exam.examType || 'MCQ'}
                          </span>
                        </div>
                        <p className="text-sm mt-1.5" style={{ color: '#ffffff' }}>{exam.subject} &middot; {exam.department}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <span className="text-sm px-3 py-1.5 rounded-full font-semibold capitalize"
                        style={{ background: `${statusColor}20`, color: statusColor, border: `1px solid ${statusColor}40` }}>
                        {exam.status}
                      </span>
                      <span className="text-sm px-3 py-1.5 rounded-full font-semibold"
                        style={{ background: `${diffColor}20`, color: diffColor }}>
                        {exam.difficulty}
                      </span>
                      <button title="Edit exam" onClick={() => { setEditExam(exam); setModalOpen(true); }}
                        className="w-9 h-9 rounded-xl flex items-center justify-center hover:bg-blue-500/20 transition-all"
                        style={{ color: '#f97316' }}><Edit2 size={15} /></button>
                      <button onClick={() => handleDelete(exam.id)} disabled={isDeleting && deletingId === exam.id} className="w-9 h-9 rounded-xl flex items-center justify-center hover:bg-red-500/20 transition-all"
                        style={{ color: '#ef4444', opacity: isDeleting && deletingId === exam.id ? 0.5 : 1 }}>
                        {isDeleting && deletingId === exam.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-5 mt-5">
                    <div className="flex items-center gap-2.5">
                      <Calendar size={15} style={{ color: '#ffffff' }} />
                      <span className="text-sm" style={{ color: '#a1a1aa' }}>{formatDate(exam.date)}</span>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <Clock size={15} style={{ color: '#ffffff' }} />
                      <span className="text-sm" style={{ color: '#a1a1aa' }}>{exam.time} &middot; {exam.duration}</span>
                    </div>
                    <span className="text-sm" style={{ color: '#ffffff' }}>Total: {exam.totalMarks} marks</span>
                  </div>
                  <button onClick={() => setQuestionExam(exam)} className="mt-4 px-4 py-2 rounded-lg bg-orange-600/20 text-orange-300 border border-orange-600/40">{exam.questionSource === 'csv' ? `Manage questions (${exam.questionCount || 0})` : 'Upload questions CSV'}</button>
                  <p className="text-sm mt-3 leading-relaxed" style={{ color: '#475569' }}>
                    <span style={{ color: '#ffffff' }}>Syllabus: </span>{exam.syllabus}
                  </p>
                  <p className="mt-3 text-sm text-zinc-400">Students: {exam.audienceMode === 'selected'
                    ? exam.audience?.map(target => `${target.collegeName}: ${target.branches.join(', ')}`).join(' · ')
                    : 'All colleges and branches'}</p>
                </motion.div>
              );
            })
          )}
        </AnimatePresence>
      </div>

      {questionExam && <QuestionBankModal exam={questionExam} onClose={() => setQuestionExam(null)} onSaved={bank => setExams(current => current.map(e => e.id === questionExam.id ? {...e, questionSource:'csv', totalMarks:bank.totalMarks,questionCount:(bank.questions||bank.problems).length} : e))} />}
      <AnimatePresence>
        {modalOpen && <ExamModal exam={editExam} colleges={colleges} onClose={() => { setModalOpen(false); setEditExam(null); }} onSave={handleSave} isSaving={isSaving} />}
      </AnimatePresence>
    </div>
  );
}

function ExamModal({ exam, colleges, onClose, onSave, isSaving }) {
  const [form, setForm] = useState({
    title: exam?.title || '', 
    subject: exam?.subject || '', 
    department: exam?.department || 'Computer Science',
    examType: exam?.examType || 'MCQ',
    date: exam?.date || '', 
    time: exam?.time || '', 
    duration: exam?.duration || '1 Hour',
    totalMarks: exam?.totalMarks || 100, 
    difficulty: exam?.difficulty || 'Medium',
    status: exam?.status || 'upcoming', 
    syllabus: exam?.syllabus || '',
    audienceMode: exam ? (exam.audienceMode || 'all') : 'selected',
    audience: exam?.audience || [],
  });

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  // Date constraints: min date is today
  const today = new Date().toISOString().split('T')[0];

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.title || !form.date || !form.time) {
      toast.error('Please fill in all required fields.');
      return;
    }
    const audienceError = validateExamAudience(form, colleges);
    if (audienceError) { toast.error(audienceError); return; }
    onSave(form);
  };

  return createPortal(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)' }} onClick={onClose}>
      <motion.div initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }}
        onClick={e => e.stopPropagation()} className="rounded-2xl p-8 w-full max-w-2xl max-h-[90vh] overflow-y-auto custom-scrollbar"
        style={{ background: '#0a0a0a', border: '1px solid #27272a', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)' }}>
        
        <style>
          {`
            .custom-scrollbar::-webkit-scrollbar { width: 6px; }
            .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
            .custom-scrollbar::-webkit-scrollbar-thumb { background: #27272a; border-radius: 10px; }
            input[type="date"],
            input[type="time"] {
              color-scheme: dark;
              accent-color: #f97316;
              font-size: 1em;
              cursor: pointer;
            }
            input[type="date"]::-webkit-calendar-picker-indicator,
            input[type="time"]::-webkit-calendar-picker-indicator {
              filter: invert(0) sepia(1) saturate(10) hue-rotate(320deg) brightness(1.2);
              cursor: pointer;
              opacity: 1;
            }
          `}
        </style>
        
        <div className="flex items-center justify-between mb-7">
          <h3 className="font-bold text-xl text-white">{exam ? 'Edit Exam' : 'Schedule New Exam'}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors"><X size={24} /></button>
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="md:col-span-2">
            <label className="block text-sm font-semibold mb-2 text-zinc-300">Exam Title <span className="text-red-500">*</span></label>
            <input value={form.title} onChange={set('title')} className="w-full px-4 py-3 rounded-xl text-sm outline-none transition-all focus:ring-2 focus:ring-orange-500/50"
              placeholder="e.g. Mid-Term Data Structures Assessment"
              style={{ background: '#000000', border: '1px solid #27272a', color: '#fafafa' }} required />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-zinc-300">Exam Type</label>
            <select value={form.examType} onChange={set('examType')} className="w-full px-4 py-3 rounded-xl text-sm outline-none"
              style={{ background: '#000000', border: '1px solid #27272a', color: '#fafafa' }}>
              <option value="MCQ">MCQ (Multiple Choice)</option>
              <option value="Coding">Coding</option>
              <option value="Mixed">Mixed (MCQ + Coding)</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-zinc-300">Subject</label>
            <input value={form.subject} onChange={set('subject')} className="w-full px-4 py-3 rounded-xl text-sm outline-none"
              placeholder="e.g. Computer Science"
              style={{ background: '#000000', border: '1px solid #27272a', color: '#fafafa' }} />
          </div>

          <div className="md:col-span-2 rounded-xl border border-orange-500/30 bg-orange-500/5 p-4 text-sm text-zinc-300">
            <p className="font-semibold text-orange-200">Question upload format</p>
            {form.examType === 'MCQ' && <p className="mt-1">MCQ CSV: question_id, question, option_a, option_b, option_c, option_d, correct_option, marks. <a className="text-orange-300 underline" href="/templates/mcq-questions-sample.csv" download>Download MCQ sample</a></p>}
            {form.examType === 'Coding' && <p className="mt-1">Coding CSV: problem_id, title, description, input/output format, marks, test input, expected output and visibility. <a className="text-orange-300 underline" href="/templates/coding-questions-sample.csv" download>Download Coding sample</a></p>}
            {form.examType === 'Mixed' && <p className="mt-1">Mixed exams use both the MCQ and Coding CSV templates under one exam. Upload both files from the Questions action after saving this exam.</p>}
            <p className="mt-2 text-xs text-zinc-400">Save the exam, then use Upload questions CSV on its exam card.</p>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-zinc-300">Date <span className="text-red-500">*</span></label>
            <input type="date" min={today} value={form.date} onChange={set('date')}
              className="w-full px-4 py-3 rounded-xl text-sm outline-none"
              style={{ background: '#000000', border: '1px solid #27272a', color: '#fafafa' }} required />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-zinc-300">Time <span className="text-red-500">*</span></label>
            <input type="time" value={form.time} onChange={set('time')}
              className="w-full px-4 py-3 rounded-xl text-sm outline-none"
              style={{ background: '#000000', border: '1px solid #27272a', color: '#fafafa' }} required />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-zinc-300">Duration</label>
            <select value={form.duration} onChange={set('duration')} className="w-full px-4 py-3 rounded-xl text-sm outline-none"
              style={{ background: '#000000', border: '1px solid #27272a', color: '#fafafa' }}>
              <option value="30 Minutes">30 Minutes</option>
              <option value="45 Minutes">45 Minutes</option>
              <option value="1 Hour">1 Hour</option>
              <option value="1.5 Hours">1.5 Hours</option>
              <option value="2 Hours">2 Hours</option>
              <option value="3 Hours">3 Hours</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-zinc-300">Total Marks</label>
            <input type="number" min="0" value={form.totalMarks} onChange={set('totalMarks')}
              className="w-full px-4 py-3 rounded-xl text-sm outline-none"
              style={{ background: '#000000', border: '1px solid #27272a', color: '#fafafa' }} />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-zinc-300">Difficulty</label>
            <select value={form.difficulty} onChange={set('difficulty')} className="w-full px-4 py-3 rounded-xl text-sm outline-none"
              style={{ background: '#000000', border: '1px solid #27272a', color: '#fafafa' }}>
              {['Easy', 'Medium', 'Hard'].map(d => <option key={d}>{d}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 text-zinc-300">Status</label>
            <select value={form.status} onChange={set('status')} className="w-full px-4 py-3 rounded-xl text-sm outline-none"
              style={{ background: '#000000', border: '1px solid #27272a', color: '#fafafa' }}>
              {['upcoming', 'scheduled', 'completed'].map(d => <option key={d} value={d} className="capitalize">{d}</option>)}
            </select>
          </div>

          <fieldset className="md:col-span-2 space-y-4 rounded-xl border border-zinc-800 p-4" disabled={isSaving}>
            <legend className="px-2 text-sm font-semibold text-zinc-300">Colleges and branches *</legend>
            <div className="flex flex-wrap gap-5 text-sm text-zinc-200">
              <label className="flex items-center gap-2"><input type="radio" name="audienceMode" value="selected" checked={form.audienceMode === 'selected'} onChange={() => setForm(previous => ({ ...previous, audienceMode: 'selected' }))} />Specific colleges and branches</label>
              <label className="flex items-center gap-2"><input type="radio" name="audienceMode" value="all" checked={form.audienceMode === 'all'} onChange={() => setForm(previous => ({ ...previous, audienceMode: 'all', audience: [] }))} />All students</label>
            </div>
            {form.audienceMode === 'selected' && <div className="space-y-3">
              <p className="text-xs text-zinc-400">Select colleges, then select one or more branches in each. Only matching students receive invitations.</p>
              {!colleges.length && <p className="text-sm text-amber-400">Add colleges and branches in Colleges before scheduling a targeted exam.</p>}
              {colleges.map(college => {
                const selected = form.audience.find(target => target.collegeId === college.id);
                const toggleCollege = checked => setForm(previous => ({ ...previous, audience: checked
                  ? [...previous.audience, { collegeId: college.id, collegeName: college.name, branches: [] }]
                  : previous.audience.filter(target => target.collegeId !== college.id) }));
                const setBranches = branches => setForm(previous => ({ ...previous, audience: previous.audience.map(target => target.collegeId === college.id ? { ...target, collegeName: college.name, branches } : target) }));
                return <div key={college.id} className="rounded-lg border border-zinc-800 p-3">
                  <label className="flex items-center gap-2 text-sm font-semibold text-white"><input type="checkbox" checked={!!selected} onChange={event => toggleCollege(event.target.checked)} />{college.name}</label>
                  {selected && <div className="mt-3 space-y-2 pl-5">
                    <label className="flex items-center gap-2 text-xs text-orange-300"><input type="checkbox" checked={!!college.branches?.length && college.branches.every(branch => selected.branches.includes(branch))} onChange={event => setBranches(event.target.checked ? [...college.branches] : [])} />All branches in {college.name}</label>
                    <div className="flex flex-wrap gap-x-5 gap-y-2">{college.branches?.map(branch => <label key={branch} className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" aria-label={`${college.name} — ${branch}`} checked={selected.branches.includes(branch)} onChange={event => setBranches(event.target.checked ? [...selected.branches, branch] : selected.branches.filter(value => value !== branch))} />{branch}</label>)}</div>
                    {!selected.branches.length && <p className="text-xs text-amber-400">Select at least one branch for this college.</p>}
                  </div>}
                </div>;
              })}
              {form.audience.filter(target => !colleges.some(college => college.id === target.collegeId)).map(target => <div key={target.collegeId} className="text-sm text-amber-400">{target.collegeName} is no longer available. <button type="button" onClick={() => setForm(previous => ({ ...previous, audience: previous.audience.filter(item => item.collegeId !== target.collegeId) }))}>Remove selection</button></div>)}
            </div>}
          </fieldset>

          <div className="md:col-span-2">
            <label className="block text-sm font-semibold mb-2 text-zinc-300">Syllabus Topics</label>
            <textarea value={form.syllabus} onChange={set('syllabus')} className="w-full px-4 py-3 rounded-xl text-sm outline-none resize-none h-24"
              placeholder="E.g., Arrays, Strings, Dynamic Programming..."
              style={{ background: '#000000', border: '1px solid #27272a', color: '#fafafa' }} />
          </div>

          <div className="md:col-span-2 flex gap-3 mt-4 pt-4 border-t border-zinc-800">
            <button type="button" onClick={onClose} disabled={isSaving} className="flex-1 py-3.5 rounded-xl text-sm font-medium transition-colors hover:bg-zinc-800 bg-zinc-900 text-zinc-400" style={{ opacity: isSaving ? 0.5 : 1 }}>
              Cancel
            </button>
            <button type="submit" disabled={isSaving} className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-xl text-sm font-semibold text-white transition-transform hover:scale-[1.02]"
              style={{ background: 'linear-gradient(135deg,#f97316,#f59e0b)', opacity: isSaving ? 0.7 : 1 }}>
              {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} {isSaving ? 'Saving...' : (exam ? 'Update Exam' : 'Schedule Exam')}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>,
    document.body
  );
}
