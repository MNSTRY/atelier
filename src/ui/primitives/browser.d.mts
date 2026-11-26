export {
  AUTOPLAY_MODES,
  MAX_GLIDE_VELOCITY,
  arrowStep,
  autoplayConfig,
  dragIntent,
  driftStep,
  glideStep,
  homeIndex,
  loopSets,
  loopThumbGeometry,
  motionAllowed,
  nearestCopy,
  pageSize,
  rampFactor,
  recede,
  releaseVelocity,
  resumeDelay,
  rowFit,
  scrollLockGap,
  scrubPosition,
  slideWindow,
  swipeStep,
  thumbGeometry,
  wrap,
} from './index.mjs'
export type {
  AutoplayConfig,
  AutoplayConfigInput,
  AutoplayMode,
  DragIntent,
  GlideStep,
  SlideWindow,
  ThumbGeometry,
} from './index.mjs'

export interface TrackCarouselHandle {
  root: HTMLElement
  go: (delta: number, options?: { user?: boolean }) => void
  goTo: (index: number) => void
  pause: () => void
  play: () => void
}

export interface FadeCarouselHandle {
  root: HTMLElement
  go: (targetIndex: number, announce?: boolean) => void
  goTo?: undefined
  pause: () => void
  play: () => void
}

export type CarouselHandle = TrackCarouselHandle | FadeCarouselHandle

export interface EnhanceDisclosuresOptions {
  openMs?: number
  closeMs?: number
}

export interface OverlayScrollbarOptions {
  thumb: HTMLElement
  viewport?: Document | HTMLElement
  header?: HTMLElement | null
  content?: HTMLElement | null
}

export interface OverlayScrollbarHandle {
  refresh: () => void
  destroy: () => void
}

export declare function enhanceCarousels(root?: ParentNode): CarouselHandle[]
export declare function enhanceCarousel(root: HTMLElement): CarouselHandle | null
export declare function enhanceDisclosures(
  root?: ParentNode,
  options?: EnhanceDisclosuresOptions,
): void
export declare function lockScroll(owner?: unknown): () => void
export declare function unlockScroll(owner: unknown): void
export declare function scrollLocked(): boolean
export declare function animate(
  element: Element,
  frames: Keyframe[] | PropertyIndexedKeyframes | null,
  options?: number | KeyframeAnimationOptions,
): Animation | null
export declare function animationAllowed(): boolean
export declare function onMotionChange(listener: () => void): () => void
export declare function startMotionWatch(): void
export declare function enhanceOverlayScrollbar(
  options: OverlayScrollbarOptions,
): OverlayScrollbarHandle | undefined
