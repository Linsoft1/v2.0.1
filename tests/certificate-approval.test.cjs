const test = require('node:test');
const assert = require('node:assert/strict');
const { CertificateApprovalRegistry } = require('../lib/certificate-approval.cjs');

test('certificate approval permits same-device HTTPS and WSS resources in one tab', () => {
  const approvals = new CertificateApprovalRegistry();
  assert.equal(approvals.approve(12, 'https://192.168.2.2/'), true);
  assert.equal(approvals.allows(12, 'https://192.168.2.2/static/app.js'), true);
  assert.equal(approvals.allows(12, 'wss://192.168.2.2/socket'), true);
  assert.equal(approvals.allows(12, 'https://192.168.2.2:443/api'), true);
});

test('certificate approval is isolated by tab and local device across its secure service ports', () => {
  const approvals = new CertificateApprovalRegistry();
  approvals.approve(12, 'https://192.168.2.2/');
  assert.equal(approvals.allows(13, 'https://192.168.2.2/static/app.js'), false);
  assert.equal(approvals.allows(12, 'https://192.168.2.3/static/app.js'), false);
  assert.equal(approvals.allows(12, 'https://192.168.2.2:8443/api'), true);
  assert.equal(approvals.allows(12, 'wss://192.168.2.2:8043/socket'), true);
  assert.equal(approvals.allows(12, 'https://router.local:8443/api'), false);
  assert.equal(approvals.allows(12, 'https://example.com/app.js'), false);
  assert.equal(approvals.approve(12, 'https://example.com/'), false);
});

test('certificate approval is cleared when its tab leaves the device', () => {
  const approvals = new CertificateApprovalRegistry();
  approvals.approve(12, 'https://router.local/');
  approvals.clear(12);
  assert.equal(approvals.allows(12, 'https://router.local/app.js'), false);
});

test('certificate approval accepts link-local IPv6 resources and rejects insecure schemes', () => {
  const approvals = new CertificateApprovalRegistry();
  assert.equal(approvals.approve(12, 'https://[fe80::1]/'), true);
  assert.equal(approvals.allows(12, 'https://[fe80::1]/app.js'), true);
  assert.equal(approvals.approve(12, 'http://192.168.2.2/'), false);
  assert.equal(approvals.allows(12, 'http://192.168.2.2/app.js'), false);
});
