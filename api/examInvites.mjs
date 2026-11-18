import crypto from 'node:crypto';
const indexes = new Map();
export async function ensureExamInvite(db, exam, student) {
  if (!indexes.has(db.databaseName)) indexes.set(db.databaseName, Promise.all([
    db.collection('examInvites').createIndex({ examCode: 1 }, { unique: true, partialFilterExpression: { examCode: { $type: 'string' } } }),
    db.collection('examInvites').createIndex({ examId: 1, rollNo: 1 }, { unique: true, partialFilterExpression: { examId: { $type: 'string' }, rollNo: { $type: 'string' } } }),
  ]).catch(error => { indexes.delete(db.databaseName); throw error; }));
  await indexes.get(db.databaseName);
  const pair = { examId: String(exam._id), rollNo: student.rollNo };
  for (let attempt=0; attempt<30; attempt++) {
    const existing=await db.collection('examInvites').findOne(pair);
    if (/^\d{6}$/.test(existing?.examCode || '')) return existing;
    const examCode=String(crypto.randomInt(100000,1000000));
    try {
      if (existing) {
        const updated=await db.collection('examInvites').findOneAndUpdate({_id:existing._id,examCode:existing.examCode??{$exists:false}},{$set:{examCode}},{returnDocument:'after'});
        if(updated)return updated;
      } else {
        const document={_id:'invite:'+crypto.createHash('sha256').update(JSON.stringify(pair)).digest('hex'),...pair,email:student.email||'',examCode,status:'Pending',createdAt:new Date()};
        await db.collection('examInvites').insertOne(document);return document;
      }
    } catch(error){if(error.code!==11000)throw error;}
  }
  throw new Error('Could not allocate a unique exam code. Please retry.');
}
