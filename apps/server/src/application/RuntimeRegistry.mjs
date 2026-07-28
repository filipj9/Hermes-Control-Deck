export class RuntimeRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter) {
    this.adapters.set(adapter.source, adapter);
  }

  get(source) {
    const adapter = this.adapters.get(source);
    if (!adapter) {
      throw new Error(`Unknown runtime source: ${source}`);
    }
    return adapter;
  }

  all() {
    return [...this.adapters.values()];
  }
}

