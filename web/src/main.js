// web/src/main.js
import './style.css'
import * as THREE from 'three'

import { Hands, HAND_CONNECTIONS } from '@mediapipe/hands'
import { Camera } from '@mediapipe/camera_utils'
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils'

// -------------------- TUNING --------------------
const GRID_SCALE = 8

// Tube route look
const ROUTE_RADIUS = 0.08
const ROUTE_SEGMENTS = 8
const ROUTE_COLOR = 0xFFA500

// Gesture / interaction tuning
const PINCH_THRESH = 0.06 // 0.04–0.08

// Rotate smoothing
const ROT_SENS = 3.0
const ROT_SMOOTH = 0.25

// Prevent board from going vertical
const MIN_PITCH = -0.9
const MAX_PITCH = 0.2

// Mode lock: prevents accidental draw when transitioning rotate <-> draw
let mode = 'none' // 'none' | 'rotate' | 'draw'
let lastModeChange = 0
const MODE_COOLDOWN_MS = 180
let mustReleaseBeforeDraw = false
let lastRotateTime = 0
const ROTATE_TO_DRAW_BLOCK_MS = 400 // tweak: 150–400 feels good

// Drawing smoothing / filtering
const DRAW_SMOOTH = 0.35    // 0..1 higher = smoother
const DRAW_MIN_STEP = 0.18  // world units; ignore tiny movement

// Straightening
const STRAIGHT_ANGLE_DEG = 12 // smaller = straighter (8–18)
const STRAIGHT_SNAP = 0.6     // 0..1 how hard to snap

// Tube perf
const ROUTE_REBUILD_EVERY = 3 // rebuild tube every N accepted points

// -------------------- ERASE (FIST) --------------------
const ERASE = {
  ENABLED: true,
  HOVER_RADIUS: 0.7,  // tweak 0.4–1.2
  COOLDOWN_MS: 180,
}
// -------------------- ZOOM (PINCH) --------------------
// spreading fingers apart => ZOOM IN (camera gets closer)
const ZOOM = {
  ENABLED: true,
  SENSITIVITY: 12.0,  // tweak 8–30 (higher = stronger zoom)
  MIN_DIST: 7.0,      // closest camera distance
  MAX_DIST: 26.0,     // farthest camera distance
}

// -------------------- RETRO HOLO FIELD --------------------
const FIELD = {
  SIZE: 20,

  // Make the plane “wide” so the 100y direction runs LEFT <-> RIGHT
  W: 19.6,          // width across X (endzone-to-endzone direction)
  L: 14,            // height across Z (sideline-to-sideline)

  HOLO: true,
  HOLO_ALPHA: 0.35,
  HOLO_EMISSIVE_BOOST: 0.18,

  STRIPE_ALPHA: 0.10,
  NOISE_ALPHA: 0.14,
  TEX_REPEAT_X: 1.0,
  TEX_REPEAT_Z: 1.0,

  LINE_COLOR: '#dfe7e6',
  LINE_ALPHA: 0.92,
  LINE_THICK: 4,

  NUM_COLOR: '#dfe7e6',
  NUM_ALPHA: 0.88,
  SHOW_NUMBERS: true,
  NUMBER_SCALE: 0.6,

  HASH_ALPHA: 0.8,
  HASH_LEN: 10,
  HASH_THICK: 3,

  SHOW_ENDZONES: true,
  ENDZONE_TEXT: 'EAGLES',
  ENDZONE_BG: '#0b3b2e',
  ENDZONE_TEXT_COLOR: '#dfe7e6',
  ENDZONE_TEXT_ALPHA: 0.92,

  // Real field sizing in yards
  PLAY_YARDS: 100,
  ENDZONE_YARDS: 10,

  Y: -0.02,
  ROUTE_Y: 0.05,
}

// -------------------- GOAL POSTS --------------------
const GOALPOST = {
  SHOW: true,
  HEIGHT: 2.8,        // how tall the uprights are
  WIDTH: 1.8,         // distance between uprights
  BAR_HEIGHT: 0.9,    // height of the crossbar from ground
  THICKNESS: 0.06,    // tube thickness
  COLOR: 0x7ffcff,    // holographic cyan
  ALPHA: 0.65,        // transparency
  Z_OFFSET: 0.0,      // shift toward near/far sideline if needed
  INSET: 0.15,        // pull posts slightly inside from the exact line
}

// -------------------- 1) Webcam video (DOM) --------------------
const video = document.createElement('video')
video.id = 'bg-video'
video.autoplay = true
video.muted = true
video.playsInline = true
document.body.appendChild(video)

const stream = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: 'user' },
  audio: false,
})
video.srcObject = stream

await new Promise((res) => (video.onloadedmetadata = res))
await video.play()

// -------------------- 2) 2D overlay canvas (landmarks) --------------------
const overlay = document.createElement('canvas')
overlay.id = 'overlay-canvas'
document.body.appendChild(overlay)
const ctx = overlay.getContext('2d')

function resizeOverlay() {
  overlay.width = window.innerWidth
  overlay.height = window.innerHeight
}
resizeOverlay()

// -------------------- 3) Three.js overlay (transparent) --------------------
const scene = new THREE.Scene()
const board = new THREE.Group()
scene.add(board)

const camera3d = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
)

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setClearColor(0x000000, 0)
renderer.domElement.id = 'three-canvas'
document.body.appendChild(renderer.domElement)

camera3d.position.set(0, 8, 12)
camera3d.lookAt(0, 0, 0)

// Camera zoom bookkeeping (keeps camera angle fixed)
const CAM_TARGET = new THREE.Vector3(0, 0, 0)
const CAM_DIR = camera3d.position.clone().sub(CAM_TARGET).normalize()
let camDist = camera3d.position.distanceTo(CAM_TARGET)

// -------------------- Ray -> Board plane mapping --------------------
const raycaster = new THREE.Raycaster()
const _tmpQuat = new THREE.Quaternion()
const _tmpPos = new THREE.Vector3()
const _tmpN = new THREE.Vector3()
const _tmpPlane = new THREE.Plane()
const _tmpHit = new THREE.Vector3()

function boardPointFromNDC(ndcX, ndcY) {
  raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera3d)

  board.getWorldQuaternion(_tmpQuat)
  board.getWorldPosition(_tmpPos)

  _tmpN.set(0, 1, 0).applyQuaternion(_tmpQuat).normalize()
  _tmpPlane.setFromNormalAndCoplanarPoint(_tmpN, _tmpPos)

  const hit = raycaster.ray.intersectPlane(_tmpPlane, _tmpHit)
  if (!hit) return null

  return board.worldToLocal(hit.clone())
}

// Input is stored as NDC
let inputNdcX = 0
let inputNdcY = 0

// board-local target point
let targetX = 0
let targetZ = 0

let usingWebSocket = false

// -------------------- RETRO FIELD (TEXTURE-BASED) --------------------
function makeRetroFieldTexture() {
  const W = 2048
  const H = 1152

  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')

  g.fillStyle = '#1e6f33'
  g.fillRect(0, 0, W, H)

  const stripeW = Math.floor(W / 12)
  for (let i = 0; i < 12; i++) {
    if (i % 2 === 0) continue
    g.fillStyle = `rgba(255,255,255,${FIELD.STRIPE_ALPHA})`
    g.fillRect(i * stripeW, 0, stripeW, H)
  }

  for (let i = 0; i < 45000; i++) {
    const x = (Math.random() * W) | 0
    const y = (Math.random() * H) | 0
    const a = Math.random() * FIELD.NOISE_ALPHA
    g.fillStyle = `rgba(0,0,0,${a})`
    g.fillRect(x, y, 1, 1)
  }
  for (let i = 0; i < 45000; i++) {
    const x = (Math.random() * W) | 0
    const y = (Math.random() * H) | 0
    const a = Math.random() * (FIELD.NOISE_ALPHA * 0.85)
    g.fillStyle = `rgba(255,255,255,${a})`
    g.fillRect(x, y, 1, 1)
  }

  const marginX = Math.floor(W * 0.03)
  const marginY = Math.floor(H * 0.10)
  const fx0 = marginX
  const fx1 = W - marginX
  const fz0 = marginY
  const fz1 = H - marginY

  const fieldWpx = fx1 - fx0
  const fieldLpx = fz1 - fz0

  const line = (x0, y0, x1, y1, thick = FIELD.LINE_THICK, alpha = FIELD.LINE_ALPHA) => {
    g.save()
    g.globalAlpha = alpha
    g.strokeStyle = FIELD.LINE_COLOR
    g.lineWidth = thick
    g.beginPath()
    g.moveTo(x0, y0)
    g.lineTo(x1, y1)
    g.stroke()
    g.restore()
  }

  const fillRectAlpha = (x, y, w, h, color, alpha) => {
    g.save()
    g.globalAlpha = alpha
    g.fillStyle = color
    g.fillRect(x, y, w, h)
    g.restore()
  }

  line(fx0, fz0, fx1, fz0, FIELD.LINE_THICK + 1, FIELD.LINE_ALPHA)
  line(fx0, fz1, fx1, fz1, FIELD.LINE_THICK + 1, FIELD.LINE_ALPHA)
  line(fx0, fz0, fx0, fz1, FIELD.LINE_THICK + 1, FIELD.LINE_ALPHA)
  line(fx1, fz0, fx1, fz1, FIELD.LINE_THICK + 1, FIELD.LINE_ALPHA)

  const totalYards = FIELD.PLAY_YARDS + 2 * FIELD.ENDZONE_YARDS
  const pxPerYard = fieldWpx / totalYards

  const ezPx = FIELD.ENDZONE_YARDS * pxPerYard
  const playStartX = fx0 + ezPx
  const playEndX = fx1 - ezPx

  if (FIELD.SHOW_ENDZONES) {
    fillRectAlpha(fx0, fz0, ezPx, fieldLpx, FIELD.ENDZONE_BG, 0.9)
    fillRectAlpha(fx1 - ezPx, fz0, ezPx, fieldLpx, FIELD.ENDZONE_BG, 0.9)

    const drawEndzoneText = (cx, cy, rotation, mirror = false) => {
      g.save()
      g.translate(cx, cy)
      g.rotate(rotation)

      const EZ_FONT_SIZE = 110 * (FIELD.NUMBER_SCALE / 0.6)
      const EZ_WIDTH_SCALE = 1.25
      const EZ_LETTER_SPACING = 18

      g.scale(mirror ? -EZ_WIDTH_SCALE : EZ_WIDTH_SCALE, 1)

      g.globalAlpha = FIELD.ENDZONE_TEXT_ALPHA
      g.fillStyle = FIELD.ENDZONE_TEXT_COLOR
      g.font = `${Math.floor(EZ_FONT_SIZE)}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`
      g.textAlign = 'left'
      g.textBaseline = 'middle'

      const text = FIELD.ENDZONE_TEXT

      let total = 0
      for (let i = 0; i < text.length; i++) {
        total += g.measureText(text[i]).width
        if (i !== text.length - 1) total += EZ_LETTER_SPACING
      }

      let x = -total / 2
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        g.fillText(ch, x, 0)
        x += g.measureText(ch).width + EZ_LETTER_SPACING
      }

      g.restore()
    }

    drawEndzoneText(fx0 + ezPx / 2, fz0 + fieldLpx / 2, -Math.PI / 2, false)
    drawEndzoneText(fx1 - ezPx / 2, fz0 + fieldLpx / 2, Math.PI / 2, true)
  }

  line(playStartX, fz0, playStartX, fz1, FIELD.LINE_THICK + 1, 0.95)
  line(playEndX, fz0, playEndX, fz1, FIELD.LINE_THICK + 1, 0.95)

  for (let yds = 0; yds <= FIELD.PLAY_YARDS; yds += 5) {
    const x = playStartX + yds * pxPerYard
    const is10 = yds % 10 === 0
    const thick = is10 ? FIELD.LINE_THICK : Math.max(2, FIELD.LINE_THICK - 1)
    const alpha = is10 ? 0.95 : 0.70
    line(x, fz0, x, fz1, thick, alpha)
  }

  for (let yd = 0; yd <= totalYards; yd += 1) {
    const x = fx0 + yd * pxPerYard
    const isMajor = yd % 5 === 0
    const len = isMajor ? 18 : 10
    line(x, fz0, x, fz0 + len, isMajor ? 3 : 2, 0.75)
    line(x, fz1, x, fz1 - len, isMajor ? 3 : 2, 0.75)
  }

  const hashZ1 = fz0 + fieldLpx * 0.42
  const hashZ2 = fz0 + fieldLpx * 0.58
  for (let yds = 0; yds <= FIELD.PLAY_YARDS; yds += 1) {
    const x = playStartX + yds * pxPerYard
    g.save()
    g.globalAlpha = FIELD.HASH_ALPHA
    g.strokeStyle = FIELD.LINE_COLOR
    g.lineWidth = FIELD.HASH_THICK

    g.beginPath()
    g.moveTo(x, hashZ1)
    g.lineTo(x, hashZ1 + FIELD.HASH_LEN)
    g.stroke()

    g.beginPath()
    g.moveTo(x, hashZ2)
    g.lineTo(x, hashZ2 - FIELD.HASH_LEN)
    g.stroke()

    g.restore()
  }

  if (FIELD.SHOW_NUMBERS) {
    const yTop = fz0 + fieldLpx * 0.18
    const yBot = fz0 + fieldLpx * 0.88
    const baseSize = Math.floor(96 * FIELD.NUMBER_SCALE)

    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = `${baseSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`

    for (let yds = 10; yds <= 90; yds += 10) {
      const label = yds <= 50 ? String(yds) : String(100 - yds)
      const x = playStartX + yds * pxPerYard

      g.save()
      g.globalAlpha = FIELD.NUM_ALPHA
      g.fillStyle = FIELD.NUM_COLOR

      g.fillText(label, x + 3, yTop + 3)
      g.fillText(label, x + 3, yBot + 3)

      g.fillText(label, x, yTop)
      g.fillText(label, x, yBot)
      g.restore()
    }
  }

  {
    const x50 = playStartX + 50 * pxPerYard
    line(x50, fz0, x50, fz1, FIELD.LINE_THICK + 2, 0.95)
  }

  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(FIELD.TEX_REPEAT_X, FIELD.TEX_REPEAT_Z)
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  return tex
}

// grid overlay
const grid = new THREE.GridHelper(FIELD.SIZE, 40, 0x00ffff, 0x003344)
grid.material.transparent = true
grid.material.opacity = 0.38
grid.material.depthWrite = false
grid.material.blending = THREE.AdditiveBlending
board.add(grid)

// field plane
const fieldTex = makeRetroFieldTexture()
const fieldMat = new THREE.MeshBasicMaterial({
  map: fieldTex,
  transparent: true,
  opacity: FIELD.HOLO ? FIELD.HOLO_ALPHA : 1.0,
  depthWrite: false,
})
const fieldPlane = new THREE.Mesh(new THREE.PlaneGeometry(FIELD.W, FIELD.L), fieldMat)
fieldPlane.rotation.x = -Math.PI / 2
fieldPlane.position.y = FIELD.Y
board.add(fieldPlane)

// glow plane
const glowMat = new THREE.MeshBasicMaterial({
  map: fieldTex,
  transparent: true,
  opacity: FIELD.HOLO ? (FIELD.HOLO_ALPHA * FIELD.HOLO_EMISSIVE_BOOST) : 0,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
})
const fieldGlow = new THREE.Mesh(new THREE.PlaneGeometry(FIELD.W, FIELD.L), glowMat)
fieldGlow.rotation.x = -Math.PI / 2
fieldGlow.position.y = FIELD.Y + 0.002
board.add(fieldGlow)

// goal posts
function addGoalPosts() {
  if (!GOALPOST.SHOW) return

  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff07a,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const cyl = (h) => new THREE.CylinderGeometry(GOALPOST.THICKNESS, GOALPOST.THICKNESS, h, 12)

  const makeOne = (x) => {
    const g = new THREE.Group()

    const cross = new THREE.Mesh(cyl(GOALPOST.WIDTH), mat)
    cross.rotation.x = Math.PI / 2
    cross.position.set(0, GOALPOST.BAR_HEIGHT, 0)
    g.add(cross)

    const u1 = new THREE.Mesh(cyl(GOALPOST.HEIGHT), mat)
    u1.position.set(0, GOALPOST.BAR_HEIGHT + GOALPOST.HEIGHT / 2, -GOALPOST.WIDTH / 2)
    g.add(u1)

    const u2 = new THREE.Mesh(cyl(GOALPOST.HEIGHT), mat)
    u2.position.set(0, GOALPOST.BAR_HEIGHT + GOALPOST.HEIGHT / 2, GOALPOST.WIDTH / 2)
    g.add(u2)

    const base = new THREE.Mesh(cyl(GOALPOST.BAR_HEIGHT), mat)
    base.position.set(0, GOALPOST.BAR_HEIGHT / 2, 0)
    g.add(base)

    g.position.set(x, 0, GOALPOST.Z_OFFSET)
    return g
  }

  const xLeftEndLine = -FIELD.W / 2 + GOALPOST.INSET
  const xRightEndLine = FIELD.W / 2 - GOALPOST.INSET

  board.add(makeOne(xLeftEndLine))
  board.add(makeOne(xRightEndLine))
}
addGoalPosts()

// cursor
const cursor = new THREE.Mesh(
  new THREE.SphereGeometry(0.18, 24, 24),
  new THREE.MeshBasicMaterial({ color: 0x00ffff })
)
cursor.position.set(0, 0.2, 0)
board.add(cursor)

// -------------------- Route drawing state --------------------
let isDrawing = false
let currentRoute = [] // THREE.Vector3 points (BOARD-LOCAL coords)
let routeMesh = null
const routes = []

let drawSmoothPoint = null
let acceptedPointsSinceRebuild = 0

function startRoute() {
  isDrawing = true
  currentRoute = []
  drawSmoothPoint = null
  acceptedPointsSinceRebuild = 0

  if (routeMesh) {
    board.remove(routeMesh)
    routeMesh.geometry.dispose()
    routeMesh.material.dispose()
    routeMesh = null
  }
}

function endRoute() {
  if (!isDrawing) return
  isDrawing = false
  drawSmoothPoint = null

  rebuildRouteMesh()

  if (currentRoute.length >= 2 && routeMesh) {
    routes.push({ points: currentRoute, mesh: routeMesh })
    routeMesh = null
  }
}

function rebuildRouteMesh() {
  if (currentRoute.length < 2) return

  if (routeMesh) {
    board.remove(routeMesh)
    routeMesh.geometry.dispose()
    routeMesh.material.dispose()
    routeMesh = null
  }

  const curve = new THREE.CatmullRomCurve3(currentRoute)

  const geometry = new THREE.TubeGeometry(
    curve,
    Math.max(8, currentRoute.length * 4),
    ROUTE_RADIUS,
    ROUTE_SEGMENTS,
    false
  )

  const material = new THREE.MeshBasicMaterial({ color: ROUTE_COLOR })
  routeMesh = new THREE.Mesh(geometry, material)
  board.add(routeMesh)
}

function addRoutePoint(localX, localZ) {
  const v = new THREE.Vector3(localX, FIELD.ROUTE_Y, localZ)

  const last = currentRoute[currentRoute.length - 1]
  if (last && last.distanceToSquared(v) < 0.02) return false

  currentRoute.push(v)
  acceptedPointsSinceRebuild++

  if (acceptedPointsSinceRebuild >= ROUTE_REBUILD_EVERY) {
    acceptedPointsSinceRebuild = 0
    rebuildRouteMesh()
  }

  return true
}

// -------------------- Gesture helpers --------------------
let twoPinchActive = false
let lastMid = null // {x,y}
let smDx = 0
let smDy = 0

// Zoom state
let lastPinchDist = null

// -------------------- FIST DETECTION--------------------
const FIST_RATIO = 0.95 // try 0.85–1.15

function dist3(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = (a.z ?? 0) - (b.z ?? 0)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function isFist(lm) {
  if (!lm) return false

  const palmIdx = [0, 5, 9, 13, 17]
  let cx = 0, cy = 0, cz = 0
  for (const i of palmIdx) {
    cx += lm[i].x
    cy += lm[i].y
    cz += (lm[i].z ?? 0)
  }
  cx /= palmIdx.length
  cy /= palmIdx.length
  cz /= palmIdx.length
  const palm = { x: cx, y: cy, z: cz }

  const palmWidth = dist3(lm[5], lm[17])
  if (palmWidth < 1e-6) return false

  const tips = [8, 12, 16, 20]
  let closed = 0
  for (const t of tips) {
    const d = dist3(lm[t], palm)
    if (d < FIST_RATIO * palmWidth) closed++
  }

  const thumbClosed = dist3(lm[4], palm) < (FIST_RATIO * 1.15) * palmWidth
  return closed >= 3 && thumbClosed
}

function dist2(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function isPinching(handLm) {
  const thumb = handLm[4]
  const index = handLm[8]
  return dist2(thumb, index) < PINCH_THRESH * PINCH_THRESH
}

function setMode(next) {
  const now = performance.now()
  if (next !== mode) {
    if (now - lastModeChange < MODE_COOLDOWN_MS) return false
    mode = next
    lastModeChange = now
  }
  return true
}

function angleDeg(a, b, c) {
  const ab = a.clone().sub(b).normalize()
  const cb = c.clone().sub(b).normalize()
  const dot = THREE.MathUtils.clamp(ab.dot(cb), -1, 1)
  return (Math.acos(dot) * 180) / Math.PI
}

// -------------------- ERASE IMPLEMENTATION --------------------
let lastEraseTime = 0

function distPointSegSqXZ(px, pz, ax, az, bx, bz) {
  const abx = bx - ax
  const abz = bz - az
  const apx = px - ax
  const apz = pz - az
  const abLenSq = abx * abx + abz * abz

  if (abLenSq === 0) {
    const dx = px - ax
    const dz = pz - az
    return dx * dx + dz * dz
  }

  let t = (apx * abx + apz * abz) / abLenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * abx
  const cz = az + t * abz
  const dx = px - cx
  const dz = pz - cz
  return dx * dx + dz * dz
}

function eraseRouteAt(localPoint) {
  if (!ERASE.ENABLED) return false

  const now = performance.now()
  if (now - lastEraseTime < ERASE.COOLDOWN_MS) return false
  if (!routes.length) return false

  const px = localPoint.x
  const pz = localPoint.z
  const r2 = ERASE.HOVER_RADIUS * ERASE.HOVER_RADIUS

  let bestIdx = -1
  let bestD2 = Infinity

  for (let i = 0; i < routes.length; i++) {
    const pts = routes[i].points
    if (!pts || pts.length < 2) continue

    let minD2 = Infinity
    for (let j = 0; j < pts.length - 1; j++) {
      const A = pts[j]
      const B = pts[j + 1]
      const d2 = distPointSegSqXZ(px, pz, A.x, A.z, B.x, B.z)
      if (d2 < minD2) minD2 = d2
      if (minD2 <= r2) break
    }

    if (minD2 <= r2 && minD2 < bestD2) {
      bestD2 = minD2
      bestIdx = i
    }
  }

  if (bestIdx === -1) return false

  const doomed = routes[bestIdx]
  if (doomed.mesh) {
    board.remove(doomed.mesh)
    doomed.mesh.geometry?.dispose()
    doomed.mesh.material?.dispose()
  }
  routes.splice(bestIdx, 1)

  lastEraseTime = now
  return true
}

// -------------------- 4) WebSocket input from Python --------------------
const ws = new WebSocket('ws://localhost:8765')

ws.addEventListener('open', () => {
  console.log('✅ WebSocket connected')
  usingWebSocket = true
})
ws.addEventListener('close', () => {
  console.log('❌ WebSocket closed')
  usingWebSocket = false
})
ws.addEventListener('error', () => {
  console.log('⚠️ WebSocket error (Python server not running?)')
  usingWebSocket = false
})

ws.addEventListener('message', (event) => {
  try {
    const msg = JSON.parse(event.data)
    inputNdcX = 1 - msg.x * 2
    inputNdcY = 1 - msg.y * 2
  } catch {}
})

// Mouse fallback
window.addEventListener('mousemove', (e) => {
  if (usingWebSocket) return
  inputNdcX = (e.clientX / window.innerWidth) * 2 - 1
  inputNdcY = -(e.clientY / window.innerHeight) * 2 + 1
})

// Mouse drag rotate
let dragging = false
let lastX = 0
let lastY = 0

window.addEventListener('mousedown', (e) => {
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
})
window.addEventListener('mouseup', () => (dragging = false))
window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  if (mode === 'rotate') return
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY
  board.rotation.y -= dx * 0.005
  board.rotation.x += dy * 0.005
})

// Animate
function animate() {
  requestAnimationFrame(animate)

  const t = performance.now() * 0.001
  grid.material.opacity = 0.33 + 0.06 * (0.5 + 0.5 * Math.sin(t * 1.3))

  const p = boardPointFromNDC(inputNdcX, inputNdcY)
  if (p) {
    targetX = p.x
    targetZ = p.z
  }

  cursor.position.x += (targetX - cursor.position.x) * 0.2
  cursor.position.z += (targetZ - cursor.position.z) * 0.2

  renderer.render(scene, camera3d)
}
animate()

// -------------------- 5) MediaPipe Hands --------------------
const hands = new Hands({
  locateFile: (file) => `/mediapipe/hands/${file}`,
})

hands.setOptions({
  maxNumHands: 2,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7,
  selfieMode: true,
})

hands.onResults((results) => {
  ctx.clearRect(0, 0, overlay.width, overlay.height)

  const handsLm = results.multiHandLandmarks || []
  const lmA = handsLm[0]
  const lmB = handsLm.length > 1 ? handsLm[1] : null

  if (!lmA) {
    endRoute()
    twoPinchActive = false
    lastMid = null
    smDx = 0
    smDy = 0
    setMode('none')
    mustReleaseBeforeDraw = false
    lastPinchDist = null
    cursor.material.color.setHex(0x00ffff)
    return
  }

  for (const lm of handsLm) {
    drawConnectors(ctx, lm, HAND_CONNECTIONS, { lineWidth: 4 })
    drawLandmarks(ctx, lm, { radius: 6 })
  }

  // hand drives cursor when not WS
  if (!usingWebSocket) {
    const t = lmA[8]
    inputNdcX = 1 - t.x * 2
    inputNdcY = 1 - t.y * 2
  }

  // -------------------- FIST ERASE MODE --------------------
  const fistClosed = isFist(lmA) || (lmB ? isFist(lmB) : false)
  if (fistClosed) {
    cursor.material.color.setHex(0xfff07a)
    endRoute()

    const tip = lmA[8]
    const ndcX = 1 - tip.x * 2
    const ndcY = 1 - tip.y * 2
    inputNdcX = ndcX
    inputNdcY = ndcY

    const hit = boardPointFromNDC(ndcX, ndcY)
    if (hit) {
      targetX = hit.x
      targetZ = hit.z
      cursor.position.x = hit.x
      cursor.position.z = hit.z
      eraseRouteAt(hit)
    }

    setMode('none')
    mustReleaseBeforeDraw = false
    twoPinchActive = false
    lastMid = null
    smDx = 0
    smDy = 0
    lastPinchDist = null
    return
  } else {
    cursor.material.color.setHex(0x00ffff)
  }

  const pinchA = isPinching(lmA)
  const pinchB = lmB ? isPinching(lmB) : false
  const numPinching = (pinchA ? 1 : 0) + (pinchB ? 1 : 0)

  // 0 pinches
  if (numPinching === 0) {
    endRoute()
    twoPinchActive = false
    lastMid = null
    smDx = 0
    smDy = 0
    setMode('none')
    mustReleaseBeforeDraw = false
    lastPinchDist = null
    return
  }

  // 2 pinches: rotate + zoom
  if (numPinching === 2) {
    if (!setMode('rotate')) return

    mustReleaseBeforeDraw = true
    lastRotateTime = performance.now()

    endRoute()

    if (!lmB) return

    const a = lmA[8]
    const b = lmB[8]

    // ---- ZOOM: distance between the two pinched index tips ----
    // spreading apart => pinchDist increases => zoom IN => camDist decreases
    if (ZOOM.ENABLED) {
      const dx = a.x - b.x
      const dy = a.y - b.y
      const pinchDist = Math.sqrt(dx * dx + dy * dy)

      if (lastPinchDist != null) {
        const delta = pinchDist - lastPinchDist
        camDist -= delta * ZOOM.SENSITIVITY
        camDist = THREE.MathUtils.clamp(camDist, ZOOM.MIN_DIST, ZOOM.MAX_DIST)

        camera3d.position.copy(CAM_DIR.clone().multiplyScalar(camDist).add(CAM_TARGET))
        camera3d.lookAt(CAM_TARGET)
      }

      lastPinchDist = pinchDist
    }

    // ---- ROTATE: based on midpoint motion ----
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }

    if (!twoPinchActive) {
      twoPinchActive = true
      lastMid = mid
      smDx = 0
      smDy = 0
      return
    }

    const dxMid = mid.x - lastMid.x
    const dyMid = mid.y - lastMid.y

    smDx += (dxMid - smDx) * ROT_SMOOTH
    smDy += (dyMid - smDy) * ROT_SMOOTH

    board.rotation.y -= smDx * ROT_SENS
    board.rotation.x += smDy * ROT_SENS
    board.rotation.x = Math.max(MIN_PITCH, Math.min(MAX_PITCH, board.rotation.x))

    lastMid = mid
    return
  }

  // leaving 2-pinch mode => reset zoom tracker
  lastPinchDist = null

  // 1 pinch: draw
  const now = performance.now()
  if (mustReleaseBeforeDraw && (now - lastRotateTime) < ROTATE_TO_DRAW_BLOCK_MS) return
  if (!setMode('draw')) return
  mustReleaseBeforeDraw = false

  twoPinchActive = false
  lastMid = null
  smDx = 0
  smDy = 0

  const drawLm = pinchA ? lmA : lmB
  if (!drawLm) return

  const tip = drawLm[8]
  const ndcX = 1 - tip.x * 2
  const ndcY = 1 - tip.y * 2

  const hit = boardPointFromNDC(ndcX, ndcY)
  if (!hit) return

  const raw = new THREE.Vector3(hit.x, FIELD.ROUTE_Y, hit.z)

  if (!drawSmoothPoint) drawSmoothPoint = raw.clone()
  drawSmoothPoint.lerp(raw, 1 - DRAW_SMOOTH)

  const sx = drawSmoothPoint.x
  const sz = drawSmoothPoint.z

  if (!isDrawing) startRoute()

  const last = currentRoute[currentRoute.length - 1]
  if (last && last.distanceTo(new THREE.Vector3(sx, FIELD.ROUTE_Y, sz)) < DRAW_MIN_STEP) return

  const added = addRoutePoint(sx, sz)
  if (!added) return

  if (currentRoute.length >= 3) {
    const A = currentRoute[currentRoute.length - 3]
    const B = currentRoute[currentRoute.length - 2]
    const C = currentRoute[currentRoute.length - 1]

    const ang = angleDeg(A, B, C)
    if (ang > (180 - STRAIGHT_ANGLE_DEG)) {
      const AC = C.clone().sub(A)
      const t = THREE.MathUtils.clamp(
        B.clone().sub(A).dot(AC) / AC.lengthSq(),
        0,
        1
      )
      const proj = A.clone().add(AC.multiplyScalar(t))
      B.lerp(proj, STRAIGHT_SNAP)

      rebuildRouteMesh()
      acceptedPointsSinceRebuild = 0
    }
  }
})

// Feed frames to MediaPipe Hands
const mpCamera = new Camera(video, {
  onFrame: async () => {
    try {
      await hands.send({ image: video })
    } catch (e) {
      console.error('hands.send failed:', e)
    }
  },
  width: 1280,
  height: 720,
})
mpCamera.start()

// Resize
window.addEventListener('resize', () => {
  camera3d.aspect = window.innerWidth / window.innerHeight
  camera3d.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  resizeOverlay()
})
