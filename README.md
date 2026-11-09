# 위더스 AX 평가

위더스컴퓨터 임직원 AI 활용 평가 웹앱입니다.

## 시범 회차 진행

1. 관리자가 사용자 관리에서 직원과 평가자, 확정권자 계정을 지정합니다. 평가 대상자는 본인 평가를 검토하거나 확정할 수 없습니다.
2. 회차 관리에서 시범 회차와 사례 기반 수동 검토를 선택해 초안을 만들고 제출을 엽니다.
3. 직원이 평가에 동의하고 활용 사례를 등록한 뒤 제출 전 검토에서 사례를 제출합니다.
4. 관리자가 회차를 채점 및 검토 단계로 진행합니다. 평가자 검토와 확정권자 확정을 마치면 관리자가 결과를 공개합니다.
5. 직원은 결과 리포트에서 결과 조회와 이의신청을 할 수 있습니다. 관리자는 공개 회차를 Excel로 내보낼 수 있습니다.

## AI 채점 회차 설정

회차를 열기 전에 평가 설정에서 구조화 출력을 지원하는 Anthropic 모델 ID를 저장하고 루브릭 버전을 등록합니다. Secret Manager에 키를 대화형으로 등록하고, 채점 함수의 실행 서비스 계정에 해당 비밀에만 Secret Accessor 역할을 부여합니다.

```powershell
npx.cmd firebase-tools functions:secrets:set ANTHROPIC_API_KEY --project withax-ai
```

기록 파서는 원본 파일을 브라우저 메모리에서 처리합니다. 내보내기 파일 구조는 서비스별 실파일 샘플로 점검해야 합니다. AI 채점에는 선택된 마스킹 발췌가 전송되므로 사내 운영 전에 외부 제공처의 데이터 보유 설정과 동의 문안을 확인합니다.

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
- 대화 원본 파일은 브라우저에서 파싱합니다. 선택·마스킹한 발췌는 평가 처리 중 메모리에서 다루며 원문 필드를 Firestore에 기록하지 않습니다.

