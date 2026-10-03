const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronPath = require('electron');
const appPath = path.resolve(process.argv[2] || '.');
const electronArgs = [appPath, ...process.argv.slice(3)];

async function prepareWindowsExecutable() {
  const packageInfo = require('../package.json');
  const outputDirectory = path.dirname(electronPath);
  const outputPath = path.join(outputDirectory, 'Linsoft Browser.exe');
  const markerPath = path.join(outputDirectory, 'build-info.json');
  const sourceStats = fs.statSync(electronPath);
  const buildInfo = { version: packageInfo.version, size: sourceStats.size, modifiedAt: sourceStats.mtimeMs };
  let previousBuildInfo = null;
  try { previousBuildInfo = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch {}

  fs.mkdirSync(outputDirectory, { recursive: true });
  if (!fs.existsSync(outputPath) || JSON.stringify(previousBuildInfo) !== JSON.stringify(buildInfo)) {
    fs.copyFileSync(electronPath, outputPath);
    const { rcedit } = require('rcedit');
    await rcedit(outputPath, {
      'version-string': {
        CompanyName: 'Linsoft',
        FileDescription: 'Linsoft Browser',
        InternalName: 'Linsoft Browser',
        OriginalFilename: 'Linsoft Browser.exe',
        ProductName: 'Linsoft Browser'
      },
      'file-version': packageInfo.version,
      'product-version': packageInfo.version
    });
    fs.writeFileSync(markerPath, JSON.stringify(buildInfo), 'utf8');
  }
  return outputPath;
}

async function main() {
  const executablePath = process.platform === 'win32' ? await prepareWindowsExecutable() : electronPath;
  const child = spawn(executablePath, electronArgs, {
    stdio: 'inherit',
    windowsHide: false,
    env: { ...process.env, LINSOFT_DEV_LAUNCH: '1' }
  });
  child.on('error', (error) => {
    console.error(`Linsoft Browser sa nepodarilo spustiť: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}

main().catch((error) => {
  console.error(`Linsoft Browser sa nepodarilo pripraviť: ${error.message}`);
  process.exitCode = 1;
});