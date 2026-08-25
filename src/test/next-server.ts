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
  lastOtpCode: () => string | undefined;
  stop: () => Promise<void>;
}

export async function startNextServer(port = 3123): Promise<TestServer> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    APP_URL: `http://localhost:${port}`,
    PLATFORM_HOST: 'admin.localhost',
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    SMS_PROVIDER: 'mock',
    TZ: 'Asia/Dhaka',
  };

  const child: ChildProcessWithoutNullStreams = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'next', 'start', '-p', String(port)],
    { env, stdio: 'pipe', shell: process.platform === 'win32' },
  );

  let buffer = '';
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
    lastOtpCode: () => {
      // { "level":"info", "msg":"otp.dispatch.mock", "to":"+880…", "code":"123456" }
      const matches = [...buffer.matchAll(/"msg":"otp\.dispatch\.mock"[^}]*"code":"(\d{6})"/g)];
      return matches.at(-1)?.[1];
    },
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
