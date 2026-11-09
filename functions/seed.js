import { readFile } from 'node:fs/promises';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const [projectId, adminEmail] = process.argv.slice(2);
if (!projectId || !adminEmail || !/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(adminEmail)) {
  throw new Error('사용법: node functions/seed.js <Firebase 프로젝트 ID> <관리자 Google 이메일>');
}

const read = async name => JSON.parse(await readFile(new URL(`../seed/${name}.json`, import.meta.url), 'utf8'));
const [settings, catalog] = await Promise.all([read('defaults'), read('catalog')]);
const db = getFirestore(initializeApp({ projectId }));
const documents = [
  ['settings/default', settings],
  ['toolCatalog/default', { tools: catalog.tools }],
  ['keywordDictionary/default', { work: catalog.work, personal: catalog.personal }],
  [`allowlist/${adminEmail.toLowerCase()}`, { active: true, roles: ['employee', 'evaluator', 'admin'] }],
];
await db.runTransaction(async transaction => {
  const refs = documents.map(([path]) => db.doc(path));
  const snapshots = await transaction.getAll(...refs);
  snapshots.forEach((snapshot, i) => {
    if (!snapshot.exists) transaction.create(refs[i], documents[i][1]);
  });
});
console.log('초기 데이터를 확인했습니다. 기존 문서는 그대로 유지했습니다.');
