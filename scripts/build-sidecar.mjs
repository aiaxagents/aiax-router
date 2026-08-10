#!/usr/bin/env node
/**
 * Builds the board server into one self-contained executable, so the desktop
 * app runs without the user installing Node or the CLI.
 *
 * Three steps, all stock tooling:
 *   1. Fetch the official Node build for the target, checksum-verified. It has
 *      to be the official one: single executable applications are disabled in
 *      shared-library builds (Homebrew's, for one), and a Homebrew Node links
 *      against dylibs that do not exist on anyone else's machine.
 *   2. esbuild bundles dist/cli/index.js (ESM, zero runtime deps) into a single
 *      CommonJS file, because single executable applications only take CommonJS.
 *   3. `node --experimental-sea-config` turns that file into a blob and postject
 *      injects it into a copy of the fetched Node binary.
 *
 * The result is named for the Rust target triple, which is what Tauri wants of
 * an `externalBin` sidecar.
 */
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src-tauri', 'binaries');
const WORK = join(ROOT, 'dist-sidecar');
// Outside the work directory, which is wiped on every build.
const CACHE = join(ROOT, 'node_modules', '.cache', 'aiax-sidecar-node');
const NAME = 'aiax-router-server';

/** Whatever Node runs this script, unless told otherwise. */
const NODE_VERSION = process.env.AIAX_SIDECAR_NODE ?? `v${process.versions.node}`;

const TRIPLE_TO_NODE = {
  'aarch64-apple-darwin': ['darwin', 'arm64'],
  'x86_64-apple-darwin': ['darwin', 'x64'],
  'x86_64-unknown-linux-gnu': ['linux', 'x64'],
  'aarch64-unknown-linux-gnu': ['linux', 'arm64'],
  'x86_64-pc-windows-msvc': ['win', 'x64'],
  'aarch64-pc-windows-msvc': ['win', 'arm64'],
};

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

/** `rustc -vV` is the only authority on what Tauri will look for. */
function targetTriple() {
  if (process.env.AIAX_TARGET_TRIPLE) return process.env.AIAX_TARGET_TRIPLE;
  const host = /^host:\s*(\S+)$/m.exec(capture('rustc', ['-vV']))?.[1];
  if (!host) throw new Error('Could not read the target triple from `rustc -vV`.');
  return host;
}

function hostNodeKey() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return [process.platform === 'win32' ? 'win' : process.platform, arch];
}

/**
 * Downloads and unpacks one official Node build, verifying it against the
 * release's own SHASUMS256.txt. Returns the path to the `node` executable.
 */
function fetchNode(platform, arch) {
  const base = `node-${NODE_VERSION}-${platform}-${arch}`;
  const archive = `${base}.${platform === 'win' ? 'zip' : 'tar.gz'}`;
  const dir = join(CACHE, base);
  const exe = platform === 'win' ? join(dir, 'node.exe') : join(dir, 'bin', 'node');
  if (existsSync(exe)) return exe;

  const url = `https://nodejs.org/dist/${NODE_VERSION}`;
  mkdirSync(CACHE, { recursive: true });
  const tarball = join(CACHE, archive);
  console.log(`Fetching ${url}/${archive}`);
  run('curl', ['-fsSL', '-o', tarball, `${url}/${archive}`]);

  const sums = capture('curl', ['-fsSL', `${url}/SHASUMS256.txt`]);
  const want = new RegExp(`^(\\w{64})\\s+\\*?${archive.replace(/\./g, '\\.')}$`, 'm').exec(sums)?.[1];
  if (!want) throw new Error(`${archive} is not listed in SHASUMS256.txt for ${NODE_VERSION}.`);
  const got = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  if (got !== want) throw new Error(`Checksum mismatch for ${archive}: ${got} != ${want}`);

  // bsdtar unpacks both .tar.gz and .zip, and ships on macOS, Linux and Windows.
  run('tar', ['-xf', tarball, '-C', CACHE]);
  rmSync(tarball, { force: true });
  if (!existsSync(exe)) throw new Error(`No node executable at ${exe} after unpacking.`);
  chmodSync(exe, 0o755);
  return exe;
}

const triple = targetTriple();
const nodeTarget = TRIPLE_TO_NODE[triple];
if (!nodeTarget) throw new Error(`No official Node build is mapped for ${triple}.`);
const isWindows = triple.includes('windows');
const exe = join(OUT_DIR, `${NAME}-${triple}${isWindows ? '.exe' : ''}`);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const baseNode = fetchNode(...nodeTarget);
// The blob is target independent, but it has to be produced by a Node that has
// single executable applications compiled in, which rules out Homebrew's.
const hostKey = hostNodeKey();
const builderNode =
  hostKey[0] === nodeTarget[0] && hostKey[1] === nodeTarget[1] ? baseNode : fetchNode(...hostKey);

// --- 1. bundle ---------------------------------------------------------------
// `import.meta.url` has no meaning in CommonJS, so rewrite it to the equivalent
// expression rather than leave esbuild's empty-object shim behind. The JS API,
// not the `.bin` launcher: on Windows that launcher is a shell script and
// spawning it directly fails, while the API finds the right binary everywhere.
buildSync({
  entryPoints: [join(ROOT, 'dist', 'cli', 'index.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  banner: { js: 'const AIAX_IMPORT_META_URL = require("node:url").pathToFileURL(__filename).href;' },
  define: { 'import.meta.url': 'AIAX_IMPORT_META_URL' },
  outfile: join(WORK, 'server.cjs'),
  logLevel: 'info',
});

writeFileSync(
  join(WORK, 'sea-config.json'),
  `${JSON.stringify(
    {
      main: join(WORK, 'server.cjs'),
      output: join(WORK, 'server.blob'),
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  )}\n`,
);

// --- 2. blob -----------------------------------------------------------------
run(builderNode, ['--experimental-sea-config', join(WORK, 'sea-config.json')]);

// --- 3. inject ---------------------------------------------------------------
rmSync(exe, { force: true });
copyFileSync(baseNode, exe);
chmodSync(exe, 0o755);
if (nodeTarget[0] === 'darwin') {
  // A signed binary rejects a new section, so drop the ad-hoc signature first
  // and put one back afterwards, or macOS kills the process on launch.
  run('codesign', ['--remove-signature', exe]);
}

run(process.execPath, [
  join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
  exe,
  'NODE_SEA_BLOB',
  join(WORK, 'server.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(nodeTarget[0] === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);

if (nodeTarget[0] === 'darwin') run('codesign', ['--sign', '-', exe]);

// The sidecar is a Node binary with our code inside it, so Node's own MIT
// notice travels with it.
copyFileSync(
  join(CACHE, `node-${NODE_VERSION}-${nodeTarget[0]}-${nodeTarget[1]}`, 'LICENSE'),
  join(OUT_DIR, 'NODE_LICENSE.txt'),
);

console.log(`\nSidecar: ${exe} (${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB)`);
