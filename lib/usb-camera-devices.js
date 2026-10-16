(function exposeUsbCameraDevices(root) {
  function getVideoInputIds(devices) {
    if (!Array.isArray(devices)) return [];
    return [...new Set(devices
      .filter((device) => device?.kind === 'videoinput' && typeof device.deviceId === 'string' && device.deviceId)
      .map((device) => device.deviceId))];
  }

  function getNewVideoInputs(previousDeviceIds, devices) {
    const knownIds = new Set(Array.isArray(previousDeviceIds) ? previousDeviceIds : []);
    if (!Array.isArray(devices)) return [];
    return devices.filter((device) => device?.kind === 'videoinput'
      && typeof device.deviceId === 'string'
      && device.deviceId
      && !knownIds.has(device.deviceId));
  }

  const api = { getNewVideoInputs, getVideoInputIds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LinsoftUsbCameraDevices = api;
})(typeof globalThis === 'undefined' ? null : globalThis);
