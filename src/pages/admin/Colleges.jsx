import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Building2, Edit2, Loader2, Plus, Save, Trash2, X } from 'lucide-react';
import { addDoc, collection, deleteDoc, doc, getDocs, serverTimestamp, updateDoc } from '../../services/mongoDb.js';
import toast from 'react-hot-toast';
import { db } from '../../services/mongoDb.js';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';

function parseBranches(value) {
  return [...new Set(value.split(/[\n,;|]/).map(branch => branch.trim()).filter(Boolean))];
}

export default function AdminColleges() {
  const [colleges, setColleges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const loadColleges = async () => {
    setLoading(true);
    try {
      const snapshot = await getDocs(collection(db, 'colleges'));
      setColleges(snapshot.docs.map(item => ({ id: item.id, ...item.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || '')));
    } catch (error) {
      console.error('Failed to load colleges:', error);
      toast.error(error.code === 'permission-denied' ? 'College access denied. Check the deployed Firestore rules.' : 'Could not load colleges. Try refreshing.');
    } finally { setLoading(false); }
  };

  useEffect(() => { loadColleges(); }, []);

  const saveCollege = async ({ name, branches }) => {
    const cleanName = name.trim();
    const cleanBranches = parseBranches(branches);
    if (!cleanName) { toast.error('Enter a college name.'); return; }
    if (!cleanBranches.length) { toast.error('Add at least one branch.'); return; }
    const duplicate = colleges.some(college => college.id !== editing?.id && (college.name || '').trim().toLowerCase() === cleanName.toLowerCase());
    if (duplicate) { toast.error('A college with this name already exists.'); return; }

    setSaving(true);
    try {
      const payload = { name: cleanName, branches: cleanBranches, updatedAt: serverTimestamp() };
      if (editing) {
        await updateDoc(doc(db, 'colleges', editing.id), payload);
        setColleges(previous => previous.map(college => college.id === editing.id ? { ...college, ...payload } : college).sort((a, b) => a.name.localeCompare(b.name)));
        toast.success('College updated');
      } else {
        const reference = await addDoc(collection(db, 'colleges'), { ...payload, createdAt: serverTimestamp() });
        setColleges(previous => [...previous, { id: reference.id, ...payload }].sort((a, b) => a.name.localeCompare(b.name)));
        toast.success('College added');
      }
      setModalOpen(false);
      setEditing(null);
    } catch (error) {
      console.error('Failed to save college:', error);
      toast.error(error.code === 'permission-denied' ? 'College changes denied. Check the deployed Firestore rules.' : `Could not save college${error.code ? ` (${error.code})` : ''}.`);
    } finally { setSaving(false); }
  };

  const removeCollege = async college => {
    const confirmed = window.confirm(`Delete ${college.name}? Existing student records will keep their saved college and branch values.`);
    if (!confirmed) return;
    setDeletingId(college.id);
    try {
      await deleteDoc(doc(db, 'colleges', college.id));
      setColleges(previous => previous.filter(item => item.id !== college.id));
      toast.success('College deleted');
    } catch (error) {
      console.error('Failed to delete college:', error);
      toast.error(error.code === 'permission-denied' ? 'College deletion denied. Check the deployed Firestore rules.' : `Could not delete college${error.code ? ` (${error.code})` : ''}.`);
    } finally { setDeletingId(null); }
  };

  if (loading) return <LoadingSkeleton type="table" rows={5} />;

  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-2xl font-bold text-white">Colleges & Branches</h1><p className="mt-1 text-sm text-zinc-400">Manage colleges and the branches available when adding students.</p></div>
      <button className="btn btn-primary" onClick={() => { setEditing(null); setModalOpen(true); }}><Plus size={15} /> Add College</button>
    </div>
    {colleges.length === 0 ? <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-12 text-center"><Building2 size={34} className="mx-auto mb-3 text-zinc-500" /><p className="font-semibold text-white">No colleges added yet</p><p className="mt-1 text-sm text-zinc-400">Add a college and its branches to use them in student records.</p></div> :
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{colleges.map(college => <motion.section layout key={college.id} className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
        <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><div className="rounded-xl bg-orange-500/10 p-3 text-orange-300"><Building2 size={19} /></div><h2 className="truncate font-bold text-white">{college.name}</h2></div>
          <div className="flex gap-1"><button title="Edit college" onClick={() => { setEditing(college); setModalOpen(true); }} className="rounded-lg p-2 text-orange-300 hover:bg-orange-500/10"><Edit2 size={15} /></button><button title="Delete college" onClick={() => removeCollege(college)} disabled={deletingId === college.id} className="rounded-lg p-2 text-red-400 hover:bg-red-500/10">{deletingId === college.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}</button></div>
        </div><p className="mb-3 mt-5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Branches ({college.branches?.length || 0})</p><div className="flex flex-wrap gap-2">{(college.branches || []).map(branch => <span key={branch} className="rounded-full border border-zinc-800 bg-black/40 px-3 py-1 text-xs text-zinc-300">{branch}</span>)}</div>
      </motion.section>)}</div>}
    <AnimatePresence>{modalOpen && <CollegeModal college={editing} saving={saving} onClose={() => { if (!saving) { setModalOpen(false); setEditing(null); } }} onSave={saveCollege} />}</AnimatePresence>
  </div>;
}

function CollegeModal({ college, saving, onClose, onSave }) {
  const [name, setName] = useState(college?.name || '');
  const [branches, setBranches] = useState((college?.branches || []).join('\n'));
  return createPortal(<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
    <motion.form initial={{ scale: 0.96, y: 12 }} animate={{ scale: 1, y: 0 }} onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); onSave({ name, branches }); }} className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
      <div className="mb-6 flex items-center justify-between"><div><h2 className="text-xl font-bold text-white">{college ? 'Edit College' : 'Add College'}</h2><p className="mt-1 text-sm text-zinc-400">Enter one branch per line, or separate branches with commas.</p></div><button type="button" onClick={onClose} disabled={saving} className="text-zinc-400 hover:text-white"><X size={21} /></button></div>
      <label className="mb-4 block text-sm font-medium text-zinc-300">College name<input required autoFocus value={name} onChange={event => setName(event.target.value)} className="mt-2 w-full rounded-xl border border-zinc-800 bg-black px-3 py-3 text-white outline-none focus:border-orange-500" placeholder="e.g. Example University" /></label>
      <label className="block text-sm font-medium text-zinc-300">Branches<textarea required rows={7} value={branches} onChange={event => setBranches(event.target.value)} className="mt-2 w-full resize-y rounded-xl border border-zinc-800 bg-black px-3 py-3 text-white outline-none focus:border-orange-500" placeholder={'Computer Science\nInformation Technology\nElectronics'} /></label>
      <div className="mt-6 flex justify-end gap-3 border-t border-zinc-800 pt-5"><button type="button" onClick={onClose} disabled={saving} className="btn btn-ghost">Cancel</button><button type="submit" disabled={saving} className="btn btn-primary">{saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}{saving ? 'Saving…' : college ? 'Save changes' : 'Add College'}</button></div>
    </motion.form>
  </motion.div>, document.body);
}
