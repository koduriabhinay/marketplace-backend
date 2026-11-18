import { Router } from 'express';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

/**
 * /health = liveness: the process is up (a load balancer restarts it if this fails).
 * /ready  = readiness: dependencies are reachable (traffic is withheld until this passes).
 */
export function healthRouter(
  checks: ReadinessCheck[],
  isShuttingDown: () => boolean,
  /** Soft dependencies: reported in /ready but never make it fail. */
  optional?: { ping: () => Promise<void> },
) {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get('/ready', async (_req, res) => {
    if (isShuttingDown()) {
      res.status(503).json({ status: 'shutting_down' });
      return;
    }
    const results = await Promise.all(
      checks.map(async (c) => {
        try {
          await c.check();
          return { name: c.name, ok: true };
        } catch {
          return { name: c.name, ok: false };
        }
      }),
    );
    const ok = results.every((r) => r.ok);
    const degraded = optional ? [{ name: 'redis', ok: await optional.ping().then(() => true, () => false), required: false }] : [];
    res
      .status(ok ? 200 : 503)
      .json({ status: ok ? 'ready' : 'not_ready', checks: [...results, ...degraded] });
  });

  return router;
}
