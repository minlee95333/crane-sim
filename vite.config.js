import { defineConfig } from 'vite';

// crane-sim은 독립 앱이지만, V2 대시보드(LIFT-OPS)의 `/sim/` 라우트로도
// 서빙된다. 그래서 기본 배포 베이스를 `/sim/`로 둔다 (dev 서버는 base 무시).
// 순수 링크/정적 호스팅일 뿐 — V2와의 소스 병합은 없다 (AGENTS.md 규약).
//
// SIM_WATCH=1 (npm run watch:dash)일 때만 라이브리로드 스니펫을 index.html에
// 주입한다. 그 스크립트가 V2의 `/sim/__mtime`(빌드 시각)을 1초마다 폴링해서
// 값이 바뀌면 페이지를 새로고침한다 → 저장 즉시 재빌드+자동 반영.
// 프로덕션 빌드(SIM_WATCH 미설정)에는 주입되지 않아 배포 산출물이 깨끗하다.
const liveReload = () => ({
  name: 'sim-dash-livereload',
  transformIndexHtml() {
    if (!process.env.SIM_WATCH) return;
    return [
      {
        tag: 'script',
        injectTo: 'body',
        children: `(function(){var last=null;async function poll(){try{var r=await fetch('/sim/__mtime',{cache:'no-store'});var j=await r.json();if(last!==null&&j.mtime!==last){location.reload();return;}last=j.mtime;}catch(e){}setTimeout(poll,1000);}poll();})();`,
      },
    ];
  },
});

export default defineConfig({
  base: '/sim/',
  plugins: [liveReload()],
});
