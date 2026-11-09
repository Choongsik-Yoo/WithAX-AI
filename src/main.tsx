import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import defaults from '../seed/defaults.json';
import './style.css';
import { Work, workPaths } from './work';
import { Configuration, Dashboard, Export, Records, Report, Review } from './assessment';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const app = Object.values(config).every(Boolean) ? initializeApp(config) : null;
const auth = app && getAuth(app);
const localPreview = !app && import.meta.env.DEV;
const groups = {
  employee: { title: '직원', pages: [['/', '내 평가'], ['/consent', '평가 동의'], ['/import', '기록 가져오기'], ['/import/review', '제출 전 검토'], ['/cases', '활용 사례'], ['/report', '결과 리포트'], ['/report/:cycleId', '결과 리포트'], ['/appeal/:cycleId', '이의신청']] },
  evaluator: { title: '평가자', pages: [['/review', '검토 대기'], ['/review/:evaluationId', '검토 상세']] },
  approver: { title: '확정권자', pages: [['/approve', '최종 확정']] },
  admin: { title: '관리자', pages: [['/admin', '운영 현황'], ['/admin/users', '사용자 관리'], ['/admin/cycles', '회차 관리'], ['/admin/settings', '평가 설정'], ['/admin/catalog', '도구·키워드'], ['/admin/rubrics', '루브릭'], ['/admin/export', '내보내기·감사 로그']] },
};
type Role = keyof typeof groups;
const allRoles = Object.keys(groups) as Role[];
const matches = (pattern: string, path: string) => {
  const parts = path.split('/');
  const segments = pattern.split('/');
  return parts.length === segments.length && segments.every((segment, i) =>
    segment.startsWith(':') ? Boolean(parts[i]) : segment === parts[i]);
};

function App() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [busy, setBusy] = useState(Boolean(auth));
  const [error, setError] = useState('');
  const [settings, setSettings] = useState<typeof defaults>();
  const [name, setName] = useState('');
  const [previewPath, setPreviewPath] = useState('/');
  const path = localPreview ? previewPath : window.location.pathname;
  useEffect(() => {
    if (!auth || !app) return;
    const firebaseAuth = auth;
    const firebaseApp = app;
    let generation = 0;
    const unsubscribe = onAuthStateChanged(firebaseAuth, async user => {
      const check = ++generation;
      setRoles([]);
      setSettings(undefined);
      if (!user) { setBusy(false); return; }
      setBusy(true);
      try {
        const access = httpsCallable<undefined, { roles: Role[] }>(
          getFunctions(firebaseApp, 'asia-northeast3'), 'access');
        const result = await access();
        const token = await user.getIdTokenResult(true);
        const verified = result.data.roles.filter(role =>
          allRoles.includes(role) && Array.isArray(token.claims.roles) && token.claims.roles.includes(role));
        if (!verified.length) throw new Error('역할 확인에 실패했습니다.');
        const snapshot = await getDoc(doc(getFirestore(firebaseApp), 'settings', 'default'));
        if (check !== generation) return;
        setSettings(snapshot.data() as typeof defaults | undefined);
        setRoles(verified);
        setName(user.displayName ?? '임직원');
        setError('');
      } catch (failure) {
        if (check !== generation) return;
        setError((failure as {code?: string}).code === 'functions/permission-denied'
          ? '등록되지 않은 계정입니다. 관리자에게 문의하세요.'
          : '접근 권한을 확인할 수 없습니다. 잠시 후 다시 시도하세요.');
        await signOut(firebaseAuth);
      } finally {
        if (check === generation) setBusy(false);
      }
    });
    return () => { generation++; unsubscribe(); };
  }, [path]);

  if (!roles.length) return <main className="login"><section className="panel login-card">
    <div className="mark">W</div><p className="eyebrow">WITHUS COMPUTER · AX</p>
    <h1>위더스 AX 평가</h1><p>임직원 AI 활용 역량평가</p>
    {error && <p role="alert">{error}</p>}
    {busy ? <p>접근 권한을 확인 중입니다.</p> : auth ? <button onClick={async () => {
      setError(''); setBusy(true);
      try { await signInWithPopup(auth, new GoogleAuthProvider()); }
      catch { setError('Google 로그인을 완료하지 못했습니다. 다시 시도하세요.'); setBusy(false); }
    }}>Google 계정으로 로그인</button> : localPreview ? <>
      <p>가상 데이터 미리보기 · 확인할 역할을 선택하세요.</p>
      <div className="buttons">{allRoles.map(role => <button key={role} onClick={() => {
        setPreviewPath(groups[role].pages[0][0]); setRoles([role]); setSettings(defaults); setName('미리보기');
      }}>{groups[role].title}</button>)}</div>
    </> : <p>Firebase 연결 설정이 필요합니다.</p>}
    <small>등록된 Google 계정을 사용하세요. Google 계정의 2단계 인증을 설정하세요.</small>
  </section></main>;

  const pages = roles.flatMap(role => groups[role].pages);
  const home = pages[0][0];
  const current = path === '/login' || (path === '/' && !roles.includes('employee')) ? home : path;
  const title = current === '/criteria' ? '평가 기준' : pages.find(([url]) => matches(url, current))?.[1];
  const navigatePreview = (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    if (localPreview) { event.preventDefault(); setPreviewPath(url); }
  };
  return <div className="shell">
    <aside><div className="brand"><span className="mark">W</span> 위더스 AX 평가</div>
      {localPreview && <p className="badge">가상 데이터 미리보기</p>}
      <nav aria-label="역할별 메뉴">
        {roles.map(role => <section key={role}><h2>{groups[role].title}</h2>
          {groups[role].pages.filter(([url]) => !url.includes(':')).map(([url, label]) =>
            <a key={url} href={url} onClick={event => navigatePreview(event, url)} aria-current={url === current ? 'page' : undefined}>{label}</a>)}
        </section>)}
        <a href="/criteria" onClick={event => navigatePreview(event, '/criteria')} aria-current={current === '/criteria' ? 'page' : undefined}>평가 기준</a>
      </nav>
    </aside>
    <main className="workspace"><header><span>임직원 AI 활용 역량평가</span><span>{name} <button className="secondary" onClick={() => {
      if (auth) void signOut(auth);
      else setRoles([]);
    }}>{localPreview ? '역할 선택' : '로그아웃'}</button></span></header>
    <div className="content"><p className="eyebrow">WITHUS AX</p><h1>{title ?? '접근 권한이 없습니다'}</h1>
      {current === '/criteria' ? <section className="panel"><h2>위더스 AX 역량평가 v2.0</h2>
        {settings ? <table><thead><tr><th>코드</th><th>평가 지표</th><th>배점</th></tr></thead><tbody>
          {settings.indicators.map(item => <tr key={item.code}><td>{item.code}</td><td>{item.name}</td><td>{item.max}</td></tr>)}
        </tbody></table> : <p>관리자가 평가 기준을 등록해야 합니다.</p>}
      </section> : title && app && current === '/admin' ? <Dashboard app={app} />
        : title && app && workPaths.includes(current) ? <Work key={current} app={app} path={current} />
        : title && app && ['/admin/settings','/admin/catalog','/admin/rubrics'].includes(current) ? <Configuration key={current} app={app} path={current} />
        : title && app && current === '/admin/export' ? <Export app={app} />
        : title && app && (current.startsWith('/review') || current === '/approve') ? <Review key={current} app={app} path={current} />
        : title && app && current.startsWith('/import') ? <Records key={current} app={app} path={current} />
        : title && app && (current.startsWith('/report') || current.startsWith('/appeal')) ? <Report key={current} app={app} path={current} />
        : <section className="panel">{title ? <p>업무 데이터를 사용하려면 Firebase 연결이 필요합니다.</p> :
        <a href={home} onClick={event => navigatePreview(event, home)}>내 역할의 시작 화면으로 이동</a>}</section>}
    </div></main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
