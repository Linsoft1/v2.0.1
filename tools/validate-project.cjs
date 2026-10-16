const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = ['app.js', 'main.cjs', 'preload.cjs', path.join('lib', 'browser-policies.cjs'), path.join('lib', 'google-signin.cjs'), path.join('lib', 'native-tab-manager.cjs'), path.join('lib', 'permission-handlers.cjs'), path.join('lib', 'tab-state.js'), path.join('tools', 'smoke-electron.cjs'), path.join('Linsoft centrum app', 'app.js')];
files.push(path.join('lib', 'certificate-approval.cjs'));
files.push(path.join('lib', 'certificate-warning.cjs'));
files.push(path.join('lib', 'usb-camera-devices.js'));
files.push(path.join('lib', 'search-page-preload.cjs'));
files.push(path.join('lib', 'page-activity-preload.cjs'));
files.push(path.join('lib', 'overlay-dismiss-preload.cjs'));
files.push(path.join('lib', 'browser-algorithms.js'));
files.push(path.join('lib', 'debian-updates.cjs'));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Syntax error in ${file}: ${result.stderr || result.stdout}`);
}
const mainSource = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
const ipcHandlers = [...mainSource.matchAll(/\bipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
const duplicateIpcHandlers = [...new Set(ipcHandlers.filter((channel, index) => ipcHandlers.indexOf(channel) !== index))];
if (duplicateIpcHandlers.length) throw new Error(`Duplicate IPC handlers in main.cjs: ${duplicateIpcHandlers.join(', ')}`);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const browserName = 'Linsoft Browser';
if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
  throw new Error('package.json and package-lock.json versions do not match');
}
if (packageJson.productName !== browserName || packageJson.build.productName !== browserName) {
  throw new Error('Linsoft Browser product names are inconsistent in package.json');
}
if (packageJson.build.appId !== 'sk.linsoft.browser' || packageJson.homepage !== 'https://github.com/Linsoft1/v2.0.1') {
  throw new Error('Linsoft Browser package identity or project homepage is inconsistent');
}
if (!mainSource.includes(`const browserName = '${browserName}';`) || !mainSource.includes('app.setName(browserName)')) {
  throw new Error('Electron core application name is not Linsoft Browser');
}
if (!mainSource.includes(`app.setAppUserModelId('${packageJson.build.appId}')`)) {
  throw new Error('Windows application identity is not aligned with the package appId');
}
const browserPage = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (!browserPage.includes(`<title>${browserName}</title>`)) throw new Error('Browser window title is not Linsoft Browser');
if (!browserPage.includes('assets/linsoft-icon.svg')) throw new Error('Browser window is missing the Linsoft Browser favicon');
const browserSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
if (!browserSource.includes(`App Centrum · ${browserName}`)) throw new Error('Integrated App Center is missing the Linsoft Browser identity');
const appCenterPage = fs.readFileSync(path.join(root, 'Linsoft centrum app', 'index.html'), 'utf8');
if (!appCenterPage.includes(`<title>${browserName} – App Centrum</title>`)) throw new Error('Standalone App Center title is not branded as Linsoft Browser');
if (!appCenterPage.includes('../assets/linsoft-icon.svg')) throw new Error('Standalone App Center is missing the Linsoft Browser logo');
const appCenterSource = fs.readFileSync(path.join(root, 'Linsoft centrum app', 'app.js'), 'utf8');
for (const serviceUrl of ['https://linsoft.ddns.net/linsoft-chat/', 'https://linsoft.ddns.net/linsoft-offiece/']) {
  if (!appCenterSource.includes(serviceUrl)) throw new Error(`App Center is missing a Linsoft service: ${serviceUrl}`);
}
const websitePage = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
if (!websitePage.includes(`<title>${browserName} ${packageJson.version}`) || !websitePage.includes(`• v${packageJson.version}`)) {
  throw new Error('Linsoft Browser website version does not match package.json');
}
if (!websitePage.includes('images/linsoft-icon.svg') || !fs.existsSync(path.join(root, 'docs', 'images', 'linsoft-icon.svg'))) {
  throw new Error('Linsoft Browser website is missing its logo or favicon');
}
if (!websitePage.includes('id="sluzby"') || !websitePage.includes('https://linsoft.ddns.net/linsoft-chat/') || !websitePage.includes('https://linsoft.ddns.net/linsoft-offiece/')) {
  throw new Error('Linsoft website is missing the Linsoft Chat and Linsoft Office services');
}
for (const serviceLogo of ['linsoft-chat.svg', 'linsoft-office.svg']) {
  if (!websitePage.includes(`images/${serviceLogo}`) || !fs.existsSync(path.join(root, 'docs', 'images', serviceLogo))) {
    throw new Error(`Linsoft website is missing a service logo: ${serviceLogo}`);
  }
}
const preloadSource = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
if (!preloadSource.includes(`appName: '${browserName}'`)) throw new Error('Preload application name is not Linsoft Browser');
const desktopEntry = fs.readFileSync(path.join(root, 'packaging', 'linsoft-browser.desktop'), 'utf8');
if (!desktopEntry.includes(`Name=${browserName}`)) throw new Error('Linux desktop application name is not Linsoft Browser');
const mimeTypeLine = desktopEntry.match(/^MimeType=(.+)$/m)?.[1] || '';
if (!mimeTypeLine.split(';').includes('application/pdf')) throw new Error('Linux desktop application is not associated with PDF documents');
const iconPath = path.join(root, 'assets', 'linsoft-icon.ico');
const icon = fs.readFileSync(iconPath);
if (icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1) throw new Error('Windows application icon is not a valid ICO file');
const iconCount = icon.readUInt16LE(4);
const iconSizes = Array.from({ length: iconCount }, (_, index) => {
  const offset = 6 + index * 16;
  return `${icon[offset] || 256}x${icon[offset + 1] || 256}`;
});
for (const size of ['16x16', '24x24', '32x32', '48x48', '64x64', '128x128', '256x256']) {
  if (!iconSizes.includes(size)) throw new Error(`Windows application icon is missing the ${size} resolution`);
}
for (const asset of ['assets/linsoft-icon.svg', packageJson.build.win.icon, packageJson.build.linux.icon]) {
  if (!fs.existsSync(path.join(root, asset))) throw new Error(`Missing branded application icon: ${asset}`);
}
if (packageJson.license !== 'MIT') throw new Error('Linsoft source code must declare its MIT license');
if (!fs.existsSync(path.join(root, 'LICENSE')) || !packageJson.build.files.includes('LICENSE')) {
  throw new Error('MIT license file is missing from the repository or packaged application');
}
const protocols = packageJson.build?.protocols || [];
const hasLinsoftProtocol = protocols.some((entry) => entry.schemes?.includes('linsoft'));
if (!hasLinsoftProtocol) throw new Error('Missing linsoft protocol registration');
if (!packageJson.build.files.includes('lib/**/*')) throw new Error('Browser policy module is missing from packaged files');
if (!packageJson.build.files.includes('Linsoft centrum app/**/*')) throw new Error('Standalone App Centrum is missing from packaged files');
if (!packageJson.build.files.includes('styles.css')) throw new Error('In-tab certificate warning styles are missing from packaged files');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
if (!styles.includes('.certificate-warning-overlay')) throw new Error('In-tab certificate warning styles are missing');
if (!fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8').includes("onCertificateWarning:")) {
  throw new Error('In-tab certificate warning bridge is missing from the preload');
}
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
