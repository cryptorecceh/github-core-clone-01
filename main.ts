// github-core-clone-01 entrypoint.
// Starts the forge as ONE process, then follows the make.fun trial lifecycle:
// bind an ephemeral port, register it with the environment, long-poll /done,
// and exit 0 when the trial ends. Without MAKEFUN_ENV_URL (local development)
// it just serves on port 18080 until stopped.
import { createForge } from './server.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const server = createForge();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function register(port: number): Promise<void> {
  const url = `${ENV_URL}/register`;
  let backoff = 250;
  for (;;) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.ok) return;
    } catch {
      // retry below
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 2000);
  }
}

async function waitDone(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`);
      if (res.ok) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // keep polling
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  if (ENV_URL === '') {
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(18080, '127.0.0.1', () => {
        console.log('forge listening on http://127.0.0.1:18080 (local mode, no MAKEFUN_ENV_URL)');
        resolve();
      });
    });
    return;
  }
  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('listen failed'));
    });
  });
  await register(port);
  await waitDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

await main();
