import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';

const phases = ['draft', 'open', 'scoring', 'reviewing', 'approving', 'published', 'closed'];
export const adminActions = ['configuration', 'saveSettings', 'saveCatalog', 'saveRubric', 'advance', 'export', 'dashboard', 'audit'];
export const assessmentActions = [...adminActions, 'queue', 'review', 'approve', 'report', 'appeal', 'resolveAppeal'];
export const deny = (message, code = 'failed-precondition') => { throw new HttpsError(code, message); };
export function bounded(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) deny('입력값을 확인하세요.', 'invalid-argument');
  return value.trim();
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[\w-]{1,180}$/.test(value)) deny('식별자를 확인하세요.', 'invalid-argument');
  return value;
}
const docs = snapshot => snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
const settingsRef = db => db.doc('settings/default');
const now = () => FieldValue.serverTimestamp();
const dayEnd = value => Date.parse(value + 'T23:59:59.999+09:00');

function validateSettings(data, previous) {
  const { axes, indicators, hrWeight, gradeBands, securityGate, reviewAdjustment, ai, caseLimits, retentionYears } = data;
  const max = value => Number.isInteger(value) && value >= 0 && value <= 100;
  if (!axes || !['A','B','C'].every(axis => max(axes[axis])) || axes.A + axes.B + axes.C !== 100
    || !Array.isArray(indicators) || indicators.length !== previous.indicators.length
    || !previous.indicators.every(item => indicators.filter(next => next?.code === item.code && max(next.max)).length === 1)
    || !['A','B','C'].every(axis => indicators.filter(item => item.code.startsWith(axis)).reduce((n,item) => n + item.max, 0) === axes[axis])
    || !Number.isInteger(hrWeight) || hrWeight < 0 || hrWeight > 30
    || !Array.isArray(gradeBands) || gradeBands.length !== 5 || !gradeBands.every((item,i) =>
      item?.grade === ['S','A','B','C','D'][i] && max(item.min) && (i === 0 || gradeBands[i-1].min > item.min))
    || gradeBands[4].min !== 0 || !['B','C','exclude'].includes(securityGate)
    || !max(reviewAdjustment) || !Number.isInteger(ai?.runs) || ai.runs < 1 || ai.runs > 5
    || typeof ai.model !== 'string' || (ai.model && !/^[a-zA-Z0-9._-]{1,100}$/.test(ai.model))
    || !Number.isFinite(ai.spreadThreshold) || ai.spreadThreshold < 0 || ai.spreadThreshold > 1
    || !Number.isInteger(caseLimits?.min) || !Number.isInteger(caseLimits?.max) || caseLimits.min < 1
    || caseLimits.max < caseLimits.min || caseLimits.max > 10
    || !Number.isInteger(retentionYears) || retentionYears < 1 || retentionYears > 10) {
    deny('배점 합계, 등급 구간 및 평가 설정 범위를 확인하세요.', 'invalid-argument');
  }
  return {
    axes: { A: axes.A, B: axes.B, C: axes.C },
    indicators: previous.indicators.map(item => ({ ...item, max: indicators.find(next => next.code === item.code).max })),
    gradeBands: gradeBands.map(item => ({ grade: item.grade, min: item.min, name: bounded(item.name, 40) })),
    hrWeight, securityGate, reviewAdjustment, ai: { model: ai.model, runs: ai.runs, spreadThreshold: ai.spreadThreshold },
    caseLimits: { min: caseLimits.min, max: caseLimits.max }, retentionYears,
  };
}
const strings = values => {
  if (!Array.isArray(values) || values.length > 150) deny('목록 형식을 확인하세요.', 'invalid-argument');
  return [...new Set(values.map(value => bounded(value, 80)))];
};
const versionBands = values => values.map(band => Array.isArray(band)
  ? { grade: band[0], min: band[1], name: band[2] } : band);

export async function assessment(db, tx, uid, user, action, data, record) {
  const currentRef = db.doc('system/currentCycle');
  const current = (await tx.get(currentRef)).data();
  const cycleRef = current?.cycleId ? db.collection('cycles').doc(current.cycleId) : null;
  const active = cycleRef ? (await tx.get(cycleRef)).data() : null;
  if (action === 'audit') {
    return docs(await tx.get(db.collection('auditLogs').orderBy('at','desc').limit(100)))
      .map(item => ({ action: item.action, target: item.target, at: item.at?.toDate().toISOString() ?? '' }));
  }
  if (action === 'dashboard') {
    if (!active) return { cycle: null };
    const members = docs(await tx.get(db.collection('allowlist'))).filter(item => item.active && item.roles.includes('employee'));
    const items = docs(await tx.get(db.collection('evaluations').where('cycleId','==',cycleRef.id)));
    const final = items.filter(item => item.final);
    const usage = (await tx.get(db.collection('usage').doc(cycleRef.id))).data() ?? {};
    const indicators = Object.values(final.flatMap(item => item.final.indicators).reduce((result,item) => {
      const row = result[item.code] ??= { code: item.code, name: item.name, score: 0, max: 0 };
      row.score += item.score;
      row.max += item.max;
      return result;
    }, {})).map(item => ({ ...item, rate: item.max ? Math.round(100 * item.score / item.max) : 0 }));
    return { cycle: { id: cycleRef.id, name: active.name, status: active.status },
      total: members.length, submitted: items.filter(item => item.submittedAt).length,
      pending: items.filter(item => ['submitted','ai_scored'].includes(item.status)).length,
      gates: items.filter(item => item.review?.gate).length,
      average: final.length ? Math.round(final.reduce((sum,item) => sum + item.final.score, 0) / final.length * 10) / 10 : null,
      grades: final.reduce((grades,item) => ({ ...grades, [item.final.grade]: (grades[item.final.grade] ?? 0) + 1 }), {}),
      staff: members.map(member => ({ email: member.id, name: member.name ?? member.id,
        status: items.find(item => item.email === member.id)?.status ?? 'not_started' })),
      usage, indicators };
  }
  if (action === 'configuration') {
    const settings = (await tx.get(settingsRef(db))).data();
    const toolCatalog = (await tx.get(db.doc('toolCatalog/default'))).data();
    const keywords = (await tx.get(db.doc('keywordDictionary/default'))).data();
    const rubrics = docs(await tx.get(db.collection('rubrics').orderBy('createdAt','desc').limit(20)));
    return { settings: { ...settings, gradeBands: versionBands(settings.gradeBands) }, toolCatalog, keywords, rubrics, locked: Boolean(active) };
  }
  if (['saveSettings','saveCatalog','saveRubric'].includes(action)) {
    if (active) deny('회차 진행 중에는 평가 설정을 변경할 수 없습니다.');
    if (action === 'saveSettings') {
      const previous = (await tx.get(settingsRef(db))).data();
      const next = validateSettings(data, previous);
      tx.set(settingsRef(db), next);
      tx.create(db.collection('criteriaHistory').doc(), { settings: next, at: now() });
      record('settings/default', { after: next });
    }
    if (action === 'saveCatalog') {
      const tools = strings(data.tools);
      if (!tools.length) deny('도구를 한 개 이상 등록하세요.');
      const work = strings(data.work);
      const personal = strings(data.personal);
      if (!work.length || !personal.length) deny('업무 및 개인 키워드를 각각 한 개 이상 등록하세요.');
      tx.set(db.doc('toolCatalog/default'), { tools });
      tx.set(db.doc('keywordDictionary/default'), { work, personal });
      record('catalog', { after: { tools, work, personal } });
    }
    if (action === 'saveRubric') {
      const settings = (await tx.get(settingsRef(db))).data();
      const criteria = Object.fromEntries(settings.indicators.map(item => [item.code, bounded(data.criteria?.[item.code], 1200)]));
      const target = db.collection('rubrics').doc();
      tx.create(target, { name: bounded(data.name, 80), criteria, createdAt: now() });
      tx.set(db.doc('system/currentRubric'), { id: target.id });
      record(target.path, {});
    }
    return null;
  }
  if (action === 'export') {
    const cycleId = identifier(data.cycleId);
    const cycle = (await tx.get(db.collection('cycles').doc(cycleId))).data();
    if (!cycle || !['published','closed'].includes(cycle.status)) deny('공개된 회차의 확정 결과만 내보낼 수 있습니다.');
    const rows = docs(await tx.get(db.collection('evaluations').where('cycleId','==',cycleId)))
      .filter(item => item.final).map(item => ({
        uid: item.uid, email: item.email ?? '', score: item.final.score, grade: item.final.grade, hrScore: item.final.hrScore,
      }));
    const audits = docs(await tx.get(db.collection('auditLogs').orderBy('at','desc').limit(100)))
      .map(item => ({ action: item.action, target: item.target, at: item.at?.toDate().toISOString() ?? '' }));
    return { rows, audits };
  }
  if (action === 'report') {
    const history = docs(await tx.get(db.collection('evaluations').where('uid','==',uid)));
    const reports = [];
    for (const item of history.filter(item => item.final)) {
      const cycle = (await tx.get(db.collection('cycles').doc(item.cycleId))).data();
      if (!cycle || !['published','closed'].includes(cycle.status)) continue;
      const appeal = (await tx.get(db.collection('appeals').doc(item.id))).data();
      reports.push({ ...item, cycle: { name: cycle.name, status: cycle.status, schedule: cycle.schedule }, appeal: appeal ?? null });
    }
    return reports.sort((a,b) => String(b.cycle.schedule.close).localeCompare(String(a.cycle.schedule.close)));
  }
  if (!active) {
    if (action === 'queue') return { cycle: null, items: [], appeals: [] };
    deny('진행 중인 회차가 없습니다.');
  }
  const cycleId = cycleRef.id;
  const evaluations = db.collection('evaluations');
  const all = evaluations.where('cycleId','==',cycleId);
  const appeals = db.collection('appeals');
  if (action === 'advance') {
    if (data.cycleId !== cycleId || data.status !== active.status) deny('최신 회차 상태를 다시 확인하세요.');
    const items = docs(await tx.get(all)).filter(item => ['submitted','ai_scored','reviewed','final'].includes(item.status));
    const next = phases[phases.indexOf(active.status) + 1];
    if (!['scoring','reviewing','approving','published','closed'].includes(next)) deny('회차 상태를 변경할 수 없습니다.');
    if (next === 'scoring' && !items.length) deny('제출된 평가가 한 건 이상 있어야 다음 단계로 진행할 수 있습니다.');
    if (next === 'reviewing' && (!items.length || items.some(item => item.status === 'submitted' && !item.manual))) deny('제출 건의 AI 채점을 완료하세요.');
    if (next === 'approving' && items.some(item => !['reviewed','final'].includes(item.status))) deny('모든 제출 건의 검토를 완료하세요.');
    if (next === 'published' && (!items.length || items.some(item => !item.final))) deny('모든 평가를 확정해야 공개할 수 있습니다.');
    if (next === 'closed') {
      const outstanding = docs(await tx.get(appeals.where('cycleId','==',cycleId))).some(item => item.status !== 'resolved');
      if (outstanding || Date.now() <= dayEnd(active.schedule.appealUntil)) deny('이의신청 기간과 처리 상태를 확인하세요.');
      tx.delete(currentRef);
    }
    const date = new Date(Date.now() + 7 * 86400000 + 9 * 3600000).toISOString().slice(0,10);
    tx.update(cycleRef, { status: next,
      ...(next === 'published' ? { 'schedule.appealUntil': date, 'schedule.publish': now() } : {}),
      ...(next === 'closed' ? { closedAt: now() } : {}),
    });
    record(cycleRef.path, { before: { status: active.status }, after: { status: next } });
    return null;
  }
  if (action === 'queue') {
    const canSee = item => item.uid !== uid && ((user.roles.includes('evaluator') && !item.subjectEvaluator) || user.roles.includes('approver'));
    const items = docs(await tx.get(all)).filter(item => (item.aiDraft || item.manual) && canSee(item));
    const settings = (await tx.get(db.collection('settingsVersions').doc(active.settingsVersion))).data()?.snapshot;
    for (const item of items) {
      const query = db.collection('cases').where('uid','==',item.uid);
      item.cases = docs(await tx.get(query)).filter(entry => entry.cycleId === cycleId);
      if (item.manual) item.manualIndicators = settings.indicators;
    }
    items.sort((a,b) => Number(Boolean(b.aiDraft?.needsAttention)) - Number(Boolean(a.aiDraft?.needsAttention)));
    const appealItems = docs(await tx.get(appeals.where('cycleId','==',cycleId))).filter(canSee);
    return { cycle: { ...active, id: cycleId }, items, appeals: appealItems };
  }
  const id = action === 'appeal' ? cycleId + '_' + uid : identifier(data.id);
  const target = evaluations.doc(id);
  const item = (await tx.get(target)).data();
  if (!item || item.cycleId !== cycleId) deny('평가 건을 찾을 수 없습니다.');
  if (action === 'appeal') {
    const ref = appeals.doc(id);
    if (data.cycleId !== cycleId || active.status !== 'published' || Date.now() > dayEnd(active.schedule.appealUntil) || !item.final || (await tx.get(ref)).exists) deny('이의신청 가능 여부를 확인하세요.');
    if (!Array.isArray(data.codes) || !data.codes.length || data.codes.some(code => !item.final.indicators.some(indicator => indicator.code === code))) deny('이의신청 지표를 선택하세요.');
    tx.create(ref, { uid, cycleId, subjectEvaluator: Boolean(item.subjectEvaluator), codes: [...new Set(data.codes)], reason: bounded(data.reason,1500), status: 'pending', createdAt: now() });
    return null;
  }
  if (item.uid === uid) deny('본인 평가를 처리할 수 없습니다.', 'permission-denied');
  const settings = (await tx.get(db.collection('settingsVersions').doc(active.settingsVersion))).data()?.snapshot;
  if (!settings) deny('평가 설정을 확인하세요.');
  if (action === 'review') {
    if (active.status !== 'reviewing' || (item.status !== 'ai_scored' && !(item.manual && item.status === 'submitted'))) deny('검토 가능한 평가가 아닙니다.');
    if (item.subjectEvaluator ? !user.roles.includes('approver') : !user.roles.includes('evaluator')) deny('배정된 검토 권한이 없습니다.', 'permission-denied');
    const cases = docs(await tx.get(db.collection('cases').where('uid','==',item.uid))).filter(entry => entry.cycleId === cycleId);
    if (!Array.isArray(data.confirmed) || data.confirmed.some(caseId => !cases.some(entry => entry.id === caseId))) deny('확인한 사례를 다시 선택하세요.');
    const confirmed = new Set(data.confirmed);
    const gate = data.gate === true;
    const indicators = item.manual ? settings.indicators.map(indicator => {
      const score = data.adjustments?.[indicator.code];
      if (!Number.isFinite(score) || score < 0 || score > indicator.max
        || (score > 0 && indicator.code.startsWith('B') && confirmed.size !== cases.length)) deny('수동 채점의 지표 배점과 사례 확인 여부를 확인하세요.');
      return { ...indicator, score, reason: bounded(data.reasons?.[indicator.code],600) };
    }) : item.aiDraft.indicators.map(indicator => {
      const delta = data.adjustments?.[indicator.code] ?? 0;
      const base = indicator.code.startsWith('B') && confirmed.size !== cases.length ? 0 : indicator.score;
      if (!Number.isFinite(delta) || Math.abs(delta) > settings.reviewAdjustment || base + delta < 0 || base + delta > indicator.max
        || (base !== indicator.score && delta > 0)) deny('지표별 조정 범위와 사례 확인 여부를 확인하세요.');
      return { ...indicator, score: base + delta, delta, reason: delta ? bounded(data.reasons?.[indicator.code], 600) : '' };
    });
    const review = { indicators, gate, gateReason: gate ? bounded(data.gateReason,600) : '', comment: bounded(data.comment,1200), reviewer: uid, at: now() };
    for (const entry of cases) tx.update(db.collection('cases').doc(entry.id), { verify: { status: confirmed.has(entry.id) ? 'confirmed' : 'unconfirmed', by: uid, at: now() } });
    tx.update(target, { status: 'reviewed', review });
    record(target.path, {});
    return null;
  }
  if (action === 'approve') {
    if (active.status !== 'approving' || item.status !== 'reviewed') deny('검토가 완료된 평가만 확정할 수 있습니다.');
    const final = outcome(item.review.indicators, item.review.gate, settings, uid);
    tx.update(target, { status: 'final', final });
    record(target.path, {});
    return null;
  }
  if (action === 'resolveAppeal') {
    const ref = appeals.doc(id);
    const appeal = (await tx.get(ref)).data();
    if (active.status !== 'published' || !appeal || !item.final) deny('처리할 이의신청을 확인하세요.');
    const note = bounded(data.note, 1200);
    if (appeal.status === 'pending' && (item.subjectEvaluator ? user.roles.includes('approver') : user.roles.includes('evaluator'))) {
      tx.update(ref, { status: 'reviewed', evaluatorNote: note });
    } else if (appeal.status === 'reviewed' && user.roles.includes('approver')) {
      const changes = data.scores ?? {};
      const indicators = item.final.indicators.map(indicator => {
        if (!(indicator.code in changes)) return indicator;
        const score = changes[indicator.code];
        if (!appeal.codes.includes(indicator.code) || !Number.isFinite(score) || score < 0 || score > indicator.max) deny('재결정 점수 범위를 확인하세요.');
        return { ...indicator, score };
      });
      if (Object.keys(changes).length) {
        tx.update(target, { final: outcome(indicators, item.review.gate, settings, uid) });
        record(target.path, { before: item.final, after: { indicators } });
      }
      tx.update(ref, { status: 'resolved', decision: note, decidedBy: uid, at: now() });
    } else deny('이의신청 처리 권한 또는 단계가 일치하지 않습니다.', 'permission-denied');
    return null;
  }
  deny('지원하지 않는 평가 작업입니다.', 'invalid-argument');
}

function outcome(indicators, gate, settings, uid) {
  const score = Math.round(indicators.reduce((sum,item) => sum + item.score, 0) * 100) / 100;
  const bands = versionBands(settings.gradeBands);
  const index = bands.findIndex(item => score >= item.min);
  const excluded = gate && settings.securityGate === 'exclude';
  const cap = gate && !excluded ? bands.findIndex(item => item.grade === settings.securityGate) : -1;
  return { indicators, score, grade: excluded ? '제외' : bands[Math.max(index,cap)].grade,
    hrScore: excluded ? null : Math.round(score * settings.hrWeight) / 100, approvedBy: uid, at: now() };
}
