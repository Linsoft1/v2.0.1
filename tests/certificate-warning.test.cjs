const test = require('node:test');
const assert = require('node:assert/strict');
const { getCertificateWarningDetails, isLocalCertificateHost } = require('../lib/certificate-warning.cjs');

test('certificate warning shows a safe address without credentials or query secrets', () => {
  const details = getCertificateWarningDetails({
    url: 'https://user:password@192.168.0.1:8443/admin?token=secret#section',
    error: 'net::ERR_CERT_AUTHORITY_INVALID'
  });
  assert.equal(details.address, 'https://192.168.0.1:8443');
  assert.equal(details.hostname, '192.168.0.1');
  assert.equal(details.reason, 'Certifikačná autorita certifikátu nie je dôveryhodná.');
  assert.equal(details.address.includes('secret'), false);
  assert.equal(details.address.includes('password'), false);
  assert.equal(details.address.includes('/admin'), false);
});

test('certificate warning is limited to local, private, and link-local destinations', () => {
  for (const url of [
    'https://localhost',
    'https://printer.local',
    'https://192.168.0.1',
    'https://[::1]',
    'https://[fd12::1]',
    'https://[fe80::1]',
    'https://[::ffff:192.168.0.1]',
    'https://[::ffff:c0a8:1]'
  ]) assert.equal(isLocalCertificateHost(url), true, url);
  for (const url of ['https://example.com', 'https://8.8.8.8', 'https://100.100.1.2', 'https://[2001:4860:4860::8888]', 'https://[::ffff:808:808]', 'not a URL']) {
    assert.equal(isLocalCertificateHost(url), false, url);
  }
});

test('certificate warning includes bounded technical certificate details', () => {
  const details = getCertificateWarningDetails({
    url: 'https://router.local/',
    error: 'net::ERR_CERT_DATE_INVALID',
    certificate: {
      subjectName: 'router.local',
      issuerName: 'Local CA',
      validStart: 1_800_000_000,
      validExpiry: 1_900_000_000,
      fingerprint256: 'AB:CD'
    }
  });
  assert.equal(details.subject, 'router.local');
  assert.equal(details.issuer, 'Local CA');
  assert.equal(details.validFrom, '2027-01-15T08:00:00.000Z');
  assert.equal(details.validTo, '2030-03-17T17:46:40.000Z');
  assert.equal(details.fingerprint, 'AB:CD');
  assert.equal(details.errorCode, 'net::ERR_CERT_DATE_INVALID');
});

test('unknown or malformed certificate fields fail safely', () => {
  const details = getCertificateWarningDetails({ url: 'not a URL', error: 'unexpected' });
  assert.equal(details.hostname, 'neznama-adresa.invalid');
  assert.equal(details.reason, 'Linsoft Browser nedokázal overiť pravosť certifikátu.');
  assert.equal(details.validFrom, '');
  assert.equal(details.fingerprint, '');
});
