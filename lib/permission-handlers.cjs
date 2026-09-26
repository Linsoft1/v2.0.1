function mediaTypesFromDetails(details = {}) {
  if (Array.isArray(details.mediaTypes)) return details.mediaTypes;
  return details.mediaType ? [details.mediaType] : [];
}

function createPermissionCheckHandler(resolveDecision) {
  return (_webContents, permission, requestingOrigin, details = {}) => {
    return resolveDecision({ permission, requestingUrl: requestingOrigin, mediaTypes: mediaTypesFromDetails(details) })?.decision === 'allow';
  };
}

function createPermissionRequestHandler(requestPermission) {
  return (webContents, permission, callback, details = {}) => {
    let responded = false;
    const respond = (allowed) => {
      if (responded) return;
      responded = true;
      callback(Boolean(allowed));
    };
    Promise.resolve(requestPermission(webContents, permission, respond, details)).catch(() => respond(false));
  };
}

module.exports = { createPermissionCheckHandler, createPermissionRequestHandler, mediaTypesFromDetails };