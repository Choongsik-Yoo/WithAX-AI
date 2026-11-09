# 위더스 AX 평가

위더스컴퓨터 임직원 AI 활용 평가 웹앱의 M1 기반입니다. 로그인과 접근 제어, 역할별 메뉴, 평가 기준 화면을 연결합니다.

## 로컬 미리보기

```powershell
npm.cmd install
npm.cmd run dev
```

Vite가 출력한 주소를 열고 직원, 평가자, 확정권자, 관리자 중 하나를 선택합니다. Firebase 설정 없이 개발 서버를 실행할 때만 가상 역할을 제공합니다.

## Firebase 연결

1. Firebase에서 웹 앱을 등록하고 Authentication의 Google 로그인 및 허용 도메인을 설정합니다. Firestore와 Functions를 사용할 수 있는 프로젝트를 준비합니다.
2. `.env.example`을 `.env.local`에 복사하고 웹 앱 설정을 채웁니다. 브라우저에 노출되는 환경 변수에는 서버 비밀값을 넣지 않습니다.
3. Functions 의존성을 설치합니다. 초기 데이터 등록을 실행할 계정에는 대상 프로젝트 Firestore 쓰기 권한과 Application Default Credentials가 필요합니다.

```powershell
npm.cmd --prefix functions install
node functions/seed.js <프로젝트-ID> <관리자-Google-이메일>
npm.cmd run build
```

초기 데이터 스크립트는 비어 있는 문서만 생성합니다. 최초 계정의 역할은 직원·평가자·관리자로 부여합니다. 확정권자는 별도의 `allowlist/{소문자 이메일}` 문서로 등록합니다. 역할 배열에는 `employee`, `evaluator`, `admin`, `approver` 중 해당 역할을 입력합니다. 관리자용 편집 화면은 M2 범위입니다.

대상 프로젝트에서 Firebase CLI로 Functions 및 Firestore 규칙을 적용한 뒤 Firebase Hosting을 사용하면 빌드된 앱을 연결할 수 있습니다. Storage를 구성한 프로젝트에는 `storage.rules`도 적용합니다.

## 검증

- 등록 계정과 미등록 계정으로 각각 로그인하고 역할별 메뉴 및 제한 경로를 확인합니다.
- 로그인 상태에서 허용 목록을 비활성화한 뒤 Firestore 보호 경로의 다음 요청이 거부되는지 확인합니다.
- 파일 가져오기, 평가, 확정은 후속 단계입니다. 대화 원본 파일은 브라우저에서만 파싱하고 서버에는 전송하지 않습니다. 선택·마스킹한 발췌는 평가 처리 중 메모리에서만 다루며 원문을 Firestore, Storage, 로그에 남기지 않습니다.

