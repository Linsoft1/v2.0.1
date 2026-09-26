const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const version = require(path.resolve(__dirname, '..', 'package.json')).version;

const file = process.env.LINSOFT_DEB_FILE ? path.resolve(process.env.LINSOFT_DEB_FILE) : path.resolve(__dirname, '..', 'dist-debian-final', `Linsoft-Browser-${version}-amd64.deb`);
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
const data = zlib.gunzipSync(members[2].data).toString();
for (const required of ['Package: linsoft-browser', `Version: ${version}`, 'Architecture: amd64']) {
  if (!control.includes(required)) throw new Error(`missing control field: ${required}`);
}
for (const required of ['./usr/share/applications/linsoft-browser.desktop', './usr/share/icons/hicolor/256x256/apps/linsoft-browser.png', './opt/Linsoft Browser/linsoft-browser']) {
  if (!data.includes(required)) throw new Error(`missing data path: ${required}`);
}
const stat = fs.statSync(file);
console.log(JSON.stringify({ path: file, bytes: stat.size, sizeMiB: (stat.size / 1048576).toFixed(2), members: members.map(member => `${member.name} (${member.data.length} bytes)`), status: 'valid Debian ar archive with control.tar.gz and data.tar.gz' }, null, 2));
