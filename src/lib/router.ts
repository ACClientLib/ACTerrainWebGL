import { debounce } from "lodash"

export type CameraRoute = {
  mode: "2d" | "3d"
  position: { x: number, y: number, z: number }
  zoom?: number
  yaw?: number
  pitch?: number
  roll?: number
  fov?: number
}

let currentRoute = ''

const updateHash = debounce((newRoute: string) => {
  location.hash = newRoute;
}, 300, {
  trailing: true,
})

function format(value: number) {
  return value.toFixed(2)
}

function makeRoute(route: CameraRoute) {
  if (route.mode === "2d") {
    return `2d,${format(route.position.x)},${format(route.position.y)},${format(route.zoom!)}`
  }

  return `3d,${format(route.position.x)},${format(route.position.y)},${format(route.position.z)},` +
    `${format(route.yaw!)},${format(route.pitch!)},${format(route.roll!)},${format(route.fov!)}`
}

export function updateCameraRoute(route: CameraRoute) {
  const newRoute = makeRoute(route);
  if (currentRoute != newRoute) {
    currentRoute = newRoute;
    updateHash(newRoute);
  }
}

function parseNumber(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parseRoute(route: string): CameraRoute | undefined {
  const parts = route.replace(/^#+/, '').split(",")
  const values = parts.slice(1).map(parseNumber)
  if (values.some(value => value === undefined)) return undefined

  if (parts[0] === "2d" && values.length === 3) {
    return {
      mode: "2d",
      position: { x: values[0]!, y: values[1]!, z: 1 },
      zoom: values[2]
    }
  }

  if (parts[0] === "3d" && values.length === 7) {
    return {
      mode: "3d",
      position: { x: values[0]!, y: values[1]!, z: values[2]! },
      yaw: values[3],
      pitch: values[4],
      roll: values[5],
      fov: values[6]
    }
  }

  return undefined
}
