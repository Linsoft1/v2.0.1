const net = require('node:net');

const CERTIFICATE_ERROR_REASONS = Object.freeze({
  'net::ERR_CERT_AUTHORITY_INVALID': 'Certifikačná autorita certifikátu nie je dôveryhodná.',
  'net::ERR_CERT_COMMON_NAME_INVALID': 'Názov v certifikáte sa nezhoduje s adresou zariadenia.',
  'net::ERR_CERT_DATE_INVALID': 'Certifikát ešte nie je platný alebo jeho platnosť vypršala.',
  'net::ERR_CERT_REVOKED': 'Certifikát bol zrušený jeho vydavateľom.',
  'net::ERR_CERT_INVALID': 'Certifikát je neplatný alebo poškodený.',
  'net::ERR_CERT_WEAK_SIGNATURE_ALGORITHM': 'Certifikát používa zastaraný podpisový algoritmus.',
  'net::ERR_CERT_WEAK_KEY': 'Certifikát používa príliš slabý šifrovací kľúč.',
  'net::ERR_CERT_CONTAINS_ERRORS': 'Certifikát obsahuje chyby a nemožno ho bezpečne overiť.',
  'net::ERR_CERT_NO_REVOCATION_MECHANISM': 'Nie je možné overiť, či bol certifikát zrušený.'
});

function isLocalCertificateHost(value) {
  let host;
  try {
    host = new URL(String(value || '')).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  const addressType = net.isIP(host);
  if (addressType === 4) return isLocalIpv4(host);
  if (addressType !== 6) return false;
  if (host === '::1') return true;
  if (/^(?:fc|fd)/.test(host)) return true;
  if (/^fe[89ab]/.test(host)) return true;
  const mappedIpv4 = host.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  if (mappedIpv4) return isLocalIpv4(mappedIpv4);
  const mappedHex = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!mappedHex) return false;
  const high = Number.parseInt(mappedHex[1], 16);
  const low = Number.parseInt(mappedHex[2], 16);
  return isLocalIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
}

function isLocalIpv4(host) {
  if (net.isIP(host) !== 4) return false;
  const parts = host.split('.').map(Number);
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function safeCertificateText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 500) : '';
}

function formatCertificateDate(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function getCertificateWarningDetails({ url, error, certificate = {} } = {}) {
  let parsedUrl;
  const certificateInfo = certificate && typeof certificate === 'object' ? certificate : {};
  try {
    parsedUrl = new URL(String(url || ''));
  } catch {
    parsedUrl = new URL('https://neznama-adresa.invalid/');
  }
  const errorCode = safeCertificateText(error) || 'net::ERR_CERT_INVALID';
  return {
    address: parsedUrl.origin.slice(0, 300),
    hostname: parsedUrl.hostname,
    reason: CERTIFICATE_ERROR_REASONS[errorCode] || 'Linsoft Browser nedokázal overiť pravosť certifikátu.',
    errorCode,
    subject: safeCertificateText(certificateInfo.subjectName),
    issuer: safeCertificateText(certificateInfo.issuerName),
    validFrom: formatCertificateDate(certificateInfo.validStart),
    validTo: formatCertificateDate(certificateInfo.validExpiry),
    fingerprint: safeCertificateText(certificateInfo.fingerprint256 || certificateInfo.fingerprint)
  };
}

module.exports = { getCertificateWarningDetails, isLocalCertificateHost };
