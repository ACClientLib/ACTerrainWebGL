const labels = {
  minZoom: "minZoom",
  maxZoom: "maxZoom",
  minZoomForTextures: "minZoomForTextures",
  showLandcellLines: "showLandcellLines",
  showLandblockLines: "showLandblockLines",
  badWireframe: "badWireframe",
  showDebug: "showDebug",
  showObjects: "showObjects",
  showServerSpawns: "showServerSpawns",
  showParticles: "showParticles",
  minZoomFor3DObjects: "minZoomFor3DObjects",
  renderQuality: "renderQuality",
  sceneryEnabled: "sceneryEnabled",
};

const data = {
  minZoom: 0.002,
  maxZoom: 1000,
  minZoomForTextures: 0.02,
  showLandcellLines: false,
  showLandblockLines: false,
  badWireframe: false,
  showDebug: false,
  showObjects: true,
  showServerSpawns: true,
  showParticles: true,
  minZoomFor3DObjects: 0.25,
  maxRenderQuality: 10,
  minRenderQuality: 1,
  renderQuality: 10,
  sceneryEnabled: true,
  get renderScale() {
    return data.maxRenderQuality + 1 - data.renderQuality;
  },
};

export { data, labels };
