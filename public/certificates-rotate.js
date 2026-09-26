// Pure rotation math shared by the certificate upload UI (public/index.html)
// and its Node test (test/certificates-rotate.test.js). No DOM/canvas here —
// keeping this file dependency-free lets the 90-degree-step math be verified
// with plain node:test, without pulling in a canvas/jsdom package.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CertRotate = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function normalizeRotation(deg) {
    return ((Math.round(deg) % 360) + 360) % 360;
  }
  function isSwapped(deg) {
    return normalizeRotation(deg) % 180 !== 0;
  }
  function rotatedCanvasSize(width, height, deg) {
    return isSwapped(deg) ? { width: height, height: width } : { width: width, height: height };
  }
  return { normalizeRotation: normalizeRotation, isSwapped: isSwapped, rotatedCanvasSize: rotatedCanvasSize };
});
