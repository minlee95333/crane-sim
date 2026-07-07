const clone = (value) => structuredClone(value);

/** 시나리오 descriptor 스냅샷 기반 Undo/Redo. */
export class DescriptorHistory {
  constructor(limit = 50) {
    this.limit = Math.max(2, limit);
    this.entries = [];
    this.index = -1;
  }

  reset(descriptor) {
    this.entries = [clone(descriptor)];
    this.index = 0;
    return this.current();
  }

  commit(descriptor) {
    const next = clone(descriptor);
    const current = this.entries[this.index];
    if (current && JSON.stringify(current) === JSON.stringify(next)) return this.current();
    this.entries.splice(this.index + 1);
    this.entries.push(next);
    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
    return this.current();
  }

  undo() {
    if (!this.canUndo) return null;
    this.index -= 1;
    return this.current();
  }

  redo() {
    if (!this.canRedo) return null;
    this.index += 1;
    return this.current();
  }

  current() {
    return this.index >= 0 ? clone(this.entries[this.index]) : null;
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }
}
