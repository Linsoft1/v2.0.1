const { isLocalCertificateHost } = require('./certificate-warning.cjs');

function secureHost(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['https:', 'wss:'].includes(url.protocol)) return '';
    return url.hostname.toLowerCase();
  } catch {
    return '';
  }
}

class CertificateApprovalRegistry {
  constructor() {
    this.approvals = new Map();
  }

  approve(webContentsId, url) {
    const host = secureHost(url);
    if (!Number.isInteger(webContentsId) || !host || !isLocalCertificateHost(url)) return false;
    this.approvals.set(webContentsId, host);
    return true;
  }

  allows(webContentsId, url) {
    const host = secureHost(url);
    return Boolean(host && isLocalCertificateHost(url) && this.approvals.get(webContentsId) === host);
  }

  clear(webContentsId) {
    this.approvals.delete(webContentsId);
  }
}

module.exports = { CertificateApprovalRegistry };
