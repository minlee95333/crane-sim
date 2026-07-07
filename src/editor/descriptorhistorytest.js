import { DescriptorHistory } from './DescriptorHistory.js';

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

console.log('--- 시나리오 Undo/Redo 이력 ---');

const history = new DescriptorHistory(3);
history.reset({ value: 0, items: [] });
history.commit({ value: 1, items: ['a'] });
history.commit({ value: 2, items: ['a', 'b'] });
check('두 변경 후 Undo 가능', history.canUndo && !history.canRedo);
check('Undo가 직전 descriptor 복원', history.undo().value === 1 && history.canRedo);
check('Redo가 다음 descriptor 복원', history.redo().value === 2);

history.undo();
history.commit({ value: 3, items: ['c'] });
check('Undo 뒤 새 편집은 Redo 분기 폐기', !history.canRedo && history.current().value === 3);

const snapshot = history.current();
snapshot.items.push('mutated');
check('외부 변경이 저장 스냅샷을 오염시키지 않음', history.current().items.length === 1);

history.commit({ value: 4, items: [] });
history.commit({ value: 5, items: [] });
check('이력 개수 상한 유지', history.entries.length === 3);
check('상한 초과 후에도 최신 상태 유지', history.current().value === 5);
