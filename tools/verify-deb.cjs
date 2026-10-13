const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const file = path.join(root, 'dist-debian-final', `Linsoft-Browser-${version}-amd64.deb`);
const archive = fs.readFileSync(file);
if (archive.subarray(0, 8).toString() !== '!<arch>\n') throw new Error('missing ar magic');
let offset = 8;
const members = [];
while (offset < archive.length) {
  const header = archive.subarray(offset, offset + 60);
  if (header.length !== 60 || header.subarray(58, 60).toString() !== '`\n') throw new Error(`invalid ar header at ${offset}`);
  const size = Number(header.subarray(48, 58).toString().trim());
  const name = header.subarray(0, 16).toString().trim();
  const data = archive.subarray(offset + 60, offset + 60 + size);
  members.push({ name, data });
  offset += 60 + size + (size % 2);
}
if (offset !== archive.length) throw new Error('invalid ar length');
if (members[0].data.toString() !== '2.0\n') throw new Error('invalid debian-binary');
const control = zlib.gunzipSync(members[1].data).toString();
const dataTar = zlib.gunzipSync(members[2].data);
const data = dataTar.toString();
for (const required of ['Package: linsoft-browser', `Version: ${version}`, 'Architecture: amd64']) {
  if (!control.includes(required)) throw new Error(`missing control field: ${required}`);
}
for (const required of ['./usr/share/applications/linsoft-browser.desktop', './usr/share/icons/hicolor/256x256/apps/linsoft-browser.png', './opt/Linsoft Browser/linsoft-browser']) {
  if (!data.includes(required)) throw new Error(`missing data path: ${required}`);
}
const dataModes = new Map();
for (let dataOffset = 0; dataOffset + 512 <= dataTar.length;) {
  if (dataTar.subarray(dataOffset, dataOffset + 512).every(byte => byte === 0)) break;
  const header = dataTar.subarray(dataOffset, dataOffset + 512);
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const mode = parseInt(header.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim(), 8);
  const size = parseInt(header.subarray(124, 136).toString('ascii').trim() || '0', 8);
  dataModes.set(name, mode);
  dataOffset += 512 + Math.ceil(size / 512) * 512;
}
for (const [name, modeMask] of Object.entries({
  './opt/Linsoft Browser/linsoft-browser': 0o755,
  './opt/Linsoft Browser/chrome-sandbox': 0o4755,
  './opt/Linsoft Browser/chrome_crashpad_handler': 0o755
})) {
  if (!dataModes.has(name) || (dataModes.get(name) & modeMask) !== modeMask) {
    throw new Error(`incorrect executable permissions: ${name}`);
  }
}
if (!data.includes('MimeType=application/pdf;')) throw new Error('desktop entry is not associated with PDF documents');
const stat = fs.statSync(file);
console.log(JSON.stringify({ path: file, bytes: stat.size, sizeMiB: (stat.size / 1048576).toFixed(2), members: members.map(member => `${member.name} (${member.data.length} bytes)`), status: 'valid Debian ar archive with control.tar.gz and data.tar.gz' }, null, 2));
