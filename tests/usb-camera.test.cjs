const test = require('node:test');
const assert = require('node:assert/strict');
const { getNewVideoInputs, getVideoInputIds } = require('../lib/usb-camera-devices.js');

test('USB camera monitoring tracks only distinct video input devices', () => {
  const devices = [
    { kind: 'videoinput', deviceId: 'built-in', label: 'Integrated Camera' },
    { kind: 'audioinput', deviceId: 'microphone' },
    { kind: 'videoinput', deviceId: 'usb-camera', label: 'USB Camera' },
    { kind: 'videoinput', deviceId: 'usb-camera', label: 'USB Camera duplicate' },
    { kind: 'videoinput', deviceId: '' }
  ];
  assert.deepEqual(getVideoInputIds(devices), ['built-in', 'usb-camera']);
});

test('USB camera monitoring reports only newly attached video devices', () => {
  const builtIn = { kind: 'videoinput', deviceId: 'built-in', label: 'Integrated Camera' };
  const usbCamera = { kind: 'videoinput', deviceId: 'usb-camera', label: 'USB Camera' };
  const microphone = { kind: 'audioinput', deviceId: 'microphone' };
  assert.deepEqual(getNewVideoInputs(['built-in'], [builtIn, usbCamera, microphone]), [usbCamera]);
  assert.deepEqual(getNewVideoInputs(['built-in', 'usb-camera'], [builtIn, usbCamera]), []);
  assert.deepEqual(getNewVideoInputs([], null), []);
});
