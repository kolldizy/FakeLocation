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

export const icons = {
  target: L.divIcon({ className: "", html: '<div class="pin-target"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
  waypoint: (armed = false) =>
    L.divIcon({ className: "", html: `<div class="pin-waypoint${armed ? " armed" : ""}"></div>`, iconSize: [15, 15], iconAnchor: [7.5, 7.5] }),
  device: L.divIcon({ className: "", html: '<div class="pin-device"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
  preview: L.divIcon({ className: "", html: '<div class="pin-preview"></div>', iconSize: [17, 17], iconAnchor: [8.5, 8.5] }),
};

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

  redrawRoute(points, armedIndex = -1) {
    for (const marker of this.waypointMarkers) this.map.removeLayer(marker);
    this.waypointMarkers = [];

    points.forEach((point, index) => {
      const marker = L.marker([point.lat, point.lon], { icon: icons.waypoint(index === armedIndex), keyboard: false })
        .bindTooltip(`Waypoint ${index + 1}`, { direction: "top" })
        .addTo(this.map);
      this.waypointMarkers.push(marker);
    });

    if (this.routeLine) {
      this.map.removeLayer(this.routeLine);
      this.routeLine = null;
    }
    if (points.length > 1) {
      this.routeLine = L.polyline(
        points.map((point) => [point.lat, point.lon]),
        { color: "#5ff3ff", weight: 3, opacity: 0.9, dashArray: "8 7", className: "route-line" }
      ).addTo(this.map);
    }
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
  routeLine: null,
  trailLine: null,
  marker: null,
  waypointMarkers: [],
  trail: [],

  init(containerId, initial) {
    this.map = L.map(containerId, { zoomControl: true, attributionControl: true, preferCanvas: true }).setView(
      [initial.lat, initial.lon],
      initial.zoom || 13
    );
    const { layer, labels } = makeTileLayer("dark");
    layer.addTo(this.map);
    if (labels) labels.addTo(this.map);
    this.tile = layer;
    this.tileLabels = labels;
    return this.map;
  },

  setRoute(points, options = {}) {
    if (this.routeLine) this.map.removeLayer(this.routeLine);
    this.routeLine = null;
    for (const marker of this.waypointMarkers) this.map.removeLayer(marker);
    this.waypointMarkers = [];

    if (points.length > 1) {
      this.routeLine = L.polyline(
        points.map((point) => [point.lat, point.lon]),
        { color: "#a175ff", weight: options.highlighted ? 3 : 2, opacity: 0.75, dashArray: "5 8", className: "route-line" }
      ).addTo(this.map);
    }
    points.forEach((point, index) => {
      this.waypointMarkers.push(
        L.marker([point.lat, point.lon], { icon: icons.waypoint(false), keyboard: false })
          .bindTooltip(`Waypoint ${index + 1}`, { direction: "top" })
          .addTo(this.map)
      );
    });
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
    this.trailLine = L.polyline(this.trail, { color: "#ff4fbd", weight: 2.5, opacity: 0.8, className: "route-line-second" }).addTo(this.map);
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
    if (this.map) this.map.invalidateSize();
  },
};
