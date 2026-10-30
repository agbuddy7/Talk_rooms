export class LatestOnlyScheduler {
  constructor(worker, onResult = () => {}, onError = console.error) {
    this.worker = worker; this.onResult = onResult; this.onError = onError;
    this.inFlight = false; this.pending = null;
    this.stats = { submitted: 0, completed: 0, replaced: 0, failed: 0 };
  }
  submit(snapshot) {
    this.stats.submitted += 1;
    if (this.inFlight) {
      if (this.pending) this.stats.replaced += 1;
      this.pending = snapshot;
      return;
    }
    void this.run(snapshot);
  }
  async run(snapshot) {
    this.inFlight = true;
    try {
      this.onResult(await this.worker(snapshot), snapshot);
      this.stats.completed += 1;
    } catch (error) {
      this.stats.failed += 1; this.onError(error);
    } finally {
      this.inFlight = false;
      if (this.pending) { const next = this.pending; this.pending = null; void this.run(next); }
    }
  }
}
