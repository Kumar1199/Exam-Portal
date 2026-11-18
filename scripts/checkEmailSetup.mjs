import { loadEnv } from 'vite';
import { MongoClient } from 'mongodb';
const env = loadEnv('development', process.cwd(), '');
const key = env.BREVO_API_KEY || env.brevo_api;
if (!key) throw new Error('BREVO_API_KEY is not configured.');
const results = await Promise.all(['account','senders'].map(async endpoint => {
  const response = await fetch(`https://api.brevo.com/v3/${endpoint}`, { headers: { 'api-key': key }, signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { endpoint, status: response.status, code: data.code || 'request_failed' };
  return endpoint === 'account'
    ? { endpoint, status: response.status, transactionalEnabled: data.relay?.enabled ?? data.smtpRelay?.enabled ?? null }
    : { endpoint, status: response.status, senders: (data.senders || []).map(sender => ({ id: sender.id, email: sender.email, name: sender.name, active: sender.active })) };
}));
console.log(JSON.stringify({ brevo: results, missing: ['BREVO_SENDER_EMAIL','APP_BASE_URL'].filter(name => !env[name]) }, null, 2));
if (env.MONGODB_URI) {
  const client = new MongoClient(env.MONGODB_URI);
  try {
    await client.connect(); const db = client.db(env.MONGODB_DB_NAME || 'student360');
    console.log(JSON.stringify({ queue: await db.collection('activationQueue').aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray() }));
  } finally { await client.close(); }
}
