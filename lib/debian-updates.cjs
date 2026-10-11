const releaseApiUrl = 'https://api.github.com/repos/Linsoft1/v2.0.1/releases/latest';
const releaseBaseUrl = 'https://github.com/Linsoft1/v2.0.1/releases';

function versionParts(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Neplatná verzia aktualizácie.');
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Neplatná verzia aktualizácie.');
  return parts;
}

function getDebianUpdateStatus(currentVersion, release, arch) {
  const current = versionParts(currentVersion);
  if (!release || release.draft !== false || release.prerelease !== false) throw new Error('Nie je dostupné platné stabilné vydanie.');
  const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
  const latest = versionParts(version);
  const difference = latest.findIndex((part, index) => part !== current[index]);
  if (difference === -1 || latest[difference] < current[difference]) return { status: 'latest', version: currentVersion };
  const architecture = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!architecture) throw new Error('Pre túto architektúru nie je dostupný Debian balík.');
  const name = `Linsoft-Browser-${version}-${architecture}.deb`;
  const downloadUrl = `${releaseBaseUrl}/download/v${version}/${name}`;
  if (!Array.isArray(release.assets) || !release.assets.some((asset) => asset.name === name && asset.browser_download_url === downloadUrl && asset.state === 'uploaded')) {
    throw new Error('Nové vydanie zatiaľ neobsahuje Debian balík pre túto architektúru.');
  }
  return { status: 'available', version, manualInstall: true, downloadUrl };
}

async function checkDebianUpdate(currentVersion, arch, fetchRelease) {
  const response = await fetchRelease(releaseApiUrl, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Linsoft-Browser' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Kontrola aktualizácií na GitHube zlyhala (HTTP ${response.status}).`);
  return getDebianUpdateStatus(currentVersion, await response.json(), arch);
}

module.exports = { checkDebianUpdate, getDebianUpdateStatus };
