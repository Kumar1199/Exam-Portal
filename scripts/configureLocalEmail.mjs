import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadEnv } from 'vite';

const env = loadEnv('development', process.cwd(), '');
const key = env.BREVO_API_KEY || env.brevo_api;
if (!key) throw new Error('No Brevo API key found in the local environment files.');
const response = await fetch('https://api.brevo.com/v3/senders', { headers: { 'api-key': key }, signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`Could not verify Brevo senders (${response.status}).`);
const { senders = [] } = await response.json();
const active = senders.filter(sender => sender.active);
const sender = env.BREVO_SENDER_EMAIL ? active.find(item => item.email.toLowerCase() === env.BREVO_SENDER_EMAIL.toLowerCase()) : active.length === 1 ? active[0] : null;
if (!sender) throw new Error('Set BREVO_SENDER_EMAIL to a verified sender in .env.local.');

const values = {
  BREVO_API_KEY: key, BREVO_SENDER_EMAIL: sender.email,
  BREVO_SENDER_NAME: env.BREVO_SENDER_NAME || 'Student 360',
  APP_BASE_URL: 'http://127.0.0.1:5173',
  ACTIVATION_DAILY_LIMIT: env.ACTIVATION_DAILY_LIMIT || '250',
  CRON_SECRET: env.CRON_SECRET || crypto.randomBytes(32).toString('hex'),
};
let local = fs.existsSync('.env.local') ? fs.readFileSync('.env.local','utf8') : '';
local = local.split(/\r?\n/).filter(line => !/^\s*(BREVO_API_KEY|brevo_api|BREVO_SENDER_EMAIL|BREVO_SENDER_NAME|APP_BASE_URL|ACTIVATION_DAILY_LIMIT|CRON_SECRET)\s*=/.test(line)).join('\n').trimEnd();
local += '\n' + Object.entries(values).map(([name,value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n';
fs.writeFileSync('.env.local', local, { mode: 0o600 });
if (fs.existsSync('.env')) {
  const source = fs.readFileSync('.env','utf8').split(/\r?\n/).filter(line => !/^\s*(brevo_api|BREVO_API_KEY)\s*=/.test(line)).join('\n');
  fs.writeFileSync('.env',source);
}
console.log(`Brevo key verified and stored in .env.local; sender configured: ${sender.email}; activation URL: ${values.APP_BASE_URL}. No key printed.`);
