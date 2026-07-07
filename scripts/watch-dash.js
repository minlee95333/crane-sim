// crane-sim을 감시하며 저장 즉시 재빌드해서, V2 대시보드가 서빙하는
// `web/sim/`으로 바로 출력한다 (수동 빌드/복사 제거).
//
//   npm run watch:dash
//
// - SIM_WATCH=1 을 켜서 vite.config의 라이브리로드 스니펫이 index.html에
//   주입되게 한다 → 브라우저가 /sim/__mtime 폴링으로 자동 새로고침.
// - outDir을 형제 폴더의 V2 web/sim으로 지정 (base '/sim/'는 config에서).
// - 프로덕션 배포용 산출물은 `npm run build`(dist/)를 쓰고, 갱신 복사는
//   V2의 scripts/update_sim.py를 쓴다. 이 스크립트는 로컬 개발 전용.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { build } from 'vite';

process.env.SIM_WATCH = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', '..', 'crane-rl-dash-auto-reward. V2', 'web', 'sim');

if (!fs.existsSync(path.dirname(outDir))) {
  console.error(`[watch:dash] V2 web 폴더를 찾을 수 없음: ${path.dirname(outDir)}`);
  console.error('  crane-sim과 V2가 같은 상위 폴더의 형제 디렉터리인지 확인하세요.');
  process.exit(1);
}

console.log(`[watch:dash] 감시 시작 → 출력: ${outDir}`);
console.log('[watch:dash] crane-sim/src 를 저장하면 자동 재빌드 + 브라우저 자동 새로고침');

await build({
  build: {
    outDir,
    emptyOutDir: true,
    watch: {},
  },
});
