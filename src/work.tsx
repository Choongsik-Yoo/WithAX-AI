import { useEffect, useState, type FormEvent } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import type { FirebaseApp } from 'firebase/app';

type Cycle = { id: string; name: string; status: string; period: { from: string; to: string }; schedule: { close: string }; hrWeight: number };
type Member = { id: string; name?: string; roles: string[]; active: boolean };
type Case = { id: string; title: string; category: string; tools: string[]; process: string; qualityNote: string; before: { hours: number }; after: { hours: number } };
type Home = { cycle: Cycle | null; agreed?: boolean; editable?: boolean; cases?: Case[]; tools?: string[]; limits?: { min: number; max: number } };
const labels = { employee: '직원', evaluator: '평가자', admin: '관리자', approver: '확정권자' };

export function Work({ app, path }: { app: FirebaseApp; path: string }) {
  const usersPage = path === '/admin/users';
  const cyclesPage = path === '/admin' || path === '/admin/cycles';
  const loadAction = usersPage ? 'users' : cyclesPage ? 'cycles' : 'home';
  const [result, setResult] = useState<Member[] | Cycle[] | Home>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);
  const [version, setVersion] = useState(0);
  const [member, setMember] = useState<Member>();
  const [currentCase, setCurrentCase] = useState<Case>();
  const [caseId, setCaseId] = useState(() => crypto.randomUUID());
  const [agree, setAgree] = useState(false);
  const call = httpsCallable<{ action: string; data?: object }, Member[] | Cycle[] | Home>(
    getFunctions(app, 'asia-northeast3'), 'operations');
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    httpsCallable<{ action: string }, Member[] | Cycle[] | Home>(getFunctions(app, 'asia-northeast3'), 'operations')({ action: loadAction })
      .then(response => { if (!cancelled) setResult(response.data); })
      .catch(failure => { if (!cancelled) setError(failure.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [app, loadAction, version]);

  async function save(action: string, data: object, onSuccess?: () => void) {
    setBusy(true); setError(''); setNotice('');
    try {
      await call({ action, data });
      onSuccess?.();
      setNotice('저장했습니다.');
      setVersion(value => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '저장에 실패했습니다.');
      setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>, handler: (form: FormData) => void) {
    event.preventDefault();
    if (!busy) handler(new FormData(event.currentTarget));
  }

  const home = !Array.isArray(result) ? result : undefined;
  const cycle = home?.cycle;
  return <section className="panel work" aria-busy={busy}>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p>데이터를 처리 중입니다.</p>}
    {usersPage && Array.isArray(result) && <>
      <h2>허용 목록</h2>
      {(result as Member[]).map(item => <div className="work-row" key={item.id}>
        <span>{item.name || item.id} · {item.active ? '활성' : '비활성'} · {item.roles.map(role => labels[role as keyof typeof labels]).join(', ')}</span>
        <button type="button" className="secondary" onClick={() => setMember(item)}>편집</button>
      </div>)}
      <h2>{member ? '계정 편집' : '계정 추가'}</h2>
      <form key={member?.id ?? 'new'} onSubmit={event => submit(event, form => void save('saveUser', {
        email: form.get('email'), name: form.get('name'), roles: form.getAll('roles'), active: form.has('active'),
      }, () => setMember(undefined)))}>
        <label>Google 이메일<input name="email" type="email" required maxLength={254} defaultValue={member?.id} readOnly={Boolean(member)} /></label>
        <label>이름<input name="name" required maxLength={80} defaultValue={member?.name ?? member?.id} /></label>
        <fieldset><legend>역할</legend>{Object.entries(labels).map(([role, label]) =>
          <label key={role}><input name="roles" type="checkbox" value={role} defaultChecked={member?.roles.includes(role) ?? role === 'employee'} /> {label}</label>)}</fieldset>
        <label><input name="active" type="checkbox" defaultChecked={member?.active ?? true} /> 활성 계정</label>
        <button disabled={busy}>저장</button>
        {member && <button type="button" className="secondary" onClick={() => setMember(undefined)}>편집 취소</button>}
      </form>
    </>}
    {cyclesPage && Array.isArray(result) && <>
      <h2>시범 평가 회차</h2>
      <p>시범 회차의 인사고과 반영 비율은 0%입니다. 제출을 열면 회차의 평가 설정이 잠깁니다.</p>
      {(result as Cycle[]).length === 0 && <p>등록된 회차가 없습니다.</p>}
      {(result as Cycle[]).map(item => <div className="work-row" key={item.id}>
        <span>{item.name} · {item.status === 'draft' ? '초안' : item.status === 'open' ? '제출 중' : '종료'} · 마감 {item.schedule.close}</span>
        {item.status === 'draft' && <button disabled={busy} onClick={() => {
          if (window.confirm('시범 회차를 열고 평가 설정을 잠글까요?')) void save('openCycle', { id: item.id });
        }}>제출 열기</button>}
        {item.status === 'open' && <button disabled={busy} onClick={() => {
          if (window.confirm('시범 회차를 종료하고 추가 등록을 막을까요?')) void save('closeCycle', { id: item.id });
        }}>시범 종료</button>}
      </div>)}
      {path === '/admin/cycles' ? <form onSubmit={event => submit(event, form => {
        const values = Object.fromEntries(form);
        void save('createCycle', values);
      })}>
        <h2>회차 만들기</h2>
        <label>회차명<input name="name" required maxLength={80} /></label>
        <label>평가 대상 시작일<input name="from" type="date" required /></label>
        <label>평가 대상 종료일<input name="to" type="date" required /></label>
        <label>제출 마감일<input name="close" type="date" required /></label>
        <button disabled={busy}>초안 저장</button>
      </form> : <p><a href="/admin/cycles">회차 관리로 이동</a></p>}
    </>}
    {home && !cycle && <p>열린 시범 평가 회차가 없습니다.</p>}
    {cycle && <>
      <h2>{cycle.name}</h2>
      <p>대상 기간 {cycle.period.from} ~ {cycle.period.to} · 제출 마감 {cycle.schedule.close} (한국시간)</p>
      {path === '/' && <>
        <p>{home.agreed ? '평가 동의 완료' : '평가 동의 대기'} · 활용 사례 {home.cases?.length ?? 0}건</p>
        <p><a href={home.agreed ? '/cases' : '/consent'}>{home.agreed ? '활용 사례 열기' : '평가 동의 확인'}</a></p>
      </>}
      {path === '/consent' && <>
        <h2>시범 평가 정보 수집·이용 안내</h2>
        <p>계정 식별 정보와 동의 기록, 직접 등록한 활용 사례를 시범 평가 기능 검증에 사용합니다. 인사고과 반영 비율은 0%입니다.</p>
        <p>시범 평가 참여는 선택 사항입니다. 동의하지 않으면 이 회차의 활용 사례를 등록할 수 없습니다. 자료 보유 기간과 열람·삭제 요청은 참여 전에 관리자에게 확인하세요.</p>
        {home.agreed ? <p>동의했습니다. <a href="/cases">활용 사례 등록</a></p> : <form onSubmit={event => submit(event, () => {
          if (agree) void save('consent', { cycleId: cycle.id, textVersion: 'pilot-1' });
        })}>
          <label><input type="checkbox" checked={agree} onChange={event => setAgree(event.target.checked)} /> 시범 평가 자료 처리에 동의합니다.</label>
          <button disabled={busy || !agree || !home.editable}>동의 저장</button>
        </form>}
      </>}
      {path === '/cases' && (!home.agreed ? <p><a href="/consent">평가 동의를 먼저 완료하세요.</a></p> : <>
        <p>등록 {home.cases?.length ?? 0}건 · 회차 기준 {home.limits?.min}~{home.limits?.max}건</p>
        {home.cases?.map(item => <div className="work-row" key={item.id}>
          <span>{item.title} · {item.before.hours}시간 → {item.after.hours}시간</span>
          <button className="secondary" disabled={!home.editable || busy} onClick={() => setCurrentCase(item)}>편집</button>
        </div>)}
        {home.editable && (currentCase || (home.cases?.length ?? 0) < (home.limits?.max ?? 0)) && <form key={currentCase?.id ?? caseId}
          onSubmit={event => submit(event, form => void save('saveCase', {
            ...Object.fromEntries(form), id: currentCase?.id ?? caseId, cycleId: cycle.id,
            tools: form.getAll('tools'), before: Number(form.get('before')), after: Number(form.get('after')),
          }, () => { setCurrentCase(undefined); setCaseId(crypto.randomUUID()); }))}>
          <h2>{currentCase ? '사례 편집' : '활용 사례 등록'}</h2>
          <p>고객 정보, 단가, AI 대화 원문을 제외한 업무 과정과 결과를 요약하세요.</p>
          <label>업무명<input name="title" required maxLength={120} defaultValue={currentCase?.title} /></label>
          <label>업무 분류<input name="category" required maxLength={60} defaultValue={currentCase?.category} /></label>
          <fieldset><legend>사용 도구</legend>{home.tools?.map(tool => <label key={tool}>
            <input type="checkbox" name="tools" value={tool} defaultChecked={currentCase?.tools.includes(tool)} /> {tool}
          </label>)}</fieldset>
          <label>업무 과정 요약<textarea name="process" required maxLength={2000} defaultValue={currentCase?.process} /></label>
          <label>이전 소요 시간<input name="before" type="number" required min="0" max="10000" step="any" defaultValue={currentCase?.before.hours} /></label>
          <label>이후 소요 시간<input name="after" type="number" required min="0" max="10000" step="any" defaultValue={currentCase?.after.hours} /></label>
          <label>품질·성과 변화<textarea name="qualityNote" required maxLength={1500} defaultValue={currentCase?.qualityNote} /></label>
          <button disabled={busy}>사례 저장</button>
          {currentCase && <button type="button" className="secondary" onClick={() => setCurrentCase(undefined)}>편집 취소</button>}
        </form>}
      </>)}
    </>}
  </section>;
}

export const workPaths = ['/', '/consent', '/cases', '/admin', '/admin/users', '/admin/cycles'];
