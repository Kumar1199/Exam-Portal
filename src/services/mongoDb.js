const API = '/api/proxy?path=';
export const db = Object.freeze({ __mongoApi: true });
const token = () => localStorage.getItem('s360_token');
async function call(body) {
  const response = await fetch(`${API}mongo`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Database request failed (${response.status})`);
    error.status = response.status;
    error.code = ({ 401: 'unauthenticated', 403: 'permission-denied', 404: 'not-found' })[response.status] || 'request-failed';
    throw error;
  }
  return data;
}
const ref = (name, id) => ({ __collection: name, ...(id === undefined ? {} : { __id: String(id) }) });
export const collection = (_db, name) => ref(name);
export const doc = (first, second, third) => first?.__collection ? ref(first.__collection, second) : ref(second, third);
export const where = (field, op, value) => ({ type: 'where', field, op, value });
export const orderBy = (field, direction = 'asc') => ({ type: 'orderBy', field, direction });
export const limit = count => ({ type: 'limit', count });
export const query = (source, ...clauses) => ({ ...source, __clauses: clauses });
const filters = source => (source.__clauses || []).filter(c => c.type === 'where').map(({ field, op, value }) => ({ field, op, value }));
const snapshot = item => ({ id: item?.id, exists: () => !!item, data: () => { if (!item) return undefined; const { id, ...data } = item; return data; } });
export async function getDocs(source) {
  const result = await call({ collection: source.__collection, operation: 'list', filters: filters(source), orderBy: (source.__clauses || []).filter(c => c.type === 'orderBy').map(c => ({ field: c.field, direction: c.direction })), limit: (source.__clauses || []).find(c => c.type === 'limit')?.count });
  const docs = (result.documents || []).map(snapshot); return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
}
export async function getDoc(source) { const result = await call({ collection: source.__collection, operation: 'get', id: source.__id }); return snapshot(result.document); }
export async function addDoc(source, data) { return call({ collection: source.__collection, operation: 'insert', data }); }
export async function setDoc(source, data, options = {}) { return call({ collection: source.__collection, operation: options.merge ? 'merge' : 'upsert', id: source.__id, data }); }
export async function updateDoc(source, data) { await call({ collection: source.__collection, operation: 'update', id: source.__id, data }); }
export async function deleteDoc(source) { await call({ collection: source.__collection, operation: 'delete', id: source.__id }); }
export const serverTimestamp = () => new Date().toISOString();
export function writeBatch() { const ops = []; const batch = { set(source, data) { ops.push({ id: source.__id, data }); return batch; }, commit() { return call({ collection: 'students', operation: 'batch', items: ops }); } }; return batch; }
