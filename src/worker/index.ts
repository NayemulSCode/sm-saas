/**
 * The worker entrypoint — the SECOND entrypoint over the same modules.
 *
 * Not a separate service: same repository, same domain modules, different
 * `main`. A background job and a web request therefore run identical business
 * logic, and there is no API contract between them to drift (§6.2).
 *
 * Handlers arrive with their modules in 3b onwards. Today this proves the
 * process starts, connects, and shuts down cleanly.
 */

import { env } from '../config/env';
import { closeAllPools } from '../db/index';

const log = (level: string, msg: string, extra: Record<string, unknown> = {}): void => {
  // Structured, and carrying tenant context where there is one. No PII —
  // ids only (invariant 12).
  console.log(JSON.stringify({ level, msg, at: new Date().toISOString(), ...extra }));
};

async function main(): Promise<void> {
  const config = env();
  log('info', 'worker starting', { nodeEnv: config.NODE_ENV, tz: config.TZ });

  // pg-boss consumers are registered here as each module ships:
  //   await boss.work('sms.send',          smsHandler);
  //   await boss.work('documents.render',  renderHandler);
  //   await boss.work('calendar.recompute', recomputeHandler);
  //
  // Jobs are enqueued INSIDE the transaction that caused them (invariant 9),
  // which is the whole reason the queue lives in PostgreSQL (ADR-0010).

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'worker shutting down', { signal });
    await closeAllPools();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log('info', 'worker ready');
}

main().catch((e: unknown) => {
  log('fatal', 'worker failed to start', { err: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
