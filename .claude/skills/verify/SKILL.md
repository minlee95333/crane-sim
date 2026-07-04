---
name: verify
description: crane-sim 3D 앱을 헤드리스 브라우저로 실제 구동·조작·캡처하는 검증 레시피 (Windows, 의존성 0)
---

# crane-sim 브라우저 검증 레시피

렌더·조작 변경은 `npm test`(헤드리스 지오메트리 검증)만으로 부족하다 — 실제 브라우저에서
구동해 HUD 텍스트와 스크린샷을 증거로 남긴다. Playwright 불필요: **headless Edge + CDP +
Node 24 내장 WebSocket/fetch**로 의존성 0.

## 절차

1. **서버**: `npm run dev` (백그라운드). 출력에서 실제 포트 확인 — 5173이 점유돼
   5174 등으로 바뀔 수 있다 (사용자가 start.bat로 이미 띄워둔 경우).
2. **브라우저**: 사용자 Edge 세션과 분리해 실행 (user-data-dir 필수):
   ```sh
   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" \
     --headless=new --disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader \
     --remote-debugging-port=9222 --user-data-dir="<scratch>\edge-profile" \
     --window-size=1600,900 about:blank
   ```
3. **드라이버** (Node .mjs): `http://127.0.0.1:9222/json/list` → page 대상의
   `webSocketDebuggerUrl`에 WebSocket 연결 후 CDP 명령:
   - `Page.navigate` → 4~5s 대기 (SwiftShader 첫 셰이더 컴파일이 느림)
   - 키 입력: `Input.dispatchKeyEvent` `{ type:'rawKeyDown'|'keyUp', code:'KeyN', key:... }`
     — 앱은 `e.code`를 읽는다. N 시나리오 전환 / C 카메라 / G 그리드 / Space 픽업.
   - 상태 증거: `Runtime.evaluate`로 `document.getElementById('hud').textContent`
   - 스크린샷: `Page.captureScreenshot`
   - 콘솔 오류: `Log.enable` + `Log.entryAdded`, `Runtime.exceptionThrown`
4. **종료**: CDP `Browser.close` (taskkill로 msedge 전체를 죽이면 사용자 브라우저가
   같이 죽는다). vite는 `netstat -ano | grep :<port>`로 PID 찾아 taskkill.

## 조작 시 함정

- **픽업은 후크를 내린 뒤에만 된다**: 초기 후크 ~21.6m, 픽업 수직 허용 4m.
  E(권하)를 시간으로 어림하지 말고 **HUD의 `후크높이`를 읽는 피드백 루프**로
  목표 높이(≈부재 상단+1m)까지 내려라. 리깅 시나리오(S7·S9·S11)는 Space 후
  `줄걸이 시작` → rigTime/배속 초 대기 → HUD `인양하중`이 잡혀야 hooked.
- 배속 기본 ×5 — 대기 시간 계산에 반영.
- FPS는 SwiftShader라 ~10으로 나온다. 실 GPU 성능 판단에 쓰지 말 것 (상대 비교만).

## 확인 포인트 (P7.9 기준)

S1 격자붐·슬링4·접지그림자 / S8 그림자 현장 커버 / S9 트럭·H형강·office 창밴드·펜스 /
S10 W주행·트랙슈·먼지 / S11 풍속·풍향 HUD·흔들림 증가·거더 요 지연 / C 카메라 4모드 /
G 그리드 / 콘솔 오류 0 (favicon 404는 기존).
