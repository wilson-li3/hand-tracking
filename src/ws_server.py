# src/ws_server.py
# Streams hand-controlled cursor data to Three.js over WebSocket:
#   {"x": <0..1>, "y": <0..1>, "pinch": <true/false>}
#
# NOTE: No OpenCV preview window here.
# The webcam feed will be shown in the browser (Three.js) using getUserMedia().
#
# Quit: Ctrl+C in the terminal.

import asyncio
import json

import cv2
import mediapipe as mp
import websockets


# -------------------- MediaPipe setup --------------------
mp_hands = mp.solutions.hands
hands = mp_hands.Hands(
    max_num_hands=1,
    min_detection_confidence=0.7,
    min_tracking_confidence=0.7,
)

# -------------------- Camera setup --------------------
cap = cv2.VideoCapture(0)


# -------------------- WebSocket handler --------------------
async def handler(websocket):
    print("🌐 Browser connected")

    while True:
        success, frame = cap.read()
        if not success:
            await asyncio.sleep(0.01)
            continue

        # Mirror so your movement matches the browser selfie view better
        frame = cv2.flip(frame, 1)

        # MediaPipe expects RGB
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = hands.process(rgb)

        # Only send when a hand is detected
        if results.multi_hand_landmarks:
            lm = results.multi_hand_landmarks[0].landmark

            # Index fingertip (normalized coords in [0,1])
            x = lm[8].x
            y = lm[8].y

            msg = {"x": x, "y": y, "pinch": False}
            await websocket.send(json.dumps(msg))

        # Aim for ~60 updates/sec
        await asyncio.sleep(1 / 60)


async def main():
    async with websockets.serve(handler, "localhost", 8765):
        print("✅ WebSocket server running on ws://localhost:8765")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    finally:
        # Cleanup if you stop with Ctrl+C
        cap.release()
        cv2.destroyAllWindows()
