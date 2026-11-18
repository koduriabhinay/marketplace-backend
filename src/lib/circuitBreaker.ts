export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker open. */
  failureThreshold: number;
  /** How long to stay open before letting one trial request through. */
  cooldownMs: number;
  now?: () => number;
}

/**
 * Circuit breaker: stop calling a dependency that keeps failing.
 *
 *   closed ──(N failures in a row)──► open ──(cooldown passes)──► half_open
 *     ▲                                 ▲                            │
 *     └──────────(trial succeeds)───────┼────────────────────────────┤
 *                                       └──────(trial fails)─────────┘
 *
 * While open, calls fail immediately without touching the dependency. That protects us
 * (no threads/sockets tied up waiting on timeouts) and the dependency (no retry storm
 * while it is trying to recover). Half-open lets exactly one trial through to probe.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get currentState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.opts.cooldownMs) return 'half_open';
    return this.state;
  }

  /** When the breaker will next allow a call (ms epoch); `now` if it allows one already. */
  get retryAt(): number {
    return this.state === 'open' ? this.openedAt + this.opts.cooldownMs : this.now();
  }

  /** Asks permission to make a call. Callers that get `true` must report the outcome. */
  tryAcquire(): boolean {
    const state = this.currentState;
    if (state === 'closed') return true;
    if (state === 'half_open' && !this.trialInFlight) {
      this.state = 'half_open';
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  onSuccess() {
    this.state = 'closed';
    this.failures = 0;
    this.trialInFlight = false;
  }

  onFailure() {
    this.trialInFlight = false;
    this.failures++;
    if (this.state === 'half_open' || this.failures >= this.opts.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}

/** One breaker per key (e.g. per webhook endpoint), so one bad endpoint can't affect others. */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  constructor(private readonly opts: CircuitBreakerOptions) {}

  get(key: string): CircuitBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(this.opts);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }
}
