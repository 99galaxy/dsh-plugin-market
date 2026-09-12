// Run a child process and capture its output WITHOUT pipes and WITHOUT a shell.
//
// Why not the obvious ways:
//   - `execFileSync` / `spawnSync` with default stdio use NAMED PIPES, which DSH's
//     confined sandbox modes deny (EPERM). Tests run in that sandbox.
//   - `shell: true` with `>` redirection works, but the shell re-parses every
//     argument — and one of our arguments is an install spec taken from a remote
//     catalog, so that would be a command-injection hole.
//
// Handing the child plain FILE DESCRIPTORS avoids both, and also removes any risk of
// a full pipe buffer deadlocking the parent.
import { spawnSync } from 'node:child_process'
import { mkdirSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RUN_DIR = join(here, '.runs')
let seq = 0

function newRunFiles () {
  mkdirSync(RUN_DIR, { recursive: true })
  seq += 1
  const tag = Date.now().toString(36) + '-' + seq
  return { out: join(RUN_DIR, tag + '.out'), err: join(RUN_DIR, tag + '.err') }
}

function readAndClean (files) {
  const read = (p) => { try { return readFileSync(p, 'utf8') } catch (e) { return '' } }
  const stdout = read(files.out)
  const stderr = read(files.err)
  try { rmSync(files.out, { force: true }) } catch (e) { /* best effort */ }
  try { rmSync(files.err, { force: true }) } catch (e) { /* best effort */ }
  return { stdout, stderr }
}

/**
 * Run `command` with `args`, capturing stdout/stderr through file descriptors.
 * @returns {{status: number|null, error: Error|null, stdout: string, stderr: string}}
 */
export function runCaptureSync (command, args, options = {}) {
  const files = newRunFiles()
  let ofd = 0
  let efd = 0
  let r
  try {
    ofd = openSync(files.out, 'w')
    efd = openSync(files.err, 'w')
    r = spawnSync(command, args || [], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', ofd, efd],
      timeout: options.timeoutMs,
    })
  } finally {
    if (ofd !== 0) closeSync(ofd)
    if (efd !== 0) closeSync(efd)
  }
  const io = readAndClean(files)
  return {
    status: r === undefined ? null : r.status,
    error: r === undefined ? null : r.error,
    stdout: io.stdout,
    stderr: io.stderr,
  }
}

/** True when this environment can spawn a child at all (with file-descriptor stdio). */
export function canSpawn () {
  const r = runCaptureSync(process.execPath, ['-e', 'console.log("ok")'])
  return r.status === 0 && r.stdout.includes('ok')
}
