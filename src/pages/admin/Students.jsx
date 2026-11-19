import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, Edit2, FileUp, Loader2, Plus, Search, Save, Trash2, X, Mail } from 'lucide-react';
import { collection, deleteDoc, doc, getDocs, updateDoc, writeBatch, setDoc } from '../../services/mongoDb.js';
import toast from 'react-hot-toast';
import { db } from '../../services/mongoDb.js';
import { calculatePlacementIndex, exportToCSV, generateInitials, getAvatarColor } from '../../utils/helpers';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';

const CSV_TEMPLATE = 'rollNo,name,email,phone,college,branch,department,year,passoutYear\n21P31A0501,Jane Doe,jane@university.edu,+919876543210,Example College,CSE,Computer Science,3,2027\n';

function branchesAsText(value) {
  return Array.isArray(value) ? value.join(', ') : (value || '').toString();
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell.trim()); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(cell.trim());
      if (row.some(value => value !== '')) rows.push(row);
      row = []; cell = '';
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

function csvStudent(headers, values) {
  const record = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  const pick = (...keys) => {
    for (const key of keys) if (record[key]) return record[key].trim();
    return '';
  };
  const branch = pick('branch', 'branches', 'program');
  const numeric = (value, fallback = 0) => value === '' ? fallback : Number(value);
  return {
    rollNo: pick('rollno', 'rollnumber', 'roll', 'rollid', 'studentid').toUpperCase(),
    name: pick('name', 'fullname', 'studentname', 'firstname'),
    email: pick('email', 'studentemail', 'academicemail'),
    phone: pick('phone', 'phonenumber', 'mobile'),
    college: pick('college', 'collegename'),
    branch: branch ? branch.split(/[;|]/).map(item => item.trim()).filter(Boolean) : [],
    department: pick('department', 'dept') || branch,
    year: numeric(pick('year', 'currentyear'), 1),
    passoutYear: pick('passoutyear', 'graduationyear'),
  };
}

function validateStudent(student) {
  if (!student.rollNo || !student.name) return 'Each student needs a roll number and name.';
  if (!student.email) return 'Each student needs an email address for account activation.';
  if (student.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(student.email)) return `Invalid email for ${student.rollNo}.`;
  if (!Number.isFinite(student.year) || student.year < 1 || student.year > 8) return `Year must be between 1 and 8 for ${student.rollNo}.`;
  return '';
}

function downloadCsvTemplate() {
  const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'student-import-template.csv';
  link.click();
  URL.revokeObjectURL(url);
}

export default function AdminStudents() {
  const [loading, setLoading] = useState(true);
  const [students, setStudents] = useState([]);
  const [collegeRecords, setCollegeRecords] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedCollege, setSelectedCollege] = useState('All');
  const [selectedBranch, setSelectedBranch] = useState('All');
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editStudent, setEditStudent] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [activationStatus, setActivationStatus] = useState(null);
  const [sendingActivations, setSendingActivations] = useState(false);
  const fileInput = useRef(null);
  const PER_PAGE = 8;
  const activationRequest = async (action, body) => {
    const response = await fetch(`/api/proxy?path=auth/${action}`, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('s360_token') || ''}` }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Activation request failed.');
    return data;
  };
  const refreshActivationStatus = () => activationRequest('activation-status').then(setActivationStatus).catch(() => setActivationStatus(null));
  const showActivation = result => {
    const activation = result?.activation || result;
    if (!activation?.statuses) return;
    if (activation.statuses.email_conflict || activation.statuses.setup_failed) toast.error('Student saved, but login setup needs attention. Check for an existing account with this email, then retry activation.');
    else if (activation.statuses.active) toast('This student already has an active login. Their password was not changed.');
    else if (activation.statuses.missing_email) toast.error('Add a valid student email before sending activation.');
    else if (activation.delivery?.sent) toast.success(`${activation.delivery.sent} activation email(s) accepted for delivery.`);
    else if (activation.delivery?.configured === false) toast('Activation queued. Email delivery setup is required.');
    else if (activation.delivery?.failed) toast.error('Activation queued for retry because email delivery failed.');
    else if (activation.statuses.recently_sent) toast('An activation email was just sent. Please wait a minute before resending.');
    else toast('Activation queued. Send pending activations to process it.');
    refreshActivationStatus();
  };
  const resendActivation = async student => {
    setSendingActivations(true);
    try { showActivation(await activationRequest('resend-activation', { studentId: student.id })); }
    catch (error) { toast.error(error.message); }
    finally { setSendingActivations(false); }
  };
  const sendPendingActivations = async () => {
    setSendingActivations(true);
    try {
      const result = await activationRequest('process-activations', {});
      setActivationStatus(result);
      if (!result.configured) toast.error('Configure email delivery before sending activations.');
      else if (result.failed) toast.error('Email delivery failed. Pending activations will be retried.');
      else toast(`${result.sent} email(s) accepted for delivery; ${result.pending} pending.${!result.sent && result.pending ? ' The daily sending limit or retry delay may apply.' : ''}`);
    } catch (error) { toast.error(error.message); }
    finally { setSendingActivations(false); }
  };

  const fetchStudents = async () => {
    setLoading(true);
    try {
      const [studentsSnapshot, resultsSnapshot, collegesSnapshot] = await Promise.all([
        getDocs(collection(db, 'students')),
        getDocs(collection(db, 'results')).catch(error => {
          console.warn('Could not load results for placement scores:', error);
          return null;
        }),
        getDocs(collection(db, 'colleges')).catch(error => {
          console.warn('Could not load colleges:', error);
          return null;
        }),
      ]);
      setCollegeRecords(collegesSnapshot?.docs.map(item => ({ id: item.id, ...item.data() })) || []);
      const results = resultsSnapshot?.docs.map(item => ({ id: item.id, ...item.data() })) || [];
      setStudents(studentsSnapshot.docs.map(item => {
        const student = { id: item.id, ...item.data() };
        return { ...student, placementIndex: calculatePlacementIndex(student, results) };
      }));
    } catch (error) {
      console.error('Error fetching students:', error);
      toast.error('Failed to load students. Check administrator access and try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchStudents(); refreshActivationStatus(); }, []);

  const colleges = ['All', ...new Set(students.map(student => student.college).filter(Boolean))];
  const branches = ['All', ...new Set(students.flatMap(student => branchesAsText(student.branch).split(',').map(value => value.trim()).filter(Boolean)))];
  const filtered = students.filter(student => {
    const query = search.toLowerCase();
    const matchesSearch = (student.name || '').toLowerCase().includes(query) || (student.rollNo || '').toLowerCase().includes(query) || (student.email || '').toLowerCase().includes(query);
    const matchesCollege = selectedCollege === 'All' || student.college === selectedCollege;
    const matchesBranch = selectedBranch === 'All' || branchesAsText(student.branch).split(',').map(value => value.trim()).includes(selectedBranch);
    return matchesSearch && matchesCollege && matchesBranch;
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  useEffect(() => { setPage(current => Math.min(current, totalPages)); }, [totalPages]);
  const paged = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const handleDelete = async id => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteDoc(doc(db, 'students', id));
      setStudents(previous => previous.filter(student => student.id !== id));
      setDeleteConfirm(null);
      toast.success('Student removed');
    } catch (error) {
      console.error('Failed to delete student:', error);
      const code = error?.code || 'unknown';
      if (code === 'not-found') {
        setStudents(previous => previous.filter(student => student.id !== id));
        setDeleteConfirm(null);
        toast('This student was already removed.');
        return;
      }
      toast.error(code === 'permission-denied'
        ? 'You need administrator access to delete students.'
        : code === 'unauthenticated'
          ? 'Your session has expired. Sign in again to delete students.'
          : `Could not delete student (${code}): ${error?.message || 'Unknown error'}`);
    } finally { setIsDeleting(false); }
  };

  const handleSave = async form => {
    const student = {
      ...form,
      rollNo: form.rollNo.trim().toUpperCase(),
      name: form.name.trim(),
      email: form.email.trim(),
      branch: form.branch.trim() ? [form.branch.trim()] : [],
      department: form.department.trim() || form.branch.trim(),
      year: Number(form.year),
      passoutYear: form.passoutYear ? String(form.passoutYear) : '',
    };
    const selectedCollege = collegeRecords.find(item => item.name === student.college);
    if (!student.college) { toast.error('Select a college.'); return; }
    if (!editStudent && !selectedCollege) { toast.error('Select a college from the managed Colleges list.'); return; }
    if (selectedCollege?.branches?.length && student.branch.length && !selectedCollege.branches.includes(student.branch[0])) {
      toast.error('Select a branch belonging to the chosen college.'); return;
    }
    const validationError = validateStudent(student);
    if (validationError) { toast.error(validationError); return; }
    setIsSaving(true);
    try {
      if (editStudent?.id) {
        if (student.rollNo !== editStudent.id) {
          toast.error('Roll number cannot be changed after a student is added.');
          return;
        }
        await updateDoc(doc(db, 'students', editStudent.id), student);
        setStudents(previous => previous.map(item => item.id === editStudent.id ? { ...item, ...student } : item));
        toast.success('Student updated');
      } else {
        const existing = students.some(item => item.id.toUpperCase() === student.rollNo);
        if (existing) { toast.error('A student with this roll number already exists.'); return; }
        const result = await setDoc(doc(db, 'students', student.rollNo), student);
        showActivation(result);
        setStudents(previous => [{ ...student, id: student.rollNo }, ...previous]);
        toast.success('Student added');
      }
      setModalOpen(false);
      setEditStudent(null);
    } catch (error) {
      console.error('Failed to save student:', error);
      toast.error('Failed to save student. Check administrator access and try again.');
    } finally { setIsSaving(false); }
  };

  const handleCsvImport = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setIsImporting(true);
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) throw new Error('CSV must include a header row and at least one student.');
      const headers = rows[0].map(value => value.toLowerCase().replace(/[^a-z0-9]/g, ''));
      const seen = new Set(students.map(student => student.id.toUpperCase()));
      const pending = [];
      let skipped = 0;
      for (let index = 1; index < rows.length; index += 1) {
        const student = csvStudent(headers, rows[index]);
        if (validateStudent(student) || seen.has(student.rollNo)) { skipped += 1; continue; }
        seen.add(student.rollNo);
        pending.push(student);
      }
      if (!pending.length) {
        toast.error(`No new valid students to import (${skipped} rows skipped).`);
        return;
      }
      for (let offset = 0; offset < pending.length; offset += 50) {
        const batch = writeBatch(db);
        pending.slice(offset, offset + 50).forEach(student => batch.set(doc(db, 'students', student.rollNo), student));
        const result = await batch.commit();
        showActivation(result);
      }
      setStudents(previous => [...pending.map(student => ({ ...student, id: student.rollNo })), ...previous]);
      toast.success(`Imported ${pending.length} students; skipped ${skipped} invalid or duplicate rows.`);
    } catch (error) {
      console.error('CSV student import failed:', error);
      toast.error(error.message || 'Could not import this CSV file.');
    } finally { setIsImporting(false); }
  };

  if (loading) return <LoadingSkeleton type="table" rows={6} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><h1 className="text-2xl font-bold text-white">Student Management</h1><p className="mt-1 text-sm text-zinc-400">{students.length} students</p></div>
        <div className="flex flex-wrap gap-2">
          <button onClick={downloadCsvTemplate} className="btn btn-ghost"><Download size={14} /> CSV template</button>
          <button onClick={() => exportToCSV(students, 'students')} className="btn btn-ghost"><Download size={14} /> Export</button>
          <button onClick={() => fileInput.current?.click()} disabled={isImporting} className="btn btn-ghost">
            {isImporting ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />} Import CSV
          </button>
          <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={handleCsvImport} className="hidden" />
          <button onClick={() => { setEditStudent(null); setModalOpen(true); }} className="btn btn-primary"><Plus size={14} /> Add Student</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 p-4">
        <p className="text-sm text-zinc-400">{activationStatus
          ? `${activationStatus.pending} activation email(s) pending.${activationStatus.configured ? '' : ' Email delivery setup is required before invitations can be sent.'}`
          : 'Students receive an activation email to set their own password. Use the envelope action to send or resend an invitation.'}</p>
        <button type="button" onClick={sendPendingActivations} disabled={sendingActivations} className="btn btn-ghost"><Mail size={14} />{sendingActivations ? 'Processing…' : 'Send pending activations'}</button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Search name, email, or roll number" className="input w-full pl-9" /></div>
        <select value={selectedCollege} onChange={event => { setSelectedCollege(event.target.value); setPage(1); }} className="input"><option value="All">All colleges</option>{colleges.filter(value => value !== 'All').map(value => <option key={value}>{value}</option>)}</select>
        <select value={selectedBranch} onChange={event => { setSelectedBranch(event.target.value); setPage(1); }} className="input"><option value="All">All branches</option>{branches.filter(value => value !== 'All').map(value => <option key={value}>{value}</option>)}</select>
      </div>

      <div className="table-wrapper"><div className="table-scroll"><table className="w-full"><thead><tr>
        {['Student', 'Roll No.', 'College', 'Branch', 'Exam score', 'Actions'].map(label => <th key={label} className="px-4 py-3 text-left text-xs font-semibold text-zinc-400">{label}</th>)}
      </tr></thead><tbody><AnimatePresence>
        {paged.map((student, index) => <motion.tr key={student.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ delay: index * 0.025 }} className="border-b border-zinc-800/50">
          <td className="px-4 py-4"><div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: getAvatarColor(student.name || student.rollNo || 'S') }}>{generateInitials(student.name || student.rollNo || 'S')}</div><div><div className="font-semibold text-zinc-100">{student.name || 'Unknown'}</div><div className="text-xs text-zinc-500">{student.email || student.passoutYear ? `${student.email || ''}${student.email && student.passoutYear ? ' · ' : ''}${student.passoutYear ? `Passout ${student.passoutYear}` : ''}` : 'No email'}</div></div></div></td>
          <td className="px-4 py-4">{student.rollNo || student.id}</td><td className="px-4 py-4">{student.college || '—'}</td><td className="px-4 py-4">{branchesAsText(student.branch) || student.department || '—'}</td>
          <td className="px-4 py-4"><span className="font-semibold text-emerald-400">{student.placementIndex ?? 0}%</span></td>
          <td className="px-4 py-4"><div className="flex gap-2"><button title="Edit student" onClick={() => { setEditStudent(student); setModalOpen(true); }} className="rounded-lg bg-orange-500/10 p-2 text-orange-300"><Edit2 size={14} /></button><button type="button" title="Send activation email" disabled={sendingActivations || !student.email} onClick={() => resendActivation(student)} className="rounded-lg bg-blue-500/10 p-2 text-blue-300 disabled:opacity-40"><Mail size={14} /></button><button title="Delete student" onClick={() => setDeleteConfirm(student.id)} className="rounded-lg bg-red-500/10 p-2 text-red-400"><Trash2 size={14} /></button></div></td>
        </motion.tr>)}
      </AnimatePresence>{paged.length === 0 && <tr><td colSpan={6} className="py-14 text-center text-zinc-500">No students found. Add one manually or import a CSV.</td></tr>}</tbody></table></div>
        {filtered.length > PER_PAGE && <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3 text-sm text-zinc-400"><span>Page {page} of {totalPages}</span><div className="flex gap-2"><button onClick={() => setPage(value => Math.max(1, value - 1))} disabled={page === 1} className="btn btn-ghost">Previous</button><button onClick={() => setPage(value => Math.min(totalPages, value + 1))} disabled={page === totalPages} className="btn btn-ghost">Next</button></div></div>}
      </div>

      <AnimatePresence>{modalOpen && <StudentModal student={editStudent} collegeRecords={collegeRecords} onClose={() => { setModalOpen(false); setEditStudent(null); }} onSave={handleSave} isSaving={isSaving} />}</AnimatePresence>
      {createPortal(<AnimatePresence>{deleteConfirm && (<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4" onClick={() => { if (!isDeleting) setDeleteConfirm(null); }}><motion.div initial={{ scale: 0.96 }} animate={{ scale: 1 }} onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="delete-student-title" className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950 p-7"><Trash2 size={28} className="mx-auto mb-4 text-red-400" /><h2 id="delete-student-title" className="text-center text-xl font-bold text-white">Remove student?</h2><p className="my-4 text-center text-sm text-zinc-400">This removes the student record from the portal.</p><div className="flex gap-3"><button className="btn btn-ghost flex-1" onClick={() => setDeleteConfirm(null)} disabled={isDeleting}>Cancel</button><button className="btn flex-1 bg-red-600 text-white" onClick={() => handleDelete(deleteConfirm)} disabled={isDeleting}>{isDeleting ? <Loader2 size={15} className="animate-spin" /> : 'Delete'}</button></div></motion.div></motion.div>)}</AnimatePresence>, document.body)}
      <p className="text-xs text-zinc-500">CSV requires <code>rollNo</code>, <code>name</code> and <code>email</code>. Existing roll numbers are skipped. New students receive an activation email when delivery is configured.</p>
    </div>
  );
}

function StudentModal({ student, collegeRecords, onClose, onSave, isSaving }) {
  const [form, setForm] = useState({
    name: student?.name || '', email: student?.email || '', rollNo: student?.rollNo || '', phone: student?.phone || '',
    college: student?.college || '', branch: Array.isArray(student?.branch) ? (student.branch[0] || '') : (student?.branch || ''), department: student?.department || '',
    year: student?.year || 1, passoutYear: student?.passoutYear || '',
  });
  const set = key => event => setForm(previous => ({ ...previous, [key]: event.target.value }));
  const selectedCollege = collegeRecords.find(item => item.name === form.college);
  const branchOptions = selectedCollege?.branches || [];
  const fields = [
    ['Full name *', 'name', 'text'], ['Email *', 'email', 'email'], ['Roll number *', 'rollNo', 'text'], ['Phone', 'phone', 'tel'],
    ['Department', 'department', 'text'], ['Current year', 'year', 'number'],
    ['CGPA (0–10)', 'cgpa', 'number'], ['B.Tech %', 'btech', 'number'], ['Backlogs', 'backlogs', 'number'], ['Passout year', 'passoutYear', 'number'], ['GitHub username', 'githubUsername', 'text'],
  ];
  const visibleFields = fields.filter(([, key]) => !['cgpa', 'btech', 'backlogs', 'githubUsername'].includes(key));
  return createPortal(<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
    <motion.div initial={{ scale: 0.96, y: 12 }} animate={{ scale: 1, y: 0 }} onClick={event => event.stopPropagation()} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
      <div className="mb-6 flex items-center justify-between"><div><h2 className="text-xl font-bold text-white">{student ? 'Edit student' : 'Add student'}</h2><p className="mt-1 text-sm text-zinc-400">Fields marked * are required.</p></div><button onClick={onClose} className="text-zinc-400 hover:text-white"><X size={22} /></button></div>
      <form onSubmit={event => { event.preventDefault(); onSave(form); }}><div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {visibleFields.map(([label, key, type]) => <label key={key} className="text-sm font-medium text-zinc-300">{label}<input required={key === 'name' || key === 'rollNo' || key === 'email'} min={type === 'number' && key === 'year' ? 1 : undefined} max={key === 'year' ? 8 : undefined} step="any" type={type} value={form[key]} onChange={set(key)} disabled={student && key === 'rollNo'} className="mt-2 w-full rounded-xl border border-zinc-800 bg-black px-3 py-3 text-white outline-none focus:border-orange-500" /></label>)}
        <label className="text-sm font-medium text-zinc-300">College *<select required value={form.college} onChange={event => setForm(previous => ({ ...previous, college: event.target.value, branch: '' }))} className="mt-2 w-full rounded-xl border border-zinc-800 bg-black px-3 py-3 text-white outline-none focus:border-orange-500"><option value="">Select a college</option>{collegeRecords.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}{form.college && !collegeRecords.some(item => item.name === form.college) && <option value={form.college}>{form.college} (existing record)</option>}</select></label>
        <label className="text-sm font-medium text-zinc-300">Branch *<select required value={form.branch} disabled={!form.college} onChange={set('branch')} className="mt-2 w-full rounded-xl border border-zinc-800 bg-black px-3 py-3 text-white outline-none focus:border-orange-500 disabled:opacity-50"><option value="">{form.college ? 'Select a branch' : 'Select a college first'}</option>{branchOptions.map(branch => <option key={branch} value={branch}>{branch}</option>)}{form.branch && !branchOptions.includes(form.branch) && <option value={form.branch}>{form.branch} (existing record)</option>}</select></label>
      </div><div className="mt-6 flex justify-end gap-3 border-t border-zinc-800 pt-5"><button type="button" onClick={onClose} disabled={isSaving} className="btn btn-ghost">Cancel</button><button type="submit" disabled={isSaving} className="btn btn-primary">{isSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}{isSaving ? 'Saving…' : student ? 'Save changes' : 'Add student'}</button></div></form>
    </motion.div>
  </motion.div>, document.body);
}
