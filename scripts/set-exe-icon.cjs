const path = require('node:path');
const { rcedit } = require('rcedit');

module.exports = async function setExecutableIcon(context) {
  if (context.electronPlatformName !== 'win32') return;
  const executablePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, 'assets', 'linsoft-icon.ico');
  await rcedit(executablePath, { icon: iconPath });
  console.log(`Embedded Linsoft icon in ${executablePath}`);
};
