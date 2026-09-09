// Bot avatar — the Blob Studio "Blob" mascot (BlobAvatar.tsx), wrapped in the
// app's historical MausAvatar API so no call site changes: per-bot color
// becomes a body gradient, the app's one-shot motion beats borrow the
// face/state for a moment, and the eyes follow the pointer. BlobAvatar owns
// blinking, drift, body motion, effects and glyphs; nothing here re-draws them.
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MAUS_COLORS, type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import { mascotShape, type MascotShape } from "@/lib/mascotShapes";
import { BlobAvatar, DEFAULT_GAZE, type BlobAvatarHandle } from "./BlobAvatar";

/**
 * The knobs Kacper settled on in Blob Studio (`blob.blobstudio.json`). They are
 * the mascot's look, not tuning left over from a previous engine, so they are
 * the defaults here rather than something every call site repeats.
 */
const STUDIO = {
  lookAround: 0.48,
  spring: 20,
  eyeScale: { left: [1.31, 0.81] as [number, number], right: [1.31, 0.81] as [number, number] },
};

/**
 * Legacy face-placement knobs from the Maus body era. The blob places its own
 * face; these remain only so the preview harness's sliders keep compiling —
 * the matching props are accepted and ignored.
 */
export const FACE_X = 80;
export const FACE_Y = 102;
export const FACE_SCALE = 0.47;
export const EYE_SCALE = 1.12;
export const MOUTH_WEIGHT = 11;

/**
 * How far the pointer may pull the eyes. Facing forward the full range is
 * safe; with the expressions' authored gaze they already start off-centre.
 */
const POINTER_GAZE = { forward: 1, authored: 0.25 };
const FORWARD_GAZE = { x: 0, y: 0 };

/**
 * What a one-shot motion does while it plays: BlobAvatar animates the body
 * per state, so borrowing the state for a beat moves body and face together.
 */
const MOTION_FACE: Partial<
  Record<Exclude<MausMotion, "none">, { state?: MausState; blink?: boolean; spin?: number }>
> = {
  arrive: { state: "spawning", spin: 900 },
  switch: { state: "waking", spin: 620 },
  customize: { state: "proud", blink: true },
  alert: { state: "alerting" },
  thinking: { state: "thinking" },
  working: { state: "working" },
  launch: { state: "loading" },
  success: { state: "happy", blink: true },
  celebrate: { state: "celebrate", spin: 700 },
  blink: { blink: true },
  surprise: { state: "surprised", blink: true },
  failure: { state: "sad" },
  sending: { state: "sending" },
};

/** How long a one-shot motion holds its state before the bot's own returns. */
const MOTION_FACE_MS = 1400;

/** Channel-wise mix of a hex color toward another, t in 0..1. */
function mix(hex: string, toward: string, t: number): string {
  const a = Number.parseInt(hex.slice(1), 16);
  const b = Number.parseInt(toward.slice(1), 16);
  const channel = (shift: number) => {
    const va = (a >> shift) & 0xff;
    const vb = (b >> shift) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  return `#${[channel(16), channel(8), channel(0)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Bot color -> the mascot's three-stop body gradient (highlight, base,
 * shadow), with the same light/dark spread as the pack's default blue
 * ["#A5D8FF", "#3B82F6", "#082b8c"].
 */
const gradientFor = (color: MausColor): [string, string, string] => {
  // Czarny nie znosi tej formuly: rozjasnienie o 55% do bieli daje szarosc,
  // a przyciemnienie o 42% do czerni — plaska plame. Stad wlasny gradient,
  // ktory trzyma kontrast na ciemnym tle zamiast go gubic.
  if (color === "black") return ["#5A5A5A", "#2A2A2A", "#101010"];
  const fill = MAUS_COLORS[color] ?? MAUS_COLORS.green;
  return [mix(fill, "#ffffff", 0.55), fill, mix(fill, "#000000", 0.42)];
};

export type MausAvatarHandle = BlobAvatarHandle;

export type MausAvatarProps = {
  color: MausColor;
  shape?: MascotShape;
  /** Custom photo — circular, overrides mascot when present (FB/GrokBot style). */
  avatarUrl?: string | null;
  /** Named behaviour — drives the expression pool, its cadence and blinking. */
  state?: MausState;
  /** Pin one of the faces and stop the state's own drift. */
  expression?: number;
  size?: number;
  label?: string;
  motion?: MausMotion;
  motionKey?: number;
  /** Head turn in degrees. */
  turn?: number;
  gaze?: { x?: number; y?: number };
  spring?: number;
  eyeScale?: number;
  showFace?: boolean;
  showMouth?: boolean;
  mouthStroke?: number;
  /**
   * Face the viewer at turn 0, cancelling each expression's authored gaze
   * direction. Off (the export's own look) restores the drawn-in directions —
   * that is what makes `thinking` glance up and away.
   */
  forward?: boolean;
  /** Let the eyes follow the pointer across this avatar. */
  trackPointer?: boolean;
  /** Run the animation. Off renders the state's resting face. */
  animated?: boolean;
  /** Legacy Maus face-placement knobs — accepted, ignored. */
  eyeSpacing?: number;
  faceX?: number;
  faceY?: number;
  faceScale?: number;
};

function MausAvatarComponent(
  {
    color,
    shape = "blob",
    avatarUrl,
    state = "idle",
    expression,
    size = 44,
    label,
    motion = "none",
    motionKey = 0,
    turn,
    gaze,
    spring = STUDIO.spring,
    eyeScale,
    showFace = true,
    showMouth,
    mouthStroke,
    forward = true,
    trackPointer = true,
    animated = true,
  }: MausAvatarProps,
  ref: React.Ref<MausAvatarHandle>,
) {
  const inner = useRef<BlobAvatarHandle>(null);
  useImperativeHandle(ref, () => ({
    blink: () => inner.current?.blink(),
    spin: (durationMs?: number) => inner.current?.spin(durationMs),
    setExpression: (index: number) => inner.current?.setExpression(index),
  }));

  // A one-shot motion borrows the state for a moment, then hands it back.
  const [motionState, setMotionState] = useState<MausState | null>(null);
  useEffect(() => {
    if (motion === "none" || !animated) {
      setMotionState(null);
      return;
    }
    const beat = MOTION_FACE[motion];
    if (!beat) return;
    if (beat.blink) inner.current?.blink();
    if (beat.spin) inner.current?.spin(beat.spin);
    if (!beat.state) return;
    setMotionState(beat.state);
    const timer = setTimeout(() => setMotionState(null), MOTION_FACE_MS);
    return () => {
      clearTimeout(timer);
      setMotionState(null);
    };
  }, [motion, motionKey, animated]);

  const shown = motionState ?? state;
  const restingGaze = forward ? FORWARD_GAZE : DEFAULT_GAZE;

  // Pointer-follow gaze, composed with any gaze the caller pins.
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const range = forward ? POINTER_GAZE.forward : POINTER_GAZE.authored;
  const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!trackPointer) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setPointer({
      x: Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1)) * range,
      y: Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1)) * range,
    });
  };
  const onPointerLeave = () => setPointer({ x: 0, y: 0 });
  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!trackPointer) return;
    onPointerMove(event);
    if (event.pointerType !== "mouse") event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.pointerType !== "mouse" && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    onPointerLeave();
  };
  const onLostPointerCapture = () => onPointerLeave();

  // custom photo — circular, FB/GrokBot style, overrides mascot shape. The
  // thinking dots are the one exception: they are the engine's own body coming
  // apart, so a photo bot shows the mascot for that beat rather than nothing.
  if (avatarUrl && shown !== "thinking-dots") {
    return (
      <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
        <img
          src={avatarUrl}
          alt={label ?? "Avatar"}
          width={size}
          height={size}
          className="size-full rounded-full object-cover border border-hairline/30"
          style={{ width: size, height: size }}
          draggable={false}
        />
      </span>
    );
  }

  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
      onPointerDown={trackPointer ? onPointerDown : undefined}
      onPointerMove={trackPointer ? onPointerMove : undefined}
      onPointerUp={trackPointer ? onPointerUp : undefined}
      onPointerCancel={trackPointer ? onPointerUp : undefined}
      onLostPointerCapture={trackPointer ? onLostPointerCapture : undefined}
      onPointerLeave={trackPointer ? onPointerLeave : undefined}
    >
      <BlobAvatar
        ref={inner}
        state={shown}
        expression={expression}
        size={size}
        shape={mascotShape(shape)}
        gradient={gradientFor(color)}
        title={label ?? null}
        lookAround={forward ? 0 : STUDIO.lookAround}
        gaze={{
          x: (gaze?.x ?? restingGaze.x) + pointer.x,
          y: (gaze?.y ?? restingGaze.y) + pointer.y,
        }}
        turn={turn}
        spring={spring}
        eyeScale={eyeScale ?? STUDIO.eyeScale}
        showFace={showFace}
        showMouth={showMouth}
        mouthStroke={mouthStroke}
        paused={!animated}
      />
    </span>
  );
}

export const MausAvatar = memo(forwardRef(MausAvatarComponent));

export function InitialsAvatar({
  initials,
  size = 32,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}
