export type AutoplayMode = 'off' | 'discrete' | 'smooth'
export type DragIntent = 'pending' | 'horizontal' | 'vertical'

export interface SlideWindow {
  start: number
  end: number
  previousDisabled: boolean
  nextDisabled: boolean
}

export interface ThumbGeometry {
  width: number
  left: number
}

export interface GlideStep {
  position: number
  velocity: number
}

export interface AutoplayConfigInput {
  mode?: string
  interval?: number | string
  speed?: number | string
}

export interface AutoplayConfig {
  mode: AutoplayMode
  interval: number
  speed: number
}

export interface RenderCarouselControlsOptions {
  label?: string
  autoplay?: AutoplayMode
  scrollbar?: boolean
  arrows?: boolean
}

export declare const MAX_GLIDE_VELOCITY: 2.5
export declare const AUTOPLAY_MODES: readonly ['off', 'discrete', 'smooth']
export declare const carouselStyles: string
export declare const scrollbarStyles: string

export declare function slideWindow(
  index: number,
  length: number,
  visible: number,
  loop?: boolean,
): SlideWindow
export declare function dragIntent(dx: number, dy: number): DragIntent
export declare function swipeStep(dx: number, dy: number, elapsed?: number): -1 | 0 | 1
export declare function motionAllowed(reduced: boolean, paused: boolean, hidden?: boolean): boolean
export declare function loopSets(length: number, perSide: number): number
export declare function homeIndex(index: number, length: number, sets: number): number
export declare function nearestCopy(from: number, to: number, length: number): number
export declare function recede(position: number, index: number): number
export declare function rowFit(
  length: number,
  natural: number,
  gap: number,
  room: number,
  min: number,
): number
export declare function pageSize(viewport: number, step: number): number
export declare function arrowStep(page: number, length: number, loop: boolean): number
export declare function wrap(position: number, period: number): number
export declare function scrubPosition(
  pointerX: number,
  railLeft: number,
  railWidth: number,
  thumbWidth: number,
  grab: number,
  range: number,
): number
export declare function thumbGeometry(
  position: number,
  range: number,
  viewport: number,
): ThumbGeometry
export declare function loopThumbGeometry(
  position: number,
  period: number,
  viewport: number,
): ThumbGeometry
export declare function rampFactor(elapsed: number, duration?: number): number
export declare function resumeDelay(value: unknown): number
export declare function releaseVelocity(dx: number, dt: number): number
export declare function glideStep(
  position: number,
  velocity: number,
  elapsed: number,
  friction?: number,
): GlideStep
export declare function autoplayConfig(options?: AutoplayConfigInput): AutoplayConfig
export declare function driftStep(
  position: number,
  speed: number,
  elapsed: number,
  period?: number,
  max?: number,
): number
export declare function scrollLockGap(widthBefore: number, widthAfter: number): number
export declare function renderCarouselControls(options?: RenderCarouselControlsOptions): string
