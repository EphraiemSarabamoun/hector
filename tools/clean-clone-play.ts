/** Prove the committed main branch installs and finishes a Hector game from npm run play. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(process.cwd());
// Each invocation supplies its own unused scratch directory; never replace existing data.
const scratchArgument = process.argv.indexOf('--scratch');
if (scratchArgument < 0 || !process.argv[scratchArgument + 1])
  throw new Error('Provide --scratch with an unused absolute clone directory');
const scratch = resolve(process.argv[scratchArgument + 1]);
if (!process.argv[scratchArgument + 1].startsWith('/') || scratch === root)
  throw new Error('Scratch must be a separate absolute directory');
const logPath = join(root, 'runs/clean-clone-play.log');
let created = false;
let server: ChildProcess | undefined;
let serverClosed: Promise<void> | undefined;
let serverError: Error | undefined;
let serverOutput = '';
let log = '';
/** Run an owned child and capture its exact output for the verification artifact. */
async function command(
  file: string,
  args: string[],
  cwd: string,
  env = process.env,
): Promise<void> {
  log += `\n$ ${file} ${args.join(' ')}\n`;
  await new Promise<void>((done, fail) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => {
      log += String(b);
    });
    child.stderr.on('data', (b) => {
      log += String(b);
    });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`${file} exited ${code}`))));
  });
}
/** Refuse to confuse an unrelated live server with the fresh clone's own listener. */
async function requireFreePort(): Promise<void> {
  await new Promise<void>((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(5173, '127.0.0.1', () => probe.close((error) => (error ? fail(error) : done())));
  });
}
try {
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (branch !== 'main') throw new Error('Run from the main branch');
  try {
    await access(scratch);
    throw new Error('Scratch path already exists; refusing to replace it');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(join(root, 'runs'), { recursive: true });
  await requireFreePort();
  await mkdir(scratch);
  created = true;
  await command(
    'git',
    ['clone', '--no-local', '--single-branch', '--branch', 'main', root, scratch],
    root,
  );
  await command('npm', ['ci'], scratch);
  server = spawn('npm', ['run', 'play'], {
    cwd: scratch,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Cache completion immediately; finally must also work when startup has already failed.
  serverClosed = new Promise<void>((done) => {
    server!.once('close', () => done());
    server!.once('error', (error) => {
      serverError = error;
      done();
    });
  });
  const capture = (chunk: Buffer) => {
    log += String(chunk);
    serverOutput += String(chunk);
  };
  server.stdout?.on('data', capture);
  server.stderr?.on('data', capture);
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    if (serverError) throw serverError;
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error(`play exited ${server.exitCode ?? server.signalCode}`);
    try {
      const response = await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(1000) });
      if (
        response.ok &&
        serverOutput.includes('http://127.0.0.1:5173') &&
        (await response.text()) === (await readFile(join(scratch, 'dist/index.html'), 'utf8'))
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error('npm run play did not serve Dardania');
  await command(
    'npm',
    ['run', 'smoke', '--', 'tests/browser/full-game.spec.ts', '--grep', 'dom-game-1'],
    scratch,
    { ...process.env, DARDANIA_PLAY_BASE_URL: 'http://127.0.0.1:5173' },
  );
  const games = JSON.parse(await readFile(join(scratch, 'runs/dom-games.json'), 'utf8'));
  if (games.games?.length !== 1 || games.games[0].winner < 0)
    throw new Error('Fresh clone did not record a finished game');
  await writeFile(join(root, 'runs/clean-clone-games.json'), JSON.stringify(games, null, 2) + '\n');
  await writeFile(
    join(root, 'runs/clean-clone-browser-results.json'),
    await readFile(join(scratch, 'runs/browser-results.json')),
  );
  log += '\nPASS: fresh npm ci + npm run play, real Hector game finished.\n';
} finally {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await serverClosed;
  }
  // Only this invocation's newly created scratch clone is removed.
  if (created) await rm(scratch, { recursive: true, force: true });
  await writeFile(logPath, log);
}
