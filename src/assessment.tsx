import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { FirebaseApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { readRecords, readSummary, type Entry } from './records';

type Indicator = { code: string; name: string; max: number; score: number; needsAttention?: boolean };
type Settings = { axes: Record<string,number>; indicators: Indicator[]; hrWeight: number; gradeBands: { grade: string; name: string; min: number }[];
  securityGate: string; reviewAdjustment: number; ai: { model: string; runs: number; spreadThreshold: number };
  caseLimits: { min: number; max: number }; retentionYears: number };
type Config = { settings: Settings; toolCatalog: { tools: string[] }; keywords: Keywords; rubrics: { id: string; name: string }[]; locked: boolean };
type Keywords = { work: string[]; personal: string[] };
type Cycle = { id: string; name: string; status: string; period: { from: string; to: string }; schedule: { appealUntil?: string }; manual?: boolean };
type Case = { id: string; title: string; process: string; qualityNote: string; before: {hours:number}; after: {hours:number} };
type Appeal = { id: string; status: string; codes: string[]; reason: string; decision?: string; evaluatorNote?: string };
type Item = { id: string; cycleId: string; email: string; status: string; subjectEvaluator: boolean; cases: Case[];
  aiDraft?: { indicators: Indicator[]; strengths: string[]; weaknesses: string[]; sources: string[]; needsAttention: boolean };
  manual?: boolean; manualIndicators?: Indicator[];
  review?: { comment: string; gate: boolean; indicators: Indicator[] };
  final?: { indicators: Indicator[]; score: number; grade: string; hrScore: number | null };
  cycle?: Cycle; appeal?: Appeal };
type Queue = { cycle: Cycle | null; items: Item[]; appeals: Appeal[] };
type Home = { cycle: Cycle | null; agreed?: boolean; editable?: boolean; keywords: Keywords; status?: string };

export const statuses: Record<string,string> = {
  draft: '초안', open: '제출 중', scoring: 'AI 채점', reviewing: '검토 중', approving: '확정 대기',
  published: '결과 공개', closed: '종료', submitted: '채점 대기', ai_scored: 'AI 채점 완료', reviewed: '검토 완료', final: '확정',
};
export function useOperations<T>(app: FirebaseApp, action: string) {
  const [result, setResult] = useState<T>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const call = useCallback(async <R,>(operation: string, data?: object) =>
    (await httpsCallable<{ action: string; data?: object },R>(getFunctions(app,'asia-northeast3'),'operations')({ action: operation, data })).data, [app]);
  useEffect(() => {
    let active = true;
    call<T>(action).then(value => { if (active) setResult(value); }).catch(error => {
      if (active) setError(error.message);
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [call, action]);
  async function run(operation: () => Promise<unknown>, refresh = true) {
    setBusy(true); setError(''); setNotice('');
    try {
      await operation();
      if (refresh) setResult(await call<T>(action));
      setNotice('처리했습니다.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '처리 중 오류가 발생했습니다.'); }
    finally { setBusy(false); }
  }
  return { result, busy, error, notice, call, run };
}

function form(event: FormEvent<HTMLFormElement>, handle: (data: FormData) => void) {
  event.preventDefault();
  handle(new FormData(event.currentTarget));
}
const lines = (value: FormDataEntryValue | null) => String(value ?? '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
function Message({ error, notice, busy }: {error:string;notice:string;busy:boolean}) {
  return <>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{busy && <p>처리 중입니다.</p>}</>;
}
function NumberField({ name, label, value, min = 0, max = 100, step = 1 }: { name:string;label:string;value?:number;min?:number;max?:number;step?:number }) {
  return <label>{label}<input type="number" name={name} defaultValue={value} min={min} max={max} step={step} required /></label>;
}

export function Configuration({ app, path }: {app:FirebaseApp;path:string}) {
  const api = useOperations<Config>(app,'configuration');
  const config = api.result;
  const settings = config?.settings;
  return <section className="panel work">
    <Message {...api} />
    {config?.locked && <p className="badge">진행 회차 설정 잠김</p>}
    {config && settings && path === '/admin/settings' && <form onSubmit={event => form(event, data => {
      const n = (key: string) => Number(data.get(key));
      void api.run(() => api.call('saveSettings', {
        axes: Object.fromEntries(Object.keys(settings.axes).map(axis => [axis,n('axis-' + axis)])),
        indicators: settings.indicators.map(item => ({ ...item, max: n(item.code) })),
        hrWeight: n('weight'), gradeBands: settings.gradeBands.map(item => ({ ...item, min: n('grade-' + item.grade) })),
        securityGate: data.get('gate'), reviewAdjustment: n('adjustment'),
        ai: { model: data.get('model'), runs: n('runs'), spreadThreshold: n('spread') / 100 },
        caseLimits: { min:n('minCases'), max:n('maxCases') }, retentionYears: n('retention'),
      }));
    })}>
      <h2>배점과 등급</h2><p>축 배점과 해당 지표의 합계를 일치시키고, 총합을 100점으로 설정하세요.</p>
      {Object.entries(settings.axes).map(([axis,value]) => <NumberField key={axis} name={'axis-' + axis} label={axis + '축 배점'} value={value} />)}
      {settings.indicators.map(item => <NumberField key={item.code} name={item.code} label={item.code + ' ' + item.name} value={item.max} />)}
      {settings.gradeBands.map(item => <NumberField key={item.grade} name={'grade-' + item.grade} label={item.grade + ' 최소 점수'} value={item.min} />)}
      <h2>평가 운영</h2>
      <NumberField name="weight" label="인사고과 반영 비율 (%)" value={settings.hrWeight} max={30} />
      <NumberField name="adjustment" label="지표 조정 폭" value={settings.reviewAdjustment} />
      <label>보안 게이트<select name="gate" defaultValue={settings.securityGate}>
        <option value="B">B등급 상한</option><option value="C">C등급 상한</option><option value="exclude">평가 제외</option>
      </select></label>
      <NumberField name="minCases" label="최소 사례 수" value={settings.caseLimits.min} min={1} max={10} />
      <NumberField name="maxCases" label="최대 사례 수" value={settings.caseLimits.max} min={1} max={10} />
      <NumberField name="retention" label="근거 보유 기간 (년)" value={settings.retentionYears} min={1} max={10} />
      <label>Anthropic 모델 ID<input name="model" maxLength={100} defaultValue={settings.ai.model} /></label>
      <NumberField name="runs" label="AI 채점 횟수" value={settings.ai.runs} min={1} max={5} />
      <NumberField name="spread" label="편차 검토 기준 (%)" value={settings.ai.spreadThreshold * 100} step={0.1} />
      <button disabled={api.busy || config.locked}>설정 저장</button>
    </form>}
    {config && path === '/admin/catalog' && <form onSubmit={event => form(event, data =>
      void api.run(() => api.call('saveCatalog',{ tools: lines(data.get('tools')), work: lines(data.get('work')), personal: lines(data.get('personal')) })))}>
      <p>항목을 한 줄에 하나씩 입력하세요.</p>
      <label>AI 도구<textarea name="tools" required rows={7} defaultValue={config.toolCatalog.tools.join('\n')} /></label>
      <label>업무 키워드<textarea name="work" required rows={7} defaultValue={config.keywords.work.join('\n')} /></label>
      <label>개인 대화 제외 키워드<textarea name="personal" required rows={7} defaultValue={config.keywords.personal.join('\n')} /></label>
      <button disabled={api.busy || config.locked}>목록 저장</button>
    </form>}
    {config && settings && path === '/admin/rubrics' && <>
      <h2>등록 버전</h2><ul>{config.rubrics.map(item => <li key={item.id}>{item.name}</li>)}</ul>
      <form onSubmit={event => form(event, data => void api.run(() => api.call('saveRubric', {
        name:data.get('name'), criteria:Object.fromEntries(settings.indicators.map(item => [item.code,data.get(item.code)])),
      })))}>
        <h2>새 루브릭 버전</h2><p>가장 최근 저장한 루브릭이 이후 개시하는 회차에 고정됩니다.</p>
        <label>버전 이름<input name="name" required maxLength={80} /></label>
        {settings.indicators.map(item => <label key={item.code}>{item.code} {item.name} 채점 기준
          <textarea name={item.code} required maxLength={1200} /></label>)}
        <button disabled={api.busy || config.locked}>버전 저장</button>
      </form>
    </>}
  </section>;
}

export function Records({ app, path }: {app:FirebaseApp;path:string}) {
  const api = useOperations<Home>(app,'home');
  const [entries,setEntries] = useState<Entry[]>([]);
  const [info,setInfo] = useState('');
  const [source,setSource] = useState<'claude'|'chatgpt'|'gemini'>('claude');
  const [reading,setReading] = useState(false);
  const [step,setStep] = useState(path.endsWith('/review') ? 'review' : 'import');
  const home = api.result;
  const cycle = home?.cycle;
  const selected = entries.filter(entry => entry.selected);
  async function read(file: File) {
    if (!cycle || !home) return;
    setReading(true); setInfo('');
    try {
      const result = await readRecords(file, source, cycle.period, home.keywords);
      setEntries(current => [...current, ...result.entries].slice(0,300));
      setInfo(`후보 ${result.entries.length}건, 자동 제외 ${result.excluded}건${result.truncated ? `, 목록 한도 초과 ${result.truncated}건` : ''}.`);
    } catch (error) { setInfo(error instanceof Error ? error.message : '파일을 읽을 수 없습니다.'); }
    finally { setReading(false); }
  }
  return <section className="panel work">
    <Message {...api} />
    {info && <p role="status">{info}</p>}
    {home && !cycle && <p>열린 평가 회차가 없습니다.</p>}
    {cycle && !home.agreed && <p><a href="/consent">평가 동의로 이동</a></p>}
    {cycle && home.agreed && !home.editable && home.status !== 'submitted' && <p>제출 가능한 상태가 아닙니다. 현재 상태는 {statuses[home.status ?? ''] ?? '마감'}입니다.</p>}
    {cycle?.manual && home?.agreed && <><p>사례 기반 수동 검토 회차입니다. 등록한 사례만 제출합니다.</p>
      {home.editable && <button disabled={api.busy} onClick={() => void api.run(() => api.call('submitManual',{ cycleId:cycle.id }))}>활용 사례 제출</button>}
      {!home.editable && <p>현재 상태 {statuses[home.status ?? ''] ?? '마감'}</p>}</>}
    {cycle && !cycle.manual && home.agreed && (home.editable || home.status === 'submitted') && <>
      <p>대상 기간 {cycle.period.from} ~ {cycle.period.to}. 개인 대화와 기간 외 기록을 자동 제외합니다.</p>
      {step === 'import' ? <>
        <form><label>AI 서비스<select value={source} onChange={event => setSource(event.target.value as typeof source)}>
          <option value="claude">Claude</option><option value="chatgpt">ChatGPT</option><option value="gemini">Gemini</option>
        </select></label><label>내보내기 파일<input type="file" accept=".zip,.json,.html" disabled={reading} onChange={event => {
          const file = event.currentTarget.files?.[0]; if (file) void read(file); event.currentTarget.value = '';
        }} /></label></form>
        <form onSubmit={event => form(event, data => {
          try {
            const entry = readSummary(String(data.get('summary')), cycle.period, home.keywords.personal);
            setEntries(current => [...current.filter(item => item.source !== 'summary'),entry]);
            setInfo('Claude 자가분석을 추가했습니다.');
          } catch (error) { setInfo(error instanceof Error ? error.message : 'JSON을 확인하세요.'); }
        })}><label>Claude 표준 분석 JSON<textarea name="summary" required maxLength={100000} rows={5} /></label>
          <button>요약 추가</button></form>
        <button onClick={() => setStep('review')} disabled={reading || !entries.length}>제출 전 검토 ({entries.length}건)</button>
      </> : <>
        {!entries.length && <p>검토할 대화를 가져오세요.</p>}
        <p>선택 {selected.length}건 · 최대 30건. 제목과 발췌를 확인하고 개인정보가 남은 자료는 해제하세요.</p>
        {entries.map((item,index) => <div key={index} className="work-row">
          <label><input type="checkbox" checked={item.selected} onChange={event =>
            setEntries(current => current.map((entry,i) => i === index ? { ...entry, selected: event.target.checked } : entry))} />
            {item.date} · {item.source} · {item.label || '제목 없음'}</label>
          <details><summary>마스킹 발췌</summary><p>{item.text}</p></details>
        </div>)}
        <button disabled={api.busy} onClick={() => setStep('import')}>가져오기로 돌아가기</button>{' '}
        <button disabled={api.busy || !selected.length || selected.length > 30} onClick={() => void api.run(async () => {
          await httpsCallable(getFunctions(app,'asia-northeast3'),'score',{ timeout: 250000 })({
            cycleId: cycle.id, entries: selected.map(({source,date,text}) => ({source,date,text})),
          });
          setEntries([]);
        })}>제출 및 AI 채점</button>
      </>}
      <p>원본 파일은 브라우저에서 열고, 선택한 마스킹 발췌만 채점 요청으로 전송합니다.</p>
    </>}
  </section>;
}

export function Review({ app, path }: {app:FirebaseApp;path:string}) {
  const api = useOperations<Queue>(app,'queue');
  const [id,setId] = useState(path.startsWith('/review/') ? path.split('/').at(-1) : '');
  const queue = api.result;
  const approval = path === '/approve';
  const item = queue?.items.find(value => value.id === id);
  const indicators = item?.aiDraft?.indicators ?? item?.manualIndicators ?? [];
  return <section className="panel work">
    <Message {...api} />
    {queue && !queue.cycle && <p>진행 중인 회차가 없습니다.</p>}
    {queue?.cycle && <>
      <h2>{queue.cycle.name} · {statuses[queue.cycle.status]}</h2>
      {queue.items.length === 0 && <p>처리할 평가가 없습니다.</p>}
      {queue.items.map(value => <div key={value.id} className="work-row">
        <span>{value.email || value.id} · {statuses[value.status]} {value.aiDraft?.needsAttention && '· 편차 검토 필요'}</span>
        <button className="secondary" onClick={() => setId(value.id)}>상세 보기</button></div>)}
      {item && <div key={item.id}>
        <h2>{item.email || item.id}</h2>
        <p>{item.manual ? '사례 기반 수동 검토' : '자료 출처 ' + item.aiDraft?.sources.join(', ')}</p>
        <table><thead><tr><th>지표</th><th>AI 점수</th><th>검토 점수</th></tr></thead>
          <tbody>{indicators.map(indicator => <tr key={indicator.code}><td>{indicator.name}</td>
            <td>{item.manual ? '수동 채점' : indicator.score + '/' + indicator.max}</td><td>{item.review?.indicators.find(value => value.code === indicator.code)?.score ?? '대기'}</td></tr>)}</tbody></table>
        {queue.cycle.status === 'reviewing' && (item.status === 'ai_scored' || (item.manual && item.status === 'submitted')) && approval === Boolean(item.subjectEvaluator) &&
          <form onSubmit={event => form(event, data => void api.run(() => api.call('review',{
            id:item.id, confirmed:data.getAll('confirmed'), gate:data.has('gate'), gateReason:data.get('gateReason'), comment:data.get('comment'),
            adjustments:Object.fromEntries(indicators.map(indicator => [indicator.code,Number(data.get(indicator.code))])),
            reasons:Object.fromEntries(indicators.map(indicator => [indicator.code,data.get('reason-' + indicator.code)])),
          })))}>
            <h2>사례 확인 및 점수 검토</h2>
            {item.cases.map(entry => <article key={entry.id}><label>
              <input name="confirmed" type="checkbox" value={entry.id} /> {entry.title} 사실 확인</label>
              <p>{entry.before.hours}시간 → {entry.after.hours}시간 · {entry.process}</p><p>{entry.qualityNote}</p>
            </article>)}
            {indicators.map(indicator => <div key={indicator.code}>
              <NumberField name={indicator.code} label={indicator.name + (item.manual ? ' 평가 점수' : ' 조정점수')} value={0} min={item.manual ? 0 : -100} max={item.manual ? indicator.max : 100} step={0.01} />
              <label>평가 사유<input name={'reason-' + indicator.code} maxLength={600} required={item.manual} /></label></div>)}
            <label><input name="gate" type="checkbox" /> 보안 게이트 적용</label>
            <label>게이트 사유<input name="gateReason" maxLength={600} /></label>
            <label>검토 의견<textarea name="comment" required maxLength={1200} /></label>
            <button disabled={api.busy}>검토 완료</button>
          </form>}
        {approval && queue.cycle.status === 'approving' && item.status === 'reviewed' &&
          <><p>검토 의견 {item.review?.comment}</p><button disabled={api.busy} onClick={() => {
            if (window.confirm('검토 결과를 최종 확정할까요?')) void api.run(() => api.call('approve',{ id:item.id }));
          }}>최종 확정</button></>}
      </div>}
      {queue.appeals.length > 0 && <h2>이의신청</h2>}
      {queue.appeals.map(appeal => {
        const evaluation = queue.items.find(value => value.id === appeal.id);
        return <article key={appeal.id}>
          <p>{appeal.codes.join(', ')} · {appeal.reason} · {appeal.status === 'resolved' ? '처리 완료' : '처리 대기'}</p>
          {appeal.evaluatorNote && <p>{appeal.evaluatorNote}</p>}
          {appeal.decision && <p>{appeal.decision}</p>}
          {(appeal.status === 'pending' && approval === Boolean(evaluation?.subjectEvaluator) || appeal.status === 'reviewed' && approval) &&
            <form onSubmit={event => form(event,data => void api.run(() => api.call('resolveAppeal',{
              id:appeal.id, note:data.get('note'), scores:Object.fromEntries(appeal.codes.flatMap(code => {
                const value = data.get(code); return value ? [[code,Number(value)]] : [];
              })),
            })))}>
              {appeal.status === 'reviewed' && <p>변경할 점수만 입력하세요.</p>}
              {appeal.status === 'reviewed' && appeal.codes.map(code => <label key={code}>{code}
                <input name={code} type="number" min="0" max={evaluation?.final?.indicators.find(item => item.code === code)?.max} step="0.01" />
              </label>)}
              <label>처리 의견<textarea name="note" required maxLength={1200} /></label><button disabled={api.busy}>이의신청 처리</button>
            </form>}
        </article>;
      })}
    </>}
  </section>;
}

export function Report({ app, path }: {app:FirebaseApp;path:string}) {
  const api = useOperations<Item[]>(app,'report');
  const cycleId = path.split('/')[2];
  const item = cycleId ? api.result?.find(value => value.cycleId === cycleId) : api.result?.[0];
  const appealPage = path.startsWith('/appeal/');
  return <section className="panel work">
    <Message {...api} />
    {api.result?.length === 0 && <p>공개된 결과가 없습니다.</p>}
    {api.result?.map(value => <p key={value.id}><a href={'/report/' + value.cycleId}>{value.cycle?.name}</a></p>)}
    {item?.final && <>
      <h2>{item.cycle?.name} · {item.final.grade}등급 · {item.final.score}점</h2>
      <p>고과 반영 점수 {item.final.hrScore ?? '제외'} · {item.review?.gate ? '보안 게이트 적용' : '보안 게이트 미적용'}</p>
      {api.result && api.result.length > 1 && <section><h3>회차별 성장</h3>
        {[...api.result].reverse().map(row => <p key={row.id}>{row.cycle?.name} · {row.final?.score}점 <meter min="0" max="100" value={row.final?.score ?? 0} /></p>)}
      </section>}
      <table><thead><tr><th>지표</th><th>점수</th><th>달성률</th></tr></thead><tbody>
        {item.final.indicators.map(value => <tr key={value.code}><td>{value.name}</td><td>{value.score}/{value.max}</td>
          <td><meter value={value.max ? value.score / value.max : 0} min="0" max="1" /></td></tr>)}
      </tbody></table>
      {item.aiDraft && <><p>AI 초안 강점 {item.aiDraft.strengths.join(', ')}</p>
        <p>AI 초안 개선 지표 {item.aiDraft.weaknesses.join(', ')}</p></>}
      <p>검토 의견 {item.review?.comment}</p>
      {item.appeal ? <p>이의신청 {item.appeal.decision ?? '처리 중'}</p> :
        item.cycle?.status === 'published' && item.cycle.schedule.appealUntil &&
        Date.now() <= Date.parse(item.cycle.schedule.appealUntil + 'T23:59:59.999+09:00') &&
        (appealPage ? <form onSubmit={event => form(event,data => void api.run(() => api.call('appeal',{
          codes:data.getAll('codes'), reason:data.get('reason'), cycleId:item.cycleId,
        })))}>
          <fieldset><legend>이의신청 지표</legend>{item.final.indicators.map(value => <label key={value.code}>
            <input name="codes" type="checkbox" value={value.code} /> {value.name}
          </label>)}</fieldset>
          <label>신청 사유<textarea name="reason" maxLength={1500} required /></label><button disabled={api.busy}>이의신청 제출</button>
        </form> : <a href={'/appeal/' + item.cycleId}>이의신청</a>)}
    </>}
  </section>;
}

export function Export({ app }: {app:FirebaseApp}) {
  const api = useOperations<Cycle[]>(app,'cycles');
  const audit = useOperations<{ action:string;target:string;at:string }[]>(app,'audit');
  function csvValue(value: unknown) {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"','""') + '"';
  }
  return <section className="panel work"><Message {...api} />
    <form onSubmit={event => form(event,data => void api.run(async () => {
      const result = await api.call<{ rows:{ email:string;score:number;grade:string;hrScore:number|null }[] }>('export',{ cycleId:data.get('cycle') });
      const rows = [['계정','점수','등급','고과 반영'],...result.rows.map(item => [item.email,item.score,item.grade,item.hrScore])];
      const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(csvValue).join(',')).join('\r\n')],{ type:'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'withax-results.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    },false))}><label>공개 회차<select name="cycle" required><option value="">선택</option>
      {api.result?.filter(item => ['published','closed'].includes(item.status)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label><button disabled={api.busy}>결과 CSV 다운로드</button></form>
    <h2>최근 감사 로그</h2><Message {...audit} />
    {audit.result && <table><thead><tr><th>시간</th><th>작업</th><th>대상</th></tr></thead>
      <tbody>{audit.result.map((row,index) => <tr key={index}><td>{row.at}</td><td>{row.action}</td><td>{row.target}</td></tr>)}</tbody></table>}
  </section>;
}

type DashboardData = { cycle: Cycle | null; total: number; submitted: number; pending: number; gates: number; average: number | null;
  grades: Record<string,number>; indicators: {code:string;name:string;rate:number}[];
  staff: {email:string;name:string;status:string}[]; usage: {apiCalls?:number;inputTokens?:number;outputTokens?:number} };
export function Dashboard({ app }: {app:FirebaseApp}) {
  const api = useOperations<DashboardData>(app,'dashboard');
  const [filter,setFilter] = useState('');
  const data = api.result;
  return <section className="panel work"><Message {...api} />
    <p><a href="/admin/cycles">회차 관리로 이동</a></p>
    {data && !data.cycle && <p>진행 중인 회차가 없습니다.</p>}
    {data?.cycle && <>
      <h2>{data.cycle.name} · {statuses[data.cycle.status]}</h2>
      <p>제출 {data.submitted}/{data.total} · 검토 대기 {data.pending} · 보안 게이트 {data.gates} · 전사 평균 {data.average ?? '대기'}</p>
      <p>AI 호출 {data.usage.apiCalls ?? 0}회 · 입력 {data.usage.inputTokens ?? 0} 토큰 · 출력 {data.usage.outputTokens ?? 0} 토큰</p>
      {Object.keys(data.grades).length > 0 && <><h2>등급 분포</h2>{Object.entries(data.grades).map(([grade,count]) =>
        <p key={grade}>{grade} · {count}명 <meter min="0" max={Math.max(data.total, count)} value={count} /></p>)}</>}
      {data.indicators.length > 0 && <><h2>지표별 평균 달성률</h2>{data.indicators.map(item =>
        <p key={item.code}>{item.name} · {item.rate}% {item.rate < 60 && '· 교육 우선 검토'} <meter min="0" max="100" value={item.rate} /></p>)}</>}
      <h2>직원 진행 현황</h2>
      <label>상태 <select value={filter} onChange={event => setFilter(event.target.value)}><option value="">전체</option>
        {['not_started','consented','submitted','ai_scored','reviewed','final'].map(value => <option key={value} value={value}>{statuses[value] ?? (value === 'consented' ? '준비 중' : '미제출')}</option>)}
      </select></label>
      <table><thead><tr><th>이름</th><th>상태</th></tr></thead><tbody>{data.staff.filter(item => !filter || item.status === filter).map(item =>
        <tr key={item.email}><td>{item.name}</td><td>{statuses[item.status] ?? (item.status === 'consented' ? '준비 중' : '미제출')}</td></tr>)}</tbody></table>
    </>}
  </section>;
}
