const normalized = value => String(value || '').trim().toLowerCase();
export function studentMatchesExam(exam, student) {
  // Exams scheduled before targeting was introduced remain available to everyone.
  if (!exam.audienceMode || exam.audienceMode === 'all') return true;
  if (!student || !Array.isArray(exam.audience)) return false;
  const branches = (Array.isArray(student.branch) ? student.branch : String(student.branch || '').split(/[,;|]/)).map(normalized);
  return exam.audience.some(target => {
    const collegeMatches = student.collegeId
      ? String(student.collegeId) === target.collegeId
      : normalized(student.college) === normalized(target.collegeName);
    return collegeMatches && target.branches.some(branch => branches.includes(normalized(branch)));
  });
}

export function validateExamAudience(exam, colleges) {
  if (exam.audienceMode === 'all') return null;
  if (exam.audienceMode !== 'selected' || !Array.isArray(exam.audience) || !exam.audience.length) return 'Select at least one college and its branches, or choose all students.';
  const seen = new Set();
  for (const target of exam.audience) {
    const college = colleges.find(item => String(item.id || item._id) === target?.collegeId);
    if (!college || seen.has(target.collegeId)) return 'Select valid, distinct colleges.';
    seen.add(target.collegeId);
    if (!Array.isArray(target.branches) || !target.branches.length || target.branches.some(branch => !college.branches?.includes(branch))) return `Select valid branches for ${college.name}.`;
  }
  return null;
}
