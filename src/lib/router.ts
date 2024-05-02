import Coordinates from "./coordinates";
import { debounce } from "lodash"
import { toHexStr } from "./util";

let currentRoute = ''
let lastRouteSet = Date.now()

const updateHash = debounce((newRoute) => {
  location.hash = newRoute;
}, 300, {
  trailing: true,
})

function makeRoute(coords: Coordinates, zoom: number) {
  if (coords.IsOutside()) {
    return `${Math.abs(coords.NS).toFixed(3)}${(coords.NS >= 0) ? "N" : "S"},${Math.abs(coords.EW).toFixed(3)}${(coords.EW >= 0) ? "E" : "W"},${zoom.toFixed(3)}`
  }
  return `#${coords.toString()}@${zoom}`
}

export function updateRoute(coords: Coordinates, zoom: number) {
  const newRoute = makeRoute(coords, zoom);
  if (currentRoute != newRoute) {
    currentRoute = newRoute;
    updateHash(newRoute);
  }
}

export function parseRoute(route: string) { 
  const parts = route.split(",");
  if (parts.length != 3) return;

  const zoom = parseFloat(parts[2]);
  let ns = parseFloat(parts[0]);
  let ew = parseFloat(parts[1]);
  
  if (parts[0].toLowerCase().includes('s')) ns *= -1;
  if (parts[1].toLowerCase().includes('w')) ew *= -1;

  const coords = Coordinates.FromCoordinates(ns, ew, 0);
  return {
    coords,
    zoom
  }
}