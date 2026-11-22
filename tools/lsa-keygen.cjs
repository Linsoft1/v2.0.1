// Creates the Ed25519 key that signs Linsoft .lsa packages.
// The private key stays outside the repository (default: ~/.linsoft/lsa-signing-key.pem);
// the public key is added to runtime/trusted-keys.json so Linsoft Runtime trusts it.
//
//   node tools/lsa-keygen.cjs [--key <path>] [--name "Linsoft"]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { publicKeyId } = require('../runtime/lib/lsa-format.cjs');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const keyPath = path.resolve(argument('--key', process.env.LINSOFT_LSA_KEY || path.join(os.homedir(), '.linsoft', 'lsa-signing-key.pem')));
const name = argument('--name', 'Linsoft');
const trustedPath = path.join(__dirname, '..', 'runtime', 'trusted-keys.json');

let privateKeyPem;
if (fs.existsSync(keyPath)) {
  console.log(`Používam existujúci kľúč: ${keyPath}`);
  privateKeyPem = fs.readFileSync(keyPath, 'utf8');
} else {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600, flag: 'wx' });
  console.log(`Vytvorený nový súkromný kľúč: ${keyPath}`);
  console.log('DÔLEŽITÉ: zálohuj tento súbor. Bez neho už nevydáš aktualizáciu, ktorej nainštalované runtime uverí.');
}

const publicKeyPem = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' });
const keyId = publicKeyId(publicKeyPem);
let trusted = { keys: [] };
try { trusted = JSON.parse(fs.readFileSync(trustedPath, 'utf8')); } catch {}
if (!Array.isArray(trusted.keys)) trusted.keys = [];
if (trusted.keys.some((key) => key.keyId === keyId)) {
  console.log(`Verejný kľúč ${keyId} už je v runtime/trusted-keys.json.`);
} else {
  trusted.keys.push({ keyId, name, publicKey: publicKeyPem });
  fs.writeFileSync(trustedPath, `${JSON.stringify(trusted, null, 2)}\n`);
  console.log(`Verejný kľúč ${keyId} pridaný do runtime/trusted-keys.json.`);
}
