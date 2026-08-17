"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { WebGPURetina } from "./webgpu-retina";
import type { Gaze, WebGPUStatus } from "./webgpu-retina";

type CameraState = "off" | "starting" | "calibrating" | "tracking" | "unavailable" | "error";
type MotionState = "off" | "requesting" | "active" | "unavailable" | "denied";
type FaceDetection = { boundingBox: { x: number; y: number; width: number; height: number } };
type FaceDetectorInstance = { detect: (source: HTMLVideoElement) => Promise<FaceDetection[]> };
type PermissionAwareDeviceMotionEvent = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

function stateLabel(pressure: number) {
  if (pressure < .18) return "daylight blue";
  if (pressure < .36) return "green veil";
  if (pressure < .57) return "yellow glow";
  if (pressure < .8) return "warm orange";
  return "deep retinal red";
}

function weightedDarkCenter(
  data: ImageData,
  bounds: { x: number; y: number; width: number; height: number },
) {
  const startX = Math.max(0, Math.floor(bounds.x));
  const startY = Math.max(0, Math.floor(bounds.y));
  const endX = Math.min(data.width, Math.ceil(bounds.x + bounds.width));
  const endY = Math.min(data.height, Math.ceil(bounds.y + bounds.height));
  let luminanceTotal = 0;
  let samples = 0;
  for (let y = startY; y < endY; y += 2) {
    for (let x = startX; x < endX; x += 2) {
      const index = (y * data.width + x) * 4;
      luminanceTotal += data.data[index] * .21 + data.data[index + 1] * .72 + data.data[index + 2] * .07;
      samples += 1;
    }
  }
  const threshold = luminanceTotal / Math.max(1, samples) * .72;
  let weightTotal = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = (y * data.width + x) * 4;
      const luminance = data.data[index] * .21 + data.data[index + 1] * .72 + data.data[index + 2] * .07;
      const weight = Math.max(0, threshold - luminance) ** 2;
      weightTotal += weight;
      weightedX += x * weight;
      weightedY += y * weight;
    }
  }
  if (weightTotal < 900) return null;
  return {
    x: (weightedX / weightTotal - startX) / Math.max(1, endX - startX),
    y: (weightedY / weightTotal - startY) / Math.max(1, endY - startY),
  };
}

export default function Home() {
  const pressureRef = useRef(.61);
  const pressureValueRef = useRef(61);
  const pressureDirectionRef = useRef<1 | -1>(1);
  const pressurePauseUntilRef = useRef(0);
  const pressureAnimationRef = useRef(0);
  const gazeRef = useRef<Gaze>({ x: .5, y: .48 });
  const cameraTrackingRef = useRef(false);
  const motionRef = useRef<Gaze>({ x: 0, y: 0 });
  const motionActiveRef = useRef(false);
  const gestureRef = useRef<Gaze>({ x: 0, y: 0 });
  const swipeRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const motionHandlerRef = useRef<((event: DeviceMotionEvent) => void) | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackingFrameRef = useRef(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pressure, setPressure] = useState(61);
  const [cameraState, setCameraState] = useState<CameraState>("off");
  const [motionState, setMotionState] = useState<MotionState>("unavailable");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [infoOpen, setInfoOpen] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [webGPUStatus, setWebGPUStatus] = useState<WebGPUStatus>("checking");

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 5600);
  }, []);

  const handleWebGPUStatus = useCallback((status: WebGPUStatus) => {
    setWebGPUStatus(status);
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    showControls();
    const target = event.target;
    if (target instanceof Element && target.closest("button,input,a,.control-deck,.info-panel")) return;
    swipeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setHasInteracted(true);
  }, [showControls]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    showControls();
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const nextX = gestureRef.current.x + (event.clientX - swipe.x) / Math.max(1, bounds.width) * .18;
    const nextY = gestureRef.current.y + (event.clientY - swipe.y) / Math.max(1, bounds.height) * .18;
    gestureRef.current = {
      x: Math.max(-.055, Math.min(.055, nextX)),
      y: Math.max(-.055, Math.min(.055, nextY)),
    };
    swipe.x = event.clientX;
    swipe.y = event.clientY;
  }, [showControls]);

  const finishSwipe = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (swipeRef.current?.pointerId !== event.pointerId) return;
    swipeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const setPressureManually = useCallback((nextPressure: number) => {
    pressureValueRef.current = nextPressure;
    pressureRef.current = nextPressure / 100;
    pressurePauseUntilRef.current = performance.now() + 9000;
    setPressure(nextPressure);
    setHasInteracted(true);
    showControls();
  }, [showControls]);

  const stopMotion = useCallback(() => {
    if (motionHandlerRef.current) {
      window.removeEventListener("devicemotion", motionHandlerRef.current);
      motionHandlerRef.current = null;
    }
    motionRef.current = { x: 0, y: 0 };
    motionActiveRef.current = false;
    setMotionState("off");
  }, []);

  const startMotion = useCallback(async () => {
    if (!("DeviceMotionEvent" in window)) {
      setMotionState("unavailable");
      return;
    }
    setMotionState("requesting");
    showControls();
    try {
      const MotionEvent = window.DeviceMotionEvent as PermissionAwareDeviceMotionEvent;
      if (MotionEvent.requestPermission) {
        const permission = await MotionEvent.requestPermission();
        if (permission !== "granted") {
          setMotionState("denied");
          return;
        }
      }

      const handleMotion = (event: DeviceMotionEvent) => {
        const acceleration = event.accelerationIncludingGravity;
        if (!acceleration) return;
        const rawX = (acceleration.x ?? 0) / 9.81;
        const rawY = (acceleration.y ?? 0) / 9.81;
        const orientation = window.screen.orientation?.angle ??
          (window as Window & { orientation?: number }).orientation ?? 0;
        let x = rawX;
        let y = rawY;
        if (orientation === 90) {
          x = -rawY;
          y = rawX;
        } else if (orientation === -90 || orientation === 270) {
          x = rawY;
          y = -rawX;
        } else if (orientation === 180) {
          x = -rawX;
          y = -rawY;
        }
        const target = {
          x: Math.max(-1.35, Math.min(1.35, x)),
          y: Math.max(-1.35, Math.min(1.35, -y)),
        };
        motionRef.current = {
          x: motionRef.current.x * .82 + target.x * .18,
          y: motionRef.current.y * .82 + target.y * .18,
        };
      };

      motionHandlerRef.current = handleMotion;
      window.addEventListener("devicemotion", handleMotion, { passive: true });
      motionActiveRef.current = true;
      setMotionState("active");
    } catch {
      motionActiveRef.current = false;
      setMotionState("denied");
    }
  }, [showControls]);

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(trackingFrameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    cameraTrackingRef.current = false;
    gazeRef.current = { x: .5, y: .48 };
    setCameraState("mediaDevices" in navigator ? "off" : "unavailable");
  }, []);

  const startCamera = useCallback(async () => {
    if (!("mediaDevices" in navigator) || !videoRef.current) {
      setCameraState("unavailable");
      return;
    }
    setCameraState("starting");
    showControls();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();
      setCameraState("calibrating");

      const analysisCanvas = document.createElement("canvas");
      analysisCanvas.width = 160;
      analysisCanvas.height = 120;
      const context = analysisCanvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Camera analysis is unavailable");

      const Detector = (window as unknown as {
        FaceDetector?: new (settings: { fastMode: boolean; maxDetectedFaces: number }) => FaceDetectorInstance;
      }).FaceDetector;
      const detector = Detector ? new Detector({ fastMode: true, maxDetectedFaces: 1 }) : null;
      let detectorBusy = false;
      let detectedFace: FaceDetection["boundingBox"] | null = null;
      let lastDetection = 0;
      let sampleCount = 0;
      const baseline = { x: 0, y: 0 };
      const startedAt = performance.now();

      const track = async (time: number) => {
        trackingFrameRef.current = requestAnimationFrame(track);
        if (video.readyState < 2) return;
        context.save();
        context.scale(-1, 1);
        context.drawImage(video, -analysisCanvas.width, 0, analysisCanvas.width, analysisCanvas.height);
        context.restore();

        if (detector && !detectorBusy && time - lastDetection > 180) {
          detectorBusy = true;
          lastDetection = time;
          try {
            const faces = await detector.detect(video);
            if (faces[0]) {
              const box = faces[0].boundingBox;
              const scaleX = analysisCanvas.width / video.videoWidth;
              const scaleY = analysisCanvas.height / video.videoHeight;
              detectedFace = {
                x: analysisCanvas.width - (box.x + box.width) * scaleX,
                y: box.y * scaleY,
                width: box.width * scaleX,
                height: box.height * scaleY,
              };
            }
          } catch {
            detectedFace = null;
          } finally {
            detectorBusy = false;
          }
        }

        const face = detectedFace ?? { x: 24, y: 8, width: 112, height: 106 };
        const image = context.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
        const left = weightedDarkCenter(image, {
          x: face.x + face.width * .14,
          y: face.y + face.height * .27,
          width: face.width * .29,
          height: face.height * .2,
        });
        const right = weightedDarkCenter(image, {
          x: face.x + face.width * .57,
          y: face.y + face.height * .27,
          width: face.width * .29,
          height: face.height * .2,
        });

        if (left && right) {
          const observed = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
          if (sampleCount < 28) {
            baseline.x += observed.x;
            baseline.y += observed.y;
            sampleCount += 1;
            if (sampleCount === 28) {
              baseline.x /= sampleCount;
              baseline.y /= sampleCount;
              cameraTrackingRef.current = true;
              setCameraState("tracking");
            }
          } else {
            const target = {
              x: Math.max(.08, Math.min(.92, .5 + (observed.x - baseline.x) * 3.8)),
              y: Math.max(.12, Math.min(.88, .48 + (observed.y - baseline.y) * 3.1)),
            };
            gazeRef.current = {
              x: gazeRef.current.x + (target.x - gazeRef.current.x) * .36,
              y: gazeRef.current.y + (target.y - gazeRef.current.y) * .36,
            };
          }
        }

        if (time - startedAt > 5200 && sampleCount < 12) {
          cameraTrackingRef.current = false;
          setCameraState("error");
          cancelAnimationFrame(trackingFrameRef.current);
        }
      };
      trackingFrameRef.current = requestAnimationFrame(track);
    } catch {
      cameraTrackingRef.current = false;
      setCameraState("error");
    }
  }, [showControls]);

  useEffect(() => {
    let previousFrame = performance.now();
    let previousInterfaceUpdate = previousFrame;
    const animatePressure = (time: number) => {
      const elapsedSeconds = Math.min(.05, Math.max(0, (time - previousFrame) / 1000));
      previousFrame = time;
      if (time >= pressurePauseUntilRef.current) {
        let nextPressure = pressureValueRef.current + pressureDirectionRef.current * elapsedSeconds * 1.4;
        if (nextPressure >= 100) {
          nextPressure = 100;
          pressureDirectionRef.current = -1;
        } else if (nextPressure <= 0) {
          nextPressure = 0;
          pressureDirectionRef.current = 1;
        }
        pressureValueRef.current = nextPressure;
        pressureRef.current = nextPressure / 100;
        if (time - previousInterfaceUpdate >= 80) {
          setPressure(Number(nextPressure.toFixed(1)));
          previousInterfaceUpdate = time;
        }
      }
      pressureAnimationRef.current = requestAnimationFrame(animatePressure);
    };
    pressureAnimationRef.current = requestAnimationFrame(animatePressure);
    return () => cancelAnimationFrame(pressureAnimationRef.current);
  }, []);

  useEffect(() => {
    const capabilityTimer = window.setTimeout(() => {
      setCameraState("mediaDevices" in navigator ? "off" : "unavailable");
      const mobileMotionCapable =
        "DeviceMotionEvent" in window &&
        (navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent));
      setMotionState(mobileMotionCapable ? "off" : "unavailable");
    }, 0);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 6500);
    return () => {
      window.clearTimeout(capabilityTimer);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      cancelAnimationFrame(trackingFrameRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (motionHandlerRef.current) {
        window.removeEventListener("devicemotion", motionHandlerRef.current);
      }
    };
  }, []);

  const cameraLabel = {
    off: "Use eye tracking",
    starting: "Requesting camera…",
    calibrating: "Look at the centre…",
    tracking: "Stop eye tracking",
    unavailable: "Camera unavailable",
    error: "Retry eye tracking",
  }[cameraState];

  const motionLabel = {
    off: "Use phone motion",
    requesting: "Requesting motion…",
    active: "Stop phone motion",
    unavailable: "Phone motion unavailable",
    denied: "Retry phone motion",
  }[motionState];

  const activeMode = cameraState === "tracking"
    ? motionState === "active" ? "eyes + phone" : "eye tracking"
    : motionState === "active" ? "phone motion" : "simulated gaze";

  const sensorCopy = cameraState === "tracking" && motionState === "active"
    ? "Eye and motion sensors are processed locally in this browser."
    : motionState === "active"
      ? "Tilt or gently nudge the phone; the fibres will lag behind and settle."
      : motionState === "denied"
        ? "Motion access was denied. You can retry from the button."
        : cameraState === "tracking"
          ? "Video is processed locally and never leaves this browser."
          : cameraState === "error"
            ? "I couldn't find both eyes. Centre your face and try again."
            : "No sensors? Small saccades and quiet pauses run automatically.";

  return (
    <main
      className="retina-shell"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishSwipe}
      onPointerCancel={finishSwipe}
    >
      <WebGPURetina
        pressureRef={pressureRef}
        gazeRef={gazeRef}
        cameraTrackingRef={cameraTrackingRef}
        motionRef={motionRef}
        motionActiveRef={motionActiveRef}
        gestureRef={gestureRef}
        onStatus={handleWebGPUStatus}
      />
      {webGPUStatus === "checking" ? <div className="gpu-loading" aria-live="polite">Waking the vitreous field…</div> : null}
      {webGPUStatus === "unsupported" || webGPUStatus === "error" ? (
        <div className="gpu-loading gpu-error" role="alert">WebGPU is unavailable in this browser.</div>
      ) : null}
      <video ref={videoRef} className="camera-feed" muted playsInline aria-hidden="true" />

      <div className={`interface-layer ${controlsVisible || infoOpen ? "is-visible" : ""}`}>
        <header className="site-header">
          <div>
            <p className="eyebrow">An entoptic field study</p>
            <h1>Vitreous Floaters</h1>
          </div>
          <div className="header-actions">
            <span className="engine-mark">WebGPU</span>
            <div className={`motion-status ${cameraState === "tracking" || motionState === "active" ? "tracking" : ""}`} aria-live="polite">
              <span className="status-dot" />
              {activeMode}
            </div>
            <button className="info-button" type="button" aria-label="About the simulation" aria-expanded={infoOpen} onClick={() => { setInfoOpen((open) => !open); showControls(); }}>i</button>
          </div>
        </header>

        <div className="instruction" aria-hidden={hasInteracted}>
          <span className="instruction-line" />
          <p>Move your eyes, swipe, or tilt your phone. Fibres lag, curl, then sink.</p>
        </div>

        <section className="control-deck" aria-label="Simulation controls">
          <div className="pressure-row">
            <div className="pressure-copy"><span>Eyelid pressure</span><strong>{stateLabel(pressure / 100)}</strong></div>
            <span className="pressure-value">{Math.round(pressure)}%</span>
          </div>
          <label className="slider-wrap">
            <span className="sr-only">Eyelid pressure and transmitted-light colour</span>
            <input type="range" min="0" max="100" step="0.1" value={pressure} onChange={(event) => setPressureManually(Number(event.target.value))} className="pressure-slider" />
            <span className="slider-labels" aria-hidden="true"><span>light</span><span>closed</span><span>tight</span></span>
          </label>
          <div className="deck-footer">
            <p>{sensorCopy}</p>
            <div className="sensor-actions">
              <button className="sensor-button" type="button" disabled={["starting", "calibrating", "unavailable"].includes(cameraState)} aria-pressed={cameraState === "tracking"} onClick={() => { setHasInteracted(true); if (cameraState === "tracking") stopCamera(); else void startCamera(); }}>
                <span className="camera-icon" aria-hidden="true" />{cameraLabel}
              </button>
              <button className="sensor-button" type="button" disabled={["requesting", "unavailable"].includes(motionState)} aria-pressed={motionState === "active"} onClick={() => { setHasInteracted(true); if (motionState === "active") stopMotion(); else void startMotion(); }}>
                <span className="motion-icon" aria-hidden="true" />{motionLabel}
              </button>
            </div>
          </div>
        </section>
      </div>

      <aside className={`info-panel ${infoOpen ? "is-open" : ""}`} aria-hidden={!infoOpen}>
        <button className="close-info" type="button" aria-label="Close information" onClick={() => setInfoOpen(false)}>×</button>
        <p className="eyebrow">The phenomenon</p>
        <h2>What you see when there is almost nothing to see.</h2>
        <p className="info-intro">Closing the eyes removes the scene, not vision. Light still crosses the eyelids, structures inside the eye modulate it, and the visual system continues to construct experience from weak, noisy signals.</p>

        <p className="info-group-label">Physics of the eye</p>
        <div className="info-section"><span>01</span><div><h3>Eyelids are colour filters</h3><p>An eyelid is living tissue, not a blackout curtain. Its transmission depends strongly on wavelength: longer red wavelengths pass through more readily than blue and green. Ambient brightness, blood, tissue thickness, adaptation and how completely the lids meet all change the field, so it can shift from pale or cool tones through yellow and orange to deep red. There is no universal pressure-to-colour sequence; the experience varies between people and lighting conditions.</p></div></div>
        <div className="info-section"><span>02</span><div><h3>The eye generates light sensations</h3><p>Even without a visible scene, retinal cells and later visual pathways remain active. Spontaneous neural fluctuations can be experienced as fine grain, flicker, sparks or diffuse glows. Mechanical pressure can also stimulate retinal tissue directly. Such light sensations without corresponding external light are called <em>phosphenes</em>. The closed-eye field is usually a mixture of transmitted light and internally generated activity.</p></div></div>
        <div className="info-section"><span>03</span><div><h3>Vitreous fibres cast real shadows</h3><p>The space between lens and retina is filled with vitreous: a transparent, viscoelastic material supported by a sparse collagen network. Small condensations or clumps interrupt the light and cast shadows on the retina. Those shadows are experienced as threads, loops, dots or cobwebs—floaters—not as material sitting on the retinal surface.</p></div></div>
        <div className="info-section"><span>04</span><div><h3>Blur is optical geometry</h3><p>A floater&apos;s appearance depends on its size, transparency, orientation and distance from the retina. Its shadow is spread by diffraction, scattering and defocus before it reaches the photoreceptors. Different depths therefore create different profiles: some shadows are relatively defined, while others have broad dark centres and very soft, sometimes brighter margins. The softness is an optical penumbra, not simple transparency.</p></div></div>
        <div className="info-section"><span>05</span><div><h3>Motion has memory</h3><p>The vitreous is neither a solid nor freely flowing water. During a saccade, the eye wall rotates first and the viscoelastic interior follows with a delay. That creates shear, internal flow and elastic deformation. When the eye stops, the vitreous can keep moving, overshoot and slowly lose energy; floaters drift and evade a direct gaze. Gravity may add a weak long-term bias, but short-term motion is dominated by eye rotation, fluid inertia and drag.</p></div></div>

        <p className="info-group-label">Psychology of seeing</p>
        <div className="info-section"><span>06</span><div><h3>Seeing is interpretation</h3><p>A retinal signal never specifies one certain cause. The brain continually resolves incomplete input using context, recent history and expectation. When external structure is weak, small correlations in noise can be grouped into contours, motion or familiar forms. This is related to perceptual completion and pareidolia: meaningful shapes can emerge even when no matching object is present.</p></div></div>
        <div className="info-section"><span>07</span><div><h3>The dreamlike boundary</h3><p>Closing the eyes changes early visual processing rather than switching it off. Sensory evidence becomes weaker while internally generated activity, memory and imagery carry relatively more weight. During relaxation or the transition into sleep, the field can therefore feel fluid and dreamlike—without being a dream, and without implying a clinical hallucination.</p></div></div>
        <nav className="sources" aria-label="Research sources">
          <span>Further reading</span>
          <a href="https://www.nei.nih.gov/eye-health-information/eye-conditions-and-diseases/floaters" target="_blank" rel="noreferrer">National Eye Institute · Floaters ↗</a>
          <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC4790124/" target="_blank" rel="noreferrer">Spectral transmission through the eyelid ↗</a>
          <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC9303562/" target="_blank" rel="noreferrer">Optical scattering from floaters ↗</a>
          <a href="https://pubmed.ncbi.nlm.nih.gov/32755799/" target="_blank" rel="noreferrer">Vitreous motion during saccades ↗</a>
          <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC3897613/" target="_blank" rel="noreferrer">Phosphenes and visual processing ↗</a>
          <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC8687672/" target="_blank" rel="noreferrer">Ambiguity and visual perception ↗</a>
        </nav>
        <p className="medical-note">A sudden shower of new floaters, flashes, or a curtain-like shadow warrants urgent eye care.</p>
      </aside>
    </main>
  );
}
