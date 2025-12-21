import cv2
import mediapipe as mp

def main():
    print("✅ Imports successful")
    print("MediaPipe version:", getattr(mp, "__version__", "unknown"))

    cap = cv2.VideoCapture(0)
    ok, frame = cap.read()
    cap.release()

    print("Camera works:", ok)
    if ok:
        print("Frame shape:", frame.shape)

if __name__ == "__main__":
    main()
