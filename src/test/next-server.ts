/**
 * Boots the built Next server for HTTP-level tests.
 *
 * `next start` in a child process rather than an in-process handler: the point
 * of these tests is to go through the real server, so anything that stubs it
 * out defeats them.
 *
 * Server stdout is captured because the mock OTP dispatcher logs the code
 * there. That is how the test learns the code without production code growing
 * a test hook — the log line already exists for developers.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface TestServer {
  url: string;
  /** Everything the server has written to stdout so far. */
  output: () => string;
  /**
   * The next OTP code the server logs, waiting for it to arrive.
   *
   * Not a snapshot read: the child's stdout is a pipe, and on Windows it goes
   * through a cmd.exe shim as well, so the code routinely lands a few
   * milliseconds AFTER the HTTP response that triggered it. Reading the buffer
   * straight after the request passes on Linux and fails here — which looks
   * like "OTP is broken" and is not.
   *
   * Each call consumes what it returns, so a later test cannot pick up an
   * earlier test's code and pass against the wrong challenge.
   */
  waitForOtpCode: (timeoutMs?: number) => Promise<string>;
  stop: () => Promise<void>;
}

export async function startNextServer(port = 3123): Promise<TestServer> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    /**
     * `test`, not `production`, even though this serves a production build.
     *
     * `otpDispatcher()` refuses SMS_PROVIDER=mock when NODE_ENV=production —
     * a mock dispatcher in production means guardians silently never receive a
     * code, and it looks like "OTP is broken" for weeks. The guard is correct;
     * claiming production here would be the harness lying about what it is.
     * `next start` serves the built output regardless of this value.
     */
    NODE_ENV: 'test',
    PORT: String(port),
    APP_URL: `http://localhost:${port}`,
    PLATFORM_HOST: 'admin.localhost',
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    SMS_PROVIDER: 'mock',
    TZ: 'Asia/Dhaka',
  };

  /*
   * Refuse to run against a server this function did not start.
   *
   * The readiness poll below cannot tell "my server came up" from "something
   * was already listening", so without this check a leftover server answers
   * every request — from a STALE BUILD, with rate-limit counters already part
   * used. The suite then fails with 404s and 429s that describe the old
   * process, not the code under test. Ninety minutes, once.
   */
  try {
    const stray = await fetch(`http://localhost:${port}/api/v1/health`);
    if (stray.ok) {
      throw new Error(
        `Port ${port} is already serving. A previous run was probably not shut ` +
          `down cleanly. Stop it and try again — on Windows:
` +
          `  netstat -ano | findstr :${port}
` +
          `  taskkill /PID <pid> /T /F`,
      );
    }
  } catch (e) {
    // A refused connection is the expected, healthy case.
    if (e instanceof Error && e.message.startsWith(`Port ${port}`)) throw e;
  }

  const child: ChildProcessWithoutNullStreams = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'next', 'start', '-p', String(port)],
    { env, stdio: 'pipe', shell: process.platform === 'win32' },
  );

  let buffer = '';
  /** How many logged codes have already been handed to a caller. */
  let consumedCodes = 0;
  child.stdout.on('data', (d: Buffer) => (buffer += d.toString()));
  child.stderr.on('data', (d: Buffer) => (buffer += d.toString()));

  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 120_000;

  // Poll a real endpoint rather than trusting a "ready" line: the log appears
  // before the routes are actually servable.
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited early (${child.exitCode}):\n${buffer}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`next start did not become ready in time:\n${buffer}`);
    }
    try {
      const res = await fetch(`${url}/api/v1/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    url,
    output: () => buffer,
    waitForOtpCode: async (timeoutMs = 15_000) => {
      // { "level":"info", "msg":"otp.dispatch.mock", "to":"+880…", "code":"123456" }
      const codes = (): string[] =>
        [...buffer.matchAll(/"msg":"otp\.dispatch\.mock"[^}]*"code":"(\d{6})"/g)].map(
          (m) => m[1]!,
        );

      const until = Date.now() + timeoutMs;
      for (;;) {
        const all = codes();
        if (all.length > consumedCodes) {
          consumedCodes = all.length;
          return all.at(-1)!;
        }
        if (Date.now() > until) {
          throw new Error(
            'The mock dispatcher logged no OTP code. Either the request never ' +
              'reached it, or SMS_PROVIDER is not `mock` in the server process.',
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    stop: async () => {
      /*
       * `shell: true` is required to spawn `pnpm.cmd`, which means `child` is
       * cmd.exe and `next start` is its GRANDCHILD. Signalling the shell kills
       * the shell and orphans the server — it keeps the port, the next run
       * attaches to it, and the failures make no sense. `taskkill /T` takes
       * the tree.
       */
      if (process.platform === 'win32' && child.pid !== undefined) {
        await new Promise<void>((resolve) => {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
          }).on('close', () => resolve());
        });
      }
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
