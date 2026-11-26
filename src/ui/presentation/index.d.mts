export declare const PRESENTATION_SCHEMA: 'atelier.presentation/v1'
export declare const PRESENTATION_VERSION: '1.0.0'
export declare const PRESENTATION_BYTE_LIMIT: 1048576
export declare const EDIT_CODE_POINT_LIMIT: 32768

export type PresentationTheme = 'light' | 'dark'
export type PresentationDensity = 'comfortable' | 'compact'
export type PresentationDirection = 'ltr' | 'rtl'
export type PresentationTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success'

export interface PaneWidth {
  min: number
  max: number
  value: number
  ext?: Record<string, unknown>
}

export interface PresentationPane {
  id: string
  label: string
  role: 'primary' | 'context' | 'utility'
  blocks: string[]
  width?: PaneWidth
  contractVersion?: string
  ext?: Record<string, unknown>
}

export interface PresentationNavigationItem {
  id: string
  label: string
  target: string
  ext?: Record<string, unknown>
}

export interface PresentationNode {
  id: string
  type: string
  label: string
  [key: string]: unknown
}

export interface PresentationModel {
  schema: 'atelier.presentation/v1'
  version: '1.0.0'
  id: string
  title: string
  theme: PresentationTheme
  density: PresentationDensity
  direction: PresentationDirection
  lang: string
  navigation: PresentationNavigationItem[]
  panes: PresentationPane[]
  nodes: PresentationNode[]
  contractVersion?: string
  ext?: Record<string, unknown>
}

export interface PresentationTokens {
  color: {
    page: string
    panel: string
    text: string
    muted: string
    accent: string
    onAccent: string
    border: string
    selected: string
    danger: string
    success: string
    focus: string
  }
  typography: {
    body: number
    small: number
    heading: number
    lineHeight: number
    family: 'sans-serif' | 'serif' | 'monospace'
  }
  spacing: {
    small: number
    medium: number
    large: number
    section: number
  }
  layout: {
    content: number
    narrow: number
    paneMin: number
  }
  density: {
    comfortable: number
    compact: number
    target: number
  }
  elevation: {
    offset: number
    blur: number
    opacity: number
  }
  border: {
    width: number
    radius: number
  }
  motion: {
    duration: number
  }
  state: {
    focusWidth: number
    focusOffset: number
    disabledOpacity: number
  }
}

export type PresentationTokenOverrides = {
  [K in keyof PresentationTokens]?: Partial<PresentationTokens[K]>
}

export interface PresentationStateAxes {
  hovered: boolean
  focused: boolean
  pressed: boolean
  selected: boolean
  disabled: boolean
  pending: boolean
  dragging: boolean
  invalid: boolean
}

export interface RenderPresentationOptions {
  tokenOverrides?: PresentationTokenOverrides
  interactive?: boolean
}

export interface PresentationProofComparison {
  readonly status: 'unchanged' | 'review-required' | 'incomparable'
  readonly reason: string
  readonly changedFrames: readonly string[]
  readonly baselineApprovalVerified: false
  readonly executionAuthority: false
}

export declare function validatePresentation(value: unknown): string[]
export declare function assertPresentation(value: unknown): PresentationModel
export declare function validatePanePresentation(value: unknown): string[]
export declare function parsePresentation(serialized: string): PresentationModel
export declare function serializePresentation(value: PresentationModel): string

export declare const tokenContract: Readonly<{
  readonly color: Readonly<PresentationTokens['color']>
  readonly typography: Readonly<PresentationTokens['typography']>
  readonly spacing: Readonly<PresentationTokens['spacing']>
  readonly layout: Readonly<PresentationTokens['layout']>
  readonly density: Readonly<PresentationTokens['density']>
  readonly elevation: Readonly<PresentationTokens['elevation']>
  readonly border: Readonly<PresentationTokens['border']>
  readonly motion: Readonly<PresentationTokens['motion']>
  readonly state: Readonly<PresentationTokens['state']>
}>

export declare function resolveTokens(
  theme?: PresentationTheme,
  overrides?: PresentationTokenOverrides,
): Readonly<PresentationTokens>
export declare function tokenVariables(tokens?: PresentationTokenOverrides): string
export declare function contrastRatio(a: string, b: string): number

export declare function presentationState(
  input?: Partial<PresentationStateAxes>,
): Readonly<PresentationStateAxes>
export declare function resizeRequest(width: PaneWidth, value: number): number
export declare function keyboardResize(
  width: PaneWidth,
  key: string,
  direction?: PresentationDirection,
): number | null
export declare function editValueError(value: unknown): string | null

export declare function renderPresentation(
  model: PresentationModel,
  options?: RenderPresentationOptions,
): string
export declare function renderPresentationDocument(
  model: PresentationModel,
  options?: RenderPresentationOptions,
): string
export declare function renderReadOnlyDocument(
  model: PresentationModel,
  options?: Omit<RenderPresentationOptions, 'interactive'>,
): string
export declare function presentationStyles(
  theme?: PresentationTheme,
  overrides?: PresentationTokenOverrides,
  rootId?: string,
): string
export declare function comparePresentationProofs(
  baseline: unknown,
  candidate: unknown,
): Readonly<PresentationProofComparison>
