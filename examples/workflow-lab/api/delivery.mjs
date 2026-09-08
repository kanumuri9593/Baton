/** Demo-only in-memory delivery state. Reset creates a new attempt. */
export class Delivery {
  #receipt;
  #sequence = 0;
  complete() {
    this.#receipt ??= `RCPT-${String(++this.#sequence).padStart(4, '0')}`;
    return this.snapshot();
  }
  reset() { this.#receipt = undefined; return this.snapshot(); }
  snapshot() { return { id: 'DEMO-1042', status: this.#receipt ? 'Delivered' : 'Ready', receipt: this.#receipt ?? null }; }
}
