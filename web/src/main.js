// web/src/main.js
import './style.css'
import * as THREE from 'three'

import { Hands, HAND_CONNECTIONS } from '@mediapipe/hands'
import { Camera } from '@mediapipe/camera_utils'
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils'

// -------------------- TUNING --------------------
const GRID_SCALE = 8
const ROUTE_RADIUS = 0.08   // thickness of route
const ROUTE_SEGMENTS = 8   // smoothness


// -------------------- 1) Webcam video (DOM) --------------------
const video = document.createElement('video')
video.id = 'bg-video'
video.autoplay = true
video.muted = true
video.playsInline = true
document.body.appendChild(video)

// Start webcam ASAP (normal refresh should work for you)
const stream = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: 'user' },
  audio: false,
})
video.srcObject = stream

// Safari reliability: wait until metadata is ready, then explicitly play()
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

const grid = new THREE.GridHelper(20, 40, 0x00ffff, 0x003344)
grid.material.transparent = true
grid.material.opacity = 0.55
board.add(grid)

const cursor = new THREE.Mesh(
  new THREE.SphereGeometry(0.18, 24, 24),
  new THREE.MeshBasicMaterial({ color: 0x00ffff })
)
cursor.position.set(0, 0.2, 0)
board.add(cursor)

// ----- Route drawing state -----
let isDrawing = false
let currentRoute = [] // THREE.Vector3 points for the active route
let routeMesh = null
const routes = [] // optional: store finished routes

function startRoute() {
  isDrawing = true
  currentRoute = []

  // start a fresh line
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

  // keep the finished route (optional)
  if (currentRoute.length >= 2 && routeMesh) {
    routes.push({ points: currentRoute, mesh: routeMesh })
    routeMesh = null
  }
}

function addRoutePoint(worldX, worldZ) {
  const v = new THREE.Vector3(worldX, 0.05, worldZ)

  const last = currentRoute[currentRoute.length - 1]
  if (last && last.distanceToSquared(v) < 0.02) return

  currentRoute.push(v)

  if (currentRoute.length < 2) return

  // Remove old tube
  if (routeMesh) {
    board.remove(routeMesh)
    routeMesh.geometry.dispose()
    routeMesh.material.dispose()
  }

  // Create smooth curve through points
  const curve = new THREE.CatmullRomCurve3(currentRoute)

  const geometry = new THREE.TubeGeometry(
    curve,
    Math.max(2, currentRoute.length * 4), // tubular segments
    ROUTE_RADIUS,
    ROUTE_SEGMENTS,
    false
  )

  const material = new THREE.MeshBasicMaterial({
    color: 0xFFA500,
  })

  routeMesh = new THREE.Mesh(geometry, material)
  board.add(routeMesh)
}



let targetX = 0
let targetZ = 0

// ----- Two-hand gesture state -----
const PINCH_THRESH = 0.06 // tweak 0.04–0.08
let twoPinchActive = false

let lastMid = null   // {x,y} normalized

// Smooth + sensitivity
const ROT_SENS = 3.0        // bigger = faster rotation
const SMOOTH = 0.25         // 0..1 (higher = snappier, lower = smoother)

// Prevent grid from going vertical (limit pitch)
const MIN_PITCH = -0.9      // ~ -52 degrees
const MAX_PITCH = 0.2       // ~ 11 degrees

let smDx = 0  
let smDy = 0

function dist2(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function isPinching(handLm) {
  const thumb = handLm[4] // thumb tip
  const index = handLm[8] // index tip
  return dist2(thumb, index) < PINCH_THRESH * PINCH_THRESH
}


// -------------------- 4) WebSocket input from Python --------------------
let usingWebSocket = false
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

    // Python sends MediaPipe normalized coords [0..1]
    const nx = 1 - msg.x * 2
    const ny = 1 - msg.y * 2

    // Map to grid X/Z
    targetX = nx * GRID_SCALE
    targetZ = -ny * GRID_SCALE
  } catch {}
})

// Mouse fallback if WS isn’t connected
window.addEventListener('mousemove', (e) => {
  if (usingWebSocket) return
  const nx = (e.clientX / window.innerWidth) * 2 - 1
  const ny = (e.clientY / window.innerHeight) * 2 - 1
  targetX = nx * GRID_SCALE
  targetZ = -ny * GRID_SCALE
})

// Grid rotation (mouse drag)
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
  if (twoPinchActive) return // don't conflict with pinch-rotate
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY
  board.rotation.y += dx * 0.005
  board.rotation.x += dy * 0.005
})

// Animate 3D
function animate() {
  requestAnimationFrame(animate)
  cursor.position.x += (targetX - cursor.position.x) * 0.2
  cursor.position.z += (targetZ - cursor.position.z) * 0.2
  renderer.render(scene, camera3d)
}
animate()

// -------------------- 5) MediaPipe Hands (Safari-safe local assets) --------------------
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

  // ---- SAFE GUARD: no hands ----
  if (!lmA) {
    endRoute()
    twoPinchActive = false
    lastMid = null
    smDx = 0
    smDy = 0
    return
  }

  // Draw all detected hands
  for (const lm of handsLm) {
    drawConnectors(ctx, lm, HAND_CONNECTIONS, { lineWidth: 4 })
    drawLandmarks(ctx, lm, { radius: 6 })
  }

  const pinchA = isPinching(lmA)
  const pinchB = lmB ? isPinching(lmB) : false
  const numPinching = (pinchA ? 1 : 0) + (pinchB ? 1 : 0)

  // -------- 0 pinches: stop everything --------
  if (numPinching === 0) {
    endRoute()
    twoPinchActive = false
    lastMid = null
    smDx = 0
    smDy = 0
    return
  }

  // -------- 2 pinches: ROTATE BOARD --------
  if (numPinching === 2) {
    endRoute()
    if (!lmB) return

    const a = lmA[8]
    const b = lmB[8] // safe because pinchB implies lmB exists

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

    smDx += (dxMid - smDx) * SMOOTH
    smDy += (dyMid - smDy) * SMOOTH

    board.rotation.y -= smDx * ROT_SENS
    board.rotation.x += smDy * ROT_SENS
    board.rotation.x = Math.max(MIN_PITCH, Math.min(MAX_PITCH, board.rotation.x))

    lastMid = mid
    return
  }

  // -------- 1 pinch: DRAW ROUTE --------
  twoPinchActive = false
  lastMid = null
  smDx = 0
  smDy = 0

  const drawLm = pinchA ? lmA : lmB
  if (!drawLm) return // extra safety

  const tip = drawLm[8]

  const nx = 1 - tip.x * 2
  const ny = 1 - tip.y * 2

  const worldX = nx * GRID_SCALE
  const worldZ = -ny * GRID_SCALE

  if (!isDrawing) startRoute()
  addRoutePoint(worldX, worldZ)
})




// Feed frames to MediaPipe Hands (in-browser)
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

// -------------------- Resize --------------------
window.addEventListener('resize', () => {
  camera3d.aspect = window.innerWidth / window.innerHeight
  camera3d.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  resizeOverlay()
})
