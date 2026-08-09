import { RainfallService } from '../core/service.js';

/**
 * The keeper closes the loop.
 *
 * Without it, repayment is something a human clicks and the freeze is theatre.
 * With it, the obligation enforces itself: installments come due on a clock,
 * an agent that pays keeps its card, and an agent that misses one has its card
 * killed by a process that was never told to be dramatic about it.
 */
export interface KeeperOptions {
  /** How often to sweep, in ms. */
  intervalMs?: number;
  /**
   * When false, the keeper only reports what is due -- it does not pay.
   * Use this to demonstrate a miss without hand-editing anything.
   */
  autopay?: boolean;
}

export class Keeper {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  autopay: boolean;
  readonly intervalMs: number;

  constructor(
    private readonly svc: RainfallService,
    opts: KeeperOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.autopay = opts.autopay ?? true;
  }

  get active(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer) return;
    this.svc.say('keeper', `started — sweeping every ${this.intervalMs / 1000}s`);
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.svc.say('keeper', 'stopped');
  }

  /** One pass. Safe to call directly in tests. */
  async sweep(): Promise<void> {
    if (this.running) return; // a slow chain must not stack sweeps
    this.running = true;
    try {
      for (const id of await this.svc.activeIds()) {
        const overdue = await this.svc.isOverdue(id);

        if (overdue) {
          // Past the grace window. This is the enforcement path, and it runs
          // whether or not anyone is watching.
          this.svc.say('keeper', `#${id} past grace — enforcing`);
          await this.svc.markDelinquent(id);
          continue;
        }

        if (this.autopay && (await this.isDue(id))) {
          await this.svc.pay(id);
        }
      }
    } catch (e) {
      this.svc.say('warn', `keeper sweep failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Due once the installment's cadence has elapsed, before grace expires. */
  private async isDue(id: number): Promise<boolean> {
    const s = await this.svc.state();
    const a = s.agreements.find((x) => x.id === id);
    return !!a && a.status === 'Active' && s.now >= a.nextDueAt;
  }
}

// Standalone: `npm run keeper`
if (import.meta.url === `file://${process.argv[1]}`) {
  const svc = new RainfallService();
  const keeper = new Keeper(svc, {
    intervalMs: Number(process.env.KEEPER_INTERVAL_MS ?? 5_000),
    autopay: process.env.KEEPER_AUTOPAY !== 'false',
  });
  keeper.start();
  process.on('SIGINT', () => {
    keeper.stop();
    process.exit(0);
  });
}
