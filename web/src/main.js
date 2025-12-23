// web/src/main.js
import './style.css'
import * as THREE from 'three'

import { Hands, HAND_CONNECTIONS } from '@mediapipe/hands'
import { Camera } from '@mediapipe/camera_utils'
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils'

// -------------------- TUNING --------------------
const GRID_SCALE = 8

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
scene.add(grid)

const cursor = new THREE.Mesh(
  new THREE.SphereGeometry(0.18, 24, 24),
  new THREE.MeshBasicMaterial({ color: 0x00ffff })
)
cursor.position.set(0, 0.2, 0)
scene.add(cursor)

let targetX = 0
let targetZ = 0

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
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY
  grid.rotation.y += dx * 0.005
  grid.rotation.x += dy * 0.005
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
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7,
  selfieMode: true,
})

hands.onResults((results) => {
  ctx.clearRect(0, 0, overlay.width, overlay.height)

  const lm = results.multiHandLandmarks?.[0]
  if (!lm) return

  // draw utils already handle normalized coords -> pixels
  drawConnectors(ctx, lm, HAND_CONNECTIONS, { lineWidth: 4 })
  drawLandmarks(ctx, lm, { radius: 6 })
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
