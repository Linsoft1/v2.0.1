const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const appDir = path.join(root, 'dist-debian-final', 'linux-unpacked');
const output = path.join(root, 'dist-debian-final', `Linsoft-Browser-${version}-amd64.deb`);
const desktopSource = path.join(root, 'packaging', 'linsoft-browser.desktop');
const iconSource = path.join(root, 'assets', 'linsoft-icon-256.png');

function fail(message) {
  throw new Error(message);
}

function octal(value, length) {
  const text = value.toString(8).padStart(length - 1, '0');
  return Buffer.from(text + '\0', 'ascii');
}

function tarHeader(name, size, mode, type, linkname) {
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
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  octal(checksum, 8).copy(header, 148);
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

function collectDirectory(directory, prefix, entries) {
  const names = fs.readdirSync(directory).sort();
  for (const name of names) {
    const absolute = path.join(directory, name);
    const stat = fs.lstatSync(absolute);
    const archiveName = `${prefix}/${name}`;
    if (stat.isDirectory()) {
      entries.push({ name: `${archiveName}/`, type: '5', mode: stat.mode & 0o7777 });
      collectDirectory(absolute, archiveName, entries);
    } else if (stat.isSymbolicLink()) {
      entries.push({ name: archiveName, type: '2', mode: 0o777, linkname: fs.readlinkSync(absolute) });
    } else if (stat.isFile()) {
      entries.push({ name: archiveName, type: '0', mode: stat.mode & 0o7777, data: fs.readFileSync(absolute) });
    } else {
      fail(`Unsupported filesystem entry: ${absolute}`);
    }
  }
}

function arMember(name, data) {
  const header = Buffer.alloc(60, 0x20);
  Buffer.from(name).copy(header, 0, 0, Math.min(name.length, 16));
  Buffer.from('0').copy(header, 16);
  Buffer.from('0').copy(header, 28);
  Buffer.from('100644').copy(header, 40);
  Buffer.from(String(data.length)).copy(header, 48);
  header[58] = 0x60;
  header[59] = 0x0a;
  return data.length % 2 ? Buffer.concat([header, data, Buffer.from('\n')]) : Buffer.concat([header, data]);
}

function validateAr(buffer) {
  if (buffer.subarray(0, 8).toString('ascii') !== '!<arch>\n') fail('Output is not an ar archive');
  let offset = 8;
  const members = [];
  while (offset < buffer.length) {
    if (offset + 60 > buffer.length) fail('Truncated ar member header');
    const header = buffer.subarray(offset, offset + 60);
    if (header.subarray(58, 60).toString('ascii') !== '`\n') fail(`Invalid ar member terminator at ${offset}: ${header.subarray(58, 60).toString('hex')}`);
    const size = Number(header.subarray(48, 58).toString('ascii').trim());
    const name = header.subarray(0, 16).toString('ascii').trim();
    const dataStart = offset + 60;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) fail('Truncated ar member data');
    members.push({ name, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + (size % 2);
  }
  if (offset !== buffer.length) fail('Invalid ar member padding');
  if (members.map(member => member.name).join(',') !== 'debian-binary,control.tar.gz,data.tar.gz') fail('Unexpected Debian members');
  return members;
}

function validateTarGz(data, requiredNames) {
  const tar = zlib.gunzipSync(data);
  const names = new Set();
  for (let offset = 0; offset + 512 <= tar.length;) {
    if (tar.subarray(offset, offset + 512).every(byte => byte === 0)) break;
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').trim() || '0', 8);
    names.add(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const name of requiredNames) if (!names.has(name)) fail(`Missing archive entry: ${name}`);
  return names.size;
}

if (!fs.existsSync(appDir)) fail(`Missing unpacked app: ${appDir}`);
if (!fs.existsSync(iconSource)) fail(`Missing icon: ${iconSource}`);

const desktop = fs.readFileSync(desktopSource, 'utf8').replace(
  'Exec=/opt/Linsoft Browser/linsoft-browser %U',
  'Exec="/opt/Linsoft Browser/linsoft-browser" %U'
);
const dataEntries = [];
dataEntries.push({ name: 'opt/', type: '5', mode: 0o755 });
dataEntries.push({ name: 'opt/Linsoft Browser/', type: '5', mode: 0o755 });
collectDirectory(appDir, 'opt/Linsoft Browser', dataEntries);
dataEntries.push({ name: 'usr/', type: '5', mode: 0o755 });
dataEntries.push({ name: 'usr/share/', type: '5', mode: 0o755 });
dataEntries.push({ name: 'usr/share/applications/', type: '5', mode: 0o755 });
dataEntries.push({ name: 'usr/share/applications/linsoft-browser.desktop', data: Buffer.from(desktop, 'utf8') });
dataEntries.push({ name: 'usr/share/icons/', type: '5', mode: 0o755 });
dataEntries.push({ name: 'usr/share/icons/hicolor/', type: '5', mode: 0o755 });
dataEntries.push({ name: 'usr/share/icons/hicolor/256x256/', type: '5', mode: 0o755 });
dataEntries.push({ name: 'usr/share/icons/hicolor/256x256/apps/', type: '5', mode: 0o755 });
dataEntries.push({ name: 'usr/share/icons/hicolor/256x256/apps/linsoft-browser.png', data: fs.readFileSync(iconSource) });

const payloadBytes = dataEntries.reduce((sum, entry) => sum + (entry.data ? entry.data.length : 0), 0);
const installedSize = Math.ceil(payloadBytes / 1024);
const md5Lines = dataEntries.filter(entry => entry.type !== '5' && entry.data).map(entry => `${crypto.createHash('md5').update(entry.data).digest('hex')}  ${entry.name.replace(/^\.\//, '')}`);
const control = [
  'Package: linsoft-browser',
  `Version: ${version}`,
  'Section: net',
  'Priority: optional',
  'Architecture: amd64',
  'Installed-Size: ' + installedSize,
  'Maintainer: Martin Pastorek <support@linsoft.local>',
  'Description: Modern web browser from Linsoft',
  ' A desktop web browser built with Electron.',
  ''
].join('\n');
const controlArchive = tarArchive([
  { name: './', type: '5', mode: 0o755 },
  { name: './control', data: Buffer.from(control, 'utf8') },
  { name: './md5sums', data: Buffer.from(md5Lines.join('\n') + '\n', 'utf8') }
]);
const dataArchive = tarArchive(dataEntries.map(entry => ({ ...entry, name: `./${entry.name}` })));
const deb = Buffer.concat([
  Buffer.from('!<arch>\n', 'ascii'),
  arMember('debian-binary', Buffer.from('2.0\n', 'ascii')),
  arMember('control.tar.gz', zlib.gzipSync(controlArchive, { mtime: 0 })),
  arMember('data.tar.gz', zlib.gzipSync(dataArchive, { mtime: 0 }))
]);

fs.writeFileSync(output, deb);
const members = validateAr(deb);
const controlNames = validateTarGz(members[1].data, ['./', './control', './md5sums']);
const dataNames = validateTarGz(members[2].data, ['./opt/Linsoft Browser/', './usr/share/applications/linsoft-browser.desktop', './usr/share/icons/hicolor/256x256/apps/linsoft-browser.png']);
console.log(JSON.stringify({ output, bytes: deb.length, members: members.map(member => ({ name: member.name, bytes: member.data.length })), controlEntries: controlNames, dataEntries: dataNames }, null, 2));
