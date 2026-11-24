'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { requireMsvcEnv } = require('./msvc-env');
const { preparePrebuilt } = require('./native-voice-prebuilt');

const targets = process.argv.slice(2);
const cargoArgs = targets[0] === '--cargo' ? targets.slice(1) : null;
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log('Skipping Windows x64 native voice helper.');
  process.exit(0);
}
if (!cargoArgs && targets.length && !targets.some((target) => ['win', '--win'].includes(target))) {
  process.exit(0);
}

const root = path.join(__dirname, '..');
const cwd = path.join(root, 'native', 'voice');
const env = { ...requireMsvcEnv('Windows native voice helper') };
const localCargo = path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe');
const cargo = fs.existsSync(localCargo) ? localCargo : 'cargo.exe';
if (path.isAbsolute(cargo)) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
  env[pathKey] = [path.dirname(cargo), env[pathKey]].filter(Boolean).join(path.delimiter);
}
async function build() {
  if (cargoArgs?.[0] !== 'fmt') await preparePrebuilt(cwd);
  const result = spawnSync(cargo, cargoArgs || ['build', '--release', '--locked'], {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status || 1;
    return;
  }
  if (!cargoArgs) {
    const target = env.CARGO_TARGET_DIR ? path.resolve(cwd, env.CARGO_TARGET_DIR) : path.join(cwd, 'target');
    const output = path.join(root, 'native', 'bin', 'windows');
    fs.mkdirSync(output, { recursive: true });
    const file = path.join(output, 'VoiceRoomVoice.exe');
    fs.copyFileSync(path.join(target, 'x86_64-pc-windows-msvc', 'release', 'voiceroom-voice.exe'), file);
    console.log(`Built VoiceRoomVoice.exe (${fs.statSync(file).size} bytes).`);
  }
}

build().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
