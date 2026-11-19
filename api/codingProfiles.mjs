import { authUser, getDb } from './mongoBackend.mjs';

const handleFrom = (value, host) => {
  try { const url = new URL(value); const name = url.hostname.toLowerCase(); if (name !== host && !name.endsWith(`.${host}`)) return ''; return url.pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; }
};
const readJson = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { 'User-Agent': 'GU-Drishti/1.0', ...(options.headers || {}) }, signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`Provider returned ${response.status}`);
  return response.json();
};
const readHtml = async url => {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GU-Drishti/1.0)' }, signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`Provider returned ${response.status}`);
  return response.text();
};
const numberMatch = (text, patterns) => {
  for (const pattern of patterns) { const match = text.match(pattern); if (match) return Number(String(match[1]).replace(/,/g, '')); }
  return null;
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
  const gfg = handleFrom(links.gfg, 'geeksforgeeks.org');
  const codechef = handleFrom(links.codechef, 'codechef.com');
  const hackerrank = handleFrom(links.hackerrank, 'hackerrank.com');
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
  if (gfg) {
    try { const html = await readHtml(`https://auth.geeksforgeeks.org/user/${encodeURIComponent(gfg)}/practice/`); profiles.gfg = { url: links.gfg, totalProblems: numberMatch(html, [/problems?\s*solved[^0-9]{0,80}([0-9,]+)/i, /"problemSolved"\s*:\s*"?([0-9,]+)/i]), score: numberMatch(html, [/coding\s*score[^0-9]{0,80}([0-9,]+)/i, /"score"\s*:\s*"?([0-9,]+)/i]), live: true }; } catch { profiles.gfg = { url: links.gfg, live: false, error: 'GeeksForGeeks did not allow a live profile read.' }; }
  }
  if (codechef) {
    try { const html = await readHtml(`https://www.codechef.com/users/${encodeURIComponent(codechef)}`); profiles.codechef = { url: links.codechef, rating: numberMatch(html, [/rating-number[^>]*>\s*([0-9,]+)/i, /"rating"\s*:\s*"?([0-9,]+)/i]), stars: (html.match(/rating\s*([1-7])\s*★/i) || html.match(/(\d)\s*star/i))?.[1] || null, solved: numberMatch(html, [/problems?\s*solved[^0-9]{0,80}([0-9,]+)/i]), live: true }; } catch { profiles.codechef = { url: links.codechef, live: false, error: 'CodeChef did not allow a live profile read.' }; }
  }
  if (hackerrank) {
    try { const html = await readHtml(`https://www.hackerrank.com/profile/${encodeURIComponent(hackerrank)}`); profiles.hackerrank = { url: links.hackerrank, badges: numberMatch(html, [/badges?[^0-9]{0,80}([0-9,]+)/i]), stars: numberMatch(html, [/stars?[^0-9]{0,80}([0-9,]+)/i]), live: true }; } catch { profiles.hackerrank = { url: links.hackerrank, live: false, error: 'HackerRank did not allow a live profile read.' }; }
  }
  for (const name of ['codechef', 'hackerrank']) if (links[name]) profiles[name] = { url: links[name], live: false, message: 'Connected. This provider does not offer a stable public statistics API; open the profile for current ratings and badges.' };
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ profiles });
}
