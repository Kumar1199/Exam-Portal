// Controlled Phase 4 heartbeat/event load harness. It never targets a URL
// unless the operator explicitly opts in with ALLOW_LOAD_TEST=1.
const base = process.env.TEST_API_BASE_URL;
const token = process.env.TEST_AUTH_TOKEN;
const sessions = JSON.parse(process.env.TEST_SESSIONS_JSON || '[]');
const concurrency = Math.max(1, Math.min(1000, Number(process.env.LOAD_CONCURRENCY || 10)));
if (process.env.ALLOW_LOAD_TEST !== '1' || !base || !token || !sessions.length) throw new Error('Set ALLOW_LOAD_TEST=1, TEST_API_BASE_URL, TEST_AUTH_TOKEN and TEST_SESSIONS_JSON for a dedicated test environment.');
if (/student-360-exam-portal-2026\.vercel\.app/i.test(base)) throw new Error('Refusing known production portal URL. Use a dedicated test deployment.');
const request = async session => { const started = performance.now(); const response = await fetch(`${base.replace(/\/$/, '')}/api/proxy?path=exam/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(session) }); return { ok: response.ok, ms: performance.now() - started, status: response.status }; };
const values = []; let cursor = 0;
await Promise.all(Array.from({ length: concurrency }, async () => { while (cursor < sessions.length) { const current = sessions[cursor++]; values.push(await request(current)); } }));
const latency = values.map(value => value.ms).sort((a,b) => a-b); const percentile = p => latency[Math.min(latency.length - 1, Math.floor(latency.length * p))] || 0;
console.log(JSON.stringify({ requests: values.length, concurrency, passed: values.filter(value => value.ok).length, failed: values.filter(value => !value.ok).length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), statuses: Object.groupBy(values, value => value.status) }, null, 2));
