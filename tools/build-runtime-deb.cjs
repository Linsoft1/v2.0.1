// Builds dist-runtime/Linsoft-Runtime-<version>-amd64.deb without fpm (works on Windows).
//
//   npm run build:runtime:linux     (runs electron-builder --dir, then this script)
//
// Installs to /opt/Linsoft Runtime, adds /usr/bin/linsoft-runtime, a desktop entry and the
// application/x-linsoft-runtime-package MIME type so double-clicking an .lsr file opens Linsoft Runtime.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'package.json'), 'utf8')).version;
const appDir = path.join(root, 'dist-runtime', 'linux-unpacked');
const output = path.join(root, 'dist-runtime', `Linsoft-Runtime-${version}-amd64.deb`);
const installDir = 'opt/Linsoft Runtime';
const executableModes = new Map([
  ['linsoft-runtime', 0o755],
  ['chrome-sandbox', 0o4755],
  ['chrome_crashpad_handler', 0o755]
]);

function fail(message) { throw new Error(message); }

function octal(value, length) {
  return Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii');
}

function tarHeader(name, size, mode, type, linkname) {
  if (Buffer.byteLength(name) > 100) fail(`Path too long for tar: ${name}`);
  const header = Buffer.alloc(512, 0);
  const write = (offset, length, value) => Buffer.from(value, 'utf8').copy(header, offset, 0, length);
  write(0, 100, name);
  octal(mode, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  write(156, 1, type);
  write(157, 100, linkname || '');
  write(257, 6, 'ustar\0');
  write(263, 2, '00');
  write(265, 32, 'root');
  write(297, 32, 'root');
  octal(header.reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148);
  return header;
}

function tarArchive(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = entry.data || Buffer.alloc(0);
    const type = entry.type || '0';
    chunks.push(tarHeader(entry.name, type === '0' ? data.length : 0, entry.mode || (type === '5' ? 0o755 : 0o644), type, entry.linkname));
    if (type === '0' && data.length) {
      chunks.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function arMember(name, data) {
  const header = Buffer.alloc(60, 0x20);
  Buffer.from(name).copy(header, 0);
  Buffer.from('0').copy(header, 16);
  Buffer.from('0').copy(header, 28);
  Buffer.from('100644').copy(header, 40);
  Buffer.from(String(data.length)).copy(header, 48);
  header[58] = 0x60;
  header[59] = 0x0a;
  return data.length % 2 ? Buffer.concat([header, data, Buffer.from('\n')]) : Buffer.concat([header, data]);
}

function directories(entries, fullPath) {
  const parts = fullPath.split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i += 1) {
    const name = `${parts.slice(0, i).join('/')}/`;
    if (!entries.some((entry) => entry.name === name)) entries.push({ name, type: '5', mode: 0o755 });
  }
}

function collectDirectory(directory, prefix, entries) {
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const stat = fs.lstatSync(absolute);
    const archiveName = `${prefix}/${name}`;
    if (stat.isDirectory()) {
      entries.push({ name: `${archiveName}/`, type: '5', mode: 0o755 });
      collectDirectory(absolute, archiveName, entries);
    } else if (stat.isSymbolicLink()) {
      entries.push({ name: archiveName, type: '2', mode: 0o777, linkname: fs.readlinkSync(absolute) });
    } else if (stat.isFile()) {
      const relative = path.relative(appDir, absolute).split(path.sep).join('/');
      const mode = executableModes.get(relative) ?? (/\.so(\.\d+)*$/.test(name) ? 0o755 : 0o644);
      entries.push({ name: archiveName, type: '0', mode, data: fs.readFileSync(absolute) });
    }
  }
}

if (!fs.existsSync(appDir)) fail(`Missing ${path.relative(root, appDir)} – run electron-builder --linux --dir first`);
for (const executable of executableModes.keys()) if (!fs.existsSync(path.join(appDir, executable))) fail(`Missing Linux executable: ${executable}`);

const desktop = [
  '[Desktop Entry]',
  'Name=Linsoft Browser (LSR)',
  'GenericName=Linsoft Runtime',
  'Comment=Spúšťa Linsoft Browser a aplikácie z podpísaných balíkov .lsr',
  `Exec="/${installDir}/linsoft-runtime" %F`,
  'Icon=linsoft-runtime',
  'Terminal=false',
  'Type=Application',
  'Categories=Network;WebBrowser;',
  'MimeType=application/x-linsoft-runtime-package;',
  'StartupWMClass=Linsoft Browser',
  ''
].join('\n');
const mimeXml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">',
  '  <mime-type type="application/x-linsoft-runtime-package">',
  '    <comment>Linsoft Runtime balík</comment>',
  '    <glob pattern="*.lsr"/>',
  '  </mime-type>',
  '</mime-info>',
  ''
].join('\n');
const postinst = [
  '#!/bin/sh',
  'set -e',
  'if command -v update-mime-database >/dev/null 2>&1; then update-mime-database /usr/share/mime || true; fi',
  'if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi',
  'if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi',
  'exit 0',
  ''
].join('\n');

const entries = [];
directories(entries, installDir);
collectDirectory(appDir, installDir, entries);
directories(entries, 'usr/bin');
entries.push({ name: 'usr/bin/linsoft-runtime', type: '2', mode: 0o777, linkname: `/${installDir}/linsoft-runtime` });
directories(entries, 'usr/share/applications');
entries.push({ name: 'usr/share/applications/linsoft-runtime.desktop', data: Buffer.from(desktop) });
directories(entries, 'usr/share/mime/packages');
entries.push({ name: 'usr/share/mime/packages/linsoft-runtime.xml', data: Buffer.from(mimeXml) });
directories(entries, 'usr/share/icons/hicolor/256x256/apps');
entries.push({ name: 'usr/share/icons/hicolor/256x256/apps/linsoft-runtime.png', data: fs.readFileSync(path.join(root, 'assets', 'linsoft-icon-256.png')) });
directories(entries, 'usr/share/icons/hicolor/256x256/mimetypes');
entries.push({ name: 'usr/share/icons/hicolor/256x256/mimetypes/application-x-linsoft-runtime-package.png', data: fs.readFileSync(path.join(root, 'assets', 'linsoft-icon-256.png')) });

const payloadBytes = entries.reduce((sum, entry) => sum + (entry.data ? entry.data.length : 0), 0);
const md5sums = entries.filter((entry) => entry.type !== '5' && entry.type !== '2' && entry.data).map((entry) => `${crypto.createHash('md5').update(entry.data).digest('hex')}  ${entry.name}`).join('\n');
const control = [
  'Package: linsoft-runtime',
  `Version: ${version}`,
  'Section: net',
  'Priority: optional',
  'Architecture: amd64',
  `Installed-Size: ${Math.ceil(payloadBytes / 1024)}`,
  'Maintainer: Martin Pastorek <support@linsoft.local>',
  'Description: Linsoft Runtime – installs and runs signed .lsr packages',
  ' Verifies, installs and starts Linsoft Browser and other Linsoft',
  ' applications distributed as signed .lsr packages.',
  ''
].join('\n');

const controlArchive = tarArchive([
  { name: './', type: '5', mode: 0o755 },
  { name: './control', data: Buffer.from(control) },
  { name: './md5sums', data: Buffer.from(`${md5sums}\n`) },
  { name: './postinst', data: Buffer.from(postinst), mode: 0o755 }
]);
const dataArchive = tarArchive([{ name: './', type: '5', mode: 0o755 }, ...entries.map((entry) => ({ ...entry, name: `./${entry.name}` }))]);
const deb = Buffer.concat([
  Buffer.from('!<arch>\n', 'ascii'),
  arMember('debian-binary', Buffer.from('2.0\n', 'ascii')),
  arMember('control.tar.gz', zlib.gzipSync(controlArchive, { mtime: 0 })),
  arMember('data.tar.gz', zlib.gzipSync(dataArchive, { mtime: 0, level: 9 }))
]);
fs.writeFileSync(output, deb);
console.log(`Vytvorený ${path.relative(root, output)} (${(deb.length / 1048576).toFixed(1)} MB, ${entries.length} položiek)`);
