import { authUser, getDb } from './mongoBackend.mjs';

const handleFrom = (value, host) => {
  try { const url = new URL(value); if (!url.hostname.includes(host)) return ''; return url.pathname.split('/').filter(Boolean).pop() || ''; } catch { return String(value || '').trim().replace(/^@/, ''); }
};
const readJson = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { 'User-Agent': 'GU-Drishti/1.0', ...(options.headers || {}) }, signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`Provider returned ${response.status}`);
  return response.json();
};

export async function handleCodingProfiles(req, res) {
  const user = authUser(req);
  if (!user?.rollNo || user.role !== 'student') return res.status(403).json({ error: 'Student sign-in required.' });
  const db = await getDb();
  const student = await db.collection('students').findOne({ rollNo: user.rollNo });
  const links = student?.codingProfiles || {};
  const profiles = {};
  const leetcode = handleFrom(links.leetcode, 'leetcode.com');
  const codeforces = handleFrom(links.codeforces, 'codeforces.com');
  if (leetcode) {
    try {
      const payload = await readJson('https://leetcode.com/graphql/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'query user($username:String!){ matchedUser(username:$username){ profile{ ranking } submitStatsGlobal{ acSubmissionNum{ difficulty count } } } }', variables: { username: leetcode } }) });
      const stats = payload?.data?.matchedUser;
      const values = Object.fromEntries((stats?.submitStatsGlobal?.acSubmissionNum || []).map(row => [row.difficulty, row.count]));
      profiles.leetcode = { url: links.leetcode, username: leetcode, totalSolved: values.All || 0, easy: values.Easy || 0, medium: values.Medium || 0, hard: values.Hard || 0, rank: stats?.profile?.ranking || null, live: !!stats };
    } catch (error) { profiles.leetcode = { url: links.leetcode, username: leetcode, live: false, error: 'LeetCode is temporarily unavailable.' }; }
  }
  if (codeforces) {
    try {
      const [info, submissions] = await Promise.all([readJson(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(codeforces)}`), readJson(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(codeforces)}&from=1&count=10000`)]);
      const userInfo = info?.result?.[0];
      const solved = new Set((submissions?.result || []).filter(item => item.verdict === 'OK').map(item => `${item.contestId}:${item.problem?.index}`)).size;
      profiles.codeforces = { url: links.codeforces, username: codeforces, rating: userInfo?.rating || null, rank: userInfo?.rank || null, maxRating: userInfo?.maxRating || null, solved, live: !!userInfo };
    } catch (error) { profiles.codeforces = { url: links.codeforces, username: codeforces, live: false, error: 'Codeforces is temporarily unavailable.' }; }
  }
  for (const name of ['codechef', 'hackerrank']) if (links[name]) profiles[name] = { url: links[name], live: false, message: 'Connected. This provider does not offer a stable public statistics API; open the profile for current ratings and badges.' };
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ profiles });
}
