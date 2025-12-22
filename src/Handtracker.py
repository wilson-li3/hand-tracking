# Import OpenCV for webcam access, image processing, and display
import cv2
# Import MediaPipe for hand tracking and landmark detection
import mediapipe as mp

# -------------------- MediaPipe setup --------------------

# Utility functions for drawing landmarks and connections on the image
mp_drawing = mp.solutions.drawing_utils
# Predefined styles for how landmarks and connections look
mp_drawing_styles = mp.solutions.drawing_styles
# MediaPipe Hands solution (contains the hand-tracking model)
mp_hands = mp.solutions.hands

# -------------------- Webcam setup --------------------

# Open the default webcam (0 = built-in camera)
cap = cv2.VideoCapture(0)

# -------------------- Hand tracking model --------------------

# Create a Hands object
# This loads the hand detection + tracking model into memory
hands = mp_hands.Hands(
    static_image_mode=False,   # False = video stream (faster tracking)
    max_num_hands=2,            # Track up to 2 hands
    min_detection_confidence=0.5,  # Confidence threshold to detect a hand
    min_tracking_confidence=0.5    # Confidence threshold to track landmarks
)

# -------------------- Main loop --------------------

# Loop forever to read webcam frames continuously
while True:
    # Read a frame from the webcam
    # success = whether the frame was read correctly
    # image = the actual frame (NumPy array)
    success, image = cap.read()
    # If the webcam failed to return a frame, stop the program
    if not success:
        break
    # Flip the image horizontally so it acts like a mirror
    image = cv2.flip(image, 1)
    # Convert the image from BGR (OpenCV default) to RGB
    # MediaPipe requires RGB images
    image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    # -------------------- Hand detection --------------------

    # Process the RGB image and find hand landmarks
    # results contains all detection information
    results = hands.process(image)
    # Convert the image back to BGR for OpenCV display
    image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)

    # -------------------- Drawing landmarks --------------------

    # If at least one hand was detected
    if results.multi_hand_landmarks:
        # Loop through each detected hand
        for i, hand_landmarks in enumerate(results.multi_hand_landmarks):
            # Draw landmarks (dots) and connections (lines) on the hand
            mp_drawing.draw_landmarks(
                image,                        # Image to draw on
                hand_landmarks,               # Hand landmark data
                mp_hands.HAND_CONNECTIONS     # Predefined hand connections
            )
            lm = hand_landmarks.landmark

            hand_label = results.multi_handedness[i].classification[0].label  # "Left" or "Right"

            if hand_label == "Right":
                thumb_up = 1 if lm[4].x < lm[3].x else 0
            else:
                thumb_up = 1 if lm[4].x > lm[3].x else 0

            tips = [8, 12, 16, 20]
            pips = [6, 10, 14, 18]

            fingers = []  # will store 1 if finger is up, 0 if down

            for tip, pip in zip(tips, pips):
                fingers.append(1 if lm[tip].y < lm[pip].y else 0)

            all_fingers = [thumb_up] + fingers
            count_up = sum(all_fingers)
            text = f"{hand_label}: {count_up} fingers"
            cv2.putText(image, text, (10, 60 + 40*i), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)

    # -------------------- Display --------------------

    # Show the image in a window called "Handtracker"
    cv2.imshow("Handtracker", image)
    # Wait 1 millisecond between frames
    # If ESC (key code 27) is pressed, exit the loop
    if cv2.waitKey(1) & 0xFF == 27:
        break

# -------------------- Cleanup --------------------

# Release the webcam
cap.release()
# Close all OpenCV windows
cv2.destroyAllWindows()
