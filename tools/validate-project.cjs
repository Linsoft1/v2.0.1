const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = ['app.js', 'main.cjs', 'preload.cjs', path.join('lib', 'browser-policies.cjs'), path.join('lib', 'google-signin.cjs'), path.join('lib', 'native-tab-manager.cjs'), path.join('lib', 'permission-handlers.cjs'), path.join('lib', 'tab-state.js'), path.join('tools', 'smoke-electron.cjs'), path.join('Linsoft centrum app', 'app.js')];
files.push(path.join('lib', 'search-page-preload.cjs'));
files.push(path.join('lib', 'page-activity-preload.cjs'));
files.push(path.join('lib', 'browser-algorithms.js'));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Syntax error in ${file}: ${result.stderr || result.stdout}`);
}
const mainSource = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
const ipcHandlers = [...mainSource.matchAll(/\bipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
const duplicateIpcHandlers = [...new Set(ipcHandlers.filter((channel, index) => ipcHandlers.indexOf(channel) !== index))];
if (duplicateIpcHandlers.length) throw new Error(`Duplicate IPC handlers in main.cjs: ${duplicateIpcHandlers.join(', ')}`);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const browserName = 'Linsoft Browser';
if (packageJson.productName !== browserName || packageJson.build.productName !== browserName) {
  throw new Error('Linsoft Browser product names are inconsistent in package.json');
}
if (!mainSource.includes(`const browserName = '${browserName}';`) || !mainSource.includes('app.setName(browserName)')) {
  throw new Error('Electron core application name is not Linsoft Browser');
}
const browserPage = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (!browserPage.includes(`<title>${browserName}</title>`)) throw new Error('Browser window title is not Linsoft Browser');
if (!browserPage.includes(`App Centrum · ${browserName}`)) throw new Error('Integrated App Center is missing the Linsoft Browser identity');
const appCenterPage = fs.readFileSync(path.join(root, 'Linsoft centrum app', 'index.html'), 'utf8');
if (!appCenterPage.includes(`<title>${browserName} – App Centrum</title>`)) throw new Error('Standalone App Center title is not branded as Linsoft Browser');
const preloadSource = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
if (!preloadSource.includes(`appName: '${browserName}'`)) throw new Error('Preload application name is not Linsoft Browser');
const desktopEntry = fs.readFileSync(path.join(root, 'packaging', 'linsoft-browser.desktop'), 'utf8');
if (!desktopEntry.includes(`Name=${browserName}`)) throw new Error('Linux desktop application name is not Linsoft Browser');
if (packageJson.license !== 'MIT') throw new Error('Linsoft source code must declare its MIT license');
if (!fs.existsSync(path.join(root, 'LICENSE')) || !packageJson.build.files.includes('LICENSE')) {
  throw new Error('MIT license file is missing from the repository or packaged application');
}
const protocols = packageJson.build?.protocols || [];
const hasLinsoftProtocol = protocols.some((entry) => entry.schemes?.includes('linsoft'));
if (!hasLinsoftProtocol) throw new Error('Missing linsoft protocol registration');
if (!packageJson.build.files.includes('lib/**/*')) throw new Error('Browser policy module is missing from packaged files');
if (!packageJson.build.files.includes('Linsoft centrum app/**/*')) throw new Error('Standalone App Centrum is missing from packaged files');
const installerScript = fs.readFileSync(path.join(root, 'packaging', 'installer.nsh'), 'utf8');
if (!installerScript.includes('FriendlyAppName') || !installerScript.includes('SupportedTypes') || !installerScript.includes('SHChangeNotify')) {
  throw new Error('Windows Open With registration for Linsoft Browser is incomplete');
}
const standaloneFiles = ['index.html', 'styles.css', 'app.js'];
for (const file of standaloneFiles) {
  if (!fs.existsSync(path.join(root, 'Linsoft centrum app', file))) throw new Error(`Missing App Centrum file: ${file}`);
}
const standalone = fs.readFileSync(path.join(root, 'Linsoft centrum app', 'app.js'), 'utf8');
if (!standalone.includes('linsoft://install')) throw new Error('App Centrum install handoff is missing');
if (!standalone.includes('linsoft://uninstall')) throw new Error('App Centrum uninstall handoff is missing');
console.log(JSON.stringify({ status: 'ok', syntaxFiles: files.length, standaloneFiles: standaloneFiles.length, protocol: 'linsoft', installerScript: 'build:installer' }, null, 2));
