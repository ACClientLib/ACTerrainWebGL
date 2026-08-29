import * as glhelpers from './glhelpers'
import { BuildingsVertSource } from '../shaders/buildings.vert'
import { BuildingsFragSource } from '../shaders/buildings.frag'
import { Camera2D } from './cameras/camera2d'
import { Vector3 } from '@math.gl/core'

const MAP_SIZE = 255 * 192
const LAND_BLOCK_SIZE = 192
const LAND_BLOCK_SIDE = 255
const MAGIC = 0x31504D42

interface BuildingModel {
  polygons: number[][]
}

interface BuildingPlacement {
  modelIndex: number
  x: number
  y: number
  rotation: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface BuildingData {
  models: BuildingModel[]
  landblocks: BuildingPlacement[][]
}

// buildings.map.gz is BMP1 little-endian: header, signed int16 model polygon
// points, normalized uint16 placement coordinates, signed int16 bounds/rotation,
// followed by 255*255 uint16 placement counts in row-major landblock order.
export class BuildingOverlay {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram | null
  private buffer: WebGLBuffer | null
  private indexBuffer: WebGLBuffer | null
  private fillIndexBuffer: WebGLBuffer | null
  private data: BuildingData | null = null
  private vertexCount = 0
  private indexCount = 0
  private fillIndexCount = 0
  private dirty = true
  private lastPositionX = NaN
  private lastPositionY = NaN
  private lastZoom = NaN
  private lastWidth = 0
  private lastHeight = 0

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    const vertexShader = glhelpers.createShader(gl, gl.VERTEX_SHADER, BuildingsVertSource)
    const fragmentShader = glhelpers.createShader(gl, gl.FRAGMENT_SHADER, BuildingsFragSource)
    this.program = vertexShader && fragmentShader ? glhelpers.createProgram(gl, vertexShader, fragmentShader) : null
    this.buffer = gl.createBuffer()
    this.indexBuffer = gl.createBuffer()
    this.fillIndexBuffer = gl.createBuffer()
  }

  async load(): Promise<boolean> {
    try {
      const urls = [`${import.meta.env.BASE_URL}data/buildings.map.gz`]
      if (import.meta.env.DEV && import.meta.env.BASE_URL !== '/') {
        urls.push('/data/buildings.map.gz')
      }

      let response: Response | null = null
      let lastError: unknown = null
      for (const url of urls) {
        try {
          const candidate = await fetch(url)
          if (candidate.ok && candidate.body) {
            response = candidate
            break
          }
          lastError = new Error(`${url} returned HTTP ${candidate.status}`)
        } catch (error) {
          lastError = error
        }
      }
      if (!response) {
        throw lastError ?? new Error('no response')
      }

      const body = response.body
      if (!body) {
        throw new Error('response has no body')
      }
      const stream = response.headers.get('content-encoding')?.includes('gzip')
        ? body
        : body.pipeThrough(new DecompressionStream('gzip'))
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
      this.data = this.parse(bytes)
      this.dirty = true
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Buildings disabled: unable to load or parse overlay (${message})`)
      this.data = null
      return false
    }
  }

  render(camera: Camera2D, enabled: boolean): void {
    if (!enabled || !this.data || !this.program) {
      return
    }

    if (this.hasCameraChanged(camera)) {
      this.dirty = true
    }
    if (this.dirty) {
      this.rebuild(camera)
    }
    if (this.indexCount === 0) {
      return
    }

    const gl = this.gl
    gl.useProgram(this.program)
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'xWorld'), false, camera.Transform)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.enableVertexAttribArray(0)

    gl.uniform4f(gl.getUniformLocation(this.program, 'color'), 0.62, 0.5, 0.22, 0.12)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fillIndexBuffer)
    gl.drawElements(gl.TRIANGLES, this.fillIndexCount, gl.UNSIGNED_INT, 0)

    gl.uniform4f(gl.getUniformLocation(this.program, 'color'), 0.95, 0.78, 0.25, 0.9)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    // WebGL2 always enables fixed-index primitive restart. 0xFFFFFFFF is the
    // restart marker for the UNSIGNED_INT index buffer.
    gl.drawElements(gl.LINE_STRIP, this.indexCount, gl.UNSIGNED_INT, 0)
    gl.disableVertexAttribArray(0)
  }

  private parse(bytes: Uint8Array): BuildingData {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = 0
    const ensure = (size: number) => {
      if (offset + size > view.byteLength) {
        throw new Error('truncated binary data')
      }
    }
    const readU16 = () => { ensure(2); const value = view.getUint16(offset, true); offset += 2; return value }
    const readI16 = () => { ensure(2); const value = view.getInt16(offset, true); offset += 2; return value }
    const readI32 = () => { ensure(4); const value = view.getInt32(offset, true); offset += 4; return value }

    ensure(20)
    if (view.getUint32(offset, true) !== MAGIC) throw new Error('invalid magic')
    offset += 4
    if (readU16() !== 1 || readU16() !== LAND_BLOCK_SIDE) throw new Error('unsupported version or side')
    const modelCount = readI32()
    const placementCount = readI32()
    if (readI32() !== LAND_BLOCK_SIDE * LAND_BLOCK_SIDE || modelCount < 0 || placementCount < 0) throw new Error('invalid counts')

    const models: BuildingModel[] = []
    for (let modelIndex = 0; modelIndex < modelCount; modelIndex++) {
      const polygonCount = readI32()
      if (polygonCount < 0) throw new Error('invalid polygon count')
      const polygons: number[][] = []
      for (let polygonIndex = 0; polygonIndex < polygonCount; polygonIndex++) {
        const pointCount = readI32()
        if (pointCount < 1) throw new Error('invalid point count')
        const polygon: number[] = []
        for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
          polygon.push(readI16() / 32767 * MAP_SIZE, readI16() / 32767 * MAP_SIZE)
        }
        polygons.push(polygon)
      }
      models.push({ polygons })
    }

    const placements: BuildingPlacement[] = []
    for (let i = 0; i < placementCount; i++) {
      const modelIndex = readU16()
      if (modelIndex >= modelCount) throw new Error('invalid model index')
      placements.push({
        modelIndex,
        x: readU16() / 65535 * MAP_SIZE,
        y: readU16() / 65535 * MAP_SIZE,
        rotation: readI16() / 32767 * Math.PI,
        minX: readI16() / 32767 * MAP_SIZE,
        minY: readI16() / 32767 * MAP_SIZE,
        maxX: readI16() / 32767 * MAP_SIZE,
        maxY: readI16() / 32767 * MAP_SIZE
      })
    }

    const landblocks: BuildingPlacement[][] = []
    let placementOffset = 0
    for (let i = 0; i < LAND_BLOCK_SIDE * LAND_BLOCK_SIDE; i++) {
      const count = readU16()
      if (placementOffset + count > placements.length) throw new Error('invalid landblock index')
      landblocks.push(placements.slice(placementOffset, placementOffset + count))
      placementOffset += count
    }
    if (placementOffset !== placements.length || offset !== view.byteLength) throw new Error('unexpected trailing data')
    return { models, landblocks }
  }

  private hasCameraChanged(camera: Camera2D): boolean {
    return camera.Position.x !== this.lastPositionX || camera.Position.y !== this.lastPositionY ||
      camera.Zoom !== this.lastZoom || camera.ViewportSize.x !== this.lastWidth || camera.ViewportSize.y !== this.lastHeight
  }

  private rebuild(camera: Camera2D): void {
    this.lastPositionX = camera.Position.x
    this.lastPositionY = camera.Position.y
    this.lastZoom = camera.Zoom
    this.lastWidth = camera.ViewportSize.x
    this.lastHeight = camera.ViewportSize.y
    this.dirty = false

    const topLeft = camera.ScreenToWorld(new Vector3(0, 0, 1))
    const bottomRight = camera.ScreenToWorld(new Vector3(camera.ViewportSize.x, camera.ViewportSize.y, 1))
    const minX = Math.max(0, Math.floor(Math.min(topLeft.x, bottomRight.x) / LAND_BLOCK_SIZE))
    const maxX = Math.min(254, Math.floor(Math.max(topLeft.x, bottomRight.x) / LAND_BLOCK_SIZE))
    const minY = Math.max(0, Math.floor(Math.min(topLeft.y, bottomRight.y) / LAND_BLOCK_SIZE))
    const maxY = Math.min(254, Math.floor(Math.max(topLeft.y, bottomRight.y) / LAND_BLOCK_SIZE))
    const vertices: number[] = []
    const indices: number[] = []
    const fillIndices: number[] = []

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const sourceY = LAND_BLOCK_SIDE - 1 - y
        const candidates = this.data!.landblocks[sourceY * LAND_BLOCK_SIDE + x]
        for (const placement of candidates) {
          const model = this.data!.models[placement.modelIndex]
          const cos = Math.cos(placement.rotation)
          const sin = Math.sin(placement.rotation)
          const bounds = this.placementBounds(placement)
          if (bounds.maxX < Math.min(topLeft.x, bottomRight.x) || bounds.minX > Math.max(topLeft.x, bottomRight.x) ||
            bounds.maxY < Math.min(topLeft.y, bottomRight.y) || bounds.minY > Math.max(topLeft.y, bottomRight.y)) continue
          for (const polygon of model.polygons) {
            const firstIndex = vertices.length / 2
            for (let i = 0; i < polygon.length; i += 2) {
              const pointX = polygon[i]
              const pointY = polygon[i + 1]
              vertices.push(pointX * cos - pointY * sin + placement.x, pointX * sin + pointY * cos + placement.y)
              indices.push(firstIndex + i / 2)
            }
            for (const index of this.triangulatePolygon(polygon)) {
              fillIndices.push(firstIndex + index)
            }
            indices.push(firstIndex)
            indices.push(0xFFFFFFFF)
          }
        }
      }
    }

    this.vertexCount = vertices.length / 2
    this.indexCount = indices.length
    this.fillIndexCount = fillIndices.length
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer)
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(vertices), this.gl.DYNAMIC_DRAW)
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), this.gl.DYNAMIC_DRAW)
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.fillIndexBuffer)
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(fillIndices), this.gl.DYNAMIC_DRAW)
  }

  private triangulatePolygon(polygon: number[]): number[] {
    const pointIndices: number[] = []
    for (let i = 0; i < polygon.length; i += 2) {
      const previous = pointIndices[pointIndices.length - 1]
      if (previous === undefined || polygon[i] !== polygon[previous * 2] || polygon[i + 1] !== polygon[previous * 2 + 1]) {
        pointIndices.push(i / 2)
      }
    }
    if (pointIndices.length > 1) {
      const first = pointIndices[0]
      const last = pointIndices[pointIndices.length - 1]
      if (polygon[first * 2] === polygon[last * 2] && polygon[first * 2 + 1] === polygon[last * 2 + 1]) {
        pointIndices.pop()
      }
    }
    const uniquePointIndices: number[] = []
    const seenPoints = new Set<string>()
    for (const index of pointIndices) {
      const key = `${polygon[index * 2]},${polygon[index * 2 + 1]}`
      if (!seenPoints.has(key)) {
        seenPoints.add(key)
        uniquePointIndices.push(index)
      }
    }
    pointIndices.splice(0, pointIndices.length, ...uniquePointIndices)
    if (pointIndices.length < 3) {
      return []
    }

    const cross = (a: number, b: number, c: number) => {
      const ax = polygon[a * 2]
      const ay = polygon[a * 2 + 1]
      const bx = polygon[b * 2]
      const by = polygon[b * 2 + 1]
      const cx = polygon[c * 2]
      const cy = polygon[c * 2 + 1]
      return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    }
    const area = pointIndices.reduce((sum, _, i) => {
      const a = pointIndices[i]
      const b = pointIndices[(i + 1) % pointIndices.length]
      return sum + polygon[a * 2] * polygon[b * 2 + 1] - polygon[b * 2] * polygon[a * 2 + 1]
    }, 0)
    if (Math.abs(area) < 0.000001) {
      return []
    }

    const orientation = area > 0 ? 1 : -1
    const remaining = pointIndices.slice()
    let removedCollinearPoint = true
    while (removedCollinearPoint && remaining.length > 3) {
      removedCollinearPoint = false
      for (let i = 0; i < remaining.length; i++) {
        const previous = remaining[(i + remaining.length - 1) % remaining.length]
        const current = remaining[i]
        const next = remaining[(i + 1) % remaining.length]
        if (Math.abs(cross(previous, current, next)) <= 0.000001) {
          remaining.splice(i, 1)
          removedCollinearPoint = true
          break
        }
      }
    }
    const triangles: number[] = []
    while (remaining.length > 3) {
      let clipped = false
      for (let i = 0; i < remaining.length; i++) {
        const previous = remaining[(i + remaining.length - 1) % remaining.length]
        const current = remaining[i]
        const next = remaining[(i + 1) % remaining.length]
        if (cross(previous, current, next) * orientation <= 0.000001) {
          continue
        }

        let containsPoint = false
        for (const candidate of remaining) {
          if (candidate === previous || candidate === current || candidate === next) {
            continue
          }
          const c0 = cross(previous, current, candidate) * orientation
          const c1 = cross(current, next, candidate) * orientation
          const c2 = cross(next, previous, candidate) * orientation
          if (c0 > 0.000001 && c1 > 0.000001 && c2 > 0.000001) {
            containsPoint = true
            break
          }
        }
        if (containsPoint) {
          continue
        }

        triangles.push(previous, current, next)
        remaining.splice(i, 1)
        clipped = true
        break
      }
      if (!clipped) {
        for (let i = 1; i < remaining.length - 1; i++) {
          triangles.push(remaining[0], remaining[i], remaining[i + 1])
        }
        return triangles
      }
    }
    triangles.push(remaining[0], remaining[1], remaining[2])
    return triangles
  }

  private placementBounds(placement: BuildingPlacement) {
    return {
      minX: placement.minX,
      minY: placement.minY,
      maxX: placement.maxX,
      maxY: placement.maxY
    }
  }
}
