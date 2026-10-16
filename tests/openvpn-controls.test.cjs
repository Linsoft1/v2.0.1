const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.on('openvpn-connect'");
  const end = source.indexOf("ipcMain.handle('openvpn-status'", start);
  assert.ok(start >= 0 && end > start, 'OpenVPN IPC handlers must exist');
  const handlers = new Map();
  const processes = [];
  const messages = [];
  const context = {
    require,
    console,
    openVpnProcess: null,
    openVpnProfile: '',
    openVpnStatus: { status: 'disconnected', message: '' },
    openVpnExecutable: () => 'controlled-openvpn.exe',
    ipcMain: { on: (name, callback) => handlers.set(name, callback) },
    sendVpnStatus(status, message) {
      messages.push({ status, message });
      if (status !== 'log') context.openVpnStatus = { status, message };
    },
    spawn(executable, args) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killCalls = 0;
      child.kill = () => { child.killCalls += 1; return true; };
      child.args = args;
      processes.push(child);
      return child;
    }
  };
  vm.runInNewContext(source.slice(start, end), context, { filename: 'main.cjs' });
  return {
    context, processes, messages,
    connect: (profile = 'controlled-profile.ovpn') => handlers.get('openvpn-connect')({}, profile),
    disconnect: () => handlers.get('openvpn-disconnect')()
  };
}

test('OpenVPN refuses missing profiles and duplicate connections', () => {
  const app = createHarness();
  app.connect('');
  assert.equal(app.context.openVpnStatus.status, 'error');
  assert.equal(app.processes.length, 0);
  app.connect();
  app.connect();
  assert.equal(app.processes.length, 1);
  assert.equal(app.context.openVpnStatus.status, 'connecting');
  assert.deepEqual(Array.from(app.processes[0].args), ['--config', 'controlled-profile.ovpn']);
  app.processes[0].stdout.emit('data', 'Initialization Sequence Completed');
  assert.equal(app.context.openVpnStatus.status, 'connected');
});

test('OpenVPN cancellation waits for exit and ignores late connection confirmation', () => {
  const app = createHarness();
  app.connect();
  const child = app.processes[0];
  app.disconnect();
  app.disconnect();
  assert.equal(child.killCalls, 1);
  assert.equal(app.context.openVpnProcess, child);
  child.stdout.emit('data', 'Initialization Sequence Completed');
  child.stderr.emit('data', 'Controlled disconnect log');
  assert.equal(app.context.openVpnStatus.status, 'disconnecting');
  child.emit('exit', 1);
  assert.equal(app.context.openVpnProcess, null);
  assert.equal(app.context.openVpnStatus.status, 'disconnected');
});

test('OpenVPN failed kill preserves active state and allows another disconnect', () => {
  const app = createHarness();
  app.connect();
  const child = app.processes[0];
  child.kill = () => false;
  app.disconnect();
  assert.equal(app.context.openVpnStatus.status, 'connecting');
  assert.match(app.context.openVpnStatus.message, /nepodarilo/);
  assert.equal(app.context.openVpnProcess, child);
  child.kill = () => { child.killCalls += 1; return true; };
  app.disconnect();
  assert.equal(child.killCalls, 1);
  assert.equal(app.context.openVpnStatus.status, 'disconnecting');
});

test('OpenVPN ignores stale process events and reports current process failure', () => {
  const app = createHarness();
  app.connect();
  const old = app.processes[0];
  old.emit('exit', 0);
  app.connect();
  const current = app.processes[1];
  old.stdout.emit('data', 'Initialization Sequence Completed');
  old.stderr.emit('data', 'Stale log');
  old.emit('error', new Error('Stale error'));
  old.emit('exit', 1);
  assert.equal(app.context.openVpnStatus.status, 'connecting');
  assert.equal(app.context.openVpnProcess, current);
  current.emit('error', Object.assign(new Error('Controlled missing executable'), { code: 'ENOENT' }));
  assert.equal(app.context.openVpnProcess, null);
  assert.equal(app.context.openVpnStatus.status, 'error');
  assert.match(app.context.openVpnStatus.message, /nenašiel/);
});
