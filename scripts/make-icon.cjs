const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico');

const root = path.resolve(__dirname, '..');
const svgPath = path.join(root, 'assets', 'linsoft-icon.svg');
const pngPath = path.join(root, 'assets', 'linsoft-icon-256.png');
const icoPath = path.join(root, 'assets', 'linsoft-icon.ico');
const iconBuildDir = path.join(root, 'assets', '.icon-build');
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  await sharp(svgPath).resize(256, 256).png().toFile(pngPath);
  fs.mkdirSync(iconBuildDir, { recursive: true });
  const iconPaths = await Promise.all(iconSizes.map(async (size) => {
    const output = path.join(iconBuildDir, `linsoft-icon-${size}.png`);
    await sharp(svgPath).resize(size, size).png().toFile(output);
    return output;
  }));
  const ico = await pngToIco(iconPaths);
  fs.writeFileSync(icoPath, ico);
  fs.rmSync(iconBuildDir, { recursive: true, force: true });
  console.log(`Created ${icoPath}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
