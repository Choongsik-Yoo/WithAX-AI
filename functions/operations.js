import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { adminActions, assessment, assessmentActions } from './assessment.js';

const roles = ['employee', 'evaluator', 'admin', 'approver'];
const consentVersion = 'evaluation-2';
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new HttpsError('invalid-argument', '입력값과 글자 수를 확인하세요.');
  }
  return value.trim();
};
const fail = message => { throw new HttpsError('failed-precondition', message); };
const list = snapshot => snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));

export async function operate(db, uid, email, input) {
  const { action, data = {} } = input ?? {};
  const isAdmin = ['users', 'saveUser', 'cycles', 'createCycle', 'deleteDraft', 'openCycle', 'closeCycle', ...adminActions].includes(action);
  const access = { queue: ['evaluator', 'approver'], review: ['evaluator', 'approver'], approve: ['approver'], resolveAppeal: ['evaluator', 'approver'] };
  const allowed = isAdmin ? ['admin'] : Object.hasOwn(access, action) ? access[action] : ['employee'];
  const entry = db.collection('allowlist').doc(email);
  const cycles = db.collection('cycles');
  const audit = db.collection('auditLogs').doc();
  return db.runTransaction(async tx => {
    const user = (await tx.get(entry)).data();
    if (user?.active !== true || !allowed.some(role => user.roles?.includes(role))) {
      throw new HttpsError('permission-denied', '이 작업에 접근할 권한이 없습니다.');
    }
    const record = (target, changes) => tx.create(audit, {
      actor: uid, action, target, ...changes, at: FieldValue.serverTimestamp(),
    });
    if (assessmentActions.includes(action)) return assessment(db, tx, uid, user, action, data, record);
    if (action === 'users') return list(await tx.get(db.collection('allowlist')));
    if (action === 'cycles') return list(await tx.get(cycles.orderBy('createdAt', 'desc')));
    if (action === 'saveUser') {
      const address = text(data.email, 254).toLowerCase();
      if (!/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(address)
        || !Array.isArray(data.roles) || !data.roles.length
        || data.roles.some(role => !roles.includes(role)) || typeof data.active !== 'boolean') {
        throw new HttpsError('invalid-argument', '이메일과 역할을 확인하세요.');
      }
      const target = db.collection('allowlist').doc(address);
      const before = (await tx.get(target)).data();
      const after = { name: text(data.name, 80), active: data.active, roles: roles.filter(role => data.roles.includes(role)) };
      if (address === email && (!after.active || !after.roles.includes('admin'))) fail('본인의 관리자 권한은 해제할 수 없습니다.');
      tx.set(target, before ? after : { ...after, createdAt: FieldValue.serverTimestamp() }, { merge: true });
      record(target.path, { before: before ?? null, after });
      return null;
    }
    if (action === 'createCycle') {
      const { from, to, close } = data;
      if (![from, to, close].every(date) || from > to || to > close) {
        throw new HttpsError('invalid-argument', '평가 시작일, 종료일, 제출 마감일 순서를 확인하세요.');
      }
      const target = cycles.doc();
      const pilot = data.pilot !== false;
      const manual = pilot && data.manual === true;
      const after = { name: text(data.name, 80), period: { from, to }, schedule: { close }, status: 'draft', pilot, manual, hrWeight: 0 };
      tx.create(target, { ...after, createdAt: FieldValue.serverTimestamp() });
      record(target.path, { after });
      return null;
    }
    const active = db.doc('system/currentCycle');
    const current = (await tx.get(active)).data();
    if (action === 'deleteDraft') {
      const id = text(data.id, 100);
      if (!/^[\w-]+$/.test(id)) fail('회차 번호를 확인하세요.');
      const target = cycles.doc(id);
      const cycle = (await tx.get(target)).data();
      if (cycle?.status !== 'draft') fail('초안만 삭제할 수 있습니다.');
      tx.delete(target);
      record(target.path, { before: { name: cycle.name, status: 'draft' } });
      return null;
    }
    if (action === 'closeCycle') {
      if (!current?.cycleId || current.cycleId !== data.id) fail('현재 제출 중인 회차를 확인하세요.');
      const target = cycles.doc(current.cycleId);
      const cycle = (await tx.get(target)).data();
      if (cycle?.status !== 'open' || cycle.pilot !== true) fail('열린 시범 회차만 종료할 수 있습니다.');
      tx.update(target, { status: 'closed', closedAt: FieldValue.serverTimestamp() });
      tx.delete(active);
      record(target.path, { before: { status: 'open' }, after: { status: 'closed' } });
      return null;
    }
    if (action === 'openCycle') {
      if (current?.cycleId) fail('이미 제출 중인 회차가 있습니다.');
      const id = text(data.id, 100);
      if (!/^[\w-]+$/.test(id)) fail('회차 번호를 확인하세요.');
      const target = cycles.doc(id);
      const cycle = (await tx.get(target)).data();
      const settings = (await tx.get(db.doc('settings/default'))).data();
      const rubric = (await tx.get(db.doc('system/currentRubric'))).data();
      if (cycle?.status !== 'draft' || !settings) fail('회차 초안과 평가 설정을 확인하세요.');
      if (Date.now() >= Date.parse(cycle.schedule.close + 'T23:59:59.999+09:00')) fail('제출 마감일이 지났습니다.');
      const version = db.collection('settingsVersions').doc();
      const gradeBands = settings.gradeBands.map(band => Array.isArray(band)
        ? { grade: band[0], min: band[1], name: band[2] } : band);
      const hrWeight = cycle.pilot ? 0 : settings.hrWeight;
      tx.create(version, { snapshot: { ...settings, gradeBands, hrWeight }, changedBy: uid, changedAt: FieldValue.serverTimestamp() });
      tx.update(target, { status: 'open', hrWeight, settingsVersion: version.id, rubricVersion: rubric?.id ?? '', 'schedule.open': FieldValue.serverTimestamp() });
      tx.set(active, { cycleId: id });
      record(target.path, { before: { status: 'draft' }, after: { status: 'open', settingsVersion: version.id } });
      return null;
    }
    if (!current?.cycleId) {
      if (action === 'home') return { cycle: null };
      fail('제출 가능한 회차가 없습니다.');
    }
    const cycleDoc = await tx.get(cycles.doc(current.cycleId));
    const cycle = cycleDoc.data();
    if (!cycle) fail('회차를 찾을 수 없습니다.');
    const cycleId = cycleDoc.id;
    const ownId = cycleId + '_' + uid;
    const consent = db.collection('consents').doc(ownId);
    const agreed = (await tx.get(consent)).exists;
    const evaluation = db.collection('evaluations').doc(ownId);
    const progress = (await tx.get(evaluation)).data();
    const submitted = ['submitted','ai_scored','reviewed','final'].includes(progress?.status);
    const editable = cycle.status === 'open' && Date.now() < Date.parse(cycle.schedule.close + 'T23:59:59.999+09:00');
    const caseQuery = db.collection('cases').where('uid', '==', uid);
    if (action === 'home') {
      const cases = agreed ? list(await tx.get(caseQuery)).filter(item => item.cycleId === cycleId) : [];
      const tools = (await tx.get(db.doc('toolCatalog/default'))).data()?.tools ?? [];
      const limits = (await tx.get(db.collection('settingsVersions').doc(cycle.settingsVersion))).data()?.snapshot.caseLimits;
      const keywords = (await tx.get(db.doc('keywordDictionary/default'))).data() ?? { work: [], personal: [] };
      return { cycle: { ...cycle, id: cycleId }, agreed, cases, editable: editable && !submitted, tools, limits, keywords, status: progress?.status ?? null };
    }
    if (!editable || data.cycleId !== cycleId) fail('제출 중인 회차를 다시 확인하세요.');
    if (action === 'consent') {
      if (data.textVersion !== consentVersion) fail('동의 문구를 다시 확인하세요.');
      if (!agreed) tx.create(consent, { uid, cycleId, textVersion: consentVersion, agreedAt: FieldValue.serverTimestamp() });
      return null;
    }
    if (!agreed) fail('평가 동의를 먼저 완료하세요.');
    if (submitted) fail('제출한 평가는 수정할 수 없습니다.');
    if (action === 'submitManual') {
      if (!cycle.pilot || !cycle.manual) fail('수동 검토 시범 회차에서만 사용할 수 있습니다.');
      const snapshot = (await tx.get(db.collection('settingsVersions').doc(cycle.settingsVersion))).data()?.snapshot;
      const count = list(await tx.get(caseQuery)).filter(item => item.cycleId === cycleId).length;
      if (!snapshot || count < snapshot.caseLimits.min || count > snapshot.caseLimits.max) fail('회차 기준에 맞는 활용 사례를 등록하세요.');
      tx.set(evaluation, { uid, email, cycleId, caseCount: count, subjectEvaluator: user.roles.includes('evaluator'),
        status: 'submitted', manual: true, submittedAt: FieldValue.serverTimestamp() }, { merge: true });
      return null;
    }
    if (action !== 'saveCase') throw new HttpsError('invalid-argument', '지원하지 않는 작업입니다.');
    const tools = (await tx.get(db.doc('toolCatalog/default'))).data()?.tools ?? [];
    const limits = (await tx.get(db.collection('settingsVersions').doc(cycle.settingsVersion))).data()?.snapshot.caseLimits;
    if (!limits || !Array.isArray(data.tools) || !data.tools.length || data.tools.some(tool => !tools.includes(tool))
      || ![data.before, data.after].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000)) {
      throw new HttpsError('invalid-argument', '사용 도구와 소요 시간을 확인하세요.');
    }
    const id = text(data.id, 100);
    if (!/^[\w-]+$/.test(id)) fail('사례 번호를 확인하세요.');
    const target = db.collection('cases').doc(id);
    const existing = await tx.get(target);
    if (existing.exists && (existing.data().uid !== uid || existing.data().cycleId !== cycleId)) {
      throw new HttpsError('permission-denied', '이 사례를 수정할 수 없습니다.');
    }
    const count = progress?.caseCount ?? list(await tx.get(caseQuery)).filter(item => item.cycleId === cycleId).length;
    if (!existing.exists && count >= limits.max) fail('회차별 사례 등록 한도에 도달했습니다.');
    tx.set(target, {
      uid, cycleId, title: text(data.title, 120), category: text(data.category, 60),
      tools: [...new Set(data.tools)], process: text(data.process, 2000),
      qualityNote: text(data.qualityNote, 1500), before: { hours: data.before },
      after: { hours: data.after }, updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(evaluation, { uid, email, cycleId, status: 'consented', caseCount: count + Number(!existing.exists) }, { merge: true });
    return null;
  });
}
