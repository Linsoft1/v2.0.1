const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = ['app.js', 'main.cjs', 'preload.cjs', path.join('Linsoft centrum app', 'app.js')];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Syntax error in ${file}: ${result.stderr || result.stdout}`);
}
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const protocols = packageJson.build?.protocols || [];
const hasLinsoftProtocol = protocols.some((entry) => entry.schemes?.includes('linsoft'));
if (!hasLinsoftProtocol) throw new Error('Missing linsoft protocol registration');
if (!packageJson.build.files.includes('Linsoft centrum app/**/*')) throw new Error('Standalone App Centrum is missing from packaged files');
const standaloneFiles = ['index.html', 'styles.css', 'app.js'];
for (const file of standaloneFiles) {
  if (!fs.existsSync(path.join(root, 'Linsoft centrum app', file))) throw new Error(`Missing App Centrum file: ${file}`);
}
const standalone = fs.readFileSync(path.join(root, 'Linsoft centrum app', 'app.js'), 'utf8');
if (!standalone.includes('linsoft://install')) throw new Error('App Centrum install handoff is missing');
if (!standalone.includes('linsoft://uninstall')) throw new Error('App Centrum uninstall handoff is missing');
console.log(JSON.stringify({ status: 'ok', syntaxFiles: files.length, standaloneFiles: standaloneFiles.length, protocol: 'linsoft', installerScript: 'build:installer' }, null, 2));
