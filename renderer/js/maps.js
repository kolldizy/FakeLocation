/**
 * Leaflet layers for the two maps.
 *
 *  - `studioMap`  : the editing surface (target pin, waypoints, route, device marker)
 *  - `previewMap` : the Motion Lab animation surface (preview marker + trail)
 *
 * The two maps are deliberately independent so a preview animation can never be
 * mistaken for device output.
 */

import { state, setState } from "./store.js";

// Both sources are key-free public endpoints. They were chosen because the
// previous dark basemap (CARTO `dark_all`) switched to requiring an API key:
// it kept answering HTTP 200, but with "API KEY REQUIRED" watermark tiles, so
// the map looked broken while every technical check still passed. The smoke
// test now probes the endpoint itself for real imagery.
const TILES = {
  dark: {
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    labels: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    attribution:
      'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    // The Esri canvas series stops serving tiles at z16; past that the last
    // real tile is upscaled instead of the map going blank.
    maxNativeZoom: 16,
  },
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
};

function makeTileLayer(style) {
  const config = TILES[style] || TILES.dark;
  const common = {
    maxZoom: config.maxZoom,
    maxNativeZoom: config.maxNativeZoom ?? config.maxZoom,
    crossOrigin: true,
  };
  const layer = L.tileLayer(config.url, { ...common, attribution: config.attribution, zIndex: 1 });
  // The label/road-reference overlay sits above the base tiles but still below
  // every marker, route and trail in the overlay pane.
  const labels = config.labels ? L.tileLayer(config.labels, { ...common, zIndex: 2 }) : null;
  return { layer, labels, config };
}

/**
 * Leaflet measures its container only when it is told to. Both maps are built while
 * their workspace is `display: none` and then live in a shell that changes size with
 * the window, the dock scrollbar and the basemap switch, so a single `invalidateSize()`
 * on view entry leaves a map painting tiles into the box it had at boot. Watching the
 * container covers reveal, resize and reflow with one mechanism.
 */
function watchSize(map, container) {
  const measure = () => map.invalidateSize({ animate: false });
  new ResizeObserver(measure).observe(container);
  measure();
}

export const icons = {
  target: L.divIcon({ className: "", html: '<div class="pin-target"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
  /**
   * Waypoints are numbered because the list, the polyline and the phone all order them,
   * and a ring of identical dots cannot show which is which. The number is the index the
   * drag and click callbacks report back, so a marker that lies about its order is a bug
   * the user can see.
   */
  waypoint: (index, selected = false) =>
    L.divIcon({
      className: "",
      html: `<div class="pin-waypoint${selected ? " selected" : ""}"><span>${index + 1}</span></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    }),
  device: L.divIcon({ className: "", html: '<div class="pin-device"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
  preview: L.divIcon({ className: "", html: '<div class="pin-preview"></div>', iconSize: [17, 17], iconAnchor: [8.5, 8.5] }),
};

/**
 * Draw the route on one map: one numbered marker per waypoint, in order, plus a polyline
 * that visits them in that order.
 *
 * Both maps share this so the editing surface and the preview cannot disagree about what
 * the route is. A route with fewer than two waypoints draws no line at all — an empty
 * plan must look empty.
 */
function drawRoute(owner, points, selected) {
  for (const marker of owner.waypointMarkers) owner.map.removeLayer(marker);
  owner.waypointMarkers = [];
  if (owner.routeLine) {
    owner.map.removeLayer(owner.routeLine);
    owner.routeLine = null;
  }

  points.forEach((point, index) => {
    const marker = L.marker([point.lat, point.lon], {
      icon: icons.waypoint(index, index === selected),
      draggable: true,
      keyboard: false,
      zIndexOffset: index === selected ? 900 : 100 + index,
    })
      .bindTooltip(`Waypoint ${index + 1} — drag to move, click to select`, { direction: "top", offset: [0, -12] })
      .addTo(owner.map);
    // Markers do not bubble clicks to the map, so selecting one never appends another.
    marker.on("click", () => {
      if (owner.onWaypointSelect) owner.onWaypointSelect(index);
    });
    marker.on("dragend", () => {
      const position = marker.getLatLng();
      if (owner.onWaypointDrag) owner.onWaypointDrag(index, position.lat, position.lng);
    });
    owner.waypointMarkers.push(marker);
  });

  if (points.length > 1) {
    owner.routeLine = L.polyline(
      points.map((point) => [point.lat, point.lon]),
      { color: "#7db4ff", weight: 3, opacity: 0.9, dashArray: "8 7", className: "route-line" }
    ).addTo(owner.map);
  }
}

/** Crosshair over the canvas while a click means "append", pan while it means "move the map". */
function setEditStyle(owner, editing) {
  const container = owner.map && owner.map.getContainer();
  if (container) container.classList.toggle("route-editing", Boolean(editing));
}

export const studioMap = {
  map: null,
  tile: null,
  tileLabels: null,
  tileStyle: "dark",
  targetMarker: null,
  deviceMarker: null,
  routeLine: null,
  waypointMarkers: [],
  onTargetChange: null,
  onMapClick: null,
  onWaypointDrag: null,
  onWaypointSelect: null,

  init(containerId, initial) {
    this.map = L.map(containerId, { zoomControl: false, attributionControl: true, preferCanvas: true }).setView(
      [initial.lat, initial.lon],
      initial.zoom || 12
    );
    L.control.zoom({ position: "bottomright" }).addTo(this.map);
    this.setTileStyle(this.tileStyle);
    this.targetMarker = L.marker([initial.lat, initial.lon], { draggable: true, icon: icons.target, keyboard: false }).addTo(this.map);
    this.targetMarker.on("dragend", () => {
      const position = this.targetMarker.getLatLng();
      if (this.onTargetChange) this.onTargetChange(position.lat, position.lng, { pan: false, source: "drag" });
    });
    this.map.on("click", (event) => {
      if (this.onMapClick) this.onMapClick(event.latlng.lat, event.latlng.lng);
    });
    this.map.on("moveend", () => {
      const centre = this.map.getCenter();
      setState({ settings: { ...state.settings, mapCenter: { lat: centre.lat, lon: centre.lng, zoom: this.map.getZoom() } } });
    });
    watchSize(this.map, document.getElementById(containerId));
    return this.map;
  },

  invalidate() {
    if (this.map) this.map.invalidateSize({ animate: false });
  },

  setTileStyle(style) {
    this.tileStyle = style;
    if (this.tile) this.map.removeLayer(this.tile);
    if (this.tileLabels) this.map.removeLayer(this.tileLabels);
    const { layer, labels, config } = makeTileLayer(style);
    layer.addTo(this.map);
    layer.bringToBack();
    if (labels) labels.addTo(this.map);
    this.tile = layer;
    this.tileLabels = labels;
    this.tileConfig = config;
  },

  setTarget(lat, lon, pan = false) {
    if (!this.targetMarker) return;
    this.targetMarker.setLatLng([lat, lon]);
    if (pan) this.map.setView([lat, lon], Math.max(this.map.getZoom(), 13));
  },

  setDeviceLocation(coordinate) {
    if (!coordinate) {
      if (this.deviceMarker) {
        this.map.removeLayer(this.deviceMarker);
        this.deviceMarker = null;
      }
      return;
    }
    const { lat, lon } = coordinate;
    if (!this.deviceMarker) {
      this.deviceMarker = L.marker([lat, lon], { icon: icons.device, keyboard: false, zIndexOffset: 800 })
        .bindTooltip("Last reported device position", { direction: "top" })
        .addTo(this.map);
    } else {
      this.deviceMarker.setLatLng([lat, lon]);
    }
  },

  redrawRoute(points, selected = -1) {
    drawRoute(this, points, selected);
  },

  setEditStyle(editing) {
    setEditStyle(this, editing);
  },

  focusWaypoint(point) {
    if (!point) return;
    this.map.setView([point.lat, point.lon], Math.max(this.map.getZoom(), 14));
  },

  fitRoute(points) {
    if (points.length < 2) return;
    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lon]));
    this.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
  },
};

export const previewMap = {
  map: null,
  tile: null,
  tileLabels: null,
  tileStyle: "dark",
  tileConfig: null,
  routeLine: null,
  trailLine: null,
  marker: null,
  waypointMarkers: [],
  trail: [],
  onMapClick: null,
  onWaypointDrag: null,
  onWaypointSelect: null,

  init(containerId, initial) {
    this.map = L.map(containerId, { zoomControl: false, attributionControl: true, preferCanvas: true }).setView(
      [initial.lat, initial.lon],
      initial.zoom || 13
    );
    // Same corner as the studio map: the overlay chip that labels this surface as a
    // preview lives top-left, and the default control position sat on top of its first word.
    L.control.zoom({ position: "bottomright" }).addTo(this.map);
    this.setTileStyle(this.tileStyle);
    this.map.on("click", (event) => {
      if (this.onMapClick) this.onMapClick(event.latlng.lat, event.latlng.lng);
    });
    watchSize(this.map, document.getElementById(containerId));
    return this.map;
  },

  setTileStyle(style) {
    this.tileStyle = style;
    if (this.tile) this.map.removeLayer(this.tile);
    if (this.tileLabels) this.map.removeLayer(this.tileLabels);
    const { layer, labels, config } = makeTileLayer(style);
    layer.addTo(this.map);
    layer.bringToBack();
    if (labels) labels.addTo(this.map);
    this.tile = layer;
    this.tileLabels = labels;
    this.tileConfig = config;
  },

  setRoute(points, options = {}) {
    drawRoute(this, points, options.selected === undefined ? -1 : options.selected);
  },

  setEditStyle(editing) {
    setEditStyle(this, editing);
  },

  focusWaypoint(point) {
    if (!point) return;
    this.map.setView([point.lat, point.lon], Math.max(this.map.getZoom(), 14));
  },

  setMarker(coordinate) {
    if (!coordinate) {
      if (this.marker) {
        this.map.removeLayer(this.marker);
        this.marker = null;
      }
      return;
    }
    if (!this.marker) {
      this.marker = L.marker([coordinate.lat, coordinate.lon], {
        icon: icons.preview,
        keyboard: false,
        zIndexOffset: 1200,
      }).addTo(this.map);
    } else {
      this.marker.setLatLng([coordinate.lat, coordinate.lon]);
    }
  },

  pushTrail(coordinate) {
    this.trail.push([coordinate.lat, coordinate.lon]);
    if (this.trail.length > 4000) this.trail.splice(0, 1000);
    if (this.trail.length < 2) return;
    if (this.trailLine) this.map.removeLayer(this.trailLine);
    this.trailLine = L.polyline(this.trail, { color: "#c56fae", weight: 2.5, opacity: 0.85, className: "route-line-second" }).addTo(this.map);
  },

  clearTrail() {
    this.trail = [];
    if (this.trailLine) {
      this.map.removeLayer(this.trailLine);
      this.trailLine = null;
    }
    this.setMarker(null);
  },

  fit(points) {
    if (points.length < 1) return;
    if (points.length === 1) {
      this.map.setView([points[0].lat, points[0].lon], 14);
      return;
    }
    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lon]));
    this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
  },

  invalidate() {
    if (this.map) this.map.invalidateSize({ animate: false });
  },
};
