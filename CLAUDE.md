# crane-sim 프로젝트 규약

> 일반 작업 원칙(판단 기준·버그 수정 절차·검증 의무·보고 형식)은 전역
> `~/.claude/CLAUDE.md`의 "일반 작업 원칙" 절에 있다. 이 문서는 그 원칙을
> crane-sim에 적용하기 위한 프로젝트 전용 사실만 담는다.

- **목적**: 여러 양중물 × 여러 크레인의 "계획 단계" 최적화를 위한 현실 기반 양중 시뮬레이터.
  최종 목표는 스케줄링 RL(P8)이지만 RL은 맨 마지막 — 사용자가 명시할 때만 착수.
- **진실 원천**: `SIM_DESIGN.md` — 작업 전 §0(층위), §2.5(계획 계층), §5(로드맵·상태), §6(원칙)을
  읽고, 단계 완료 시 §5 표의 상태 열을 갱신.
- **판단 기준 적용**: "핵심 지표"는 스케줄의 **타당성·시간(makespan)·비용**이다. 이를 바꾸지
  않는 동역학 정밀도(이중진자 등)는 후순위.
- **계층**: `core`(World/Crane/Load/물리·제약) → `sim`(Simulation/Environment/Recorder)
  → `plan`(AutoPilot/PlanRunner/MacroPlanner/…) → `render`/`ui`. core는 render·RL을 모른다.
- **2단 계획 구조**: MacroPlanner가 빠른 근사(닫힌식·2D)로 후보 생성 → 최종 계획은
  ScheduleValidator의 3D 시간축 검증을 통과. 상세 물리(AutoPilot·리깅 상태기계)는 고정
  `duration` 뒤의 교체 가능 계층.
- **V2 경계**: `crane-rl-dash-auto-reward. V2`(Python)는 설계 참고 전용. 코드 병합 금지,
  공유는 JSON 데이터 스펙으로.
- **테스트 관례**: 모듈 옆 `*test.js`(예: `src/plan/macrotest.js`), 프레임워크 없는 Node 단정문
  스크립트. `scripts/run-tests.js`가 `src/` 아래를 자동 수집.
- **명령**: 실행 `npm run dev` 또는 `start.bat` / 테스트 `npm test` / 빌드 `npm run build`.
  기존 500kB 번들 경고는 알려진 상태.
- **환경**: Windows + 한글 경로(`바탕 화면`) — 쉘 명령에서 경로는 항상 따옴표.
- **기록**: 세션 로그는 SessionEnd 훅이 `obsidian/`에 자동 작성 — 수동 중복 생성 금지.
  `obsidian/세션/` 최근 로그로 맥락을 잡되 노트는 참고일 뿐, 현재 코드·테스트로 검증.
